import { getDb } from '../db'
import { getSettings } from './settings'

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
  // 操作者不由各调用方传：十几个服务各自传，迟早传成两套（有人传空、有人传客户名）。
  // 「这笔款昨天还在，今天谁删的」要一句话答得出来，所以在这里统一盖章。
  const actor = getSettings().operator
  getDb().run(
    'INSERT INTO order_events(order_id, at, actor, kind, from_status, to_status, note) VALUES(?,?,?,?,?,?,?)',
    [orderId, new Date().toISOString(), actor, kind, fromStatus, toStatus, note]
  )
}
