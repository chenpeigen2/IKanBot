import { Database } from 'node-sqlite3-wasm'
import type { Db, Row, RunResult } from './types'

/** 本地模式与测试用：同步驱动包成 Promise，事务语义与 electron/db 的 transact 一致 */
export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const
  private db: Database
  private depth = 0

  constructor(file: string) {
    this.db = new Database(file)
    this.db.exec('PRAGMA foreign_keys = ON;')
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

  async transact<T>(fn: () => Promise<T>): Promise<T> {
    // 以数据库自己的状态为准：调用方可能手写了 BEGIN
    const top = !this.db.inTransaction
    const tag = `tx_${this.depth}`
    this.depth++
    try {
      this.db.exec(top ? 'BEGIN' : `SAVEPOINT ${tag}`)
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
