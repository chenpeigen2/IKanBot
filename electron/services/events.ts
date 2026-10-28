import { coreDb } from '../db'
import { logEvent as logEventCore } from '../../core/events'

/**
 * 操作历史（order_events）的唯一写入口。
 * 实现在 core/events.ts（后端也用这一份），这里只把本机连接接进去。
 */
export function logEvent(
  orderId: number,
  kind: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string
): Promise<void> {
  return logEventCore(coreDb, orderId, kind, fromStatus, toStatus, note)
}
