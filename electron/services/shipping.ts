import { coreDb } from '../db'
import {
  shipmentSummary as shipmentSummaryCore,
  factoryDeliveredQuantity as factoryDeliveredQuantityCore,
  applyShipStatus as applyShipStatusCore,
  isShipStatusDerived as isShipStatusDerivedCore
} from '../../core/shipping'
import type { ShipStatus, ShipSummary } from '../../src/shared/types'

/**
 * 出货状态真源（批次 + 件数）。实现在 core/shipping.ts（后端也用这一份），
 * 这里只把本机连接接进去，调用方签名不变，只多一个 Promise。
 */
export function shipmentSummary(orderId: number): Promise<ShipSummary> {
  return shipmentSummaryCore(coreDb, orderId)
}

export function factoryDeliveredQuantity(orderId: number): Promise<number> {
  return factoryDeliveredQuantityCore(coreDb, orderId)
}

export function applyShipStatus(orderId: number): Promise<ShipStatus | null> {
  return applyShipStatusCore(coreDb, orderId)
}

export function isShipStatusDerived(orderId: number): Promise<boolean> {
  return isShipStatusDerivedCore(coreDb, orderId)
}
