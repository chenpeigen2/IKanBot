import { getDb } from '../db'
import type { ShipStatus, ShipSummary } from '../../src/shared/types'

/**
 * 出货状态真源：批次（装箱单）+ 件数。
 *
 * 订单上的 ship_status 只是缓存：
 *  - 没有任何批次 → 不推导，订单继续手工状态；
 *  - 只要还有迁移前的老批次（ship_status 为 NULL）→ 也不推导。老批次不知道走到哪一步了，
 *    把它当「已包装」会凭空把一张已签收的老单拉回备货，只能等它补上状态再接管；
 *  - 全部批次都有状态 → 订单状态由批次和件数算出来，回写缓存供列表/看板复用。
 *
 * 算状态的规则（业务定义，别在别处另写一套）：
 *  1. 所有批次都签收 → 已签收（允许短装后客户接受并结案）；
 *  2. 有货已经走了，但还有批次没走，或箱数没装够 → 部分出运；
 *  3. 一箱没走、也没装够 → 备货中；
 *  4. 全部装完 → 取最落后那一批的进度（有一批还在包装就不能说整单已出运）。
 */
const RANK: Record<ShipStatus, number> = {
  not_prepared: 0,
  preparing: 1,
  packed: 2,
  shipped: 3,
  cleared: 4,
  delivered: 5,
  // 派生状态，不会出现在批次上；给个值只为满足类型
  partial_shipped: 3
}

const SHIPPED = 3

interface Batch {
  id: number
  plNo: string
  status: ShipStatus | null
  quantity: number
}

function loadBatches(orderId: number): Batch[] {
  const rows = getDb().all(
    `SELECT pl.id, pl.pl_no, pl.ship_status, COALESCE(SUM(l.quantity), 0) AS qty
     FROM packing_lists pl
     LEFT JOIN packing_list_lines l ON l.packing_list_id = pl.id
     WHERE pl.order_id = ?
     GROUP BY pl.id
     ORDER BY pl.id`,
    [orderId]
  ) as Record<string, unknown>[]
  return rows
    .map((r) => ({
      id: Number(r.id),
      plNo: String(r.pl_no ?? ''),
      status: (r.ship_status == null ? null : String(r.ship_status)) as ShipStatus | null,
      quantity: Number(r.qty ?? 0)
    }))
    // 空批次（没有明细）不进汇总，否则删到只剩空壳会永远卡在某个状态
    .filter((b) => b.quantity > 0)
}

/** 一张订单的出货汇总；derivedStatus 为 null 表示订单仍走手工状态 */
export function shipmentSummary(orderId: number): ShipSummary {
  const ordered = Number(
    (
      getDb().get('SELECT COALESCE(SUM(quantity), 0) AS qty FROM order_items WHERE order_id = ? AND quantity > 0', [
        orderId
      ]) as { qty?: number } | null
    )?.qty ?? 0
  )
  const batches = loadBatches(orderId)
  const packed = batches.reduce((s, b) => s + b.quantity, 0)
  const shipped = batches
    .filter((b) => RANK[(b.status ?? 'packed') as ShipStatus] >= SHIPPED)
    .reduce((s, b) => s + b.quantity, 0)
  return {
    orderedQuantity: ordered,
    packedQuantity: packed,
    shippedQuantity: shipped,
    batchCount: batches.length,
    unshippedBatches: batches.filter((b) => RANK[(b.status ?? 'packed') as ShipStatus] < SHIPPED).length,
    derivedStatus: deriveStatus(ordered, batches)
  }
}

function deriveStatus(ordered: number, batches: Batch[]): ShipStatus | null {
  if (batches.length === 0) return null
  // 还有升级前的老批次：不知道它的进度，不推导，订单保持手工状态。
  // 混着一张老批一张新批也一样——否则新建一个批次就能把手工标「已签收」的老单拉回来。
  if (batches.some((b) => b.status === null)) return null

  const ranks = batches.map((b) => RANK[(b.status ?? 'packed') as ShipStatus])
  const minRank = Math.min(...ranks)
  const packed = batches.reduce((s, b) => s + b.quantity, 0)
  const shipped = batches
    .filter((b) => RANK[(b.status ?? 'packed') as ShipStatus] >= SHIPPED)
    .reduce((s, b) => s + b.quantity, 0)

  if (minRank >= 5) return 'delivered'
  if (shipped > 0 && (packed + 0.0001 < ordered || minRank < SHIPPED)) return 'partial_shipped'
  if (packed + 0.0001 < ordered) return 'preparing'
  if (minRank >= 4) return 'cleared'
  if (minRank >= 3) return 'shipped'
  if (minRank >= 2) return 'packed'
  if (minRank >= 1) return 'preparing'
  return 'not_prepared'
}

/**
 * 回写订单状态缓存。只改 ship_status，不碰 updated_at——
 * 改备注/补柜号不能把老单算进「本月完成」。
 */
export function applyShipStatus(orderId: number): ShipStatus | null {
  const summary = shipmentSummary(orderId)
  if (summary.derivedStatus === null) return null
  getDb().run('UPDATE orders SET ship_status = ? WHERE id = ?', [summary.derivedStatus, orderId])
  return summary.derivedStatus
}

/** 这张单的出货状态是否已由批次接管（接管后订单级状态只能到批次上改） */
export function isShipStatusDerived(orderId: number): boolean {
  return shipmentSummary(orderId).derivedStatus !== null
}
