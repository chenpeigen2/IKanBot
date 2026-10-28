/**
 * 桌面侧的订单服务：SQL 与守门全在 core/orders.ts（后端跑同一份），
 * 这里只多一件 core 不该知道的事——照片的实物文件在本机图片目录里，由壳来删。
 */
import { existsSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { coreDb, imagesDir } from '../db'
import {
  ordersCore,
  type BatchPaymentEntry,
  type OrderInput,
  type OrderItemInput,
  type OrderListFilter,
  type OrderSort,
  type OrderTerms,
  type PaymentInput,
  type SettlementInput
} from '../../core/orders'

export type {
  BatchPaymentEntry,
  OrderInput,
  OrderItemInput,
  OrderListFilter,
  OrderSort,
  OrderTerms,
  PaymentInput,
  SettlementInput
}

const core = ordersCore(coreDb)

export const {
  assertOrderWritable,
  listOrderIds,
  listOrders,
  listOrderRows,
  getOrder,
  createOrder,
  updateOrder,
  setOrderParties,
  voidOrder,
  deleteOrder,
  assertChargeAmounts,
  assertOrderTotalNonNegative,
  updateOrderCharges,
  assertSkuListUnique,
  addOrderItem,
  addOrderItems,
  updateOrderItem,
  removeOrderItem,
  replaceOrderItems,
  summarizeSkus,
  assertPaymentInput,
  assertBankRefUnused,
  addPayment,
  batchAddPayments,
  deletePayment,
  listSettlements,
  addSettlement,
  reverseSettlement,
  recomputePaymentStatus,
  setShipStatus,
  setPaymentStatus,
  listEvents,
  lastOrderTerms,
  lastExchangeRate,
  lastExchangeRateInfo,
  listPorts,
  listOrderPhotos,
  addOrderPhoto
} = core

/**
 * 删照片记录并留痕；core 只管库，返回要删的文件名。
 * 文件在记录删掉之后才删：回滚时记录还在，不能先把实物证据毁了。
 */
export async function deleteOrderPhoto(orderId: number, photoId: number): Promise<void> {
  const fileName = await core.deleteOrderPhoto(orderId, photoId)
  if (!fileName) return
  try {
    const p = join(imagesDir(), basename(fileName))
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* 文件已被手工移走：记录已清，不挡主流程 */
  }
}
