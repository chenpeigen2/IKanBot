import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Db, Row, RunResult } from './types'

/** 本地模式与测试用：同步驱动包成 Promise，事务语义与 electron/db 的 transact 一致 */
export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const
  private db: Database
  private depth = 0
  private seq = 0

  constructor(file: string) {
    const path = resolve(file)
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    clearStaleLock(path)
    this.db = new Database(path)
    this.db.exec('PRAGMA foreign_keys = ON;')
    // 备份/恢复/桌面端偶尔会同时握着同一个文件，没有 busy_timeout 就是裸的 database is locked
    this.db.exec('PRAGMA busy_timeout = 5000;')
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return (this.db.get(sql, params as never) ?? undefined) as Row | undefined
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.db.all(sql, params as never) as Row[]
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = this.db.run(sql, params as never) as { lastInsertRowid?: number; changes?: number }
    return { lastInsertRowid: Number(r?.lastInsertRowid ?? 0), changes: Number(r?.changes ?? 0) }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  /**
   * 事务：最外层 BEGIN、嵌套 SAVEPOINT，语义与 electron/db 完全一致。
   *
   * 存档点标签只增不复用（RELEASE 会连带删掉它之后开的所有存档点，同名两条链会互相抹掉回滚点）；
   * 「连接在事务里、本地一层都没开」直接报错——那说明这层事务是别处开的（手写 BEGIN 或上次提交
   * 失败留下的残事务），把这段并进去会让两边回滚互相牵连。
   */
  async transact<T>(fn: () => Promise<T>): Promise<T> {
    // 以数据库自己的状态为准：调用方可能手写了 BEGIN
    const top = !this.db.inTransaction
    if (!top && this.depth === 0) {
      throw new Error(
        '事务插队：这个连接已经在事务里，但本地没有任何在途事务，这段写入不能并进别人的事务。' +
          '多半是别处手写了 BEGIN，或上一次提交失败后残事务没清——请先找到那一层，别把两段账并成一笔。'
      )
    }
    const tag = `tx_${this.seq++}`
    this.db.exec(top ? 'BEGIN' : `SAVEPOINT ${tag}`)
    this.depth++
    try {
      const result = await fn()
      this.db.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${tag}`)
      return result
    } catch (e) {
      if (top) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK')
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${tag}`)
        this.db.exec(`RELEASE SAVEPOINT ${tag}`)
      }
      throw e
    } finally {
      this.depth--
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

/**
 * node-sqlite3-wasm 用「建一个 <db>.lock 目录」当排他锁，正常 close() 会删。
 * 进程被强杀（Ctrl+C 没来得及关、taskkill、崩溃）时锁目录留在原地，
 * 下次启动直接抛 database is locked——本地跑服务最常见的一次性故障。
 * 只删空目录：非空说明可能真有别的进程握着，改名挪开留个案底，不硬抢。
 */
function clearStaleLock(file: string): void {
  try {
    const lockPath = `${file}.lock`
    if (!existsSync(lockPath) || !statSync(lockPath).isDirectory()) return
    try {
      rmdirSync(lockPath)
      return
    } catch {
      /* 非空：往下改名 */
    }
    renameSync(lockPath, `${lockPath}.stale-${Date.now()}`)
    console.warn(`[db] 锁目录不为空，已挪开（${lockPath}）：可能是上次异常退出留下的`)
  } catch {
    /* 删不掉就交给驱动报错 */
  }
}
