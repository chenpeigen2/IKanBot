/**
 * 数据访问接口：桌面本地模式（SQLite）与后端服务（MySQL）共用这一份形状。
 * 必须是异步的——MySQL 没有可用的同步驱动；本地 SQLite 用同步 API 包成 Promise 即可。
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
