import type { Db } from './db'
import { actorOf } from './actor'

/**
 * 操作历史（order_events）的唯一写入口。桌面（本机 SQLite）与后端服务共用这一份。
 *
 * 操作者不由各调用方传：十几个服务各自传，迟早传成两套（有人传空、有人传客户名）。
 * 「这笔款昨天还在，今天谁删的」要一句话答得出来，所以在这里统一盖章。
 */
export async function logEvent(
  db: Db,
  orderId: number,
  kind: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string
): Promise<void> {
  // 操作者先认 token 认定的身份（远端模式服务端盖章），本地模式回落设置里那位业务员
  const actor = await actorOf(db)
  await db.run(
    'INSERT INTO order_events(order_id, at, actor, kind, from_status, to_status, note) VALUES(?,?,?,?,?,?,?)',
    [orderId, new Date().toISOString(), actor, kind, fromStatus, toStatus, note]
  )
}
