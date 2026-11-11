/**
 * MySQL 方言的 SQL 组装（纯函数，R79）：从 MysqlDb 里抽出来，让「组装出来的 SQL 与参数」
 * 可以**不需要真实例**就能本地测试——方言对错等真连上才发现就太晚了（R66 立的原则：
 * MySQL 侧要么给真实现，要么报错不静默；组装逻辑同理，锁住才不会无声漂移）。
 *
 * 语义对照（与 SQLite 侧 core/sqlite-dialect.ts 同一套）：
 *   upsert overwrite → ON DUPLICATE KEY UPDATE col = VALUES(col)
 *   upsert increment → ON DUPLICATE KEY UPDATE col = col + ?（旧值 + 新值，参数各填一次）
 *   insertIgnore     → INSERT IGNORE（撞唯一索引整句放弃）
 */

export interface UpsertSpec {
  table: string
  keyCol: string
  valueCol: string
  mode: 'overwrite' | 'increment'
  key: unknown
  value: unknown
}

export function buildUpsert(spec: UpsertSpec): { sql: string; params: unknown[] } {
  const set =
    spec.mode === 'increment'
      ? `${spec.valueCol} = ${spec.valueCol} + ?`
      : `${spec.valueCol} = VALUES(${spec.valueCol})`
  const params = spec.mode === 'increment' ? [spec.key, spec.value, spec.value] : [spec.key, spec.value]
  return {
    sql: `INSERT INTO ${spec.table}(${spec.keyCol}, ${spec.valueCol}) VALUES(?, ?) ON DUPLICATE KEY UPDATE ${set}`,
    params
  }
}

export function buildInsertIgnore(table: string, cols: string[]): string {
  return `INSERT IGNORE INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`
}
