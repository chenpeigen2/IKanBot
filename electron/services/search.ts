/**
 * 搜索框 → SQL LIKE 的唯一口径。
 *
 * 两件事必须集中做：
 *   1. 转义 LIKE 的通配符。用户搜 "100%"、"A_B" 时不转义会把 % _ 当通配符，
 *      搜出八竿子打不着的单，还会让人以为数据乱了。
 *   2. 每列都带 ESCAPE '\'，转义符和 SQLite 的默认行为对齐。
 *
 * SQLite 的 LIKE 对 ASCII 本来就不区分大小写，所以不用 UPPER。
 */

/** 关键词 → "%转义后的关键词%" */
export function likeContains(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`
}

/** 多列「任一命中」的 OR 片段 + 对应的绑定参数 */
export function likeAny(
  columns: string[],
  keyword: string
): { sql: string; params: string[] } {
  const pattern = likeContains(keyword)
  return {
    sql: columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR '),
    params: columns.map(() => pattern)
  }
}
