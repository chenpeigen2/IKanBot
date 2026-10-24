import { getDb, nextNo } from '../db'
import { mapOrder, mapOrderItem, mapPayment, mapPackingList, mapPackingListLine, mapEvent, mapSkuSummary, mapOrderPhoto, mapCustomer } from '../db/mappers'
import { getSettings } from './settings'
import { computeOrderMoney, parseCharges } from './money'
import { applyShipStatus, isShipStatusDerived, shipmentSummary } from './shipping'
import { localDate, addDays, isLocalDate } from '../../src/shared/date'
import { SHIP_STATUS_LABEL } from '../../src/shared/types'
import type {
  Currency,
  Incoterm,
  Order,
  OrderDetail,
  OrderEvent,
  OrderPhoto,
  PackingList,
  PaymentMethod,
  PaymentStatus,
  QuotationCharge,
  ShipStatus,
  SkuSummary
} from '../../src/shared/types'

/** sqlite 绑定参数 */
type Bind = string | number | bigint | boolean | null | Uint8Array

function now(): string {
  return new Date().toISOString()
}


export interface OrderInput {
  id?: number
  customerId: number
  currency?: Currency
  exchangeRate?: number
  exchangeRateDate?: string | null
  baseCurrency?: Currency
  incoterm?: Incoterm
  portOfLoading?: string
  portOfDestination?: string
  paymentMethod?: PaymentMethod
  depositRatio?: number
  validUntil?: string | null
  expectedShipDate?: string | null
  expectedArrivalDate?: string | null
  customerPo?: string
  note?: string
  piNo?: string
  factory?: string
  factoryDueDate?: string | null
  cutOffDate?: string | null
  etdDate?: string | null
  vessel?: string
  sealNo?: string
  /** 正式费用行（运费/保险等） */
  charges?: QuotationCharge[]
  /** 建单时的收款状态（报价单转订单时用：PI 已发 = sent） */
  paymentStatus?: PaymentStatus
}

export interface OrderItemInput {
  productId?: number | null
  styleNo: string
  productName?: string
  composition?: string
  color?: string
  size?: string
  quantity: number
  unitPrice: number
  unitCost?: number | null
}

export type OrderSort = 'created_desc' | 'created_asc' | 'amount_desc' | 'amount_asc' | 'ship_asc'

export function listOrders(filter: {
  keyword?: string
  paymentStatus?: string
  shipStatus?: string
  customerId?: number
  from?: string
  to?: string
  sort?: OrderSort
}): OrderDetail[] {
  const db = getDb()
  const where: string[] = []
  const params: Bind[] = []
  const kw = (filter.keyword ?? '').trim()
  if (kw) {
    // 搜索范围：订单号 / PI号 / 客户PO / 客户名 / 款号 / 颜色 / 尺码
    where.push(
      `(o.order_no LIKE ? OR o.pi_no LIKE ? OR o.customer_po LIKE ? OR c.company LIKE ?
        OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id
          AND (oi.style_no LIKE ? OR oi.color LIKE ? OR oi.size LIKE ?)))`
    )
    const k = `%${kw}%`
    params.push(k, k, k, k, k, k, k)
  }
  if (filter.paymentStatus) {
    where.push('o.payment_status = ?')
    params.push(filter.paymentStatus)
  } else {
    // 已作废的单不进默认列表（但在「已作废」页签里查得到，记录全留）
    where.push("o.payment_status != 'void'")
  }
  if (filter.shipStatus) {
    where.push('o.ship_status = ?')
    params.push(filter.shipStatus)
  }
  if (filter.customerId) {
    where.push('o.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.from) {
    where.push('date(o.created_at) >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    where.push('date(o.created_at) <= ?')
    params.push(filter.to)
  }
  const sql = `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  const rows = db.all(sql, params) as Record<string, unknown>[]
  const list = rows.map((r) => hydrate(mapOrder(r)))
  return sortOrders(list, filter.sort ?? 'created_desc')
}

/** 排序：金额需按各订单自身币种比较，故先折算为基准币再比 */
function sortOrders(list: OrderDetail[], sort: OrderSort): OrderDetail[] {
  const base = (o: OrderDetail) => o.totalAmount * o.exchangeRate
  const byCreated = (a: OrderDetail, b: OrderDetail) =>
    a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1
  switch (sort) {
    case 'created_asc':
      return [...list].sort((a, b) => -byCreated(a, b))
    case 'amount_desc':
      return [...list].sort((a, b) => base(b) - base(a))
    case 'amount_asc':
      return [...list].sort((a, b) => base(a) - base(b))
    case 'ship_asc':
      return [...list].sort((a, b) => {
        const av = a.expectedShipDate ?? '9999-12-31'
        const bv = b.expectedShipDate ?? '9999-12-31'
        return av === bv ? byCreated(a, b) : av < bv ? -1 : 1
      })
    case 'created_desc':
    default:
      return [...list].sort(byCreated)
  }
}

/** 读取订单并展开关联数据与汇总 */
export function getOrder(id: number): OrderDetail | null {
  const row = getDb().get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
  if (!row) return null
  return hydrate(mapOrder(row))
}

function hydrate(order: Order): OrderDetail {
  const db = getDb()
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [order.customerId]) as
    | Record<string, unknown>
    | null
  const items = (
    db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY style_no, color, size, id', [order.id]) as Record<
      string,
      unknown
    >[]
  ).map(mapOrderItem)
  const payments = (
    db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at, id', [order.id]) as Record<string, unknown>[]
  ).map(mapPayment)
  const plRows = db.all('SELECT * FROM packing_lists WHERE order_id = ? ORDER BY id', [order.id]) as Record<
    string,
    unknown
  >[]
  const packingLists: PackingList[] = plRows.map((r) => {
    const lines = (
      db.all('SELECT * FROM packing_list_lines WHERE packing_list_id = ? ORDER BY box_no, id', [Number(r.id)]) as Record<
        string,
        unknown
      >[]
    ).map(mapPackingListLine)
    return mapPackingList(r, lines)
  })

  // 金额口径统一走 services/money.ts（唯一真源）：
  // 货值 / 费用 / 含费用合计 / 待收 / 毛利（成本缺失 → 不可信）
  const m = computeOrderMoney({
    items: items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, unitCost: i.unitCost })),
    charges: order.charges,
    payments: payments.map((p) => ({ amount: p.amount })),
    depositRatio: order.depositRatio
  })

  return {
    ...order,
    customer: customerRow ? mapCustomer(customerRow) : null,
    items,
    payments,
    packingLists,
    totalAmount: m.goodsValue,
    chargesTotal: m.chargesTotal,
    grandTotal: m.grandTotal,
    totalCost: m.totalCost,
    totalProfit: m.profitRaw,
    missingCostItems: m.missingCostItems,
    totalQuantity: m.totalQuantity,
    paidAmount: m.paidAmount,
    remaining: m.receivable,
    remainingRaw: m.remaining,
    depositAmount: m.depositAmount,
    shipSummary: shipmentSummary(order.id)
  }
}

/** PI 号是否已被别的订单占用（单号是凭据，N-3 查重） */
function piNoTaken(no: string, selfId?: number): boolean {
  const db = getDb()
  const row = selfId
    ? db.get('SELECT id FROM orders WHERE pi_no = ? AND id != ?', [no, selfId])
    : db.get('SELECT id FROM orders WHERE pi_no = ?', [no])
  return !!row
}

function piDupErr(no: string): Error {
  return new Error(
    `PI 号 ${no} 已经存在（可能恢复过备份或手工导过数据）。单号是凭据，不能两张单共用一个号——请在「PI号」里换一个号再保存。`
  )
}

export function createOrder(input: OrderInput): OrderDetail {
  const db = getDb()
  const settings = getSettings()
  const ts = now()
  const orderNo = nextNo('SO')
  const piNo = input.piNo?.trim() || nextNo('PI')
  // 单号是凭据：手工指定的 PI 号不能跟别的订单撞号（与打样单号同一条规矩，N-3）
  if (input.piNo?.trim() && piNoTaken(input.piNo.trim())) throw piDupErr(piNo)
  const validUntil = input.validUntil ?? addDays(localDate(), settings.piValidDays)
  // 汇率锁定日期：默认记今天（本地日期）
  const rateDate = input.exchangeRateDate ?? localDate()
  // 收款状态：报价单转单时可以指定（PI 已发 = sent），默认草稿
  const status: PaymentStatus = input.paymentStatus ?? 'draft'
  // 费用行（运费/保险等）存 JSON
  const chargesJson = JSON.stringify((input.charges ?? []).filter((c) => c.label.trim()))

  const res = db.run(
    `INSERT INTO orders(order_no, customer_id, pi_no, payment_status, ship_status, currency, exchange_rate,
      base_currency, incoterm, port_of_loading, port_of_destination, payment_method, deposit_ratio,
      valid_until, expected_ship_date, expected_arrival_date, customer_po, note,
      exchange_rate_date, factory, factory_due_date, cut_off_date, etd_date, vessel, seal_no, charges,
      created_at, updated_at)
     VALUES(?,?,?,?,'not_prepared',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      orderNo,
      input.customerId,
      piNo,
      status,
      input.currency ?? 'USD',
      input.exchangeRate ?? 1,
      input.baseCurrency ?? settings.baseCurrency,
      input.incoterm ?? 'FOB',
      input.portOfLoading ?? '',
      input.portOfDestination ?? '',
      input.paymentMethod ?? 'tt_deposit',
      input.depositRatio ?? settings.defaultDepositRatio,
      validUntil,
      input.expectedShipDate ?? null,
      input.expectedArrivalDate ?? null,
      input.customerPo ?? '',
      input.note ?? '',
      rateDate,
      input.factory ?? '',
      input.factoryDueDate ?? null,
      input.cutOffDate ?? null,
      input.etdDate ?? null,
      input.vessel ?? '',
      input.sealNo ?? '',
      chargesJson,
      ts,
      ts
    ]
  )
  const orderId = Number(res.lastInsertRowid)
  logEvent(orderId, 'create', null, status, `创建订单 ${orderNo}`)
  return getOrder(orderId)!
}

export function updateOrder(id: number, input: OrderInput): OrderDetail {
  const db = getDb()
  const ts = now()
  const before = db.get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
  if (!before) throw new Error('订单不存在')
  // 单号是凭据：编辑时把 PI 号改成别人的号要拦住（改成自己的号不算重号）
  const newPiNo = (input.piNo ?? '').trim()
  if (newPiNo && newPiNo !== String(before.pi_no ?? '') && piNoTaken(newPiNo, id))
    throw piDupErr(newPiNo)

  // 汇率是锁定的凭据：清空或填 0 不许悄悄落成 1——
  // 1 会让整单金额按错汇率折算，四张单据、报表、待收全跟着错
  const newRate = Number(input.exchangeRate ?? before.exchange_rate)
  if (!(newRate > 0)) throw new Error('汇率必须大于 0，清空汇率不能保存')
  const oldRate = Number(before.exchange_rate)
  const newCurrency = (input.currency ?? String(before.currency ?? 'USD')) as Currency
  const oldCurrency = String(before.currency ?? 'USD') as Currency
  if (newCurrency !== oldCurrency) {
    // 收款是按原币登记的凭据：改币种会让历史收款、银行流水和客户对账全部错位
    const payCount = Number(
      (db.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
    )
    if (payCount > 0) {
      throw new Error(
        `这张单已经登记了 ${payCount} 笔收款，不能改币种——收款是按 ${oldCurrency} 记的，改了会和银行流水对不上。确实要换币种，请作废这张单后按正确币种重开。`
      )
    }
    // 没改汇率就换币种，等于把 USD 的 7.1 套在 EUR 上，报表和毛利全错
    if (newRate === oldRate) {
      throw new Error(
        `币种从 ${oldCurrency} 换成 ${newCurrency}，汇率不能沿用原来的 ${oldRate}；请按 ${newCurrency} 重新填写汇率再保存。`
      )
    }
  }
  // 汇率变了就重新记锁定日期（未手动指定时）
  let rateDate = (before.exchange_rate_date as string | null) ?? null
  if (input.exchangeRateDate !== undefined) rateDate = input.exchangeRateDate
  else if (newRate !== oldRate) rateDate = localDate()
  // 费用行（运费/保险）：传了就按传的改，没传就保持原样（不能一个字段没传就把费用清空）
  const chargesJson =
    input.charges === undefined
      ? String(before.charges ?? '[]')
      : JSON.stringify(input.charges.filter((c) => c.label.trim()))

  db.run(
    `UPDATE orders SET customer_id=?, currency=?, exchange_rate=?, base_currency=?, incoterm=?,
      port_of_loading=?, port_of_destination=?, payment_method=?, deposit_ratio=?, valid_until=?,
      expected_ship_date=?, expected_arrival_date=?, customer_po=?, note=?, pi_no=?,
      exchange_rate_date=?, factory=?, factory_due_date=?, cut_off_date=?, etd_date=?, vessel=?, seal_no=?,
      charges=?, updated_at=?
     WHERE id=?`,
    [
      input.customerId,
      newCurrency,
      newRate,
      input.baseCurrency ?? getSettings().baseCurrency,
      input.incoterm ?? 'FOB',
      input.portOfLoading ?? '',
      input.portOfDestination ?? '',
      input.paymentMethod ?? 'tt_deposit',
      input.depositRatio ?? getSettings().defaultDepositRatio,
      input.validUntil ?? null,
      input.expectedShipDate ?? null,
      input.expectedArrivalDate ?? null,
      input.customerPo ?? '',
      input.note ?? '',
      input.piNo ?? '',
      rateDate,
      input.factory ?? '',
      input.factoryDueDate ?? null,
      input.cutOffDate ?? null,
      input.etdDate ?? null,
      input.vessel ?? '',
      input.sealNo ?? '',
      chargesJson,
      ts,
      id
    ]
  )
  logEvent(id, 'update', null, null, describeOrderChange(before, input))
  // 收款金额变了，状态可能需要重算
  recomputePaymentStatus(id)
  return getOrder(id)!
}

/** 生成一条人话版的「改了什么」记录 */
function describeOrderChange(before: Record<string, unknown>, input: OrderInput): string {
  const parts: string[] = []
  const cmp = (label: string, key: string, val: unknown) => {
    const old = before[key]
    const next = val ?? ''
    if (String(old ?? '') !== String(next ?? '')) {
      parts.push(`${label} ${old === null || old === undefined || old === '' ? '空' : old} → ${next === '' ? '空' : next}`)
    }
  }
  cmp('币种', 'currency', input.currency)
  cmp('汇率', 'exchange_rate', input.exchangeRate)
  cmp('贸易术语', 'incoterm', input.incoterm)
  cmp('装运港', 'port_of_loading', input.portOfLoading)
  cmp('目的港', 'port_of_destination', input.portOfDestination)
  cmp('付款方式', 'payment_method', input.paymentMethod)
  cmp('定金比例', 'deposit_ratio', input.depositRatio)
  cmp('PI号', 'pi_no', input.piNo)
  cmp('客户PO', 'customer_po', input.customerPo)
  cmp('工厂', 'factory', input.factory)
  cmp('船名航次', 'vessel', input.vessel)
  cmp('封条号', 'seal_no', input.sealNo)
  // 费用行也要留痕（运费改了多少）
  if (input.charges !== undefined) {
    const oldCharges = parseCharges(before.charges)
    const oldMap = new Map(oldCharges.map((c) => [c.label, c.amount]))
    const newMap = new Map(input.charges.filter((c) => c.label.trim()).map((c) => [c.label, c.amount]))
    for (const [label, amt] of newMap) {
      const old = oldMap.get(label)
      if (old === undefined) parts.push(`新增费用 ${label} ${amt}`)
      else if (Math.abs(old - amt) > 0.0001) parts.push(`费用 ${label} ${old} → ${amt}`)
    }
    for (const [label] of oldMap) {
      if (!newMap.has(label)) parts.push(`删除费用 ${label}`)
    }
  }
  if (parts.length === 0) return '修改订单信息'
  return `修改订单：${parts.join('；')}`
}

/**
 * 作废订单（客户取消 / 建错单）：
 * 记录全部保留（收款流水、操作历史、单据存档），但不再进货值 / 待收 / 毛利。
 * 老板的规矩：所有订单必须留痕，真删除只留给「建错字」的空单。
 */
export function voidOrder(id: number, reason = ''): OrderDetail {
  const db = getDb()
  const cur = db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [id]) as
    | { order_no: string; payment_status: string }
    | null
  if (!cur) throw new Error('订单不存在')
  if (cur.payment_status === 'void') return getOrder(id)!
  db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', ['void', now(), id])
  logEvent(id, 'void', cur.payment_status, 'void', `作废订单 ${cur.order_no}${reason ? '：' + reason : ''}`)
  return getOrder(id)!
}

/**
 * 物理删除：只允许删「从没收过钱、也没有明细」的空单。
 * 有钱或有明细的订单必须走「作废」，否则收款凭据和操作历史会一起消失。
 */
export function deleteOrder(id: number): void {
  const db = getDb()
  const row = db.get(
    `SELECT o.order_no,
            (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS pay_cnt,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_cnt
     FROM orders o WHERE o.id = ?`,
    [id]
  ) as { order_no?: string; pay_cnt?: number; item_cnt?: number } | null
  if (!row) throw new Error('订单不存在')
  const payCnt = Number(row.pay_cnt ?? 0)
  const itemCnt = Number(row.item_cnt ?? 0)
  if (payCnt > 0 || itemCnt > 0) {
    throw new Error(
      `订单 ${row.order_no} 已经有 ${itemCnt} 行明细、${payCnt} 笔收款，不能直接删（删了收款凭据和操作历史会一起没有）。请用「作废」：记录全留，只是不再计入销售额和待收款。`
    )
  }
  db.run('DELETE FROM orders WHERE id = ?', [id])
}

/** 只改费用行（运费/保险），其他字段一个都不动 */
export function updateOrderCharges(orderId: number, charges: QuotationCharge[]): OrderDetail {
  const db = getDb()
  const before = db.get('SELECT charges FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
  if (!before) throw new Error('订单不存在')
  const clean = charges.filter((c) => c.label.trim())
  db.run('UPDATE orders SET charges=?, updated_at=? WHERE id=?', [JSON.stringify(clean), now(), orderId])
  const parts = describeChargeChange(parseCharges(before.charges), clean)
  logEvent(orderId, 'update', null, null, parts.length ? `修改费用：${parts.join('；')}` : '修改费用行')
  // 费用变了，应收总额也变了，状态可能要重算
  recomputePaymentStatus(orderId)
  return getOrder(orderId)!
}

/** 费用行变更说明（人话） */
function describeChargeChange(oldCharges: QuotationCharge[], newCharges: QuotationCharge[]): string[] {
  const parts: string[] = []
  const oldMap = new Map(oldCharges.map((c) => [c.label, c.amount]))
  const newMap = new Map(newCharges.map((c) => [c.label, c.amount]))
  for (const [label, amt] of newMap) {
    const old = oldMap.get(label)
    if (old === undefined) parts.push(`新增 ${label} ${amt}`)
    else if (Math.abs(old - amt) > 0.0001) parts.push(`${label} ${old} → ${amt}`)
  }
  for (const [label] of oldMap) {
    if (!newMap.has(label)) parts.push(`删除 ${label}`)
  }
  return parts
}

/* ---------------- 订单行 ---------------- */

export function addOrderItem(orderId: number, item: OrderItemInput): OrderDetail {
  const db = getDb()
  db.run(
    `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      orderId,
      item.productId ?? null,
      item.styleNo,
      item.productName ?? '',
      item.composition ?? '',
      item.color ?? '',
      item.size ?? '',
      item.quantity,
      item.unitPrice,
      item.unitCost ?? null
    ]
  )
  db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
  logEvent(orderId, 'item_add', null, null, `添加 SKU ${item.styleNo} ${item.color}/${item.size} × ${item.quantity}`)
  // 件数变了，订单的「装够没有 / 走了没有」跟着变
  applyShipStatus(orderId)
  // 金额变了，应收总额 / 定金 / 待收都变了，收款状态要重算（可以往上也可以往下）
  recomputePaymentStatus(orderId)
  return getOrder(orderId)!
}

/** 这一款（款号×颜色×尺码）在所有装箱单里已经装了多少件 */
function packedQty(orderId: number, sku: { styleNo: string; color: string; size: string }): number {
  return Number(
    (
      getDb().get(
        `SELECT COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
         WHERE pl.order_id = ? AND l.style_no = ? AND l.color = ? AND l.size = ?`,
        [orderId, sku.styleNo, sku.color, sku.size]
      ) as { qty?: number } | null
    )?.qty ?? 0
  )
}

/** 订单减量不能减到已装箱数以下：箱子里实物已经在了，订单数字必须兜得住 */
function assertNotBelowPacked(orderId: number, sku: { styleNo: string; color: string; size: string }): void {
  const packed = packedQty(orderId, sku)
  if (packed > 0) {
    throw new Error(
      `款号 ${sku.styleNo} ${sku.color}/${sku.size} 已经装了 ${packed} 件箱，订单数量不能改到 ${packed} 件以下；请先到「装箱单」里改小或删掉对应箱明细（已出运的批次要先把状态改回「已包装」）。`
    )
  }
}

export function updateOrderItem(
  orderId: number,
  itemId: number,
  patch: Partial<OrderItemInput>
): OrderDetail {
  const db = getDb()
  const cur = db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]) as
    | Record<string, unknown>
    | null
  if (!cur) throw new Error('订单行不存在')
  const curSku = {
    styleNo: String(cur.style_no ?? ''),
    color: String(cur.color ?? ''),
    size: String(cur.size ?? '')
  }
  const nextSku = {
    styleNo: patch.styleNo ?? curSku.styleNo,
    color: patch.color ?? curSku.color,
    size: patch.size ?? curSku.size
  }
  const skuChanged = nextSku.styleNo !== curSku.styleNo || nextSku.color !== curSku.color || nextSku.size !== curSku.size
  const packed = packedQty(orderId, curSku)
  if (skuChanged && packed > 0) {
    throw new Error(
      `款号 ${curSku.styleNo} ${curSku.color}/${curSku.size} 已经装了 ${packed} 件箱，不能直接换款号/颜色/尺码；请先到「装箱单」里处理这一款的箱明细（已出运的批次要先把状态改回「已包装」）。`
    )
  }
  if (!skuChanged && patch.quantity !== undefined && Number(patch.quantity) < packed) {
    assertNotBelowPacked(orderId, curSku)
  }
  db.run(
    `UPDATE order_items SET product_id=?, style_no=?, product_name=?, composition=?, color=?, size=?, quantity=?, unit_price=?, unit_cost=?
     WHERE id=? AND order_id=?`,
    [
      patch.productId !== undefined ? patch.productId : (cur.product_id as number | null),
      patch.styleNo ?? (cur.style_no as string),
      patch.productName ?? (cur.product_name as string),
      patch.composition ?? (cur.composition as string),
      patch.color ?? (cur.color as string),
      patch.size ?? (cur.size as string),
      patch.quantity ?? (cur.quantity as number),
      patch.unitPrice ?? (cur.unit_price as number),
      patch.unitCost !== undefined ? patch.unitCost : (cur.unit_cost as number | null),
      itemId,
      orderId
    ]
  )
  db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
  const changes = describeItemChange(cur, patch)
  if (changes) logEvent(orderId, 'item_update', null, null, `修改明细 ${patch.styleNo ?? cur.style_no}：${changes}`)
  // 件数变了，订单的「装够没有 / 走了没有」跟着变
  applyShipStatus(orderId)
  // 金额变了，收款状态要重算（加单加到收不够要从「已收款」退回「部分收款」）
  recomputePaymentStatus(orderId)
  return getOrder(orderId)!
}

/** 生成明细行变更说明 */
function describeItemChange(cur: Record<string, unknown>, patch: Partial<OrderItemInput>): string {
  const parts: string[] = []
  const cmp = (label: string, key: string, val: unknown) => {
    if (val === undefined) return
    const old = cur[key]
    if (String(old ?? '') !== String(val ?? '')) {
      parts.push(
        `${label} ${old === null || old === undefined || old === '' ? '空' : old} → ${val === '' ? '空' : val}`
      )
    }
  }
  cmp('款号', 'style_no', patch.styleNo)
  cmp('颜色', 'color', patch.color)
  cmp('尺码', 'size', patch.size)
  cmp('数量', 'quantity', patch.quantity)
  cmp('单价', 'unit_price', patch.unitPrice)
  cmp('成本', 'unit_cost', patch.unitCost)
  return parts.join('；')
}

export function removeOrderItem(orderId: number, itemId: number): OrderDetail {
  const db = getDb()
  // 删行也要留痕：客户要过 50 件后来取消了，这件事系统必须记得
  const cur = db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]) as
    | Record<string, unknown>
    | null
  if (!cur) throw new Error('订单行不存在')
  const packed = packedQty(orderId, {
    styleNo: String(cur.style_no ?? ''),
    color: String(cur.color ?? ''),
    size: String(cur.size ?? '')
  })
  if (packed > 0) {
    throw new Error(
      `款号 ${String(cur.style_no)} ${String(cur.color)}/${String(cur.size)} 已经装了 ${packed} 件箱，不能直接删这一行；请先到「装箱单」里删掉对应箱明细（已出运的批次要先把状态改回「已包装」）。`
    )
  }
  db.run('DELETE FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId])
  db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
  logEvent(
    orderId,
    'item_remove',
    null,
    null,
    `删除明细 ${cur.style_no} ${cur.color}/${cur.size} × ${cur.quantity}（单价 ${Number(
      cur.unit_price ?? 0
    ).toFixed(2)}）`
  )
  // 件数变了，订单的「装够没有 / 走了没有」跟着变
  applyShipStatus(orderId)
  // 金额变了，收款状态要重算
  recomputePaymentStatus(orderId)
  return getOrder(orderId)!
}

/** 批量替换订单行（从商品库选款生成 SKU 矩阵时用） */
export function replaceOrderItems(orderId: number, items: OrderItemInput[]): OrderDetail {
  const db = getDb()
  const packed = Number(
    (
      db.get(
        `SELECT COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
         WHERE pl.order_id = ?`,
        [orderId]
      ) as { qty?: number } | null
    )?.qty ?? 0
  )
  if (packed > 0) {
    throw new Error(
      `这张单已经装了 ${packed} 件箱，不能整体替换明细；请逐行调整，或先到「装箱单」里处理箱明细（已出运的批次要先把状态改回「已包装」）。`
    )
  }
  db.exec('BEGIN')
  try {
    db.run('DELETE FROM order_items WHERE order_id = ?', [orderId])
    for (const item of items) {
      db.run(
        `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          orderId,
          item.productId ?? null,
          item.styleNo,
          item.productName ?? '',
          item.composition ?? '',
          item.color ?? '',
          item.size ?? '',
          item.quantity,
          item.unitPrice,
          item.unitCost ?? null
        ]
      )
    }
    db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  logEvent(orderId, 'item_replace', null, null, `批量生成 ${items.length} 个 SKU 行`)
  // 金额变了，收款状态要重算
  recomputePaymentStatus(orderId)
  return getOrder(orderId)!
}

/**
 * 按 SKU 汇总（用于 PL 装箱单自动生成）。
 * 同时算出「已经装箱的数量」：分批出货时，新的一箱只装还没装的部分。
 * SKU 按 款号×颜色×尺码 认（品名取其中一行，不参与归组）。
 */
export function summarizeSkus(orderId: number): SkuSummary[] {
  const rows = getDb().all(
    `SELECT oi.style_no, MAX(oi.product_name) AS product_name, oi.color, oi.size,
            SUM(oi.quantity) AS quantity,
            COALESCE((
              SELECT SUM(pll.quantity) FROM packing_list_lines pll
              JOIN packing_lists pl ON pl.id = pll.packing_list_id
              WHERE pl.order_id = oi.order_id AND pll.style_no = oi.style_no
                AND pll.color = oi.color AND pll.size = oi.size
            ), 0) AS packed_quantity
     FROM order_items oi
     WHERE oi.order_id = ? AND oi.quantity > 0
     GROUP BY oi.style_no, oi.color, oi.size
     ORDER BY oi.style_no, oi.color, oi.size`,
    [orderId]
  ) as Record<string, unknown>[]
  return rows.map(mapSkuSummary)
}

/* ---------------- 收款 ---------------- */

export function addPayment(
  orderId: number,
  p: { paidAt: string; amount: number; method?: string; bankRef?: string; note?: string }
): OrderDetail {
  const db = getDb()
  const paidAt = String(p.paidAt ?? '').trim()
  // 空日期会让这笔钱从「本月收款」和月报里消失，只剩订单上的已收能看见
  if (!isLocalDate(paidAt)) {
    throw new Error('收款日期要填完整（例如 2026-10-24）。空日期的收款不会进本月收款和月报。')
  }
  const amount = Number(p.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('收款金额必须是大于 0 的数。')
  }
  db.exec('BEGIN')
  try {
    db.run(
      `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, created_at) VALUES(?,?,?,?,?,?,?)`,
      [orderId, paidAt, amount, p.method ?? 'T/T', p.bankRef ?? '', p.note ?? '', now()]
    )
    logEvent(
      orderId,
      'payment',
      null,
      null,
      `收款 ${amount.toFixed(2)}（${paidAt}${p.bankRef ? `，流水号 ${p.bankRef}` : `，${p.method ?? 'T/T'}`}）`
    )
    recomputePaymentStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return getOrder(orderId)!
}

export function deletePayment(orderId: number, paymentId: number, reason = ''): OrderDetail {
  const db = getDb()
  const row = db.get(
    `SELECT p.paid_at, p.amount, p.bank_ref, o.currency
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.id = ? AND p.order_id = ?`,
    [paymentId, orderId]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('这条收款记录已经不存在了，刷新页面后再试。')
  const why = String(reason ?? '').trim()
  // 删掉的是钱到账的凭据，操作历史必须能回答「删了多少钱、哪一天、哪笔流水、为什么」
  if (!why) {
    throw new Error('删除收款要写原因（例如“金额录错”“客户退汇”），操作历史里要留痕。')
  }
  const amount = Number(row.amount ?? 0)
  const currency = String(row.currency ?? '')
  const bankRef = String(row.bank_ref ?? '')
  const paidAt = String(row.paid_at ?? '')
  db.exec('BEGIN')
  try {
    db.run('DELETE FROM payments WHERE id = ? AND order_id = ?', [paymentId, orderId])
    logEvent(
      orderId,
      'payment_delete',
      null,
      null,
      `删除收款 ${currency} ${amount.toFixed(2)}（${paidAt}${bankRef ? `，流水号 ${bankRef}` : ''}）原因：${why}`
    )
    recomputePaymentStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return getOrder(orderId)!
}

/**
 * 收款状态自动流转（双向）：
 *  - 收款 >= 总额 → 已结清
 *  - 收款 >= 定金（且 > 0）→ 已收款
 *  - 收款 > 0 → 部分收款
 *  - 一分没收 → 客户已确认
 *
 * 关键：加单 / 减单 / 改数量 / 改单价 / 删行都会重算，
 * 所以「已收款」可以退回「部分收款」，「部分收款」也能升到「已结清」。
 * 人工设定的 draft / sent / confirmed / expired / void 保持不变。
 */
export function recomputePaymentStatus(orderId: number): PaymentStatus {
  const db = getDb()
  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
  if (!order) throw new Error('订单不存在')
  const status = String(order.payment_status) as PaymentStatus
  // 草稿 / 已发送 / 已失效 / 已作废 不参与自动流转
  if (status === 'draft' || status === 'sent' || status === 'expired' || status === 'void') return status

  const goods = Number(
    (
      db.get('SELECT COALESCE(SUM(quantity * unit_price), 0) AS t FROM order_items WHERE order_id = ?', [
        orderId
      ]) as { t: number }
    ).t
  )
  // 费用行（运费/保险）是正式金额：应收总额 = 货值 + 费用，流转要按这个算
  const chargesTotal = parseCharges(order.charges).reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const total = goods + chargesTotal
  const paid = Number(
    (
      db.get('SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE order_id = ?', [orderId]) as { p: number }
    ).p
  )
  const deposit = total * Number(order.deposit_ratio)

  // 注意：这里算出来的是「下一个状态」，跟当前状态无关，所以能往上走也能往下退
  let next: PaymentStatus = status
  if (total > 0 && paid >= total - 0.001) next = 'settled'
  else if (deposit > 0 && paid >= deposit - 0.001) next = 'paid'
  else if (paid > 0) next = 'partial'
  else next = 'confirmed'

  if (next !== status) {
    db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
    logEvent(orderId, 'status_auto', status, next, `收款状态自动流转为 ${next}`)
  }
  return next
}

/* ---------------- 出货状态 ---------------- */

export function setShipStatus(orderId: number, next: ShipStatus, note = ''): OrderDetail {
  const db = getDb()
  const cur = db.get('SELECT ship_status FROM orders WHERE id = ?', [orderId]) as
    | { ship_status: string }
    | null
  if (!cur) throw new Error('订单不存在')
  // 有批次之后，整单状态只能由批次汇总，手改会跟批次打架（比如尾批还在厂里却标已签收）
  if (isShipStatusDerived(orderId)) {
    throw new Error(
      `这张单的出货状态由装箱单批次汇总（当前：${SHIP_STATUS_LABEL[cur.ship_status as ShipStatus] ?? cur.ship_status}）。请到「装箱单」里改对应批次的出运状态，整单状态会自动跟着变。`
    )
  }
  db.run('UPDATE orders SET ship_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
  logEvent(orderId, 'ship_status', cur.ship_status, next, note)
  return getOrder(orderId)!
}

/** 人工设置收款状态（会打断自动流转） */
export function setPaymentStatus(orderId: number, next: PaymentStatus, note = ''): OrderDetail {
  const db = getDb()
  const cur = db.get('SELECT payment_status FROM orders WHERE id = ?', [orderId]) as
    | { payment_status: string }
    | null
  if (!cur) throw new Error('订单不存在')
  db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
  logEvent(orderId, 'payment_status', cur.payment_status, next, note)
  return getOrder(orderId)!
}

/* ---------------- 事件日志 ---------------- */

export function logEvent(
  orderId: number,
  kind: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string
): void {
  getDb().run(
    'INSERT INTO order_events(order_id, at, actor, kind, from_status, to_status, note) VALUES(?,?,?,?,?,?,?)',
    [orderId, now(), '', kind, fromStatus, toStatus, note]
  )
}

export function listEvents(orderId: number): OrderEvent[] {
  const rows = getDb().all('SELECT * FROM order_events WHERE order_id = ? ORDER BY at, id', [orderId]) as Record<
    string,
    unknown
  >[]
  return rows.map(mapEvent)
}

/* ---------------- 历史条款 / 港口 / 照片 ---------------- */

/** 客户上一次订单用的条款，建单时直接带出来 */
export interface OrderTerms {
  currency: Currency
  exchangeRate: number
  incoterm: Incoterm
  portOfLoading: string
  portOfDestination: string
  paymentMethod: PaymentMethod
  depositRatio: number
  customerPo: string
  orderNo: string
  createdAt: string
}

export function lastOrderTerms(customerId: number): OrderTerms | null {
  const row = getDb().get(
    `SELECT * FROM orders WHERE customer_id = ? AND payment_status != 'draft'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [customerId]
  ) as Record<string, unknown> | null
  if (!row) return null
  return {
    currency: String(row.currency) as Currency,
    exchangeRate: Number(row.exchange_rate),
    incoterm: String(row.incoterm) as Incoterm,
    portOfLoading: String(row.port_of_loading),
    portOfDestination: String(row.port_of_destination),
    paymentMethod: String(row.payment_method) as PaymentMethod,
    depositRatio: Number(row.deposit_ratio),
    customerPo: String(row.customer_po),
    orderNo: String(row.order_no),
    createdAt: String(row.created_at)
  }
}

/** 最近一次填过的汇率（新建订单/报价单时的参考） */
export function lastExchangeRate(): number | null {
  const row = getDb().get(
    `SELECT exchange_rate FROM orders ORDER BY updated_at DESC, id DESC LIMIT 1`
  ) as { exchange_rate?: number } | null
  if (!row || row.exchange_rate == null) return null
  return Number(row.exchange_rate)
}

/** 最近一次用的汇率 + 当时的锁定日期（参考值，不自动填） */
export function lastExchangeRateInfo(): { rate: number; date: string } | null {
  const row = getDb().get(
    `SELECT exchange_rate, exchange_rate_date FROM orders ORDER BY updated_at DESC, id DESC LIMIT 1`
  ) as { exchange_rate?: number; exchange_rate_date?: string | null } | null
  if (!row || row.exchange_rate == null) return null
  return {
    rate: Number(row.exchange_rate),
    date: String(row.exchange_rate_date ?? '').slice(0, 10)
  }
}

/** 历史用过的港口，供自动补全 */
export function listPorts(): { loading: string[]; destination: string[] } {
  const db = getDb()
  const loading = (
    db.all(
      `SELECT DISTINCT port_of_loading AS p FROM orders
       WHERE port_of_loading != '' ORDER BY port_of_loading`
    ) as Record<string, unknown>[]
  ).map((r) => String(r.p))
  const destination = (
    db.all(
      `SELECT DISTINCT port_of_destination AS p FROM orders
       WHERE port_of_destination != '' ORDER BY port_of_destination`
    ) as Record<string, unknown>[]
  ).map((r) => String(r.p))
  return { loading, destination }
}

/* ---------------- 订单照片 ---------------- */

export function listOrderPhotos(orderId: number): OrderPhoto[] {
  const rows = getDb().all('SELECT * FROM order_photos WHERE order_id = ? ORDER BY id', [orderId]) as Record<
    string,
    unknown
  >[]
  return rows.map(mapOrderPhoto)
}

export function addOrderPhoto(
  orderId: number,
  fileName: string,
  kind: OrderPhoto['kind'] = 'inspection',
  note = ''
): OrderPhoto {
  const db = getDb()
  const res = db.run(
    'INSERT INTO order_photos(order_id, file_name, kind, note, created_at) VALUES(?,?,?,?,?)',
    [orderId, fileName, kind, note, now()]
  )
  const row = db.get('SELECT * FROM order_photos WHERE id = ?', [Number(res.lastInsertRowid)]) as Record<
    string,
    unknown
  >
  logEvent(orderId, 'photo', null, null, `上传${kind === 'container' ? '柜照' : '验货照'}`)
  return mapOrderPhoto(row)
}

export function deleteOrderPhoto(orderId: number, photoId: number): void {
  getDb().run('DELETE FROM order_photos WHERE id = ? AND order_id = ?', [photoId, orderId])
}
