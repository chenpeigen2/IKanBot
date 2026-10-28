import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDb } from '../src/db/sqlite'
import { listCustomers } from '../src/core/customers'
import { createApp } from '../src/http/server'

/**
 * M0 冒烟：证明两件事——
 * 1) transact 的 SAVEPOINT 语义与 electron/db 一致（内层回滚不影响外层、外层回滚全丢）；
 * 2) 同一份 core 业务函数能通过 Db 接口读写，并能从 HTTP 面取回来。
 * MySQL 实现要在有实例后单独验（见 docs/backend-plan.md M0/M1 验收）。
 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ikan-m0-'))
  const file = join(dir, 'smoke.db')
  mkdirSync(`${file}.lock`) // 模拟上次被强杀留下的空锁目录
  const db = new SqliteDb(file)
  let passed = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}`)
    if (!cond) throw new Error(`断言失败：${name}`)
    passed++
  }

  try {
    check('残留的锁目录不挡启动', !existsSync(`${file}.lock`))
    await db.exec(
      `CREATE TABLE customers (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         company TEXT NOT NULL,
         country TEXT,
         active INTEGER NOT NULL DEFAULT 1
       )`
    )
    await db.exec(
      `INSERT INTO customers (company, country, active) VALUES
         ('Acme Trading', 'US', 1), ('Beta GmbH', 'DE', 0)`
    )

    console.log('M0 事务语义')
    await db.transact(async () => {
      await db.run(`INSERT INTO customers (company) VALUES ('OuterA')`)
      try {
        await db.transact(async () => {
          await db.run(`INSERT INTO customers (company) VALUES ('InnerB')`)
          throw new Error('内层故意失败')
        })
      } catch {
        /* 内层回滚，外层继续 */
      }
      await db.run(`INSERT INTO customers (company) VALUES ('OuterC')`)
    })
    const names = (await db.all(`SELECT company FROM customers ORDER BY id`)).map(
      (r) => r['company'] as string
    )
    check('内层 SAVEPOINT 回滚只丢自己那行', !names.includes('InnerB'))
    check('外层提交保住前后两行', names.includes('OuterA') && names.includes('OuterC'))

    try {
      await db.transact(async () => {
        await db.run(`INSERT INTO customers (company) VALUES ('OuterD')`)
        throw new Error('外层故意失败')
      })
    } catch {
      /* 整层回滚 */
    }
    const afterOuter = await db.all(`SELECT company FROM customers WHERE company = 'OuterD'`)
    check('外层抛错整层回滚（不留半截）', afterOuter.length === 0)

    console.log('M0 样板域')
    const active = await listCustomers(db)
    check(
      '默认只出启用客户',
      active.some((c) => c.company === 'Acme Trading') &&
        !active.some((c) => c.company === 'Beta GmbH')
    )
    const all = await listCustomers(db, { includeInactive: true })
    check('includeInactive 含停用客户', all.some((c) => c.company === 'Beta GmbH'))

    console.log('M0 HTTP 面')
    const app = createApp(db)
    const port = await new Promise<number>((resolve) => {
      app.listen(0, () => {
        const addr = app.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    const base = `http://127.0.0.1:${port}`
    const health = (await (await fetch(`${base}/healthz`)).json()) as {
      ok: boolean
      db: string
    }
    check('/healthz 报告数据库可用', health.ok === true && health.db === 'sqlite')

    const listed = (await (
      await fetch(`${base}/api/customers/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeInactive: true })
      })
    ).json()) as unknown[]
    check('样板路由与 core 同一份数据', listed.length === all.length)

    const notFound = await fetch(`${base}/api/nope`, { method: 'POST' })
    const body = (await notFound.json()) as { error?: { message?: string } }
    check('未知路由回中文错误体', notFound.status === 404 && !!body.error?.message)

    const index = (await (await fetch(`${base}/api`)).json()) as { routes: string[] }
    check(
      'GET /api 列出已实现接口',
      index.routes.includes('POST /api/customers/list') && index.routes.includes('GET /healthz')
    )

    const wrongMethod = await fetch(`${base}/api/customers/list`)
    const wrongBody = (await wrongMethod.json()) as { error?: { message?: string } }
    check('路径对、方法错时说清是什么错', wrongBody.error?.message === '这个接口不接 GET')

    const arrayBody = await fetch(`${base}/api/customers/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]'
    })
    const arrayBodyText = (await arrayBody.json()) as { error?: { message?: string } }
    check(
      '顶层不是对象时拒收（不静默当成空条件）',
      arrayBodyText.error?.message === '请求体必须是一个 JSON 对象'
    )

    await new Promise<void>((resolve) => app.close(() => resolve()))
    console.log(`\nM0 冒烟通过 ${passed} 项`)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
