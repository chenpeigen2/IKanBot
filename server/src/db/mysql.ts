import { AsyncLocalStorage } from 'node:async_hooks'
import mysql from 'mysql2/promise'
import type { Db, Row, RunResult } from './types'

export interface MysqlConfig {
  host: string
  port?: number
  user: string
  password: string
  database: string
}

/**
 * 后端服务用。事务必须钉在同一条连接上：连接池下 SAVEPOINT 与后续写漂到别的连接
 * 会变成「主表回滚了、明细却提交了」。用 AsyncLocalStorage 把当前事务连接带进嵌套调用。
 */
const txConn = new AsyncLocalStorage<mysql.PoolConnection>()
/** 每条连接自己的 SAVEPOINT 深度（并发事务各算各的） */
const depths = new WeakMap<object, number>()

export class MysqlDb implements Db {
  readonly kind = 'mysql' as const
  private pool: mysql.Pool

  constructor(cfg: MysqlConfig) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port ?? 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: 10,
      charset: 'utf8mb4',
      timezone: 'Z',
      // 业务日 DATE 与时刻 DATETIME 都要按原样字符串读，不做本地时区换算
      dateStrings: true
    })
  }

  private conn(): mysql.Pool | mysql.PoolConnection {
    return txConn.getStore() ?? this.pool
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    const [rows] = await this.conn().query(sql, params)
    return (rows as Row[])[0]
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    const [rows] = await this.conn().query(sql, params)
    return rows as Row[]
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const [res] = await this.conn().query(sql, params)
    const r = res as mysql.ResultSetHeader
    return { lastInsertRowid: Number(r.insertId ?? 0), changes: Number(r.affectedRows ?? 0) }
  }

  async exec(sql: string): Promise<void> {
    await this.conn().query(sql)
  }

  async transact<T>(fn: () => Promise<T>): Promise<T> {
    const outer = txConn.getStore()
    if (outer) {
      const d = depths.get(outer) ?? 0
      const tag = `sp_${d}`
      depths.set(outer, d + 1)
      try {
        await outer.query(`SAVEPOINT ${tag}`)
        const r = await fn()
        await outer.query(`RELEASE SAVEPOINT ${tag}`)
        return r
      } catch (e) {
        await outer.query(`ROLLBACK TO SAVEPOINT ${tag}`)
        await outer.query(`RELEASE SAVEPOINT ${tag}`)
        throw e
      } finally {
        depths.set(outer, d)
      }
    }

    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      depths.set(conn, 0)
      const r = await txConn.run(conn, fn)
      await conn.commit()
      return r
    } catch (e) {
      try {
        await conn.rollback()
      } catch {
        /* 连接已坏时回滚也会失败，保留原始错误 */
      }
      throw e
    } finally {
      depths.delete(conn)
      conn.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
