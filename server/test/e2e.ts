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
    check('路由数与控制器一致（8 个）', routes.length === 8)

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
