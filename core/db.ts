/**
 * 桌面端与后端服务共用的数据访问接口。
 *
 * 必须是异步的——后端可能连 MySQL，没有可用的同步驱动；
 * 本机的 node-sqlite3-wasm 是同步的，由 electron/db 包成「立刻兑现的 Promise」。
 * 业务代码只认这个接口，不认具体驱动，所以一份实现两边跑。
 */
export type Row = Record<string, unknown>

export interface RunResult {
  lastInsertRowid: number
  changes: number
}

export interface Db {
  /** 实现名，用于 /healthz 与日志 */
  readonly kind: 'sqlite' | 'mysql'
  get(sql: string, params?: unknown[]): Promise<Row | undefined>
  all(sql: string, params?: unknown[]): Promise<Row[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  /** 外层 BEGIN/COMMIT，嵌套 SAVEPOINT；抛错整体或局部回滚后原样抛出 */
  transact<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}
