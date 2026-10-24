import { getDb } from '../db'

/**
 * 操作历史（order_events）的唯一写入口。
 * 单独成模块：订单、装箱、报价、单据都要留痕，留在 orders.ts 里会让
 * 服务层互相引用成环（装箱汇总要回写整单状态，就得写历史）。
 */
export function logEvent(
  orderId: number,
  kind: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string
): void {
  getDb().run(
    'INSERT INTO order_events(order_id, at, actor, kind, from_status, to_status, note) VALUES(?,?,?,?,?,?,?)',
    [orderId, new Date().toISOString(), '', kind, fromStatus, toStatus, note]
  )
}
