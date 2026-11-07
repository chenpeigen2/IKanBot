/**
 * SQLite 方言拼装件：electron/db 与 server/src/db 两个 SQLite 实现共用的原语 SQL。
 *
 * 这个文件是「驱动层的一部分」，只是因为两边都要用才放在 core/ 旁边；
 * core 的业务代码不准 import 它（方言照妖镜会扫除它以外的整个 core/）。
 * MySQL 的对应实现在 server/src/db/mysql.ts，那边自己的方言自己写。
 * 方言只写一遍，不会两处各写各的再漂移。
 */
import type { UpsertSpec } from './db'
export function sqliteUpsertSql(spec: UpsertSpec): { sql: string; params: unknown[] } {
  const set = spec.mode === 'increment' ? `${spec.valueCol} = ${spec.valueCol} + ?` : `${spec.valueCol} = excluded.${spec.valueCol}`
  return {
    sql: `INSERT INTO ${spec.table}(${spec.keyCol}, ${spec.valueCol}) VALUES(?, ?) ON CONFLICT(${spec.keyCol}) DO UPDATE SET ${set}`,
    params: spec.mode === 'increment' ? [spec.key, spec.value, spec.value] : [spec.key, spec.value]
  }
}

export function sqliteInsertIgnoreSql(table: string, cols: string[]): string {
  return `INSERT OR IGNORE INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`
}

/** 业务月：UTC 时刻串按本机时区换算成年月 'YYYY-MM'（月报/筛选按本地月份切） */
export function sqliteBizMonthExpr(col: string): string {
  return `strftime('%Y-%m', ${col}, 'localtime')`
}
