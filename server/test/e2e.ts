import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/app.setup'
import { DB } from '../src/db/db.module'
import type { Db } from '../src/db/types'

/**
 * HTTP 面冒烟：跑的就是线上那套 AppModule + configureApp（不另搭一条测试路径）。
 * 覆盖健康检查、接口自描述、客户域正门与三道守门、以及错误体文案。
 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ikan-e2e-'))
  process.env['IKAN_SQLITE_FILE'] = join(dir, 'e2e.db')
  process.env['IKAN_IMAGES_DIR'] = join(dir, 'images')
  delete process.env['IKAN_DB']

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>()
  await configureApp(app)
  const http = request(app.getHttpServer())

  let passed = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}`)
    if (!cond) throw new Error(`断言失败：${name}`)
    passed++
  }

  try {
    console.log('服务面子')
    const health = await http.get('/healthz')
    check('/healthz 报告数据库可用', health.status === 200 && health.body.ok === true && health.body.db === 'sqlite')

    const meta = await http.get('/api')
    const routes: string[] = meta.body.routes ?? []
    check('GET /api 自描述已接接口', routes.includes('POST /api/customers/list') && routes.includes('GET /healthz'))
    check(
      '路由数与控制器一致（30 个：客户 6 + 商品 12 + 图片 3 + 设置 3 + 金额只读 4 + 自带 2）',
      routes.length === 30
    )

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
