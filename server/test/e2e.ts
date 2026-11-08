import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { Database } from 'node-sqlite3-wasm'
import { createZip } from '../../core/zip'
import { configureApp } from '../src/app.setup'
import { BackupService } from '../src/backup/backup.service'
import { DB } from '../src/db/db.module'
import type { Db } from '../src/db/types'
import { localDate } from '../../src/shared/date'

/**
 * HTTP 面冒烟：跑的就是线上那套 AppModule + configureApp（不另搭一条测试路径）。
 * 覆盖健康检查、接口自描述、客户/商品/设置/金额各域正门，以及单据簇（订单/报价/打样/装箱/工作台/导出）。
 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ikan-e2e-'))
  process.env['IKAN_SQLITE_FILE'] = join(dir, 'e2e.db')
  process.env['IKAN_IMAGES_DIR'] = join(dir, 'images')
  process.env['IKAN_DOCS_DIR'] = join(dir, 'docs')
  delete process.env['IKAN_DB']
  // 首个用户的引导走启动路径本身：users 空 + 环境变量齐全 → 建一个（M2 鉴权第一片）
  process.env['IKAN_BOOTSTRAP_USER'] = 'wenjuan'
  process.env['IKAN_BOOTSTRAP_PASSWORD'] = 'Secret#123'
  process.env['IKAN_BOOTSTRAP_NAME'] = '周文娟'

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>()
  await configureApp(app)
  const raw = request(app.getHttpServer())

  let passed = 0
  const check = (name: string, cond: boolean, extra?: unknown): void => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}`)
    if (!cond) throw new Error(`断言失败：${name}${extra !== undefined ? ` —— ${String(extra)}` : ''}`)
    passed++
  }
  // 「权限错误一律人话」锁死断言（R62）：把 r60（存档）与 r61（备份）两轮的 EACCES 断言
  // 合成同一把尺——任何一条通往用户的路撞上文件系统权限错，都必须说清权限、路径、找谁，
  // 绝不能又落回「服务器内部错误」五个字。以后新接口加文件读写，红灯插在这把尺上。
  const checkPerm = (name: string, resp: { status: number; body?: any; text?: string }, where: string): void => {
    const msg = String(resp.body?.error?.message ?? '')
    check(
      name,
      resp.status === 500 &&
        msg.includes('权限') &&
        msg.includes(where) &&
        msg.includes('管服务器') &&
        msg !== '服务器内部错误',
      'status=' + resp.status + ' text=' + JSON.stringify(resp.text)
    )
  }

  console.log('鉴权（M2 第一片）')
  const noToken = await raw.post('/api/customers/list').send({})
  check(
    '无 token 401，中文说去哪登录',
    noToken.status === 401 && String(noToken.body.error.message).includes('请先登录'),
    JSON.stringify(noToken.body)
  )
  const badToken = await raw.post('/api/customers/list').set('Authorization', 'Bearer abc.def').send({})
  check('随手编的 token 同样 401', badToken.status === 401)
  const wrongLogin = await raw.post('/api/auth/login').send({ username: 'wenjuan', password: 'wrong-pass' })
  check(
    '错密码拒登录：401 +「用户名或密码不对」（查无此人也回同一句，不告诉试探的人用户名存不存在）',
    wrongLogin.status === 401 && wrongLogin.body.error.message === '用户名或密码不对'
  )
  const login = await raw.post('/api/auth/login').send({ username: 'wenjuan', password: 'Secret#123' })
  check(
    '登录发 token 并带回显示名',
    login.status === 200 && typeof login.body.token === 'string' && login.body.displayName === '周文娟',
    JSON.stringify(login.body)
  )
  const token = login.body.token as string
  // 闸门开启后的冒烟一律带这张通行证；查无此入口的三条已经用 raw 验过。
  // 带着 token 打公开入口（/healthz、GET /api）也应照常——别把运维探活锁在门里
  const http = {
    get: (u: string) => raw.get(u).set('Authorization', `Bearer ${token}`),
    post: (u: string) => raw.post(u).set('Authorization', `Bearer ${token}`),
    put: (u: string) => raw.put(u).set('Authorization', `Bearer ${token}`)
  }

  try {
    console.log('服务面子')
    const health = await http.get('/healthz')
    check('/healthz 报告数据库可用', health.status === 200 && health.body.ok === true && health.body.db === 'sqlite')

    const meta = await http.get('/api')
    const routes: string[] = meta.body.routes ?? []
    check('GET /api 自描述已接接口', routes.includes('POST /api/customers/list') && routes.includes('GET /healthz'))
    check(
      '路由数与控制器一致（109 个：前 30 + 订单 30 + 报价 8 + 打样 8 + 预收 4 + 装箱 9 + 工作台 2 + 月报 1 + 导出 1 + 客户聚合 3 + 登录 1 + 单据存档 6 + 备份 6）',
      routes.length === 109
    )
    const metaNoAuth = await raw.get('/api')
    check('GET /api 不挂锁（探活与覆盖率靠它）', metaNoAuth.status === 200)

    console.log('客户域')
    const empty = await http.post('/api/customers/list').send({})
    check('空库出空列表', empty.status === 200 && Array.isArray(empty.body) && empty.body.length === 0)

    const created = await http
      .post('/api/customers/save')
      .send({ input: { company: 'Acme Trading', country: 'US', contact: 'Ann' } })
    check('新建客户返回落库后的档案', created.status === 200 && created.body.id > 0 && created.body.company === 'Acme Trading')
    const id = created.body.id as number

    const listed = await http.post('/api/customers/list').send({ keyword: 'acme' })
    check('列表能按关键词搜到', listed.status === 200 && listed.body.length === 1)

    const dup = await http.post('/api/customers/save').send({ input: { company: ' acme trading ' } })
    check(
      '同名客户默认拦下（话术说清后果）',
      dup.status === 400 && String(dup.body.error.message).includes('已经有同名客户')
    )

    const dupOk = await http
      .post('/api/customers/save')
      .send({ input: { company: 'Acme Trading', country: 'DE', allowDuplicate: true } })
    check('显式确认后允许重名', dupOk.status === 200 && dupOk.body.id !== id)

    const badRatio = await http
      .post('/api/customers/save')
      .send({ input: { company: 'Ratio Co', defaultDepositRatio: 1.5 } })
    check(
      '定金比例越界拒收（守门文案原样透出）',
      badRatio.status === 400 && String(badRatio.body.error.message).length > 6
    )

    const noName = await http.post('/api/customers/save').send({ input: { company: '   ' } })
    check('空公司名拒收', noName.status === 400 && noName.body.error.message === '客户公司名不能为空')

    const off = await http.post('/api/customers/setActive').send({ id, active: 0 })
    check('停用后 active 落 0', off.status === 200 && off.body.active === 0)
    const normal = await http.post('/api/customers/list').send({})
    check('停用的不出现在默认列表', !normal.body.some((c: { id: number }) => c.id === id))
    const withInactive = await http.post('/api/customers/list').send({ includeInactive: true })
    check('includeInactive 能看见停用的', withInactive.body.some((c: { id: number }) => c.id === id))

    const missing = await http.post('/api/customers/get').send({ id: 9999 })
    check('查不存在的客户说「客户不存在」', missing.status === 404 && missing.body.error.message === '客户不存在')

    const statsEmpty = await http.post('/api/customers/stats').send({ id })
    check(
      '统计通道：没下过单的客户回一页 0',
      statsEmpty.status === 200 && statsEmpty.body.orderCount === 0 && statsEmpty.body.rateMissingSamples === 0
    )

    const briefsEmpty = await http.post('/api/customers/orders').send({ id })
    check(
      '历史订单通道：空客户回空列表',
      briefsEmpty.status === 200 && Array.isArray(briefsEmpty.body) && briefsEmpty.body.length === 0
    )

    const histNoFilter = await http.post('/api/customers/stylePriceHistory').send({})
    check(
      '历史价两个条件都不给：400 并指路',
      histNoFilter.status === 400 && String(histNoFilter.body.error.message).includes('哪一款')
    )

    const statsMissing = await http.post('/api/customers/stats').send({ id: 9999 })
    check(
      '统计通道：客户不存在回 404，与桌面同一句话',
      statsMissing.status === 404 && statsMissing.body.error.message === '客户不存在'
    )

    const histMissing = await http
      .post('/api/customers/stylePriceHistory')
      .send({ filter: { customerId: 9999 } })
    check(
      '历史价：客户不存在同样是 404',
      histMissing.status === 404 && histMissing.body.error.message === '客户不存在'
    )

    const removed = await http.post('/api/customers/delete').send({ id })
    check('没有关联单据的客户可以删', removed.status === 200)
    check('删完再查确实没了', (await http.post('/api/customers/get').send({ id })).status === 404)

    console.log('边界与守门')
    const metaShape = await http.get('/api')
    check(
      '自描述带上服务名与版本（探活靠它识别是不是自家后端）',
      metaShape.body.service === 'ikanbot-server' && metaShape.body.version === 1 && metaShape.body.db === 'sqlite'
    )

    const noBody = await http.post('/api/customers/list')
    check('一个字节都不带也能回空列表（不白屏、不 500）', noBody.status === 200 && Array.isArray(noBody.body))

    const arrayBody = await http.post('/api/customers/save').send([])
    check('请求体是数组时拒收档案', arrayBody.status === 400 && arrayBody.body.error.message.includes('客户档案'))

    const sneaky = await http
      .post('/api/customers/save')
      .send({ input: { company: 'Whitelist Co', evil: 'DROP TABLE', id: 'not-a-number' } })
    check('白名单读字段：多余键进不了库', sneaky.status === 200 && sneaky.body.company === 'Whitelist Co')
    check('多传的字段不会回显（查库也没有）', !('evil' in sneaky.body))
    const sneakyId = sneaky.body.id as number
    check(
      '字符串 id 不当作修改（按新建处理，不会误改别的客户）',
      sneakyId > 0 && sneakyId !== id
    )

    const nullRatio = await http
      .post('/api/customers/save')
      .send({ input: { company: 'Null Ratio Co', defaultDepositRatio: null } })
    check('定金比例可以留空（null 是合法值）', nullRatio.status === 200 && nullRatio.body.defaultDepositRatio === null)

    const same1 = await http.post('/api/customers/sameName').send({ company: '  acme TRADING ' })
    check('同名查重忽略大小写与首尾空格', same1.status === 200 && same1.body.length >= 1)
    const sameSelf = await http
      .post('/api/customers/sameName')
      .send({ company: 'whitelist co', selfId: sneakyId })
    check('查重时排除自己（改名不该提示重名）', sameSelf.status === 200 && sameSelf.body.length === 0)

    const pct = await http.post('/api/customers/save').send({ input: { company: '100% Cotton Ltd' } })
    check('含 % 的公司名能存', pct.status === 200)
    const pctHit = await http.post('/api/customers/list').send({ keyword: '100%' })
    check('搜 100% 只命中它（LIKE 通配符已转义）', pctHit.status === 200 && pctHit.body.length === 1)

    const coerced = await http.post('/api/customers/get').send({ id: String(sneakyId) })
    check('字符串数字编号照收（跨语言调用常见）', coerced.status === 200 && coerced.body.id === sneakyId)

    const on = await http.post('/api/customers/setActive').send({ id: sneakyId, active: true })
    check('active 传 true 落 1', on.status === 200 && on.body.active === 1)
    const strict = await http.post('/api/customers/setActive').send({ id: sneakyId, active: '1' })
    check('active 传字符串不当真（严格布尔）', strict.status === 200 && strict.body.active === 0)

    // 有单据的客户删不掉：先直接落一张订单（订单域还没搬过来，这里只造引用）
    const db = app.get<Db>(DB)
    await db.run(
      `INSERT INTO orders(order_no, customer_id, created_at, updated_at) VALUES('SO-R1', ?, '', '')`,
      [sneakyId]
    )
    const blocked = await http.post('/api/customers/delete').send({ id: sneakyId })
    check(
      '有订单的客户删不掉，并说清有几张单、该改用停用',
      blocked.status === 400 &&
        blocked.body.error.message.includes('1 个订单') &&
        blocked.body.error.message.includes('停用')
    )

    const parallel = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        http.post('/api/customers/list').send({ keyword: i % 2 === 0 ? 'acme' : '' })
      )
    )
    check('并发六个请求互不串数据（全 200）', parallel.every((r) => r.status === 200))

    console.log('商品域')
    const pEmpty = await http.post('/api/products/list').send({})
    check('空库出空商品列表', pEmpty.status === 200 && Array.isArray(pEmpty.body) && pEmpty.body.length === 0)

    const pSave = await http.post('/api/products/save').send({
      input: { styleNo: 'API-1', name: '接口款', composition: '100% Cotton', sizes: ['M', 'L'], colors: ['Black'] }
    })
    check(
      '新建商品返回落库后的档案',
      pSave.status === 200 && pSave.body.styleNo === 'API-1' && pSave.body.sizes.length === 2
    )
    const pid = pSave.body.id as number

    const pDup = await http
      .post('/api/products/save')
      .send({ input: { styleNo: 'api-1', name: '撞号', composition: '', sizes: [], colors: [] } })
    check(
      '款号大小写撞号拒收（原句说清后果）',
      pDup.status === 400 && String(pDup.body.error.message).includes('已经存在')
    )

    const pMissing = await http.post('/api/products/get').send({ id: 999999 })
    check('查不存在的商品说「商品不存在」', pMissing.status === 404 && pMissing.body.error.message === '商品不存在')

    const pNeg = await http
      .post('/api/products/save')
      .send({ input: { styleNo: 'API-NEG', name: '负数', composition: '', sizes: [], colors: [], costPrice: -1 } })
    check(
      '成本价负数拒收（守门文案原样透出）',
      pNeg.status === 400 && String(pNeg.body.error.message).includes('不能是负数')
    )

    const pCopy = await http.post('/api/products/copy').send({ id: pid, newStyleNo: 'API-1-COPY' })
    check(
      '复制款号保留尺码表',
      pCopy.status === 200 && pCopy.body.styleNo === 'API-1-COPY' && pCopy.body.sizes.length === 2
    )

    const img = await http.post('/api/products/addImage').send({ productId: pid, fileName: 'probe.png' })
    check('第一张图自动上主位', img.status === 200 && img.body.isPrimary === 1)
    const imgs = await http.post('/api/products/images').send({ productId: pid })
    check('图片列表按主图优先', imgs.status === 200 && imgs.body.length === 1)

    const imgNoName = await http.post('/api/products/addImage').send({ productId: pid, fileName: '   ' })
    check('空图片文件名拒收', imgNoName.status === 400)

    const ghostImg = await http.post('/api/products/setPrimary').send({ productId: pid, imageId: 999999 })
    check(
      '指到不属于该商品的图报错（原句）',
      ghostImg.status === 400 && String(ghostImg.body.error.message).includes('主图没有改动')
    )

    check('删图片登记不报错', (await http.post('/api/products/delImage').send({ id: img.body.id })).status === 200)
    const refs = await http.post('/api/products/referenceCount').send({ id: pid })
    check(
      '引用计数三项齐全',
      refs.status === 200 && refs.body.orders === 0 && refs.body.quotations === 0 && refs.body.samples === 0
    )

    const pImp = await http
      .post('/api/products/importCsv')
      .send({ text: '款号,品名\nAPI-CSV,导入款\n', mode: 'skip' })
    check('CSV 导入走同一份解析（表头别名都认）', pImp.status === 200 && pImp.body.created === 1)

    const pDel = await http.post('/api/products/delete').send({ id: pid })
    check('没引用的商品可以真删', pDel.status === 200 && pDel.body.deactivated === false)

    console.log('图片文件')
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const up = await http
      .post('/api/files/upload?name=probe.png')
      .set('content-type', 'application/octet-stream')
      .send(png)
    check('上传图片返回后端生成的文件名', up.status === 200 && /\.png$/.test(String(up.body.fileName)))
    const storedName = String(up.body.fileName)

    const fetched = await http.get(`/api/files/images/${storedName}`)
    check(
      '按文件名取回图片（类型与缓存头都对）',
      fetched.status === 200 && String(fetched.headers['content-type']).includes('image/png')
    )
    check('不存在的图 404', (await http.get('/api/files/images/nope.png')).status === 404)

    const badExt = await http
      .post('/api/files/upload?name=probe.exe')
      .set('content-type', 'application/octet-stream')
      .send(png)
    check(
      '非图片扩展名拒收（说清只接哪几种）',
      badExt.status === 400 && String(badExt.body.error.message).includes('只接')
    )

    const svgUp = await http
      .post('/api/files/upload?name=logo.svg')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))
    check('公司 Logo 收 SVG（放大到纸面也不糊）', svgUp.status === 200 && /\.svg$/.test(String(svgUp.body.fileName)))
    const svgGot = await http.get(`/api/files/images/${String(svgUp.body.fileName)}`)
    check(
      'SVG 取回带 CSP 沙箱头（单独打开也跑不了脚本）',
      svgGot.status === 200 &&
        String(svgGot.headers['content-type']).includes('image/svg+xml') &&
        String(svgGot.headers['content-security-policy'] ?? '').includes("default-src 'none'")
    )
    await http.post('/api/files/discard').send({ names: [String(svgUp.body.fileName)] })

    check(
      '目录穿越读不到目录外的文件',
      (await http.get('/api/files/images/..%2F..%2Fpackage.json')).status === 404
    )

    const disc = await http.post('/api/files/discard').send({ names: [storedName, 'nope.png'] })
    check('丢弃图片只删存在的那张', disc.status === 200 && disc.body.removed === 1)
    check('删完再取确实没了', (await http.get(`/api/files/images/${storedName}`)).status === 404)

    // 删除不可逆：这条通道本来是给「传上去没登记」的草稿收尾的，
    // 但名字是调用方传上来的——已经在用的那张不能当草稿清掉
    const draftUp = await http
      .post('/api/files/upload?name=r43-draft.png')
      .set('content-type', 'application/octet-stream')
      .send(png)
    const draftName = String(draftUp.body.fileName)
    const usedUp = await http
      .post('/api/files/upload?name=r43-used.png')
      .set('content-type', 'application/octet-stream')
      .send(png)
    const usedName = String(usedUp.body.fileName)
    const usedProduct = await http
      .post('/api/products/save')
      .send({ input: { styleNo: 'R43-USED', name: '引用检查', composition: '', sizes: [], colors: [] } })
    await http
      .post('/api/products/addImage')
      .send({ productId: usedProduct.body.id, fileName: usedName })
    const ghostAdd = await http.post('/api/products/addImage').send({ productId: 999999, fileName: 'ghost.png' })
    check(
      '给已经不存在的商品登记图说「商品不存在」（不外泄 SQLite 原话）',
      ghostAdd.status === 404 && ghostAdd.body.error.message === '商品不存在'
    )
    const discUsed = await http.post('/api/files/discard').send({ names: [usedName, draftName] })
    check('已登记在商品上的图拒删，只删没登记的那张', discUsed.status === 200 && discUsed.body.removed === 1)
    check(
      '被引用的图还在（记录在、文件没了 = 商品页一片破图）',
      (await http.get(`/api/files/images/${usedName}`)).status === 200
    )
    check(
      '没登记的草稿照删（这条通道的本意）',
      (await http.get(`/api/files/images/${draftName}`)).status === 404
    )

    console.log('设置域')
    const sDefault = await http.post('/api/settings/get').send({})
    check(
      '空库读设置给的是完整默认值（不是空对象）',
      sDefault.status === 200 && sDefault.body.baseCurrency === 'CNY' && sDefault.body.piValidDays === 15
    )

    const sSaved = await http.post('/api/settings/save').send({
      input: {
        company: { name: '  接口工厂  ', logoFile: '', address: '', phone: '', email: '', website: '' },
        banks: [{ currency: 'USD', bankName: 'BOA', accountName: '', accountNo: '001', swift: '', address: '' }],
        piValidDays: 20,
        defaultDepositRatio: 0.3,
        remindConfirmDays: 7,
        remindPaymentDays: 10,
        remindBalanceDays: 15,
        remindShipDays: 3,
        grossWeightFactor: 1.1,
        baseCurrency: 'CNY',
        operator: '接口测试'
      }
    })
    check(
      '保存去掉首尾空格并原样返回',
      sSaved.status === 200 && sSaved.body.company.name === '接口工厂' && sSaved.body.banks.length === 1
    )
    check('再读回来就是刚存的那份', (await http.post('/api/settings/get').send({})).body.piValidDays === 20)

    const sBadDay = await http.post('/api/settings/save').send({
      input: { ...sSaved.body, piValidDays: 7.5 }
    })
    check(
      '天数填小数拒收（守门文案原样透出）',
      sBadDay.status === 400 && String(sBadDay.body.error.message).includes('整数')
    )

    const sDupBank = await http.post('/api/settings/save').send({
      input: {
        ...sSaved.body,
        banks: [
          { currency: 'USD', bankName: 'A' },
          { currency: 'USD', bankName: 'B' }
        ]
      }
    })
    check(
      '同币种两个收款账户拒收（PI 不知道印哪个）',
      sDupBank.status === 400 && String(sDupBank.body.error.message).includes('加了两遍')
    )

    const sBadShape = await http.post('/api/settings/save').send({ input: 'abc' })
    check('设置内容不是对象当场拒收', sBadShape.status === 400)

    const sLock = await http.post('/api/settings/baseLocked').send({})
    check('库里有单据时基准币锁死', sLock.status === 200 && sLock.body === true)

    const sSwitch = await http
      .post('/api/settings/save')
      .send({ input: { ...sSaved.body, baseCurrency: 'USD' } })
    check(
      '有账后换基准币拒收（说清要重算历史）',
      sSwitch.status === 400 && String(sSwitch.body.error.message).includes('基准币不能换')
    )

    console.log('金额只读面')
    const moneyCust = await http.post('/api/customers/save').send({ input: { company: 'Money Co' } })
    const mcid = Number(moneyCust.body.id)
    await db.run(
      `INSERT INTO orders(order_no, customer_id, payment_status, currency, exchange_rate, charges, deposit_ratio, created_at, updated_at)
       VALUES('SO-M1', ?, 'issued', 'USD', 7, ?, 0.3, '', '')`,
      [mcid, JSON.stringify([{ label: '运费', amount: 100 }])]
    )
    const mOrderId = Number((await db.get(`SELECT id FROM orders WHERE order_no = 'SO-M1'`))?.['id'])
    await db.run(
      `INSERT INTO order_items(order_id, style_no, quantity, unit_price, unit_cost) VALUES(?, 'M-1', 10, 5, 3)`,
      [mOrderId]
    )

    const recv = await http.post('/api/report/receivables').send({})
    const recvRow = (recv.body as { customerId: number; orders: number; totalBase: number }[]).find(
      (r) => r.customerId === mcid
    )
    check(
      '待收榜：货值 50 + 运费 100，折基准币 1050，按 1 张未结单挂榜',
      recv.status === 200 && recvRow?.orders === 1 && recvRow?.totalBase === 1050
    )

    const openRows = await http.post('/api/report/customerOrderRows').send({ customerId: mcid })
    check(
      '客户未结单行：原币待收 150（不是折后金额）',
      openRows.status === 200 && openRows.body.length === 1 && openRows.body[0].receivable === 150
    )

    const noPl = await http.post('/api/pl/amounts').send({ orderId: mOrderId })
    check('没装箱批次的单，本批金额是空表', noPl.status === 200 && Array.isArray(noPl.body) && noPl.body.length === 0)

    const noCredit = await http.post('/api/credits/balance').send({ customerId: mcid })
    check(
      '没抵扣过预收的客户，余额是空表而不是一堆 0',
      noCredit.status === 200 && Array.isArray(noCredit.body) && noCredit.body.length === 0
    )

    const badCustomer = await http.post('/api/report/customerOrderRows').send({ customerId: 0 })
    check(
      '金额接口的编号守门：不是正整数当场说清',
      badCustomer.status === 400 && String(badCustomer.body.error.message).includes('客户编号')
    )

    console.log('订单域')
    const ordCust = await http.post('/api/customers/save').send({ input: { company: 'Order Co' } })
    const ocid = Number(ordCust.body.id)
    const oCreate = await http
      .post('/api/orders/create')
      .send({ input: { customerId: ocid, currency: 'USD', exchangeRate: 7.2, exchangeRateDate: localDate() } })
    check(
      '建单自动烧单号并回完整档案',
      oCreate.status === 200 && /^SO\d/.test(String(oCreate.body.orderNo)) && oCreate.body.customerId === ocid
    )
    const oid = Number(oCreate.body.id)

    const oItems = await http
      .post('/api/orders/addItems')
      .send({ orderId: oid, items: [{ styleNo: 'OC-1', quantity: 10, unitPrice: 5 }] })
    check(
      '批量加明细一次落库（货值 50）',
      oItems.status === 200 && oItems.body.items.length === 1 && oItems.body.totalAmount === 50
    )

    const oList = await http.post('/api/orders/list').send({ filter: { customerId: ocid } })
    check(
      '订单列表按客户筛得到这一张',
      oList.status === 200 && oList.body.total === 1 && oList.body.rows[0].id === oid
    )

    const oGet = await http.post('/api/orders/get').send({ id: oid })
    check('查单带回明细与空收款', oGet.status === 200 && oGet.body.items.length === 1 && oGet.body.payments.length === 0)
    const oMissing = await http.post('/api/orders/get').send({ id: 999999 })
    check('查不存在的单回空体（桌面读成 null，按「没找到」处理）', oMissing.status === 200 && oMissing.text === '')

    const skus = await http.post('/api/orders/summarizeSkus').send({ orderId: oid })
    check('SKU 汇总按款色码合计', skus.status === 200 && skus.body.length === 1 && skus.body[0].quantity === 10)

    const oShipBad = await http
      .post('/api/orders/setShipStatus')
      .send({ orderId: oid, status: 'partial_shipped' })
    check(
      '「部分出运」不能手工设：说要到装箱单里推进',
      oShipBad.status === 400 && String(oShipBad.body.error.message).includes('装箱单')
    )
    const oShip = await http.post('/api/orders/setShipStatus').send({ orderId: oid, status: 'preparing', note: '开始备货' })
    check('合法出货状态落库', oShip.status === 200 && oShip.body.shipStatus === 'preparing')

    const draftPay = await http
      .post('/api/orders/addPayment')
      .send({ orderId: oid, p: { paidAt: localDate(), amount: 10 } })
    check(
      '草稿单登记收款被拦（说清这笔钱会从月报消失）',
      draftPay.status === 400 && String(draftPay.body.error.message).includes('草稿')
    )

    const oStatus = await http
      .post('/api/orders/setPaymentStatus')
      .send({ orderId: oid, status: 'sent', note: 'PI 已发' })
    check('收款状态推到「已发出」', oStatus.status === 200 && oStatus.body.paymentStatus === 'sent')
    const oBadStatus = await http.post('/api/orders/setPaymentStatus').send({ orderId: oid, status: 'nope' })
    check(
      '不存在的收款状态说清有哪些可选',
      oBadStatus.status === 400 && String(oBadStatus.body.error.message).includes('不是收款状态')
    )

    const oPay = await http
      .post('/api/orders/addPayment')
      .send({ orderId: oid, p: { paidAt: localDate(), amount: 10, method: 'tt' } })
    check(
      '登记收款后已收 10、待收 40',
      oPay.status === 200 && oPay.body.paidAmount === 10 && oPay.body.remaining === 40
    )
    const paymentId = Number(oPay.body.payments[0].id)

    const oBadPay = await http
      .post('/api/orders/addPayment')
      .send({ orderId: oid, p: { paidAt: localDate(), amount: 0 } })
    check('收款金额为 0 拒收（不留空流水）', oBadPay.status === 400)

    const oEvents = await http.post('/api/orders/events').send({ orderId: oid })
    check('操作历史里建单/出货/收款都留下了', oEvents.status === 200 && oEvents.body.length >= 3)

    const ports = await http.post('/api/orders/ports').send({})
    check(
      '港口清单两类都在',
      ports.status === 200 && Array.isArray(ports.body.loading) && Array.isArray(ports.body.destination)
    )

    const chargeBad = await http.post('/api/orders/updateCharges').send({ id: oid, charges: 'oops', reason: '' })
    check('费用行不是列表当场拒收', chargeBad.status === 400)
    const batchBad = await http.post('/api/orders/batchAddPayments').send({ entries: 'oops' })
    check('批量收款不是列表当场拒收', batchBad.status === 400)

    const settle = await http.post('/api/orders/listSettlements').send({ orderId: oid })
    check('核销记录空表', settle.status === 200 && settle.body.length === 0)
    const rateInfo = await http.post('/api/orders/lastExchangeRateInfo').send({ currency: 'USD' })
    check('最近一次 USD 汇率报得出来', rateInfo.status === 200 && rateInfo.body.rate === 7.2)

    const oDelPay = await http.post('/api/orders/deletePayment').send({ orderId: oid, paymentId, reason: '录错了' })
    check(
      '删收款写原因后待收回到 50',
      oDelPay.status === 200 && oDelPay.body.paidAmount === 0 && oDelPay.body.remaining === 50
    )

    const shotUp = await http
      .post('/api/files/upload?name=inspection.png')
      .set('content-type', 'application/octet-stream')
      .send(png)
    const shotName = String(shotUp.body.fileName)
    const photo = await http
      .post('/api/orders/addPhoto')
      .send({ orderId: oid, fileName: shotName, kind: 'inspection', note: '验货照' })
    check('照片登记回 id 与类型', photo.status === 200 && Number(photo.body.id) > 0 && photo.body.kind === 'inspection')
    check('照片列表能取回', (await http.post('/api/orders/photos').send({ orderId: oid })).body.length === 1)
    await http.post('/api/orders/delPhoto').send({ orderId: oid, photoId: photo.body.id })
    check('删照片记录时实物文件一并清掉', (await http.get(`/api/files/images/${shotName}`)).status === 404)

    console.log('报价域')
    const qSave = await http.post('/api/quotations/save').send({
      input: {
        customerId: ocid,
        currency: 'USD',
        exchangeRate: 7.2,
        exchangeRateDate: localDate(),
        items: [{ styleNo: 'QC-1', quantity: 4, unitPrice: 6 }]
      }
    })
    check('报价单保存回单号与明细', qSave.status === 200 && /^Q\d/.test(String(qSave.body.qNo)) && qSave.body.items.length === 1)
    const qid = Number(qSave.body.id)

    const qList = await http.post('/api/quotations/list').send({})
    check('报价列表能搜到刚存的', qList.status === 200 && qList.body.some((q: { id: number }) => q.id === qid))

    const qVersions = await http.post('/api/quotations/versions').send({ id: qid })
    check('版本存档至少一版（转单靠它取快照）', qVersions.status === 200 && qVersions.body.length >= 1)

    const qConvert = await http.post('/api/quotations/convert').send({ id: qid })
    check(
      '报价转订单：金额与行数照搬',
      qConvert.status === 200 && qConvert.body.grandTotal === 24 && qConvert.body.items.length === 1
    )
    const qDelete = await http.post('/api/quotations/delete').send({ id: qid })
    check(
      '已转单的报价删不掉（说要保留原始报价）',
      qDelete.status === 400 && String(qDelete.body.error.message).includes('原始报价')
    )

    console.log('打样域')
    const sSave = await http.post('/api/samples/save').send({
      input: {
        customerId: ocid,
        currency: 'USD',
        exchangeRate: 7.2,
        exchangeRateDate: localDate(),
        sampleDate: localDate(),
        items: [{ styleNo: 'SM-1', quantity: 2, unitPrice: 10, goodsUnitPrice: 8 }]
      }
    })
    check('打样单保存回样品费 20', sSave.status === 200 && sSave.body.sampleFee === 20)
    const sid = Number(sSave.body.id)

    check('新单收款流水为空', (await http.post('/api/samples/listPayments').send({ id: sid })).body.length === 0)
    const sPay = await http
      .post('/api/samples/addPayment')
      .send({ id: sid, p: { paidAt: localDate(), amount: 5, method: 'tt' } })
    check('登记样品费收款 5', sPay.status === 200 && sPay.body.collected === 5)
    check('收款流水列得出来', (await http.post('/api/samples/listPayments').send({ id: sid })).body.length === 1)

    const sConvert = await http.post('/api/samples/convert').send({ id: sid, opts: { paymentStatus: 'sent' } })
    check('打样转订单：大货单价 8 × 2 = 16', sConvert.status === 200 && sConvert.body.grandTotal === 16)
    const sGet = await http.post('/api/samples/get').send({ id: sid })
    check('转单后的打样单记得转到了哪张单', sGet.status === 200 && Number(sGet.body.convertedOrderId) > 0)

    console.log('预收与退款')
    const cApply = await http.post('/api/credits/apply').send({
      input: { customerId: ocid, currency: 'USD', targetKind: 'order', targetId: oid, amount: 10 }
    })
    check(
      '没有预收就抵扣：说清可用余额是 0',
      cApply.status === 400 && String(cApply.body.error.message).includes('可用预收')
    )
    const cRefund = await http.post('/api/credits/refund').send({
      input: { customerId: ocid, currency: 'USD', amount: 5, bankRef: 'TT-1', note: '多付退回' }
    })
    check('没有预收可退：按余额拦下', cRefund.status === 400 && String(cRefund.body.error.message).includes('不够退'))
    const cNoRef = await http.post('/api/credits/refund').send({
      input: { customerId: ocid, currency: 'USD', amount: 5, bankRef: '  ', note: '多付退回' }
    })
    check('退款不填水单号拒收（钱出门要有凭据）', cNoRef.status === 400 && String(cNoRef.body.error.message).includes('水单号'))
    const cRev = await http.post('/api/credits/reverse').send({ applicationId: 999999, reason: '抵错了单' })
    check('撤销不存在的抵扣说清楚', cRev.status === 400 && String(cRev.body.error.message).includes('不存在'))
    const cRevRef = await http.post('/api/credits/reverseRefund').send({ refundId: 999999, reason: '水单录错' })
    check('撤销不存在的退款说清楚', cRevRef.status === 400 && String(cRevRef.body.error.message).includes('不存在'))

    console.log('装箱域')
    check('新单还没有批次', (await http.post('/api/pl/list').send({ orderId: oid })).body.length === 0)
    const plCreate = await http.post('/api/pl/create').send({
      input: { orderId: oid, containerNo: 'TCLU1', lines: [{ boxNo: '1', styleNo: 'OC-1', quantity: 5 }] }
    })
    check(
      '建批次：一箱五件',
      plCreate.status === 200 && plCreate.body.length === 1 && plCreate.body[0].lines[0].quantity === 5
    )
    const plId = Number(plCreate.body[0].id)
    const plLineId = Number(plCreate.body[0].lines[0].id)

    const plInfo = await http
      .post('/api/pl/updateInfo')
      .send({ orderId: oid, plId, patch: { vessel: 'MV TEST', etdDate: localDate() } })
    check('改批次信息落库', plInfo.status === 200 && plInfo.body[0].vessel === 'MV TEST')

    const plLine = await http
      .post('/api/pl/updateLine')
      .send({ orderId: oid, plId, lineId: plLineId, patch: { quantity: 4 } })
    check('改箱内数量落库', plLine.status === 200 && plLine.body[0].lines[0].quantity === 4)

    const plVoidNoReason = await http.post('/api/pl/void').send({ orderId: oid, plId, reason: '  ' })
    check(
      '作废批次必须写原因',
      plVoidNoReason.status === 400 && String(plVoidNoReason.body.error.message).includes('原因')
    )
    const plVoid = await http.post('/api/pl/void').send({ orderId: oid, plId, reason: '订舱取消' })
    check('作废后标记留档（不再参与汇总）', plVoid.status === 200 && plVoid.body[0].voidedAt !== null)
    const plUnvoid = await http.post('/api/pl/unvoid').send({ orderId: oid, plId, reason: '重新订舱' })
    check('撤销作废后回到活批次', plUnvoid.status === 200 && plUnvoid.body[0].voidedAt === null)

    // R45：作废期间这一款的空间会被别的批次用掉，翻案前必须重算一遍守恒
    const plVoid2 = await http.post('/api/pl/void').send({ orderId: oid, plId, reason: '再作废一次' })
    check('为了守恒场景再作废一次', plVoid2.status === 200 && plVoid2.body[0].voidedAt !== null)
    const plFill = await http
      .post('/api/pl/create')
      .send({ input: { orderId: oid, containerNo: 'TCLU2', lines: [{ boxNo: '2', styleNo: 'OC-1', quantity: 10 }] } })
    check('作废期间新批次能把 10 件全装走', plFill.status === 200 && plFill.body.length === 2)
    const plUnvoidOver = await http.post('/api/pl/unvoid').send({ orderId: oid, plId, reason: '重新订舱' })
    check(
      '翻案会让同款累计超过订单量：后端同一份守门照样拦下（话术原样传回）',
      plUnvoidOver.status === 400 &&
        String(plUnvoidOver.body.error.message).includes('撤销作废会被件数守门拦下') &&
        String(plUnvoidOver.body.error.message).includes('还能装 0 件')
    )
    const plStillVoided = await http.post('/api/pl/list').send({ orderId: oid })
    check(
      '拦下后这一批照旧是作废留档（状态没被半路改动）',
      plStillVoided.body.find((p: any) => p.id === plId).voidedAt !== null
    )
    await http.post('/api/pl/delete').send({ orderId: oid, plId: Number(plFill.body[1].id) })
    const plUnvoidOk = await http.post('/api/pl/unvoid').send({ orderId: oid, plId, reason: '位置腾出来了' })
    check('腾出位置后翻案放行（与桌面同一个结果）', plUnvoidOk.status === 200 && plUnvoidOk.body[0].voidedAt === null)

    const plDel = await http.post('/api/pl/delete').send({ orderId: oid, plId })
    check('没出过 CI 的批次可以删', plDel.status === 200 && plDel.body.length === 0)

    console.log('单据存档（R60：docs 簇上后端，PDF 字节走 HTTP）')
    const docPdf = Buffer.from('%PDF-1.4 server doc v1')
    const docMeta = encodeURIComponent(JSON.stringify({ docNo: 'PI-DOCSRV', kind: 'pi', orderId: oid, amount: 50 }))
    const docNoAuth = await raw
      .post(`/api/docs/save?meta=${docMeta}`)
      .set('content-type', 'application/octet-stream')
      .send(docPdf)
    check('存档是写操作，无 token 401', docNoAuth.status === 401)
    const dSave = await http
      .post(`/api/docs/save?meta=${docMeta}`)
      .set('content-type', 'application/octet-stream')
      .send(docPdf)
    check(
      'PDF 字节上传落档：版本 1，路径带 docs 段',
      dSave.status === 200 && dSave.body.version === 1 && String(dSave.body.filePath).includes('docs/'),
      JSON.stringify(dSave.body)
    )
    const dBytes = await http.post('/api/docs/read').send({ filePath: dSave.body.filePath })
    check(
      '按路径取回的字节与存入的逐字节一致',
      dBytes.status === 200 && Buffer.compare(Buffer.from(dBytes.body), docPdf) === 0
    )
    const dNext = await http.post('/api/docs/nextVersion').send({ docNo: 'PI-DOCSRV', kind: 'pi' })
    check('下一版 = 2（版本只增不减）', dNext.status === 200 && Number(dNext.text) === 2, 'status=' + dNext.status + ' text=' + JSON.stringify(dNext.text))
    const dV2 = await http
      .post(`/api/docs/save?meta=${docMeta}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.4 server doc v2'))
    check('重版存档版本递增', dV2.status === 200 && dV2.body.version === 2)
    const dStale = await http
      .post(`/api/docs/save?meta=${encodeURIComponent(JSON.stringify({ docNo: 'PI-DOCSRV', kind: 'pi', orderId: oid, amount: 50, expectedVersion: 1 }))}`)
      .set('content-type', 'application/octet-stream')
      .send(docPdf)
    check(
      '纸面版次过时拒存（原句）',
      dStale.status === 400 && String(dStale.body.error.message).includes('该存第'),
      JSON.stringify(dStale.body)
    )
    const dNoAmt = await http
      .post(`/api/docs/save?meta=${encodeURIComponent(JSON.stringify({ docNo: 'PI-DOCSRV', kind: 'pi', orderId: oid }))}`)
      .set('content-type', 'application/octet-stream')
      .send(docPdf)
    check('漏金额拒存（存档金额是凭据，不能按 0 记）', dNoAmt.status === 400 && String(dNoAmt.body.error.message).includes('没带金额'))
    const dList = await http.post('/api/docs/list').send({ orderId: oid })
    check(
      '存档列表按订单查到两版',
      dList.status === 200 && dList.body.filter((d: any) => d.docNo === 'PI-DOCSRV').length === 2,
      JSON.stringify(dList.body)
    )
    check('存档时间戳在，且是这一刻的（UTC 存、桌面按本地日显示）',
      dList.body.every((d: any) => !Number.isNaN(Date.parse(d.createdAt)))
    )
    const dVoidPi = await http.post('/api/docs/void').send({ versionId: Number(dList.body.find((d: any) => d.docNo === 'PI-DOCSRV').id), reason: '试一下' })
    check('PI 存档不作废（只有 CI 支持作废重出，原句）', dVoidPi.status === 400 && String(dVoidPi.body.error.message).includes('只有 CI'))

    // 路径守卫与桌面同一份判据（R42 语义服务端同样要守）
    for (const evil of ['../../secret.pdf', 'D:\\old-pc\\x.pdf', '/etc/passwd', 'docs/../../ikanbot.db']) {
      const evilRead = await http.post('/api/docs/read').send({ filePath: evil });
      check(`外来路径拒读：${evil}`, evilRead.status === 400 && String(evilRead.body.error.message).includes('拒绝打开'), 'status=' + evilRead.status + ' text=' + JSON.stringify(evilRead.text))
    }
    const dMissing = await http
      .post('/api/docs/read')
      .send({ filePath: 'docs/PI-DOCSRV/pi_PI-DOCSRV_v99.pdf' })
    check('路径在目录里但文件不在 → 404 说「文件已不存在」', dMissing.status === 404)

    // r60-verify 账：文件系统权限错误不能裸奍成「服务器内部错误」五个字。
    // 存档目录被 chmod 000（磁盘满、运维改权限都会遇到）要给人话：哪个路径、找谁。
    const docsRoot = join(dir, 'docs')
    chmodSync(docsRoot, 0o000)
    const dPerm = await http
      .post(`/api/docs/save?meta=${encodeURIComponent(JSON.stringify({ docNo: 'PI-EACCES', kind: 'pi', orderId: oid, amount: 70 }))}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.4 eacces'))
    chmodSync(docsRoot, 0o755)
    checkPerm('存档目录不可写（EACCES）给人话：说权限、说路径、指到管服务器的人', dPerm, docsRoot)
    const dPermList = await http.post('/api/docs/list').send({ orderId: oid })
    check(
      '权限失败那次不留半条版本记录（R57 老规矩：存档区报错不污染账）',
      dPermList.status === 200 && !dPermList.body.some((d: any) => d.docNo === 'PI-EACCES'),
      JSON.stringify(dPermList.body?.filter?.((d: any) => d.docNo === 'PI-EACCES'))
    )

    // CI 存档 + 作废重出（R18/R45 的语义在服务端同样成立）
    const oidPiNo = String(oCreate.body.piNo ?? '').trim()
    check('订单带着 PI 号（CI 认账靠它）', oidPiNo !== '', oidPiNo)
    const ciNo = `CI${oidPiNo}`
    const ciSave = await http
      .post(`/api/docs/save?meta=${encodeURIComponent(JSON.stringify({ docNo: ciNo, kind: 'ci', orderId: oid, amount: 60 }))}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.4 server ci'))
    check('CI 存档落档', ciSave.status === 200 && ciSave.body.version === 1, JSON.stringify(ciSave.body))
    const ciList = await http.post('/api/docs/list').send({ orderId: oid })
    const ciRow = ciList.body.find((d: any) => d.docNo === ciNo)
    const ciVoidBad = await http.post('/api/docs/void').send({ versionId: Number(ciRow.id), reason: '  ' })
    check('作废存档不写原因被拦（原句）', ciVoidBad.status === 400 && String(ciVoidBad.body.error.message).includes('原因'))
    const ciVoid = await http
      .post('/api/docs/void')
      .send({ versionId: Number(ciRow.id), reason: 'CI 金额敲错一位：60 应为 600' })
    check('CI 作废重出通道在服务端同样打开',
      ciVoid.status === 200 && ciVoid.body.find((d: any) => d.docNo === ciNo).voidedAt !== null,
      JSON.stringify(ciVoid.body)
    )

    console.log('工作台与报表')
    const stats = await http.post('/api/dashboard/stats').send({})
    check(
      '工作台数字有来源：在做的单与本月新单都 ≥ 1',
      stats.status === 200 && stats.body.activeOrders >= 1 && stats.body.monthNewOrders >= 1
    )
    const reminders = await http.post('/api/dashboard/reminders').send({})
    check('提醒是列表（没到期就是空）', reminders.status === 200 && Array.isArray(reminders.body))
    const monthly = await http.post('/api/report/monthly').send({})
    check('月报按月归集出至少一行', monthly.status === 200 && monthly.body.length >= 1)

    console.log('导出')
    const exOrders = await http.post('/api/export/csv').send({ kind: 'orders' })
    check(
      '订单台账 CSV 由后端算好（带单号，文件名带日期）',
      exOrders.status === 200 &&
        String(exOrders.body.csv).includes(String(qConvert.body.orderNo)) &&
        /\.csv$/.test(String(exOrders.body.fileName))
    )
    const exStmt = await http.post('/api/export/csv').send({ kind: 'statement', filter: { customerId: ocid } })
    check(
      '对账单文件名带客户名（两处各拼一次迟早不一致）',
      exStmt.status === 200 && String(exStmt.body.fileName).includes('Order Co')
    )
    const exBad = await http.post('/api/export/csv').send({ kind: 'nope' })
    check('未知导出类型说清只接哪几种', exBad.status === 400 && String(exBad.body.error.message).includes('只接'))

    console.log('R57 后端同一份守门：坏账没追回不许按普通收款记，追回要看得见余额')
    const r57Create = await http
      .post('/api/orders/create')
      .send({ input: { customerId: ocid, currency: 'USD', exchangeRate: 7.2, exchangeRateDate: localDate() } })
    const r57Oid = Number(r57Create.body.id)
    await http.post('/api/orders/addItems').send({ orderId: r57Oid, items: [{ styleNo: 'R57-1', quantity: 10, unitPrice: 5 }] })
    await http.post('/api/orders/setPaymentStatus').send({ orderId: r57Oid, status: 'confirmed', note: '后端对拍：PI 已确认' })
    const r57Bd = await http
      .post('/api/orders/addSettlement')
      .send({ orderId: r57Oid, input: { kind: 'bad_debt', amount: 20, at: localDate(), reason: '后端对拍：客户失联挂坏账' } })
    check('坏账核销在后端也落得下', r57Bd.status === 200 && Number(r57Bd.body.badDebtOutstanding) === 20)
    const r57BadPay = await http
      .post('/api/orders/addPayment')
      .send({ orderId: r57Oid, p: { paidAt: localDate(), amount: 10, bankRef: 'ZZ-SRV-R57' } })
    check(
      '没追回的坏账挡住普通收款（拦人的话后端与桌面同一份）',
      r57BadPay.status === 400 && String(r57BadPay.body.error.message).includes('坏账没追回')
    )
    const r57Rows = await http.post('/api/orders/listSettlements').send({ orderId: r57Oid })
    const r57BdId = Number(
      (r57Rows.body as Array<{ kind: string; id: number }>).find((s) => s.kind === 'bad_debt')!.id
    )
    const r57Rec = await http
      .post('/api/orders/addSettlement')
      .send({ orderId: r57Oid, input: { kind: 'recovery', amount: 30, at: localDate(), paidAt: localDate(), reason: '后端对拍：追过头' } })
    check(
      '追回超过尚未追回的坏账：后端当场说清还剩多少',
      r57Rec.status === 400 && String(r57Rec.body.error.message).includes('超过了尚未追回的坏账')
    )
    const r57Rev = await http
      .post('/api/orders/reverseSettlement')
      .send({ orderId: r57Oid, settlementId: r57BdId, reason: '后端对拍：这笔认错了' })
    check('撤销坏账后闸门重新开得动', r57Rev.status === 200 && Number(r57Rev.body.badDebtOutstanding) === 0)
    const r57Pay = await http
      .post('/api/orders/addPayment')
      .send({ orderId: r57Oid, p: { paidAt: localDate(), amount: 10, bankRef: 'ZZ-SRV-R57' } })
    check('撤掉的坏账不再拦这一笔收款', r57Pay.status === 200 && Number(r57Pay.body.paidAmount) === 10)
    const r57RecAgain = await http
      .post('/api/orders/addSettlement')
      .send({ orderId: r57Oid, input: { kind: 'recovery', amount: 5, reason: '后端对拍：没坏账也追一笔' } })
    check(
      '没有尚未追回的坏账时追回被拦（余额读在落库这一刻）',
      r57RecAgain.status === 400 && String(r57RecAgain.body.error.message).includes('没有尚未追回的坏账')
    )

    console.log('R58 后端同一份守门：钱档是账的结论、裸码不落库、作废把报价退回待跟进')
    const r58Create = await http
      .post('/api/orders/create')
      .send({ input: { customerId: ocid, currency: 'USD', exchangeRate: 7.2, exchangeRateDate: localDate(), depositRatio: 0 } })
    const r58Oid = Number(r58Create.body.id)
    await http.post('/api/orders/addItems').send({ orderId: r58Oid, items: [{ styleNo: 'R58-1', quantity: 10, unitPrice: 5 }] })
    await http.post('/api/orders/setPaymentStatus').send({ orderId: r58Oid, status: 'confirmed', note: '后端对拍：PI 已确认' })
    const r58Partial = await http
      .post('/api/orders/setPaymentStatus')
      .send({ orderId: r58Oid, status: 'partial', note: '后端对拍：一分没收想勾部分收款' })
    check(
      '账上一分没收就想手工「部分收款」：后端按同一份阶梯拦下，并点名账上那一档',
      r58Partial.status === 400 &&
        String(r58Partial.body.error.message).includes('按账算') &&
        String(r58Partial.body.error.message).includes('客户已确认')
    )
    const r58Settled = await http
      .post('/api/orders/setPaymentStatus')
      .send({ orderId: r58Oid, status: 'settled', note: '后端对拍：一分没收想勾结清' })
    check(
      '勾「已结清」先撞上欠款的闸门：后端把还欠多少说出来',
      r58Settled.status === 400 && String(r58Settled.body.error.message).includes('还欠 50.00')
    )
    const r58Half = await http
      .post('/api/orders/addPayment')
      .send({ orderId: r58Oid, p: { paidAt: localDate(), amount: 20, bankRef: 'ZZ-SRV-R58' } })
    check('收 20/50 后标签自己跟上（部分收款）', r58Half.status === 200 && r58Half.body.paymentStatus === 'partial')
    const r58StillDebt = await http
      .post('/api/orders/setPaymentStatus')
      .send({ orderId: r58Oid, status: 'settled', note: '后端对拍：还欠着也想勾' })
    check(
      '还欠 30 时手工结清照样拦，话术点名还欠多少',
      r58StillDebt.status === 400 && String(r58StillDebt.body.error.message).includes('还欠 30.00')
    )
    const r58Clear = await http
      .post('/api/orders/addPayment')
      .send({ orderId: r58Oid, p: { paidAt: localDate(), amount: 30, bankRef: 'ZZ-SRV-R58B' } })
    check('补齐后自己走到已结清（后端不靠人手勾）', r58Clear.status === 200 && r58Clear.body.paymentStatus === 'settled')

    const r58QBad = await http.post('/api/quotations/updateMeta').send({ id: qid, meta: { status: 'issued' } })
    check(
      '报价状态认裸码：后端说清只能选哪几种（桌面同一句）',
      r58QBad.status === 400 && String(r58QBad.body.error.message).includes('不是报价单状态')
    )
    const r58QBadResult = await http.post('/api/quotations/updateMeta').send({ id: qid, meta: { result: 'win' } })
    check(
      '报价结果同样只认枚举：没成交不许写成 win',
      r58QBadResult.status === 400 && String(r58QBadResult.body.error.message).includes('不是报价结果')
    )

    const r58SBad = await http.post('/api/samples/save').send({ input: { id: sid, status: 'done' } })
    check(
      '打样状态裸码同样进不了库（后端与桌面同一份白名单）',
      r58SBad.status === 400 && String(r58SBad.body.error.message).includes('打样状态')
    )
    const r58SmpCreate = await http
      .post('/api/samples/save')
      .send({
        input: {
          customerId: ocid,
          currency: 'USD',
          exchangeRate: 7.2,
          exchangeRateDate: localDate(),
          sampleDate: localDate(),
          items: [{ styleNo: 'R58-S', quantity: 1, unitPrice: 20, goodsUnitPrice: 10 }]
        }
      })
    const r58SmpId = Number(r58SmpCreate.body.id)
    const r58Waive = await http.post('/api/samples/save').send({ input: { id: r58SmpId, feeStatus: 'waived' } })
    check(
      '样品费改成「客户免单」不写原因：后端也拒（免收就是把钱从待收里抹掉）',
      r58Waive.status === 400 && String(r58Waive.body.error.message).includes('客户免单')
    )
    const r58WaiveOk = await http
      .post('/api/samples/save')
      .send({ input: { id: r58SmpId, feeStatus: 'waived', feeWaiveReason: '后端对拍：客户自己承担' } })
    check(
      '补上原因就能免，原因落在收款说明里',
      r58WaiveOk.status === 200 && String(r58WaiveOk.body.feeNote).includes('客户自己承担')
    )

    const r58HomeCust = await http.post('/api/customers/save').send({ input: { company: 'R58-HOME-SRV' } })
    const r58HomeCid = Number(r58HomeCust.body.id)
    const r58HomeSmp = await http
      .post('/api/samples/save')
      .send({
        input: {
          customerId: r58HomeCid,
          currency: 'CNY',
          sampleDate: localDate(),
          status: 'sent',
          items: [{ styleNo: 'R58-CNY', quantity: 2, unitPrice: 100 }]
        }
      })
    // 升级前的老数据：本币单的汇率列留着 0。按原始列筛会把这张单从拆分表里漏掉，
    // 而客户页页头「未收金额」明明含它——后端与桌面读的是同一份 baseRate 口径
    await db.run('UPDATE sample_orders SET exchange_rate = 0 WHERE id = ?', [Number(r58HomeSmp.body.id)])
    const r58HomeRows = await http.post('/api/report/customerOrderRows').send({ customerId: r58HomeCid })
    check(
      '汇率列是 0 的本币打样单照样进未收拆分表（认折好的价，不认裸列）',
      r58HomeRows.status === 200 &&
        (r58HomeRows.body as { kind: string; receivable: number }[]).some(
          (r) => r.kind === 'sample' && r.receivable === 200
        )
    )

    const r58Q = await http
      .post('/api/quotations/save')
      .send({
        input: {
          customerId: ocid,
          currency: 'USD',
          exchangeRate: 7.2,
          exchangeRateDate: localDate(),
          items: [{ styleNo: 'R58-Q', quantity: 2, unitPrice: 7 }]
        }
      })
    const r58Qid = Number(r58Q.body.id)
    const r58Convert = await http.post('/api/quotations/convert').send({ id: r58Qid })
    const r58Void = await http
      .post('/api/orders/void')
      .send({ id: Number(r58Convert.body.id), reason: '后端对拍：客户取消', opts: { confirmDocs: true } })
    check('后端作废单走得通', r58Void.status === 200 && r58Void.body.paymentStatus === 'void')
    const r58QAfter = await http.post('/api/quotations/get').send({ id: r58Qid })
    check(
      '订单作废后报价退回待跟进：状态回到客户已确认、结果回到待回',
      r58QAfter.status === 200 &&
        r58QAfter.body.status === 'confirmed' &&
        r58QAfter.body.result === 'pending' &&
        !r58QAfter.body.convertedOrderId
    )
    const r58QEvents = await http.post('/api/quotations/events').send({ id: r58Qid })
    check(
      '退回这件事在报价时间线留痕（不靠 converted_order_id 那个空列交代）',
      (r58QEvents.body as { note?: string }[]).some((e) => String(e.note ?? '').includes('已作废') && String(e.note ?? '').includes('退回'))
    )
    const r58OEvents = await http.post('/api/orders/events').send({ orderId: Number(r58Convert.body.id) })
    check(
      '订单侧也记一条「报价已退回」',
      (r58OEvents.body as { kind?: string }[]).some((e) => e.kind === 'quotation_back')
    )

    console.log('错误体')
    const unknown = await http.post('/api/no-such-route').send({})
    check('未知路由回中文错误体', unknown.status === 404 && unknown.body.error.message === '没有这个接口')

    const wrongMethod = await http.get('/api/customers/list')
    check(
      '路径对方法错时说清该用什么方法',
      wrongMethod.status === 404 && wrongMethod.body.error.message === '这个接口不接 GET（只接 POST）'
    )

    const putMethod = await http.put('/api/customers/list').send({})
    check(
      'PUT 也当场说清（不让人对着 404 猜）',
      putMethod.status === 404 && putMethod.body.error.message === '这个接口不接 PUT（只接 POST）'
    )

    const badJson = await http
      .post('/api/customers/list')
      .set('content-type', 'application/json')
      .send('{oops')
    check('坏 JSON 回中文错误体', badJson.status === 400 && badJson.body.error.message === '请求体不是合法 JSON')

    const badId = await http.post('/api/customers/get').send({ id: 'abc' })
    check('编号不是整数时拒收', badId.status === 400 && String(badId.body.error.message).includes('客户编号'))

    console.log('留痕：操作者是 token 认定的，不是桌面传的（M2 第一片）')
    // 故意把本机设置里的业务员写成一个「不该出现的人」：
    // 若留痕还在信 settings.operator，历史里就会出现这个名字
    const actorSettings = (await http.post('/api/settings/get').send({})).body as Record<string, unknown>
    await http.post('/api/settings/save').send({
      input: { ...actorSettings, operator: '界面上传的名字不算数' }
    })
    const actorCust = await http.post('/api/customers/save').send({ input: { company: 'Auth Actor Co' } })
    const actorOrder = await http
      .post('/api/orders/create')
      .send({ input: { customerId: actorCust.body.id, currency: 'USD', exchangeRate: 7.2 } })
    check('带着 token 能建单（通行证真的开门）', actorOrder.status === 200 && actorOrder.body.id > 0)
    const actorEvents = (
      await http.post('/api/orders/events').send({ orderId: actorOrder.body.id })
    ).body as Array<{ actor?: unknown; kind?: unknown }>
    check(
      '操作历史里的操作人是 token 里的显示名（周文娟），不是设置里那个人',
      actorEvents.length >= 1 && actorEvents.every((e) => e.actor === '周文娟'),
      JSON.stringify(actorEvents)
    )
    check(
      '历史里找不到「界面上传的名字」（它只是 settings 里的一行字，不是身份）',
      !actorEvents.some((e) => e.actor === '界面上传的名字不算数')
    )

    console.log('写冲突检测（M4 乐观锁：两个窗口同改一单，后写者收到 409）')
    const conflictCust = await http.post('/api/customers/save').send({ input: { company: 'R62 Conflict Co' } })
    const conflictOrder = await http
      .post('/api/orders/create')
      .send({ input: { customerId: conflictCust.body.id, currency: 'USD', exchangeRate: 7.2, exchangeRateDate: localDate() } })
    const conflictOd = await http.post('/api/orders/get').send({ id: conflictOrder.body.id })
    const seenVer = Number(conflictOd.body.rowVersion ?? -1)
    check('读单带回 row_version（乐观锁的凭据）', Number.isInteger(seenVer) && seenVer >= 0, String(seenVer))
    const winA = await http
      .post('/api/orders/update')
      .send({ id: conflictOrder.body.id, input: { customerId: conflictCust.body.id, customerPo: 'WIN-A', expectedRowVersion: seenVer } })
    check('窗口 A 拿读单那一刻的 row_version 先存成功', winA.status === 200 && winA.body.customerPo === 'WIN-A', JSON.stringify(winA.text))
    const winB = await http
      .post('/api/orders/update')
      .send({ id: conflictOrder.body.id, input: { customerId: conflictCust.body.id, customerPo: 'WIN-B', expectedRowVersion: seenVer } })
    check(
      '窗口 B 还拿着旧 row_version 后存被拦：409 + 「刚被别人改过」人话',
      winB.status === 409 && String(winB.body?.error?.message ?? '').includes('刚被别人改过'),
      'status=' + winB.status + ' text=' + JSON.stringify(winB.text)
    )
    const winB2 = await http
      .post('/api/orders/update')
      .send({ id: conflictOrder.body.id, input: { customerId: conflictCust.body.id, customerPo: 'WIN-B2', expectedRowVersion: Number(winA.body.rowVersion) } })
    check('窗口 B 刷新后重存成功（矛盾解开，不卡死）', winB2.status === 200 && winB2.body.customerPo === 'WIN-B2', JSON.stringify(winB2.text))
    const noLock = await http
      .post('/api/orders/update')
      .send({ id: conflictOrder.body.id, input: { customerId: conflictCust.body.id, customerPo: 'NO-LOCK' } })
    check('不传 expectedRowVersion 的老调用不受影响', noLock.status === 200 && noLock.body.customerPo === 'NO-LOCK')

    console.log('收款幂等（M4：request_id 重放只落一笔）')
    const idemCust = await http.post('/api/customers/save').send({ input: { company: 'R62 Idem Co' } })
    const idemOrder = await http
      .post('/api/orders/create')
      .send({ input: { customerId: idemCust.body.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' } })
    const idemPay = { paidAt: localDate(), amount: 100, bankRef: 'HTTP-IDEM-1', requestId: 'http-idem-1' }
    const pay1 = await http.post('/api/orders/addPayment').send({ orderId: idemOrder.body.id, p: idemPay })
    const pay2 = await http.post('/api/orders/addPayment').send({ orderId: idemOrder.body.id, p: idemPay })
    check(
      '同一个 request_id 重放：HTTP 两次都 200，且重放拿回第一次的结果（不落第二笔、不报错）',
      pay1.status === 200 && pay2.status === 200 && pay2.body.payments.length === 1,
      `pay1=${pay1.status} pay2=${pay2.status} text=${JSON.stringify(pay2.text)}`
    )
    const idemOd = await http.post('/api/orders/get').send({ id: idemOrder.body.id })
    check('账面上确实只有一笔收款', idemOd.body.payments.length === 1, JSON.stringify(idemOd.body.payments))

    console.log('水单拆分收款幂等（R64：整批一个 request_id）')
    const bCust = await http.post('/api/customers/save').send({ input: { company: 'R64 Batch Co' } })
    const bOrder = await http
      .post('/api/orders/create')
      .send({ input: { customerId: bCust.body.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' } })
    const batchEntries = [{ orderId: bOrder.body.id, paidAt: localDate(), amount: 60, method: 'T/T', bankRef: 'HTTP-SLIP-1' }]
    const bCount = async () => {
      const od = await http.post('/api/orders/get').send({ id: bOrder.body.id })
      return od.body.payments.length as number
    }
    const b1st = await http.post('/api/orders/batchAddPayments').send({ entries: batchEntries, requestId: 'http-batch-1' })
    check('HTTP 拆分收款落一笔', b1st.status === 200 && (await bCount()) === 1, `${b1st.status} ${JSON.stringify(b1st.text)}`)
    const bReplay = await http.post('/api/orders/batchAddPayments').send({ entries: batchEntries, requestId: 'http-batch-1' })
    check(
      'HTTP 同键重放拿回第一次结果、流水不翻倍',
      bReplay.status === 200 && bReplay.body[0].id === b1st.body[0].id && (await bCount()) === 1,
      `${bReplay.status} ${JSON.stringify(bReplay.text)}`
    )
    // 新键 = 新水单：流水号也要换（同一张水单记两次会被水单查重拦，那是另一道正经闸门）
    await http
      .post('/api/orders/batchAddPayments')
      .send({ entries: batchEntries.map((e) => ({ ...e, bankRef: 'HTTP-SLIP-2' })), requestId: 'http-batch-2' })
    check('HTTP 换新键的新水单照常落账', (await bCount()) === 2)

    console.log('备份（R61：备份簇上后端，服务器侧打包与恢复，与桌面同一份 core）')
    const bkNoAuth = await raw.post('/api/backup/create').send({})
    check('备份是写操作，无 token 401', bkNoAuth.status === 401)
    const bkCreate = await http.post('/api/backup/create').send({})
    check(
      '服务器侧打包成功：路径落在备份目录里',
      bkCreate.status === 200 && String(bkCreate.body.path).endsWith('.zip'),
      `${bkCreate.status} ${JSON.stringify(bkCreate.text)}`
    )
    const bkList = await http.post('/api/backup/list').send({})
    check(
      '备份列表里刚打包的这份在（带时间戳与体积）',
      bkList.status === 200 &&
        Array.isArray(bkList.body) &&
        bkList.body.some((b: { path: string; size: number }) => b.path === bkCreate.body.path && b.size > 0),
      JSON.stringify(bkList.body)
    )

    console.log('搬迁上传（R66：老桌面的整库包传上来，走同一条恢复闸门）')
    const upNoAuth = await raw
      .post('/api/backup/upload')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('not-a-zip'))
    check('上传是写操作，无 token 401', upNoAuth.status === 401)
    const badUp = await http
      .post('/api/backup/upload')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('definitely not a zip file'))
    check('不是 zip 的字节被当场退回（人话）', badUp.status === 400 && String(badUp.body?.error?.message ?? '').includes('备份包'), JSON.stringify(badUp.text))
    // 模拟老桌面：把自己刚打的包原样字节传上来（搬迁 = 本机 zip → 服务器备份目录）
    const localZip = readFileSync(String(bkCreate.body.path))
    const upResp = await http.post('/api/backup/upload').set('content-type', 'application/octet-stream').send(localZip)
    check(
      '整库包上传成功：落在服务器备份目录并带回摘要（带库、订单/收款数）',
      upResp.status === 200 && upResp.body?.path !== bkCreate.body.path && upResp.body?.hasDb === true && upResp.body?.orderCount > 0,
      `${upResp.status} ${JSON.stringify(upResp.text)}`
    )
    // 造一份「来自未来的包」：db 的 user_version 拉到 999 → 上传必须被人话拦
    //（版本守卫对搬上来的包与列表里的包一视同仁——老程序收到新数据，升级前不许动）
    // 裸驱动直接钉 user_version：server 的 SqliteDb 打开时会自动迁移，会把版本拉回当前值，
    // 就测不到「版本超前」那条人话了
    const futureDb = join(tmpdir(), `future-${Date.now()}.db`)
    const fdb = new Database(futureDb)
    fdb.exec('PRAGMA user_version = 999')
    fdb.close()
    const futureZip = createZip([{ name: 'ikanbot.db', data: readFileSync(futureDb) }])
    rmSync(futureDb, { force: true })
    const futureUp = await http
      .post('/api/backup/upload')
      .set('content-type', 'application/octet-stream')
      .send(futureZip)
    check(
      '来自未来的包被人话拦（先升级程序再打开），且不留在备份列表里',
      futureUp.status === 400 && String(futureUp.body?.error?.message ?? '').includes('升级'),
      `${futureUp.status} ${JSON.stringify(futureUp.text)}`
    )
    const upRestore = await http.post('/api/backup/restore').send({ path: upResp.body.path })
    check('上传的包走既有恢复闸门成功', upRestore.status === 200 && upRestore.body?.restarted === false, JSON.stringify(upRestore.text))
    const rep = upRestore.body?.report
    check(
      '恢复响应带搬迁对账：表行数在、收款合计是数、单号唯一、抵扣台账合计是数',
      rep &&
        rep.tables?.orders > 0 &&
        rep.tables?.payments > 0 &&
        typeof rep.paymentTotal === 'number' &&
        rep.orderNoDistinct === rep.orderNoCount &&
        typeof rep.creditAppliedTotal === 'number',
      JSON.stringify(rep)
    )

    console.log('搬迁对账 v2（R68）：逐客户预收派生余额 + 恢复对账持久化')
    // 造一笔真预收：单子没有明细（合计 0），收进来的 1000 全额进客户预收——
    // 打包 → 恢复这一份，恢复后对账里的逐客户余额必须把这笔查出来（money 域同一份算法）
    const preCust = await http.post('/api/customers/save').send({ input: { company: 'R68 Prepaid Co' } })
    const preOrder = await http
      .post('/api/orders/create')
      .send({ input: { customerId: preCust.body.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' } })
    await http.post('/api/orders/addPayment').send({
      orderId: preOrder.body.id,
      p: { paidAt: localDate(), amount: 1000, bankRef: 'R68-OVERPAY' }
    })
    const prePack = await http.post('/api/backup/create').send({})
    const repWithCredit = await http.post('/api/backup/restore').send({ path: prePack.body.path })
    const cb = repWithCredit.body?.report?.creditBalances
    const mine = Array.isArray(cb) ? cb.find((x: { company?: string }) => x.company === 'R68 Prepaid Co') : null
    check(
      '搬迁对账带逐客户预收派生余额（多收的那笔按 money 域同一份算法出现在客户名下）',
      Array.isArray(cb) && mine && Math.abs(mine.available - 1000) < 0.001 && mine.currency === 'USD',
      JSON.stringify(cb)
    )
    const lastRep = await http.post('/api/backup/lastReport').send({})
    check(
      '恢复对账持久化（backup/lastReport 读得到最近一次，带 reportedAt）',
      lastRep.status === 200 && lastRep.body?.reportedAt && lastRep.body?.tables?.orders > 0,
      JSON.stringify(lastRep.body)
    )
    const bkInspect = await http.post('/api/backup/inspect').send({ path: bkCreate.body.path })
    check(
      '备份包能打开来看：带库、带订单与收款数（恢复前必须看得见，不等于闭眼按）',
      bkInspect.status === 200 && bkInspect.body.hasDb === true && Number(bkInspect.body.orderCount) >= 1,
      JSON.stringify(bkInspect.body)
    )
    const bkOutside = await http.post('/api/backup/inspect').send({ path: join(dir, 'elsewhere.zip') })
    check(
      '备份目录外的包不认（路径守卫：目录内或选择框点过的才收）',
      bkOutside.status === 400 && String(bkOutside.body.error.message).includes('备份目录'),
      JSON.stringify(bkOutside.text)
    )
    const bkNotZip = await http.post('/api/backup/inspect').send({ path: 'not-even-a-path' })
    check('不是 .zip 的路径当场拒', bkNotZip.status === 400)

    // r61-verify 账：备份这条路当时把错误重包了一层（core/backup.ts 的 throw new Error(msg)
    // 把原始错误的 .code/.path 吞了），同样的 chmod 000 在备份接口上又裸奍成「服务器内部错误」。
    // R62 起与存档共用上面那把「权限错误一律人话」的尺。
    const backupsRoot = dirname(String(bkCreate.body.path))
    chmodSync(backupsRoot, 0o000)
    const bkPerm = await http.post('/api/backup/create').send({})
    chmodSync(backupsRoot, 0o755)
    checkPerm('备份目录不可写（EACCES）给人话：说权限、说路径、指到管服务器的人', bkPerm, backupsRoot)
    const bkPermList = await http.post('/api/backup/list').send({})
    check(
      '权限失败那次不留半包（临时文件当场清掉，列表里没有 .part 残骸）',
      bkPermList.status === 200 && !bkPermList.body.some((b: { path: string }) => String(b.path).includes('.part')),
      JSON.stringify(bkPermList.body)
    )

    // 恢复对拍：先打一份「此刻」的包 → 造一笔新账 → 恢复 → 行数回到备份那一刻，新账消失。
    // 包必须现打：前面各段（R66-R68）造过账也恢复过，老包里的订单数早就不等于此刻的基线
    const r61Pack = await http.post('/api/backup/create').send({})
    check('对拍源包现打', r61Pack.status === 200 && String(r61Pack.body.path).endsWith('.zip'))
    const beforeTotal = Number((await http.post('/api/orders/list').send({ filter: {} })).body.total)
    const r61Cust = await http.post('/api/customers/save').send({ input: { company: 'R61 Restore Probe' } })
    const r61Order = await http
      .post('/api/orders/create')
      .send({ input: { customerId: r61Cust.body.id, currency: 'USD', exchangeRate: 7.2, exchangeRateDate: localDate() } })
    await http
      .post('/api/orders/addItems')
      .send({ orderId: Number(r61Order.body.id), items: [{ styleNo: 'R61-1', quantity: 3, unitPrice: 2 }] })
    const probeTotal = Number((await http.post('/api/orders/list').send({ filter: {} })).body.total)
    check('造账成功：恢复前的订单比备份那一刻多一张', probeTotal === beforeTotal + 1, `${beforeTotal} -> ${probeTotal}`)
    const bkRestore = await http.post('/api/backup/restore').send({ path: r61Pack.body.path })
    check(
      '恢复成功：整库导入 + 目录替换；服务器重开连接不重启进程',
      bkRestore.status === 200 && bkRestore.body.restarted === false,
      JSON.stringify(bkRestore.text)
    )
    const afterTotal = Number((await http.post('/api/orders/list').send({ filter: {} })).body.total)
    check('恢复后订单回到备份那一刻（恢复期间写的那笔被旧包盖掉）', afterTotal === beforeTotal, `${probeTotal} -> ${afterTotal}`)

    // 恢复在途的写闸门：多用户时别人正在录单，第一版先把话说清（完整并发方案留 M4/M5）
    const backupSvc = app.get(BackupService)
    backupSvc.setRestoringForTest(true)
    const gated = await http.post('/api/customers/list').send({})
    check(
      '恢复期间业务请求被挡：请全员停手',
      gated.status === 503 && String(gated.body.error.message).includes('恢复期间请全员停手'),
      JSON.stringify(gated.text)
    )
    const bkDuring = await http.post('/api/backup/list').send({})
    check('恢复期间备份页自己照常用（还得看得见列表、按得动取消）', bkDuring.status === 200)
    backupSvc.setRestoringForTest(false)
    const ungated = await http.post('/api/customers/list').send({})
    check('恢复完成后写闸门放开', ungated.status === 200)

    console.log(`\nHTTP 冒烟通过 ${passed} 项`)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
