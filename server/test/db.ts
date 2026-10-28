import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDb } from '../src/db/sqlite'
import { migrate } from '../src/db/migrate'
import { CustomersRepository } from '../src/customers/customers.repository'
import { loadConfig } from '../src/config/config'
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

    console.log('配置')
    const def = loadConfig({})
    check('默认端口 8787 + 本地 sqlite', def.port === 8787 && def.db.kind === 'sqlite')
    check(
      '默认库落在 .tmp 下（不碰开发库）',
      def.db.kind === 'sqlite' && def.db.file.includes('.tmp')
    )
    const mysql = loadConfig({ IKAN_DB: 'mysql', IKAN_MYSQL_HOST: 'db.local', IKAN_MYSQL_PORT: '3307' })
    check(
      'IKAN_DB=mysql 且给了 host 才走 MySQL（默认端口 3306）',
      mysql.db.kind === 'mysql' && mysql.db.port === 3307 && mysql.db.user === 'ikanbot'
    )
    const noHost = loadConfig({ IKAN_DB: 'mysql' })
    check('只说 mysql 没给 host 不瞎连，落回 sqlite', noHost.db.kind === 'sqlite')
    const badPort = (() => {
      try {
        loadConfig({ IKAN_PORT: 'abc' })
        return ''
      } catch (e) {
        return (e as Error).message
      }
    })()
    check('端口不合法当场拒（中文说清是哪个变量）', badPort.includes('IKAN_PORT'))

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

    await repo.insert({ company: '100% Cotton Ltd' }, new Date().toISOString())
    await repo.insert({ company: '100X Cotton Ltd' }, new Date().toISOString())
    const pct = await repo.list('100%', false)
    check(
      'LIKE 转义：% 按字面找，不漏成通配符',
      pct.length === 1 && pct[0]?.company === '100% Cotton Ltd'
    )
    const under = await repo.list('100_', false)
    check('LIKE 转义：_ 也不当单字符通配', under.length === 0)

    await db.run(`INSERT INTO orders(order_no, customer_id, created_at, updated_at) VALUES('SO-T1', ?, '', '')`, [id])
    const refs = await repo.refCounts(id)
    check('引用计数认订单', refs.orders === 1 && refs.quotations === 0 && refs.samples === 0)

    console.log('并发与幂等')
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.run(`INSERT INTO customers(company, created_at, updated_at) VALUES(?, '', '')`, [`Bulk${i}`])
      )
    )
    const bulk = await db.all(`SELECT id FROM customers WHERE company LIKE 'Bulk%'`)
    check('并发写入十条一条不少（异步接口下不假设串行）', bulk.length === 10)

    await migrate(db)
    const verAgain = await db.get('PRAGMA user_version')
    check('重复迁移是幂等的', Number(verAgain?.['user_version'] ?? 0) === LATEST_DB_VERSION)

    // 升级过的库被老程序打开：必须当场拦住，不能拿老 schema 去改新数据
    const future = join(dir, 'future.db')
    const fdb = new SqliteDb(future)
    try {
      await migrate(fdb)
      await fdb.exec(`PRAGMA user_version = ${LATEST_DB_VERSION + 1}`)
      let msg = ''
      try {
        await migrate(fdb)
      } catch (e) {
        msg = (e as Error).message
      }
      check('库比程序新时拒绝打开（中文说清怎么办）', msg.includes(`v${LATEST_DB_VERSION + 1}`) && msg.includes('升级'))
    } finally {
      await fdb.close()
    }

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
