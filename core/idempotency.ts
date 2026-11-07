import type { Db } from './db'

/**
 * 收款/退款幂等（M4）。
 *
 * 场景：双击「登记收款」、远端请求超时后重试——同一笔钱不能落两笔。
 * 入口收一个可空的 request_id：落账前先查 request_dedup 表，
 * 同 id 重放直接返回第一次落账时的结果快照；没查到才落账，落完把结果快照记进去。
 *
 * 复查与落库在同一个事务里（调用方负责）：两个窗口拿同一个 id 同时点，
 * 后进事务的那个会在复查时命中第一次的结果，不会再走收款正门。
 * 未来换 MySQL 时语义不变：复查-落库同事务，唯一索引（PRIMARY KEY）兑底，
 * 真撞上时第二笔整体回滚，也绝不会落两笔钱。
 */
export async function findReplay<T>(db: Db, requestId: string | null | undefined): Promise<T | null> {
  const id = String(requestId ?? '').trim()
  if (!id) return null
  const hit = (await db.get('SELECT result FROM request_dedup WHERE request_id = ?', [id])) as
    | { result?: unknown }
    | null
  if (!hit) return null
  try {
    return JSON.parse(String(hit.result)) as T
  } catch {
    // 快照读不出来不能把重放变成第二笔落账：宁可大声失败（正常不会发生，行是我们自己写的）
    throw new Error(`这笔操作的幂等记录损坏了，请带 request_id「${id}」找开发排查。`)
  }
}

/** 落账成功后记结果快照（request_id 为空不记，老调用方不参与幂等） */
export async function recordResult(
  db: Db,
  requestId: string | null | undefined,
  kind: string,
  result: unknown
): Promise<void> {
  const id = String(requestId ?? '').trim()
  if (!id) return
  await db.run('INSERT INTO request_dedup(request_id, kind, result, created_at) VALUES(?,?,?,?)', [
    id,
    kind,
    JSON.stringify(result),
    new Date().toISOString()
  ])
}
