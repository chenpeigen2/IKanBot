import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, statSync, rmdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { MIGRATIONS } from './schema'

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

export function openDb(): Database {
  if (db) return db
  const file = join(dataDir(), 'ikanbot.db')
  clearStaleLock(file)
  db = new Database(file)
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

/**
 * 清理残留的文件锁。
 *
 * node-sqlite3-wasm 用「建一个 <db>.lock 目录」当排他锁：正常 close() 会删，
 * 但进程被强杀（超时 / taskkill / 崩溃）时不会删——下次启动就抛
 * `SQLite3Error: database is locked`，程序直接打不开。
 * 所以打开前先自愈：锁目录存在且确实是目录就删掉。
 * 只删空目录，避免误删别人正持有的锁。
 */
function clearStaleLock(file: string): void {
  try {
    const lockPath = `${file}.lock`
    if (!existsSync(lockPath)) return
    if (!statSync(lockPath).isDirectory()) return
    rmdirSync(lockPath, { recursive: true })
  } catch {
    // 删不掉就算了，下次还会再试
  }
}

function migrate(database: Database): void {
  const row = database.get('PRAGMA user_version') as { user_version?: number } | null
  const current = Number(row?.user_version ?? 0)
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
