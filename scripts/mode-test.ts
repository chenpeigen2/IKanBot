/**
 * 双模式测试：本机库与后端服务各跑一遍同一组客户操作，验的是「转发器按模式分流」这条线。
 *
 * 三层：
 *  1) 连接配置（纯函数）——默认值、环境变量钉住、地址校验；
 *  2) 转发与探活——真起一个假后端，看参数怎么翻成请求体、错误体怎么还原成中文原句；
 *  3) 真后端对拍——起 server/dist 的 NestJS 进程，经真实 IPC handler 调客户与商品通道
 *     （含图片上传/取回），再切回本机确认两边各是各的数据；没搬的通道必须当场报错。
 *
 * 运行：npm run test:mode（会先构建 server/dist）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, closeDb } from '../electron/db'
import { registerIpc } from '../electron/ipc'
import {
  getConnection,
  saveConnection,
  normalizeBaseUrl,
  resolveConnection,
  envLocked
} from '../electron/mode'
import {
  probeRemote,
  remoteCall,
  remoteImageBase,
  remoteUploadImage,
  REMOTE_ROUTES
} from '../electron/remote/client'

const root = mkdtempSync(join(tmpdir(), 'ikan-mode-'))
process.env['IKAN_DATA_DIR'] = join(root, 'data')
process.env['IKAN_CONNECTION_FILE'] = join(root, 'connection.json')
delete process.env['IKAN_MODE']
delete process.env['IKAN_REMOTE_URL']

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
type IpcResult = { ok: true; data: any } | { ok: false; error: string }

const stub = require('electron') as { __handlers: Map<string, Handler> }

async function ipc(channel: string, ...args: unknown[]): Promise<IpcResult> {
  const handler = stub.__handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return (await handler({}, ...args)) as IpcResult
}

/** 内部等待：后端进程起来要一会儿，轮询健康检查比死等 sleep 可靠 */
async function waitHealthy(url: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(port))
    })
  })
}

async function main(): Promise<void> {
  let passed = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}`)
    if (!cond) throw new Error(`断言失败：${name}`)
    passed++
  }
  const errorOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }

  let child: ChildProcess | null = null
  const fake = createServer()

  try {
    console.log('连接配置（纯函数）')
    check('什么都没有时给本机 + 默认端口', (() => {
      const c = resolveConnection(null, {})
      return c.mode === 'local' && c.remoteUrl === 'http://localhost:8787'
    })())
    check('文件里的地址去掉结尾斜杠', resolveConnection({ mode: 'remote', remoteUrl: 'http://a:1/' }, {}).remoteUrl === 'http://a:1')
    check(
      '环境变量压过文件（自动化验收靠它）',
      (() => {
        const c = resolveConnection(
          { mode: 'local', remoteUrl: 'http://file:1' },
          { IKAN_MODE: 'remote', IKAN_REMOTE_URL: 'http://env:2' }
        )
        return c.mode === 'remote' && c.remoteUrl === 'http://env:2'
      })()
    )
    check(
      '只钉模式时地址仍用文件里的',
      (() => {
        const c = resolveConnection({ mode: 'remote', remoteUrl: 'http://file:1' }, { IKAN_MODE: 'local' })
        return c.mode === 'local' && c.remoteUrl === 'http://file:1'
      })()
    )
    check('没设变量时不算被钉住', !envLocked({}) && envLocked({ IKAN_MODE: 'remote' }))
    check('地址少了协议头当场拒（说清要什么格式）', (() => {
      try {
        normalizeBaseUrl('localhost:8787')
        return false
      } catch (e) {
        return (e as Error).message.includes('http://')
      }
    })())
    check('地址两头空格与尾斜杠都收拾掉', normalizeBaseUrl('  http://x:1/  ') === 'http://x:1')

    const saved = saveConnection({ mode: 'remote', remoteUrl: 'http://127.0.0.1:1' })
    const onDisk = JSON.parse(readFileSync(process.env['IKAN_CONNECTION_FILE']!, 'utf8'))
    check('保存后落盘、内存同步', onDisk.mode === 'remote' && saved.mode === 'remote' && getConnection().remoteUrl === 'http://127.0.0.1:1')
    saveConnection({ mode: 'local' })
    check('切回本机也落盘', getConnection().mode === 'local')

    console.log('转发与探活（假后端）')
    let variant: 'ok' | 'err' | 'garbage' | 'meta-missing' | 'meta-other' | 'meta-not-json' = 'ok'
    let captured: Record<string, unknown> | null = null
    fake.on('request', (req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url === '/api') {
        if (variant === 'meta-missing') {
          send(200, { service: 'ikanbot-server', version: 1, db: 'sqlite', routes: ['POST /api/customers/list'] })
        } else if (variant === 'meta-other') {
          send(200, { service: 'nginx', db: '', routes: [] })
        } else if (variant === 'meta-not-json') {
          send(200, 'hello')
        } else {
          send(200, { service: 'ikanbot-server', version: 1, db: 'sqlite', routes: Object.values(REMOTE_ROUTES).map((r) => `POST ${r.path}`) })
        }
        return
      }
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        captured = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        if (req.url === '/api/customers/list') {
          if (variant === 'err') send(404, { error: { message: '客户不存在' } })
          else send(200, [{ id: 1, company: 'Fake' }])
        } else if (req.url === '/api/customers/get') {
          if (variant === 'err') send(404, { error: { message: '客户不存在' } })
          else send(200, { id: 7, company: 'Fake' })
        } else if (req.url === '/api/customers/save') {
          if (variant === 'garbage') send(200, 'oops')
          else send(200, { id: 2 })
        } else {
          send(404, { error: { message: '没有这个接口' } })
        }
      })
    })
    const fakePort = await freePort()
    await new Promise<void>((res) => fake.listen(fakePort, '127.0.0.1', () => res()))
    const fakeUrl = `http://127.0.0.1:${fakePort}`
    saveConnection({ mode: 'remote', remoteUrl: fakeUrl })

    const listed = await remoteCall('customers:list', ['acme', true])
    check('位置参数翻成具名请求体', JSON.stringify(captured) === JSON.stringify({ keyword: 'acme', includeInactive: true }))
    check('返回值原样交回（不包一层）', Array.isArray(listed) && (listed as { id: number }[])[0]?.id === 1)

    await remoteCall('customers:list', [])
    check('没传的参数不进请求体', JSON.stringify(captured) === '{}')

    variant = 'err'
    check('后端的错误体还原成中文原句', (await errorOf(remoteCall('customers:get', [7]))) === '客户不存在')

    variant = 'garbage'
    check('后端回非 JSON 时说清状态码', (await errorOf(remoteCall('customers:save', [{}]))).includes('不是 JSON'))

    variant = 'meta-missing'
    const probeMissing = await probeRemote(fakeUrl)
    check('探活能点出后端缺哪几条路由', !probeMissing.ok && probeMissing.missing.some((m) => m === 'POST /api/customers/get'))
    variant = 'meta-other'
    check('地址写错到别的服务上会说不是自家后端', (await probeRemote(fakeUrl)).message.includes('不是 IKanBot 后端'))
    variant = 'meta-not-json'
    check('回的是一坨 HTML/文本也能说清', (await probeRemote(fakeUrl)).message.includes('不是 JSON'))
    variant = 'ok'
    check('后端齐全时探活通过', (await probeRemote(fakeUrl)).ok === true)
    check('没填地址直接说还没填', (await errorOf(probeRemote(''))).includes('还没填'))

    await new Promise<void>((res) => fake.close(() => res()))
    saveConnection({ mode: 'remote', remoteUrl: 'http://127.0.0.1:1' })
    check(
      '端口没人听时给人话 + 指出去哪改',
      (await errorOf(remoteCall('customers:list', []))).includes('连不上后端') &&
        (await errorOf(remoteCall('customers:list', []))).includes('设置 · 数据来源')
    )

    console.log('真后端对拍')
    const serverMain = resolve(__dirname, '../../server/dist/server/src/main.js')
    if (!existsSync(serverMain)) throw new Error(`没找到 ${serverMain}，先跑 npm run build（server）`)
    const port = await freePort()
    const serverUrl = `http://127.0.0.1:${port}`
    const logs: string[] = []
    child = spawn(process.execPath, [serverMain], {
      env: {
        ...process.env,
        IKAN_SQLITE_FILE: join(root, 'server.db'),
        IKAN_IMAGES_DIR: join(root, 'server-images'),
        IKAN_PORT: String(port)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (d) => logs.push(String(d)))
    child.stderr?.on('data', (d) => logs.push(String(d)))
    const up = await waitHealthy(serverUrl)
    check(`后端进程起来了（${serverUrl}）${up ? '' : `\n${logs.join('')}`}`, up)

    openDb()
    registerIpc()
    check(
      'IPC 通道都挂上了（客户 6 个 + 商品 12 个 + 分母那一批）',
      stub.__handlers.has('customers:list') && stub.__handlers.has('products:list') && stub.__handlers.has('mode:get')
    )

    // 本机先落一个只有本机才有的客户和商品
    saveConnection({ mode: 'local' })
    const localSeed = await ipc('customers:save', { company: 'Local Only Co', country: 'CN' })
    check('本机模式：新建客户走本机库', localSeed.ok === true && (localSeed as any).data.id > 0)
    const localDup = await ipc('customers:save', { company: 'local only co' })
    check(
      '本机模式：重名话术照旧',
      !localDup.ok && (localDup as any).error.includes('同一个客户建两份')
    )
    const localProd = await ipc('products:save', {
      styleNo: 'LOCAL-ONLY-1',
      name: '只在本机的款',
      composition: '100% Cotton',
      sizes: ['M'],
      colors: ['Black']
    })
    check('本机模式：新建商品走本机库', localProd.ok === true && (localProd as any).data.styleNo === 'LOCAL-ONLY-1')

    // 设置也是「这份账自己的」：公司抬头、提醒阈值跟着数据来源走
    const localSet0 = await ipc('settings:get')
    const localSetSaved = await ipc('settings:save', {
      ...(localSet0 as any).data,
      company: { ...(localSet0 as any).data.company, name: '本机工厂' },
      piValidDays: 20
    })
    check(
      '本机模式：设置存进本机库',
      localSetSaved.ok && (localSetSaved as any).data.company.name === '本机工厂'
    )

    // 切到后端：同一批通道，数据换了一整套
    const conn = saveConnection({ mode: 'remote', remoteUrl: serverUrl })
    check('切到后端模式（地址带端口）', conn.mode === 'remote' && conn.remoteUrl === serverUrl)

    const state = await ipc('mode:get')
    check(
      `覆盖率口径：21 / 118（实得 ${(state as any).data?.covered} / ${(state as any).data?.total}）`,
      state.ok && (state as any).data.covered === 21 && (state as any).data.total === 118
    )
    const probe = await ipc('mode:test')
    check('设置页的「测试连接」走真后端', probe.ok && (probe as any).data.ok === true)

    const remoteEmpty = await ipc('customers:list', '')
    check(
      '后端那份是空库：看不到本机刚建的客户（两边各是各的）',
      remoteEmpty.ok && (remoteEmpty as any).data.length === 0
    )

    const remoteSeed = await ipc('customers:save', { company: 'Remote Only Co', country: 'DE', contact: 'Anna' })
    check('后端模式：新建客户落到后端', remoteSeed.ok === true && (remoteSeed as any).data.company === 'Remote Only Co')
    const remoteId = (remoteSeed as any).data.id as number

    const remoteHit = await ipc('customers:list', 'remote only')
    check('后端模式：关键词搜索', remoteHit.ok && (remoteHit as any).data.length === 1)

    const remoteDup = await ipc('customers:save', { company: 'REMOTE ONLY CO' })
    check(
      '后端模式：重名守门与后果说明与原话一致',
      !remoteDup.ok &&
        (remoteDup as any).error.includes('同一个客户建两份') &&
        (remoteDup as any).error.includes('就是同名，继续保存')
    )
    const remoteDupOk = await ipc('customers:save', { company: 'Remote Only Co', allowDuplicate: true })
    check('后端模式：确认后允许重名', remoteDupOk.ok && (remoteDupOk as any).data.id !== remoteId)

    const remoteBlank = await ipc('customers:save', { company: '  ' })
    check('后端模式：空公司名拒收（原句）', !remoteBlank.ok && (remoteBlank as any).error === '客户公司名不能为空')

    const remoteRatio = await ipc('customers:save', { company: 'Ratio Co', defaultDepositRatio: 1.5 })
    check(
      '后端模式：定金比例守门（同一份 guards）',
      !remoteRatio.ok && (remoteRatio as any).error.includes('定金比例要填 0 到 1')
    )

    const remoteMissing = await ipc('customers:get', 999999)
    check('后端模式：查不存在的客户说「客户不存在」', !remoteMissing.ok && (remoteMissing as any).error === '客户不存在')

    const off = await ipc('customers:setActive', remoteId, 0)
    check('后端模式：停用生效', off.ok && (off as any).data.active === 0)
    const noInactive = await ipc('customers:list', '')
    check('后端模式：停用的不出现在默认列表', noInactive.ok && !(noInactive as any).data.some((c: any) => c.id === remoteId))
    const withInactive = await ipc('customers:list', '', true)
    check('后端模式：能主动把停用的调出来', withInactive.ok && (withInactive as any).data.some((c: any) => c.id === remoteId))

    // 商品：同一批通道换成后端那份库
    const remoteProducts = await ipc('products:list', '')
    check(
      '后端那份是空库：看不到本机刚建的商品（两边各是各的）',
      remoteProducts.ok && (remoteProducts as any).data.length === 0
    )
    const remoteProd = await ipc('products:save', {
      styleNo: 'REMOTE-1',
      name: '后端款',
      composition: '100% Cotton',
      sizes: ['M', 'L'],
      colors: ['Black'],
      costPrice: 9.9
    })
    check('后端模式：商品落库到后端', remoteProd.ok && (remoteProd as any).data.styleNo === 'REMOTE-1')
    const remoteProdId = (remoteProd as any).data.id as number
    const remoteProdDup = await ipc('products:save', {
      styleNo: 'remote-1',
      name: '撞号',
      composition: '',
      sizes: [],
      colors: []
    })
    check(
      '后端模式：款号撞号守门与原句一致',
      !remoteProdDup.ok &&
        (remoteProdDup as any).error.includes('已经存在') &&
        (remoteProdDup as any).error.includes('复制')
    )
    const remoteProdMiss = await ipc('products:get', 999999)
    check(
      '后端模式：查不存在的商品说「商品不存在」',
      !remoteProdMiss.ok && (remoteProdMiss as any).error === '商品不存在'
    )
    const remoteCopy = await ipc('products:copy', remoteProdId, 'REMOTE-1-COPY')
    check(
      '后端模式：复制款号保留尺码表',
      remoteCopy.ok && (remoteCopy as any).data.sizes.length === 2
    )

    // 图片：传上去 → 登记 → 地址/纸面取图 —— 库搬了图没搬，商品卡就是一片空白
    const storedName = await remoteUploadImage('probe.png', Buffer.from('89504e470d0a1a0a', 'hex'))
    const addedImg = await ipc('products:addImage', remoteProdId, storedName)
    check('后端模式：图片登记进后端库（首张自动上位）', addedImg.ok && (addedImg as any).data.isPrimary === 1)
    const imgUrl = await ipc('images:url', storedName)
    check(
      '后端模式：图片地址指回后端',
      imgUrl.ok && String((imgUrl as any).data).startsWith(`${serverUrl}/api/files/images/`)
    )
    check('后端模式：图片基地址是后端的 HTTP 目录', remoteImageBase() === `${serverUrl}/api/files/images`)
    const dataUrl = await ipc('images:readDataUrl', storedName)
    check(
      '后端模式：纸面用图能取成 data URL',
      dataUrl.ok && String((dataUrl as any).data).startsWith('data:image/png;base64,')
    )
    const imgRows = await ipc('products:images', remoteProdId)
    check('后端模式：能列出刚登记的图', imgRows.ok && (imgRows as any).data.length === 1)
    await ipc('products:delImage', (imgRows as any).data[0].id)
    const afterDel = await ipc('images:readDataUrl', storedName)
    check(
      '后端模式：删图后文件也清了（纸面取图回空，再回退本机也找不到）',
      afterDel.ok && (afterDel as any).data === ''
    )

    // 设置：同一批通道，读的也是后端那份
    const remoteSettings = await ipc('settings:get')
    check(
      '后端模式：设置读的是后端那份（看不到本机工厂抬头）',
      remoteSettings.ok && (remoteSettings as any).data.company.name === ''
    )
    const remoteSettingsSaved = await ipc('settings:save', {
      ...(remoteSettings as any).data,
      company: { ...(remoteSettings as any).data.company, name: '  后端工厂  ' },
      piValidDays: 25,
      banks: [{ currency: 'USD', bankName: '后端银行', accountName: '', accountNo: '', swift: '', address: '' }]
    })
    check(
      '后端模式：保存设置去掉首尾空格',
      remoteSettingsSaved.ok && (remoteSettingsSaved as any).data.company.name === '后端工厂'
    )
    const remoteSettingsAgain = await ipc('settings:get')
    check('后端模式：再读就是刚存的那份', remoteSettingsAgain.ok && (remoteSettingsAgain as any).data.piValidDays === 25)

    const remoteBadDay = await ipc('settings:save', { ...(remoteSettings as any).data, piValidDays: 7.5 })
    check(
      '后端模式：设置守门文案与原句一致',
      !remoteBadDay.ok && (remoteBadDay as any).error.includes('整数')
    )
    const remoteLocked = await ipc('settings:baseLocked')
    check('后端模式：基准币锁状态也问后端（空库未锁）', remoteLocked.ok && (remoteLocked as any).data === false)

    // 不碰数据的通道没必要绕一趟网络
    const tpl = await ipc('products:csvTemplate')
    check('远端模式下 CSV 模板仍走本机（不白跑一趟网络）', tpl.ok && String((tpl as any).data).includes('款号'))

    const unMigrated = await ipc('orders:list', {})
    check(
      '没搬的通道当场报错（含去哪切回本机）',
      !unMigrated.ok &&
        (unMigrated as any).error.includes('还没搬到后端') &&
        (unMigrated as any).error.includes('设置 · 数据来源')
    )
    const statsUnMigrated = await ipc('customers:stats', remoteId)
    check('客户统计也还没搬（同一条错误路，不静默读本机）', !statsUnMigrated.ok && (statsUnMigrated as any).error.includes('还没搬到后端'))

    const paths = await ipc('app:paths')
    check('本机独有通道在远端模式下照常可用', paths.ok && typeof (paths as any).data.db === 'string')

    // 切回本机：后端那份数据必须原封不动地留在后端
    saveConnection({ mode: 'local' })
    const backLocal = await ipc('customers:list', '')
    check('切回本机：本机客户还在', backLocal.ok && (backLocal as any).data.some((c: any) => c.company === 'Local Only Co'))
    check(
      '切回本机：后端那份不会混进来',
      backLocal.ok && !(backLocal as any).data.some((c: any) => c.company === 'Remote Only Co')
    )

    const remoteAgain = await remoteCall('customers:get', [remoteId])
    check('后端数据仍在后端（不是被搬走）', (remoteAgain as any)?.company === 'Remote Only Co')
    const remoteProdAgain = await remoteCall('products:get', [remoteProdId])
    check('后端商品也仍在后端', (remoteProdAgain as any)?.styleNo === 'REMOTE-1')

    const backProducts = await ipc('products:list', '')
    check(
      '切回本机：本机商品还在',
      backProducts.ok && (backProducts as any).data.some((p: any) => p.styleNo === 'LOCAL-ONLY-1')
    )
    check(
      '切回本机：后端那份商品不会混进来',
      backProducts.ok && !(backProducts as any).data.some((p: any) => p.styleNo === 'REMOTE-1')
    )

    const backSettings = await ipc('settings:get')
    check(
      '切回本机：设置回到本机那一份',
      backSettings.ok &&
        (backSettings as any).data.company.name === '本机工厂' &&
        (backSettings as any).data.piValidDays === 20
    )
    const remoteSettingsStill = (await remoteCall('settings:get', [])) as any
    check('后端设置仍在后端', remoteSettingsStill?.company?.name === '后端工厂')

    console.log(`\n${'='.repeat(46)}`)
    console.log(`双模式通过 ${passed} 项`)
    console.log('='.repeat(46))
  } finally {
    try {
      closeDb()
    } catch {
      /* 没开过库就算了 */
    }
    child?.kill()
    fake.close()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
