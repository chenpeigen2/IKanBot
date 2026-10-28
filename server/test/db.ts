import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDb } from '../src/db/sqlite'
import { migrate } from '../src/db/migrate'
import { customersCore } from '../../core/customers'
import { productsCore } from '../../core/products'
import { settingsCore } from '../../core/settings'
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
    const core = customersCore(db)
    await db.run(`UPDATE customers SET active = 0 WHERE company = 'OuterC'`)
    const active = await core.list('', false)
    check('默认只出启用客户', active.some((c) => c.company === 'OuterA') && !active.some((c) => c.company === 'OuterC'))
    const all = await core.list('', true)
    check('includeInactive 含停用客户', all.some((c) => c.company === 'OuterC'))
    const hit = await core.list('outer', false)
    check('关键词命中（大小写不敏感）', hit.length === 1 && hit[0]?.company === 'OuterA')
    const id = (await core.save({ company: 'Acme', country: 'US' })).id
    const got = await core.get(id)
    check('插入后按 id 取回（mapCustomer 与桌面端同一份）', got?.company === 'Acme' && got?.country === 'US')
    check('同名查重忽略大小写与首尾空格', (await core.sameName('  acme ')).length === 1)

    await core.save({ company: '100% Cotton Ltd' })
    await core.save({ company: '100X Cotton Ltd' })
    const pct = await core.list('100%', false)
    check(
      'LIKE 转义：% 按字面找，不漏成通配符',
      pct.length === 1 && pct[0]?.company === '100% Cotton Ltd'
    )
    const under = await core.list('100_', false)
    check('LIKE 转义：_ 也不当单字符通配', under.length === 0)

    await db.run(`INSERT INTO orders(order_no, customer_id, created_at, updated_at) VALUES('SO-T1', ?, '', '')`, [id])
    let blocked = ''
    try {
      await core.remove(id)
    } catch (e) {
      blocked = (e as Error).message
    }
    check('挂着订单的客户删不掉，并说清有几张单', blocked.includes('1 个订单') && blocked.includes('停用'))

    console.log('商品域 SQL')
    const pc = productsCore(db)
    const prod = await pc.save({
      styleNo: 'T-100',
      name: '纯棉T恤',
      composition: '100% Cotton',
      sizes: ['M', 'L'],
      colors: ['Black']
    })
    check('商品入库并归一款号与尺码', prod.styleNo === 'T-100' && prod.sizes.join(',') === 'M,L')
    let dupStyle = ''
    try {
      await pc.save({ styleNo: ' t-100 ', name: '撞号', composition: '', sizes: [], colors: [] })
    } catch (e) {
      dupStyle = (e as Error).message
    }
    check('款号大小写撞号被拦（原句带后果说明）', dupStyle.includes('已经存在') && dupStyle.includes('复制'))

    const firstImg = await pc.addImage(prod.id, 'a.jpg')
    await pc.addImage(prod.id, 'b.jpg')
    check('第一张图自动上位成主图', firstImg.isPrimary === 1)
    const imgs = await pc.listImages(prod.id)
    check('有图就恰好一张主图', imgs.filter((i) => i.isPrimary === 1).length === 1)
    const filesAfterDelete = (await pc.removeImage(firstImg.id)).files
    check('删主图把文件名交回给调用方清文件', filesAfterDelete.length === 1 && filesAfterDelete[0] === 'a.jpg')
    const afterDelete = await pc.listImages(prod.id)
    check('删掉主图立刻顺延一张，不留有图无主图', afterDelete.length === 1 && afterDelete[0]?.isPrimary === 1)

    await db.run(`INSERT INTO orders(order_no, customer_id, created_at, updated_at) VALUES('SO-P1', ?, '', '')`, [
      id
    ])
    const orderId = Number((await db.get(`SELECT id FROM orders WHERE order_no = 'SO-P1'`))?.['id'])
    await db.run(`INSERT INTO order_items(order_id, product_id, style_no) VALUES(?, ?, 'T-100')`, [
      orderId,
      prod.id
    ])
    const ref = await pc.referenceCount(prod.id)
    check('引用计数数得出订单行', ref.orders === 1 && ref.quotations === 0)
    const delUsed = await pc.remove(prod.id)
    check(
      '有引用的商品只做停用（不删图）',
      delUsed.deactivated && delUsed.files.length === 0 && (await pc.get(prod.id))?.active === 0
    )

    const spare = await pc.save({ styleNo: 'T-200', name: '没引用', composition: '', sizes: [], colors: [] })
    await pc.addImage(spare.id, 'c.jpg')
    const delFree = await pc.remove(spare.id)
    check(
      '没引用的商品连图片一起清，文件名单交回',
      !delFree.deactivated && delFree.files.length === 1 && delFree.files[0] === 'c.jpg'
    )
    check('商品真的没了，图片登记也跟着清', (await pc.get(spare.id)) === null && (await pc.listImages(spare.id)).length === 0)

    await pc.importCsv('款号,品名,尺码\nT-300,导入款,M L\n', 'skip')
    const imp = await pc.importCsv('款号,品名\nT-300,改名\n', 'overwrite')
    const t300 = await pc.findByStyleNo('T-300')
    check(
      'CSV 覆盖导入：表头里没有的列保留（尺码没被抹平）',
      imp.updated === 1 && t300?.name === '改名' && t300?.sizes.join(',') === 'M,L'
    )

    console.log('设置域 SQL')
    const sc = settingsCore(db)
    const sDef = await sc.get()
    check('空库读设置给完整默认值（界面不会出现空白表单）', sDef.piValidDays === 15 && sDef.baseCurrency === 'CNY')

    const sOne = await sc.save({ ...sDef, company: { ...sDef.company, name: '  测试工厂  ' }, piValidDays: 30 })
    check('保存去掉首尾空格', sOne.company.name === '测试工厂' && sOne.piValidDays === 30)
    check('再读就是刚存的那份', (await sc.get()).piValidDays === 30)

    const sLocked = await sc.baseCurrencyLocked()
    check('库里有订单（上面插过一张）基准币就锁死', sLocked === true)
    let lockMsg = ''
    try {
      await sc.save({ ...sOne, baseCurrency: 'EUR' })
    } catch (e) {
      lockMsg = (e as Error).message
    }
    check('锁死后换基准币被拦，并说清后果', lockMsg.includes('基准币不能换') && lockMsg.includes('重算'))

    // 备份服务只盖自己那两个戳：设置页传什么都不认
    await sc.patchBackup({ lastBackupAt: '2026-10-01T08:00:00.000Z', lastBackupError: null })
    const sAfter = await sc.save({ ...sOne, lastBackupAt: '瞎填的', lastBackupError: '瞎填的' })
    check(
      '设置页保存不会抹掉备份凭据',
      sAfter.lastBackupAt === '2026-10-01T08:00:00.000Z' && sAfter.lastBackupError === null
    )

    // 库里的 JSON 被改坏：按字段退默认，不把默认值一起冲掉
    await db.run(`UPDATE settings SET value = ? WHERE key = 'app_settings'`, [
      JSON.stringify({ company: { name: 123 }, piValidDays: null, baseCurrency: 'BTC', banks: [{ currency: 'BTC' }] })
    ])
    const sBroken = await sc.get()
    check(
      '坏 JSON 退回默认值而不是留空',
      sBroken.piValidDays === 15 && sBroken.baseCurrency === 'CNY' && sBroken.banks.length === 0
    )

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
