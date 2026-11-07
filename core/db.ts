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

/**
 * 单键单值的 upsert：没有就插，有就按 mode 覆盖或自增。
 *
 * 两个使用人：序号计数器（increment，并发下由数据库自己加）、
 * 设置单行（overwrite，整格换成新 JSON）。
 * SQLite 走 ON CONFLICT、MySQL 走 ON DUPLICATE KEY，同一套语义。
 */
export interface UpsertSpec {
  table: string
  keyCol: string
  valueCol: string
  key: string
  value: string | number
  /** overwrite = 冲突时换成新值；increment = 冲突时在旧值上加新值（计数器） */
  mode: 'overwrite' | 'increment'
}


export interface Db {
  /** 实现名，用于 /healthz 与日志 */
  readonly kind: 'sqlite' | 'mysql'
  get(sql: string, params?: unknown[]): Promise<Row | undefined>
  all(sql: string, params?: unknown[]): Promise<Row[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  /** 单键单值 upsert（计数器 increment / 设置行 overwrite）；SQLite 与 MySQL 同一套语义 */
  upsert(spec: UpsertSpec): Promise<RunResult>
  /** 插入，撞唯一索引时整句放弃不报错也不改行（同版不重复入档这类「有就算了」） */
  insertIgnore(table: string, cols: string[], params: unknown[]): Promise<RunResult>
  /** 业务月 SQL 片段：把 UTC 时刻列按本地时区折成年月（报表面月筛选用）；驱动各自实现 */
  bizMonthExpr(col: string): string
  /** 外层 BEGIN/COMMIT，嵌套 SAVEPOINT；抛错整体或局部回滚后原样抛出 */
  transact<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
  /**
   * 恢复备份后重接库文件（可选能力，SQLite 实现）。MySQL 没有这个能力：
   * 整库导入是另一套（mysqldump），备份簇对 MySQL 只做「不做」的人话，恢复同。
   */
  reopen?(file: string): void
}
