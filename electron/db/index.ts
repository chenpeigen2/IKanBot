import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, statSync, rmdirSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { LATEST_DB_VERSION, MIGRATIONS } from './schema'
import type { Db, Row } from '../../core/db'

let db: Database | null = null

/** 数据根目录：开发态用项目下的 data/，打包后用 userData。可用 IKAN_DATA_DIR 覆盖。 */
export function dataDir(): string {
  const override = process.env['IKAN_DATA_DIR']
  const dir = override
    ? override
    : app.isPackaged
      ? join(app.getPath('userData'), 'data')
      : join(app.getAppPath(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function imagesDir(): string {
  const dir = join(dataDir(), 'images')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function backupsDir(): string {
  const dir = join(dataDir(), 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 单据存档目录：data/docs/，每张单据一个子目录 */
export function docsDir(): string {
  const dir = join(dataDir(), 'docs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

/** transact 的嵌套深度：只用来给 SAVEPOINT 起不重名的标签 */
let txDepth = 0

/**
 * 事务包装：里面的代码抛错就整体回滚，不会留下「主表改了、明细被删了没插回去」这种半截单。
 *
 * 支持嵌套（内层用 SAVEPOINT）：报价转订单已经包着一层事务，里面还要调建单/存报价，
 * 直接再发 BEGIN 会被 sqlite 拒绝（cannot start a transaction within a transaction）。
 * 是否「已经在事务里」以数据库自己的状态为准——旧代码里还有手写的 BEGIN，
 * 只看自己的计数器会误判，然后在真事务里再 BEGIN 一次。
 */
export function transact<T>(fn: () => T): T {
  const database = getDb()
  const top = !database.inTransaction
  const tag = `tx_${txDepth}`
  txDepth++
  try {
    database.exec(top ? 'BEGIN' : `SAVEPOINT ${tag}`)
    const result = fn()
    database.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${tag}`)
    return result
  } catch (e) {
    // COMMIT 本身也可能抛错（磁盘满等）：深度只在这里和 finally 里各走一条路，
    // 旧写法「成功路径先减、catch 再减」会在 COMMIT 抛错时双递减，SAVEPOINT 标签错乱
    if (top) {
      if (database.inTransaction) database.exec('ROLLBACK')
    } else {
      database.exec(`ROLLBACK TO SAVEPOINT ${tag}`)
      database.exec(`RELEASE SAVEPOINT ${tag}`)
    }
    throw e
  } finally {
    txDepth--
  }
}

export function openDb(): Database {
  if (db) return db
  const file = join(dataDir(), 'ikanbot.db')
  clearStaleLock(file)
  db = new Database(file)
  db.exec('PRAGMA foreign_keys = ON;')
  // 单实例锁挡住了第二个 IKanBot，但挡不住网盘同步/DB 工具偶尔握住文件：
  // 没有 busy_timeout 时任何写会直接抛裸英文 database is locked，用户只看到一串报错
  db.exec('PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

/**
 * 清理残留的文件锁。
 *
 * node-sqlite3-wasm 用「建一个 <db>.lock 目录」当排他锁：正常 close() 会删，
 * 但进程被强杀（超时 / taskkill / 崩溃）时不会删——下次启动就抛
 * `SQLite3Error: database is locked`，程序直接打不开。
 * 所以打开前先自愈。
 *
 * 只敢删空目录：锁目录里万一有内容，说明可能是别的进程（比如没退干净的另一份程序）
 * 正拿着它，递归删掉等于把它的锁抽走——两边同时写同一个库才是真灾难。
 * 所以非空时改名挪开、留个案底，让本次启动照常进行，也让人看得见发生过什么。
 */
function clearStaleLock(file: string): void {
  try {
    const lockPath = `${file}.lock`
    if (!existsSync(lockPath)) return
    if (!statSync(lockPath).isDirectory()) return
    try {
      rmdirSync(lockPath)
      return
    } catch {
      /* 非空（ENOTEMPTY）或正被别人持有：往下改名挪走 */
    }
    const moved = `${lockPath}.stale-${Date.now()}`
    renameSync(lockPath, moved)
    console.warn(`[db] 锁目录不为空，已挪到 ${moved}（可能是上一次异常退出留下的）`)
  } catch {
    // 删不掉就算了，下次还会再试
  }
}

function migrate(database: Database): void {
  const row = database.get('PRAGMA user_version') as { user_version?: number } | null
  const current = Number(row?.user_version ?? 0)
  if (current > LATEST_DB_VERSION) {
    throw new Error(
      `这份数据的新版结构是 v${current}，当前程序只认到 v${LATEST_DB_VERSION}。` +
        `多半是恢复了升级版程序做出来的备份。` +
        `请先升级程序再打开，直接在老版本里改会把新数据改坏。`
    )
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    database.exec('BEGIN')
    try {
      database.exec(m.sql)
      database.exec(`PRAGMA user_version = ${m.version}`)
      database.exec('COMMIT')
    } catch (e) {
      database.exec('ROLLBACK')
      throw new Error(`迁移失败 (v${m.version} ${m.name}): ${(e as Error).message}`)
    }
  }
}

/** 序列号生成：PI20260320001 */
/**
 * 每个号段占哪张表。单号是凭据（客户拿单号对账），
 * 恢复备份 / 手工导库之后计数器可能落后于库里已有的号，
 * 生成时必须查重跳号，绝不能撞号。
 */
const NO_RESERVATION: Record<string, { table: string; col: string }> = {
  SO: { table: 'orders', col: 'order_no' },
  PI: { table: 'orders', col: 'pi_no' },
  PL: { table: 'packing_lists', col: 'pl_no' },
  Q: { table: 'quotations', col: 'q_no' },
  SMP: { table: 'sample_orders', col: 'sample_no' },
  SM: { table: 'sample_orders', col: 'sample_no' }
}

export function nextNo(kind: 'PI' | 'PL' | 'SO' | 'Q' | 'SM' | 'SMP', date = new Date()): string {
  const database = getDb()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const prefix = `${kind}${y}${m}${d}`
  const row = database.get('SELECT value FROM counters WHERE name = ?', [prefix]) as
    | { value: number }
    | null
  let next = (row?.value ?? 0) + 1
  let no = `${prefix}${String(next).padStart(3, '0')}`
  const resv = NO_RESERVATION[kind]
  if (resv) {
    // 跳号：库里已经被占的号（含手工插的）不能再生一次
    for (let i = 0; i < 100000; i++) {
      const hit = database.get(`SELECT 1 FROM ${resv.table} WHERE ${resv.col} = ?`, [no])
      if (!hit) break
      next += 1
      no = `${prefix}${String(next).padStart(3, '0')}`
    }
  }
  database.run(
    'INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    [prefix, next]
  )
  return no
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * 给 core/ 用的异步门面：同一个连接、同一套事务语义，只是把同步驱动包成「立刻兑现的 Promise」。
 *
 * 为什么不直接 new 一个 SqliteDb：同一份文件开两个连接，写操作会互相抢锁
 * （node-sqlite3-wasm 还是「建锁目录」那种排他锁），是 database is locked 的经典来源。
 * 也不另抄一份 SQL——core/customers.ts 等实现只认 Db 接口，本机与后端跑的是同一段代码。
 */
export const coreDb: Db = {
  kind: 'sqlite',
  async get(sql, params = []) {
    return (getDb().get(sql, params as never) ?? undefined) as Row | undefined
  },
  async all(sql, params = []) {
    return getDb().all(sql, params as never) as Row[]
  },
  async run(sql, params = []) {
    const r = getDb().run(sql, params as never) as { lastInsertRowid?: number; changes?: number }
    return { lastInsertRowid: Number(r?.lastInsertRowid ?? 0), changes: Number(r?.changes ?? 0) }
  },
  async exec(sql) {
    getDb().exec(sql)
  },
  // 与上面的 transact 共用 txDepth：两条路混用时 SAVEPOINT 标签也不能撞
  async transact<T>(fn: () => Promise<T>): Promise<T> {
    const database = getDb()
    const top = !database.inTransaction
    const tag = `tx_${txDepth}`
    txDepth++
    try {
      database.exec(top ? 'BEGIN' : `SAVEPOINT ${tag}`)
      const result = await fn()
      database.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${tag}`)
      return result
    } catch (e) {
      if (top) {
        if (database.inTransaction) database.exec('ROLLBACK')
      } else {
        database.exec(`ROLLBACK TO SAVEPOINT ${tag}`)
        database.exec(`RELEASE SAVEPOINT ${tag}`)
      }
      throw e
    } finally {
      txDepth--
    }
  },
  async close() {
    closeDb()
  }
}
