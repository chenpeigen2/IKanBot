import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDb } from '../src/db/sqlite'
import { migrate } from '../src/db/migrate'
import { CustomersRepository } from '../src/customers/customers.repository'
import { LATEST_DB_VERSION } from '../../electron/db/schema'

/**
 * 数据层冒烟：证明三件事
 * 1) 残留锁自愈与事务 SAVEPOINT 语义与 electron/db 一致；
 * 2) 建库走的是桌面端同一份 MIGRATIONS（schema 只有一处真源），新库能直接到最新版；
 * 3) 客户域的 SQL 跑在异步 Db 上，查询口径与桌面端一致。
 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ikan-db-'))
  const file = join(dir, 'smoke.db')
  mkdirSync(`${file}.lock`) // 模拟上次被强杀留下的锁目录
  const db = new SqliteDb(file)

  let passed = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}`)
    if (!cond) throw new Error(`断言失败：${name}`)
    passed++
  }

  try {
    check('残留的锁目录不挡启动', !existsSync(`${file}.lock`))

    console.log('建库与事务')
    await migrate(db)
    const ver = await db.get('PRAGMA user_version')
    check(`新库一次建到 v${LATEST_DB_VERSION}`, Number(ver?.['user_version'] ?? 0) === LATEST_DB_VERSION)

    await db.transact(async () => {
      await db.run(`INSERT INTO customers(company, created_at, updated_at) VALUES('OuterA', '', '')`)
      try {
        await db.transact(async () => {
          await db.run(`INSERT INTO customers(company, created_at, updated_at) VALUES('InnerB', '', '')`)
          throw new Error('内层故意失败')
        })
      } catch {
        /* 内层回滚，外层继续 */
      }
      await db.run(`INSERT INTO customers(company, created_at, updated_at) VALUES('OuterC', '', '')`)
    })
    const names = (await db.all(`SELECT company FROM customers ORDER BY id`)).map((r) =>
      String(r['company'])
    )
    check('内层 SAVEPOINT 回滚只丢自己那行', !names.includes('InnerB'))
    check('外层提交保住前后两行', names.includes('OuterA') && names.includes('OuterC'))

    try {
      await db.transact(async () => {
        await db.run(`INSERT INTO customers(company, created_at, updated_at) VALUES('OuterD', '', '')`)
        throw new Error('外层故意失败')
      })
    } catch {
      /* 整层回滚 */
    }
    check(
      '外层抛错整层回滚（不留半截）',
      (await db.all(`SELECT id FROM customers WHERE company = 'OuterD'`)).length === 0
    )

    console.log('客户域 SQL')
    const repo = new CustomersRepository(db)
    await db.run(`UPDATE customers SET active = 0 WHERE company = 'OuterC'`)
    const active = await repo.list('', false)
    check('默认只出启用客户', active.some((c) => c.company === 'OuterA') && !active.some((c) => c.company === 'OuterC'))
    const all = await repo.list('', true)
    check('includeInactive 含停用客户', all.some((c) => c.company === 'OuterC'))
    const hit = await repo.list('outer', false)
    check('关键词命中（大小写不敏感）', hit.length === 1 && hit[0]?.company === 'OuterA')
    const id = await repo.insert({ company: 'Acme', country: 'US' }, new Date().toISOString())
    const got = await repo.get(id)
    check('插入后按 id 取回（mapCustomer 与桌面端同一份）', got?.company === 'Acme' && got?.country === 'US')
    check('同名查重忽略大小写与首尾空格', (await repo.sameName('  acme ')).length === 1)

    console.log(`\n数据层冒烟通过 ${passed} 项`)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
