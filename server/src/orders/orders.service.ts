import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { ImageStore } from '../files/image-store.service'
import {
  ordersCore,
  type BatchPaymentEntry,
  type OrderInput,
  type OrderItemInput,
  type OrderListFilter,
  type OrderTerms,
  type OrdersCore,
  type PaymentInput,
  type SettlementInput
} from '../../../core/orders'
import type {
  OrderDetail,
  OrderEvent,
  OrderListPage,
  OrderPhoto,
  PaymentStatus,
  QuotationCharge,
  SampleOrderDetail,
  Settlement,
  ShipStatus,
  SkuSummary
} from '../../../src/shared/types'

/**
 * 订单域的 HTTP 门面：SQL、守门、留痕全在 core/orders.ts，桌面走同一份。
 * 这里只多一件 core 不该知道的事——验货照/柜照的实物文件在后端图片目录里，删记录时一并清掉。
 */
@Injectable()
export class OrdersService {
  private readonly core: OrdersCore

  constructor(@Inject(DB) db: Db, private readonly images: ImageStore) {
    this.core = ordersCore(db)
  }

  list(filter: Record<string, unknown>): Promise<OrderListPage> {
    return this.core.listOrderRows(filter as OrderListFilter)
  }

  get(id: number): Promise<OrderDetail | null> {
    return this.core.getOrder(id)
  }

  create(input: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.createOrder(input as unknown as OrderInput)
  }

  update(id: number, input: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.updateOrder(id, input as unknown as OrderInput)
  }

  setParties(id: number, patch: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.setOrderParties(id, patch as unknown as Parameters<OrdersCore['setOrderParties']>[1])
  }

  updateCharges(id: number, charges: unknown[], reason: string): Promise<OrderDetail> {
    return this.core.updateOrderCharges(id, charges as QuotationCharge[], reason)
  }

  remove(id: number): Promise<void> {
    return this.core.deleteOrder(id)
  }

  void(id: number, reason: string, confirmDocs: boolean): Promise<OrderDetail> {
    return this.core.voidOrder(id, reason, { confirmDocs })
  }

  addItem(orderId: number, item: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.addOrderItem(orderId, item as unknown as OrderItemInput)
  }

  updateItem(orderId: number, itemId: number, patch: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.updateOrderItem(orderId, itemId, patch as unknown as Partial<OrderItemInput>)
  }

  addItems(orderId: number, items: unknown[]): Promise<OrderDetail> {
    return this.core.addOrderItems(orderId, items as OrderItemInput[])
  }

  removeItem(orderId: number, itemId: number): Promise<OrderDetail> {
    return this.core.removeOrderItem(orderId, itemId)
  }

  replaceItems(orderId: number, items: unknown[]): Promise<OrderDetail> {
    return this.core.replaceOrderItems(orderId, items as OrderItemInput[])
  }

  summarizeSkus(orderId: number): Promise<SkuSummary[]> {
    return this.core.summarizeSkus(orderId)
  }

  addPayment(orderId: number, p: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.addPayment(orderId, p as unknown as PaymentInput)
  }

  batchAddPayments(entries: unknown[]): Promise<(OrderDetail | SampleOrderDetail)[]> {
    return this.core.batchAddPayments(entries as BatchPaymentEntry[])
  }

  deletePayment(orderId: number, paymentId: number, reason: string): Promise<OrderDetail> {
    return this.core.deletePayment(orderId, paymentId, reason)
  }

  listSettlements(orderId: number): Promise<Settlement[]> {
    return this.core.listSettlements(orderId)
  }

  addSettlement(orderId: number, input: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.addSettlement(orderId, input as unknown as SettlementInput)
  }

  reverseSettlement(orderId: number, settlementId: number, reason: string): Promise<OrderDetail> {
    return this.core.reverseSettlement(orderId, settlementId, reason)
  }

  setShipStatus(orderId: number, status: string, note: string): Promise<OrderDetail> {
    return this.core.setShipStatus(orderId, status as ShipStatus, note)
  }

  setPaymentStatus(orderId: number, status: string, note: string): Promise<OrderDetail> {
    return this.core.setPaymentStatus(orderId, status as PaymentStatus, note)
  }

  listEvents(orderId: number): Promise<OrderEvent[]> {
    return this.core.listEvents(orderId)
  }

  listPorts(): Promise<{ loading: string[]; destination: string[] }> {
    return this.core.listPorts()
  }

  lastTerms(customerId: number): Promise<OrderTerms | null> {
    return this.core.lastOrderTerms(customerId)
  }

  lastExchangeRate(): Promise<number | null> {
    return this.core.lastExchangeRate()
  }

  lastExchangeRateInfo(currency?: string): Promise<{ rate: number; date: string } | null> {
    return this.core.lastExchangeRateInfo(currency)
  }

  listPhotos(orderId: number): Promise<OrderPhoto[]> {
    return this.core.listOrderPhotos(orderId)
  }

  addPhoto(orderId: number, fileName: string, kind: string, note: string): Promise<OrderPhoto> {
    return this.core.addOrderPhoto(orderId, fileName, kind as OrderPhoto['kind'], note)
  }

  /** 删记录与留痕在 core 里；实物文件在这边删（core 不碰文件系统） */
  async removePhoto(orderId: number, photoId: number): Promise<void> {
    const fileName = await this.core.deleteOrderPhoto(orderId, photoId)
    if (fileName) this.images.remove(fileName)
  }
}
