import { getDb, imagesDir, nextNo, transact } from '../db'
import { existsSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { mapOrder, mapOrderItem, mapPayment, mapPackingList, mapPackingListLine, mapEvent, mapSkuSummary, mapOrderPhoto, mapCustomer, mapSettlement } from '../db/mappers'
import { getSettings } from './settings'
import { computeOrderMoney, costInOrderCurrency, moneyForOrders, parseCharges } from './money'
import { likeAny } from './search'
import { applyShipStatus, isShipStatusDerived, shipmentSummary } from './shipping'
import { logEvent } from './events'
import { addDays, daysBetween, isLocalDate, localDate, localDayAfterUtc, localDayStartUtc } from '../../src/shared/date'
import { billPartyOf, emptyParty, parseParty, patchParty, shipPartyOf, stringifyParty } from '../../src/shared/party'
import { isBillingStatus } from '../../src/shared/billing'
import { assertQuantity, assertUnitPrice } from '../../src/shared/guards'
import { PAYMENT_STATUS_LABEL, SETTLEMENT_KIND_LABEL, SHIP_STATUS_LABEL, SHIP_STATUS_ORDER } from '../../src/shared/types'
import type {
  Currency,
  Incoterm,
  Order,
  OrderDetail,
  OrderEvent,
  OrderListPage,
  OrderListRow,
  OrderPhoto,
  PackingList,
  PartySnapshot,
  PaymentMethod,
  PaymentStatus,
  QuotationCharge,
  Settlement,
  SettlementKind,
  ShipStatus,
  SkuSummary
} from '../../src/shared/types'

/** sqlite 绑定参数 */
type Bind = string | number | bigint | boolean | null | Uint8Array

function now(): string {
  return new Date().toISOString()
}

/**
 * 作废 / 失效的单是留档凭据：还能看、还能重印，但不能再往上加明细、装箱或收钱。
 * 以前只有界面把入口藏了，主进程照收不误——一次调用就能把箱单和台账改得对不上。
 */
export function assertOrderWritable(orderId: number, action: string): void {
  const o = getDb().get('SELECT order_no, payment_status FROM orders WHERE id = ?', [orderId]) as
    | { order_no?: string; payment_status?: string }
    | null
  if (!o) throw new Error('订单不存在')
  const no = String(o.order_no ?? '')
  const status = String(o.payment_status ?? '')
  if (status === 'void') {
    throw new Error(`订单 ${no} 已作废，不能再${action}：作废单只是留档，要接着做生意请按新单重开。`)
  }
  if (status === 'expired') {
    throw new Error(`订单 ${no} 已失效，不能再${action}：先把收款状态改回「客户已确认」，再继续。`)
  }
}

/**
 * 出过 CI 的单，单价与费用行就是批次金额的输入：
 * 批次金额 = 箱单件数 × 订单单价 + 费用按货值分摊。改价会让已经发出去的 CI
 * 与系统里重算的批次金额对不上，而存档的 PDF 又不会跟着变。
 * 数量不锁：分批金额按箱单件数算，改整单数量不会改写已出运那批的金额。
 */
function assertPricingEditable(orderId: number, action: string): void {
  const row = getDb().get(
    "SELECT MAX(version) AS v FROM doc_versions WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL",
    [orderId]
  ) as { v?: number | null } | null
  const ver = Number(row?.v ?? 0)
  if (ver > 0) {
    throw new Error(
      `这张单已经出过 CI（第 ${ver} 版存档），不能再${action}：批次金额是按当前单价和费用行算的，改了会和已经发出去的 CI 对不上。确实改错了价，先作废那一版 CI 存档（写明原因），改完重出正确的一版。`
    )
  }
}

/** 费用行是否真的变了（只比标签和金额，空标签不算一行） */
function sameCharges(a: QuotationCharge[], b: QuotationCharge[]): boolean {
  const norm = (list: QuotationCharge[]) =>
    list
      .map((c) => ({ label: String(c.label ?? '').trim(), amount: Number(c.amount) }))
      .filter((c) => c.label)
      .map((c) => `${c.label}|${c.amount.toFixed(4)}`)
      .sort()
  const x = norm(a)
  const y = norm(b)
  return x.length === y.length && x.every((k, i) => k === y[i])
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
  /** 买方抬头覆盖（不传就用客户档案当时的值，存进单子里冻结） */
  billTo?: Partial<PartySnapshot>
  /** 收货抬头覆盖（这单要送别的仓就在这里改） */
  shipTo?: Partial<PartySnapshot>
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
  /** 行成本单价（订单币种） */
  unitCost?: number | null
  /** 工厂成本（基准币）：由服务端按本单汇率折算，前端不要自己乘除 */
  costBase?: number | null
}

export type OrderSort =
  | 'created_desc'
  | 'created_asc'
  | 'amount_desc'
  | 'amount_asc'
  | 'ship_asc'
  /** 待收（折基准币）高→低：催款先看最大的 */
  | 'owed_desc'
  /** 逾期最久的排前面，没逾期的按创建时间 */
  | 'overdue_first'

/** 订单列表的筛选条件 */
export interface OrderListFilter {
  keyword?: string
  paymentStatus?: string
  shipStatus?: string
  customerId?: number
  /** 本地日 YYYY-MM-DD（含这一天） */
  from?: string
  /** 本地日 YYYY-MM-DD（含这一天） */
  to?: string
  sort?: OrderSort
}

/** 排序要看的几列：订单详情和瘦身列表行都有，比较器只写一遍 */
interface SortKeys {
  id: number
  createdAt: string
  /** 货值（原币） */
  totalAmount: number
  exchangeRate: number
  /** 待收（原币） */
  remaining: number
  expectedShipDate: string | null
  shipStatus: ShipStatus
}

/** 出运之后的状态：货已经走了，交期不再算逾期 */
const SHIPPED_STATUSES: ShipStatus[] = ['shipped', 'cleared', 'delivered']

/**
 * 逾期天数（本地日）。
 * 没填预计出货日、货已经出运/清关/签收、或还没到期 → null（不是 0，0 会被当成「今天到期」）。
 */
function daysLateOf(row: { expectedShipDate: string | null; shipStatus: ShipStatus }): number | null {
  if (!row.expectedShipDate || SHIPPED_STATUSES.includes(row.shipStatus)) return null
  const late = daysBetween(row.expectedShipDate, localDate())
  return late > 0 ? late : null
}

/**
 * 列表排序（订单列表与瘦身列表共用同一个比较器）。
 * 金额跨币种比较一律折成基准币，否则 7.1 的 CNY 单会压过 10 万美元的 USD 单。
 */
function sortRows<T extends SortKeys>(list: T[], sort: OrderSort): T[] {
  const base = (o: T) => o.totalAmount * o.exchangeRate
  const byCreated = (a: T, b: T) =>
    a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1
  switch (sort) {
    case 'created_asc':
      return [...list].sort((a, b) => -byCreated(a, b))
    case 'amount_desc':
      return [...list].sort((a, b) => base(b) - base(a) || byCreated(a, b))
    case 'amount_asc':
      return [...list].sort((a, b) => base(a) - base(b) || byCreated(a, b))
    case 'ship_asc':
      return [...list].sort((a, b) => {
        const av = a.expectedShipDate ?? '9999-12-31'
        const bv = b.expectedShipDate ?? '9999-12-31'
        return av === bv ? byCreated(a, b) : av < bv ? -1 : 1
      })
    case 'owed_desc':
      return [...list].sort(
        (a, b) => b.remaining * b.exchangeRate - a.remaining * a.exchangeRate || byCreated(a, b)
      )
    case 'overdue_first':
      return [...list].sort(
        (a, b) => (daysLateOf(b) ?? -1) - (daysLateOf(a) ?? -1) || byCreated(a, b)
      )
    case 'created_desc':
    default:
      return [...list].sort(byCreated)
  }
}

/** 搜索框的关键词命中范围：单据本身 + 明细款号 + 批次柜号/提单号 + 收款流水号 */
function keywordClause(kw: string): { sql: string; params: Bind[] } {
  const own = likeAny(
    [
      'o.order_no',
      'o.pi_no',
      'o.customer_po',
      'c.company',
      'o.port_of_loading',
      'o.port_of_destination',
      'o.factory',
      'o.vessel',
      'o.seal_no'
    ],
    kw
  )
  const items = likeAny(['oi.style_no', 'oi.product_name', 'oi.color', 'oi.size'], kw)
  const batches = likeAny(['pl.pl_no', 'pl.container_no', 'pl.bl_no', 'pl.vessel', 'pl.seal_no'], kw)
  const pays = likeAny(['p.bank_ref'], kw)
  return {
    sql:
      `(${own.sql}
        OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND (${items.sql}))
        OR EXISTS (SELECT 1 FROM packing_lists pl WHERE pl.order_id = o.id AND pl.voided_at IS NULL AND (${batches.sql}))
        OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (${pays.sql})))`,
    params: [...own.params, ...items.params, ...batches.params, ...pays.params]
  }
}

/**
 * 列表 WHERE（订单列表与瘦身列表共用，两边筛出来的单必须一模一样）。
 *
 * 日期区间：created_at 存的是 UTC 时间戳，以前用 date(created_at) 比较是按 UTC 日切，
 * UTC+8 晚上 8 点后建的单会被算到前一天，报表和工作台又按本地日归集——
 * 同一段时间，列表和报表数不一样。现在两端都换成本地日的 UTC 边界。
 */
function listWhere(filter: OrderListFilter): { sql: string; params: Bind[] } {
  const where: string[] = []
  const params: Bind[] = []
  const kw = (filter.keyword ?? '').trim()
  if (kw) {
    const clause = keywordClause(kw)
    where.push(clause.sql)
    params.push(...clause.params)
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
    const gte = localDayStartUtc(filter.from)
    if (!gte) throw new Error('开始日期要填完整（例如 2026-10-01）。')
    where.push('o.created_at >= ?')
    params.push(gte)
  }
  if (filter.to) {
    const lt = localDayAfterUtc(filter.to)
    if (!lt) throw new Error('结束日期要填完整（例如 2026-10-31）。')
    where.push('o.created_at < ?')
    params.push(lt)
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
}

/**
 * 当前筛选命中的订单 id，与订单列表共用同一个 listWhere。
 * 导出台账拿它过滤：页面上筛出几张，Excel 里就是几张，合计才对得上。
 */
export function listOrderIds(filter: OrderListFilter = {}): number[] {
  const db = getDb()
  const w = listWhere(filter)
  const rows = db.all(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id ${w.sql}`,
    w.params
  ) as { id?: number }[]
  return rows.map((r) => Number(r.id))
}

/**
 * 全量展开的订单列表：每张单都要展开明细 / 收款 / 装箱 / 抬头。
 * 页面列表不许用它（用 listOrderRows），这里留给脚本和口径校验当参照。
 */
export function listOrders(filter: OrderListFilter = {}): OrderDetail[] {
  const db = getDb()
  const w = listWhere(filter)
  const rows = db.all(
    `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id ${w.sql}`,
    w.params
  ) as Record<string, unknown>[]
  return sortRows(rows.map((r) => hydrate(mapOrder(r), r)), filter.sort ?? 'created_desc')
}

/**
 * 订单列表（瘦身版）：整页固定几条查询，不再逐单展开。
 *
 * 以前 300 张单点一下列表要等 2.7 秒（每张单 9 条查询），
 * 列表上那些字段其实一条明细都不需要。
 * 金额仍走 moneyForOrders → computeOrderMoney，与详情/单据/报表同一口径。
 *
 * 排序要先看全筛选集才能排（金额、待收、逾期都不是数据库里的列），
 * 所以先算完再切页；总数按筛选条件给，分页拿的是它而不是本页行数。
 */
export function listOrderRows(
  filter: OrderListFilter & { limit?: number; offset?: number } = {}
): OrderListPage {
  const db = getDb()
  const w = listWhere(filter)
  const rows = db.all(
    `SELECT o.id, o.order_no, o.pi_no, o.customer_po, o.currency, o.exchange_rate, o.base_currency,
            o.payment_status, o.ship_status, o.port_of_loading, o.port_of_destination,
            o.factory, o.vessel, o.seal_no, o.etd_date, o.cut_off_date, o.expected_ship_date,
            o.valid_until, o.charges, o.deposit_ratio, o.created_at,
            o.customer_id, c.company AS customer_company, c.country AS customer_country
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ${w.sql}`,
    w.params
  ) as Record<string, unknown>[]

  const moneyBy = moneyForOrders(
    rows.map((r) => ({
      id: Number(r.id),
      charges: r.charges,
      depositRatio: Number(r.deposit_ratio ?? 0)
    }))
  )
  const ids = rows.map((r) => Number(r.id))
  const ph = ids.map(() => '?').join(',')
  const packBy = new Map<number, { qty: number; batches: number; containers: string }>()
  const styleBy = new Map<number, { styles: number; first: string }>()
  if (ids.length > 0) {
    // 已装箱件数、批次数与柜号：作废批次和空批次都不算（和 shipmentSummary 一个口径）
    const packRows = db.all(
      `SELECT pl.order_id AS order_id, COUNT(*) AS batches,
              COALESCE(SUM(t.qty), 0) AS qty,
              GROUP_CONCAT(DISTINCT NULLIF(t.container_no, '')) AS containers
       FROM (
         SELECT pl2.id, pl2.order_id, pl2.container_no, COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_lists pl2
         LEFT JOIN packing_list_lines l ON l.packing_list_id = pl2.id
         WHERE pl2.order_id IN (${ph}) AND pl2.voided_at IS NULL
         GROUP BY pl2.id
         HAVING COALESCE(SUM(l.quantity), 0) > 0
       ) t JOIN packing_lists pl ON pl.id = t.id
       GROUP BY pl.order_id`,
      ids
    ) as Record<string, unknown>[]
    for (const r of packRows)
      packBy.set(Number(r.order_id), {
        qty: Number(r.qty ?? 0),
        batches: Number(r.batches ?? 0),
        containers: String(r.containers ?? '')
      })
    const styleRows = db.all(
      `SELECT order_id, COUNT(DISTINCT TRIM(style_no)) AS styles, MIN(style_no) AS first_style
       FROM order_items WHERE order_id IN (${ph}) GROUP BY order_id`,
      ids
    ) as Record<string, unknown>[]
    for (const r of styleRows)
      styleBy.set(Number(r.order_id), { styles: Number(r.styles ?? 0), first: String(r.first_style ?? '') })
  }

  const list: OrderListRow[] = rows.map((r) => {
    const id = Number(r.id)
    const m = moneyBy.get(id)!
    const rate = Number(r.exchange_rate ?? 1)
    const pack = packBy.get(id) ?? { qty: 0, batches: 0, containers: '' }
    const style = styleBy.get(id) ?? { styles: 0, first: '' }
    const shipStatus = String(r.ship_status ?? 'not_prepared') as ShipStatus
    return {
      id,
      orderNo: String(r.order_no ?? ''),
      piNo: String(r.pi_no ?? ''),
      customerPo: String(r.customer_po ?? ''),
      currency: String(r.currency ?? 'USD') as Currency,
      exchangeRate: rate,
      baseCurrency: String(r.base_currency ?? 'CNY') as Currency,
      paymentStatus: String(r.payment_status ?? '') as PaymentStatus,
      shipStatus,
      customer: { id: Number(r.customer_id), company: String(r.customer_company ?? ''), country: String(r.customer_country ?? '') },
      portOfLoading: String(r.port_of_loading ?? ''),
      portOfDestination: String(r.port_of_destination ?? ''),
      factory: String(r.factory ?? ''),
      vessel: String(r.vessel ?? ''),
      sealNo: String(r.seal_no ?? ''),
      etdDate: r.etd_date == null ? null : String(r.etd_date),
      cutOffDate: r.cut_off_date == null ? null : String(r.cut_off_date),
      expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date),
      validUntil: r.valid_until == null ? null : String(r.valid_until),
      createdAt: String(r.created_at ?? ''),
      totalAmount: m.goodsValue,
      chargesTotal: m.chargesTotal,
      grandTotal: m.grandTotal,
      paidAmount: m.paidAmount,
      remaining: m.receivable,
      remainingBase: m.receivable * rate,
      totalQuantity: m.totalQuantity,
      packedQuantity: pack.qty,
      batchCount: pack.batches,
      containerNos: pack.containers,
      chargesCount: parseCharges(r.charges).length,
      styleCount: style.styles,
      firstStyleNo: style.first,
      missingCostItems: m.missingCostItems,
      daysLate: daysLateOf({ expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date), shipStatus })
    }
  })

  const sorted = sortRows(list, filter.sort ?? 'created_desc')
  const offset = Math.max(0, Math.floor(Number(filter.offset ?? 0)) || 0)
  const limit = Number(filter.limit)
  const page = Number.isFinite(limit) && limit > 0 ? sorted.slice(offset, offset + Math.floor(limit)) : sorted
  // 合计按整个筛选集算（不是本页），否则翻一页换一个总数，等于给了个假数
  const billing = sorted.filter((r) => isBillingStatus(r.paymentStatus))
  return {
    rows: page,
    total: sorted.length,
    owedBaseTotal: billing.reduce((s, r) => s + r.remainingBase, 0),
    grandBaseTotal: billing.reduce((s, r) => s + r.grandTotal * r.exchangeRate, 0)
  }
}

/** 读取订单并展开关联数据与汇总 */
export function getOrder(id: number): OrderDetail | null {
  const row = getDb().get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
  if (!row) return null
  return hydrate(mapOrder(row), row)
}

function hydrate(order: Order, row?: Record<string, unknown>): OrderDetail {
  const db = getDb()
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [order.customerId]) as
    | Record<string, unknown>
    | null
  const liveCustomer = customerRow ? mapCustomer(customerRow) : null
  // 抬头优先用单子上钉死的快照；升级前的老单子没有快照，回退客户档案（保持原行为）
  const billTo = parseParty(row?.bill_to_json) ?? billPartyOf(liveCustomer)
  const shipTo = parseParty(row?.ship_to_json) ?? shipPartyOf(liveCustomer)
  const items = (
    db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY style_no, color, size, id', [order.id]) as Record<
      string,
      unknown
    >[]
  ).map(mapOrderItem)
  const payments = (
    db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at, id', [order.id]) as Record<string, unknown>[]
  ).map(mapPayment)
  const settlements = (
    db.all('SELECT * FROM order_settlements WHERE order_id = ? ORDER BY at, id', [order.id]) as Record<
      string,
      unknown
    >[]
  ).map(mapSettlement)
  const sourceQuotationNo = order.sourceQuotationId
    ? String(
        (
          db.get('SELECT q_no FROM quotations WHERE id = ?', [order.sourceQuotationId]) as
            | { q_no?: string }
            | null
        )?.q_no ?? ''
      )
    : ''
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
    settlements: settlements.map((s) => ({ kind: s.kind, amount: s.amount })),
    depositRatio: order.depositRatio
  })

  return {
    ...order,
    customer: liveCustomer,
    billTo,
    shipTo,
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
    writeOffShortage: m.shortageAmount,
    writeOffBadDebt: m.badDebtAmount,
    badDebtOutstanding: m.badDebtOutstanding,
    writtenOff: m.writtenOff,
    settlements,
    sourceQuotationNo,
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

/** 建单时把客户档案当时的抬头钉在这张单上（改档案不再影响已发出的单据） */
function partiesForOrder(
  customerId: number,
  patch: { billTo?: Partial<PartySnapshot>; shipTo?: Partial<PartySnapshot> } = {}
): { bill: string; ship: string } {
  const row = getDb().get('SELECT * FROM customers WHERE id = ?', [customerId]) as Record<string, unknown> | null
  const c = row ? mapCustomer(row) : null
  if (!c) throw new Error(`客户编号 ${customerId} 不存在，不能建单`)
  return {
    bill: stringifyParty(patchParty(billPartyOf(c), patch.billTo)),
    ship: stringifyParty(patchParty(shipPartyOf(c), patch.shipTo))
  }
}

export function createOrder(input: OrderInput): OrderDetail {
  const db = getDb()
  const settings = getSettings()
  const ts = now()
  const validUntil = input.validUntil ?? addDays(localDate(), settings.piValidDays)
  // 汇率锁定日期：默认记今天（本地日期）
  const rateDate = input.exchangeRateDate ?? localDate()
  // 收款状态：报价单转单时可以指定（PI 已发 = sent），默认草稿
  const status: PaymentStatus = input.paymentStatus ?? 'draft'
  // 费用行（运费/保险等）存 JSON
  const chargesJson = JSON.stringify((input.charges ?? []).filter((c) => c.label.trim()))
  const parties = partiesForOrder(input.customerId, input)

  // 烧号也放进事务：以前在事务外取号，保存失败（撞号、校验不过、转单回滚）时
  // 单没建成、号已烧掉，SO/PI 是客户对账凭据，凭空跳号对不上水单
  const orderId = transact(() => {
    const orderNo = nextNo('SO')
    const piNo = input.piNo?.trim() || nextNo('PI')
    // 单号是凭据：手工指定的 PI 号不能跟别的订单撞号（与打样单号同一条规矩，N-3）。
    // 查重放在事务里，查完到写入之间没有别人能插一张同号的单进来。
    if (input.piNo?.trim() && piNoTaken(input.piNo.trim())) throw piDupErr(piNo)
    const res = db.run(
      `INSERT INTO orders(order_no, customer_id, pi_no, payment_status, ship_status, currency, exchange_rate,
        base_currency, incoterm, port_of_loading, port_of_destination, payment_method, deposit_ratio,
        valid_until, expected_ship_date, expected_arrival_date, customer_po, note,
        exchange_rate_date, factory, factory_due_date, cut_off_date, etd_date, vessel, seal_no, charges,
        bill_to_json, ship_to_json, created_at, updated_at)
       VALUES(?,?,?,?,'not_prepared',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        parties.bill,
        parties.ship,
        ts,
        ts
      ]
    )
    const id = Number(res.lastInsertRowid)
    logEvent(id, 'create', null, status, `创建订单 ${orderNo}`)
    return id
  })
  return getOrder(orderId)!
}

export function updateOrder(id: number, input: OrderInput): OrderDetail {
  const db = getDb()
  const ts = now()
  const before = db.get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
  if (!before) throw new Error('订单不存在')
  assertOrderWritable(id, '改这张单')
  // 单号是凭据：编辑时把 PI 号改成别人的号要拦住（改成自己的号不算重号）
  const oldPiNo = String(before.pi_no ?? '').trim()
  const newPiNo = input.piNo === undefined ? oldPiNo : String(input.piNo).trim()
  if (newPiNo && newPiNo !== oldPiNo && piNoTaken(newPiNo, id)) throw piDupErr(newPiNo)
  // 已经开出去的 PI 号要被报关、要被对账，清空等于把凭据抹了还不留话
  if (oldPiNo && !newPiNo)
    throw new Error(`PI 号 ${oldPiNo} 已经写在这张单上，不能清空——确实不要这个号请作废这张单后重开。`)

  // 汇率是锁定的凭据：清空或填 0 不许悄悄落成 1——
  // 1 会让整单金额按错汇率折算，四张单据、报表、待收全跟着错
  const newRate = Number(input.exchangeRate ?? before.exchange_rate)
  if (!(newRate > 0)) throw new Error('汇率必须大于 0，清空汇率不能保存')
  const oldRate = Number(before.exchange_rate)
  const newCurrency = (input.currency ?? String(before.currency ?? 'USD')) as Currency
  const oldCurrency = String(before.currency ?? 'USD') as Currency
  const payCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
  )
  const settleCount = Number(
    (
      db.get('SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?', [id]) as
        | { n?: number }
        | null
    )?.n ?? 0
  )
  const itemCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
  )
  const docCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM doc_versions WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
  )
  // PI 号印在已经发出去的单据上，CI 号又是由 PI 号派生的：改了号，重印的纸和客户手里那张对不上
  if (newPiNo !== oldPiNo && docCount > 0) {
    throw new Error(
      `这张单已经有 ${docCount} 份单据存档，PI 号 ${oldPiNo} 印在纸面上、CI 号也由它派生，不能再改。确实要换号，请作废这张单后按新单重开。`
    )
  }
  const plCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM packing_lists WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
  )
  // 汇率印在纸面上（PI/CI 都有 Exchange Rate 一行），也参与核销的账：
  // 这两样一旦落定，改汇率就会和已发出的纸面、已核定的账对不上。
  // 只登记了收款、还没出单据时不锁——录错汇率要能修正，操作历史里有旧值 → 新值。
  if (newRate !== oldRate && (docCount > 0 || settleCount > 0)) {
    const why =
      docCount > 0
        ? `${docCount} 份单据存档（纸面上印着 1 ${oldCurrency} = ${oldRate}）`
        : `${settleCount} 笔核销`
    throw new Error(
      `这张单已经有 ${why}，汇率不能再改：改了会和已经发出去的纸面、已经核定的账对不上。确实要按新汇率重算，请作废这张单后按新单重开。`
    )
  }
  if (newCurrency !== oldCurrency) {
    // 明细单价没有独立币种：已经对外发过（或已出单据/箱单）的单换币种，
    // 等于把 100 USD 的单价当成 100 EUR 用。草稿还没发出去，允许改错字。
    const released =
      String(before.payment_status ?? '') !== 'draft' || docCount > 0 || plCount > 0
    if (itemCount > 0 && released) {
      throw new Error(
        `这张单已经有 ${itemCount} 行明细，而且已经对外发过（不是草稿），不能改币种——单价都是按 ${oldCurrency} 记的，100 ${oldCurrency} 会被当成 100 ${newCurrency}。确实要换币种，请作废这张单后按新单重开。`
      )
    }
    // 收款是按原币登记的凭据：改币种会让历史收款、银行流水和客户对账全部错位
    if (payCount > 0 || settleCount > 0) {
      const what = payCount > 0 ? `${payCount} 笔收款` : `${settleCount} 笔核销`
      throw new Error(
        `这张单已经登记了 ${what}，不能改币种——历史金额都是按 ${oldCurrency} 记的，改了会和银行流水、核销记录对不上。确实要换币种，请作废这张单后按正确币种重开。`
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
  if (input.charges !== undefined) {
    assertChargeAmounts(input.charges)
    if (!sameCharges(parseCharges(before.charges), input.charges)) {
      assertPricingEditable(id, '改费用行')
    }
  }
  const chargesJson =
    input.charges === undefined
      ? String(before.charges ?? '[]')
      : JSON.stringify(input.charges.filter((c) => c.label.trim()))

  // 抬头快照：换了客户就按新客户重新钉一次；没换客户则保住单子上原有的快照，
  // 只把用户这次明确改动的字段写进去（改档案绝不会顺带动到已发出的单据）
  // customerId 也可能整条没传（只改备注的编辑）——那时这张单还挂在原客户名下
  const nextCustomerId = input.customerId === undefined ? Number(before.customer_id) : Number(input.customerId)
  const customerChanged = Number(before.customer_id) !== nextCustomerId
  const fresh = partiesForOrder(nextCustomerId, {})
  const baseBill = (customerChanged ? null : parseParty(before.bill_to_json)) ?? parseParty(fresh.bill) ?? emptyParty()
  const baseShip = (customerChanged ? null : parseParty(before.ship_to_json)) ?? parseParty(fresh.ship) ?? emptyParty()
  const billJson = stringifyParty(patchParty(baseBill, input.billTo))
  const shipJson = stringifyParty(patchParty(baseShip, input.shipTo))

  /**
   * 只写「这次真的传了」的列：input 里没有的键保留数据库原值。
   * 以前这里是全量替换（input.x ?? null），调用方少传一个日期，
   * 那张单的交期 / ETD / 截关就被静默清空——单据早发出去了，界面上看不出少了东西。
   * 语义：undefined = 这次没提，保留原值；null 或 '' = 用户明确清空。
   */
  const keep = (key: keyof OrderInput, col: string): unknown => (input[key] === undefined ? before[col] : input[key])
  /** 日期列收口：空串一律存 NULL，不让 '' 混进日期比较 */
  const keepDate = (key: keyof OrderInput, col: string): string | null => {
    const v = keep(key, col)
    return v === '' || v == null ? null : String(v)
  }
  const keepText = (key: keyof OrderInput, col: string): string => {
    const v = keep(key, col)
    return v == null ? '' : String(v)
  }
  const settings = getSettings()
  const cells: Array<[string, unknown]> = [
    ['customer_id', nextCustomerId],
    ['currency', newCurrency],
    ['exchange_rate', newRate],
    ['base_currency', keepText('baseCurrency', 'base_currency') || settings.baseCurrency],
    ['incoterm', keepText('incoterm', 'incoterm') || 'FOB'],
    ['port_of_loading', keepText('portOfLoading', 'port_of_loading')],
    ['port_of_destination', keepText('portOfDestination', 'port_of_destination')],
    ['payment_method', keepText('paymentMethod', 'payment_method') || 'tt_deposit'],
    ['deposit_ratio', keep('depositRatio', 'deposit_ratio') ?? settings.defaultDepositRatio],
    ['valid_until', keepDate('validUntil', 'valid_until')],
    ['expected_ship_date', keepDate('expectedShipDate', 'expected_ship_date')],
    ['expected_arrival_date', keepDate('expectedArrivalDate', 'expected_arrival_date')],
    ['customer_po', keepText('customerPo', 'customer_po')],
    ['note', keepText('note', 'note')],
    ['pi_no', newPiNo],
    ['exchange_rate_date', rateDate],
    ['factory', keepText('factory', 'factory')],
    ['factory_due_date', keepDate('factoryDueDate', 'factory_due_date')],
    ['cut_off_date', keepDate('cutOffDate', 'cut_off_date')],
    ['etd_date', keepDate('etdDate', 'etd_date')],
    ['vessel', keepText('vessel', 'vessel')],
    ['seal_no', keepText('sealNo', 'seal_no')],
    ['charges', chargesJson],
    ['bill_to_json', billJson],
    ['ship_to_json', shipJson]
  ]
  transact(() => {
    db.run(
      `UPDATE orders SET ${cells.map(([col]) => `${col}=?`).join(', ')}, updated_at=? WHERE id=?`,
      [...cells.map(([, v]) => v as string | number | null), ts, id]
    )
    logEvent(id, 'update', null, null, describeOrderChange(before, input))
    // 收款金额变了，状态可能需要重算
    recomputePaymentStatus(id)
  })
  return getOrder(id)!
}

/**
 * 单独改这张单的抬头（客户这单要送别的仓 / 抬头写错了）。
 * 只动快照，不动客户档案——档案改了不能把已经发出去的单据改掉。
 */
export function setOrderParties(
  orderId: number,
  patch: { billTo?: Partial<PartySnapshot>; shipTo?: Partial<PartySnapshot> }
): OrderDetail {
  const db = getDb()
  const row = db.get('SELECT * FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
  if (!row) throw new Error('订单不存在')
  assertOrderWritable(orderId, '改抬头')
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [Number(row.customer_id)]) as
    | Record<string, unknown>
    | null
  const live = customerRow ? mapCustomer(customerRow) : null
  const baseBill = parseParty(row.bill_to_json) ?? billPartyOf(live) ?? emptyParty()
  const baseShip = parseParty(row.ship_to_json) ?? shipPartyOf(live) ?? emptyParty()
  const billJson = stringifyParty(patchParty(baseBill, patch.billTo))
  const shipJson = stringifyParty(patchParty(baseShip, patch.shipTo))
  db.run('UPDATE orders SET bill_to_json=?, ship_to_json=?, updated_at=? WHERE id=?', [
    billJson,
    shipJson,
    now(),
    orderId
  ])
  const changed: string[] = []
  const labels: Record<keyof PartySnapshot, string> = {
    company: '公司',
    attn: '收件人',
    contact: '联系人',
    address: '地址',
    zipCode: '邮编',
    country: '国家',
    email: '邮箱',
    phone: '电话',
    paymentPref: '付款条款'
  }
  const diff = (title: string, base: PartySnapshot, p?: Partial<PartySnapshot>) => {
    if (!p) return
    const parts = (Object.keys(p) as (keyof PartySnapshot)[])
      .filter((k) => p[k] !== undefined && String(p[k]) !== String(base[k]))
      .map((k) => `${labels[k]} ${base[k] || '空'} → ${String(p[k]) || '空'}`)
    if (parts.length) changed.push(`${title}：${parts.join('；')}`)
  }
  diff('买方抬头', baseBill, patch.billTo)
  diff('收货抬头', baseShip, patch.shipTo)
  logEvent(orderId, 'party_update', null, null, changed.join('；') || '抬头没改动')
  return getOrder(orderId)!
}

/** 生成一条人话版的「改了什么」记录 */
function describeOrderChange(before: Record<string, unknown>, input: OrderInput): string {
  const parts: string[] = []
  const shown = (v: unknown): string => (v === null || v === undefined || v === '' ? '空' : String(v))
  /**
   * 只比「这次真的传了」的字段。漏传一个日期不等于把它清空，
   * 否则一次只改备注的保存会在历史里留下一串「交期 xxx → 空」，反而把真改动淹了。
   */
  const cmp = (label: string, key: keyof OrderInput, col: string) => {
    if (input[key] === undefined) return
    const old = before[col]
    const next = input[key]
    if (shown(old) !== shown(next)) parts.push(`${label} ${shown(old)} → ${shown(next)}`)
  }
  cmp('币种', 'currency', 'currency')
  cmp('汇率', 'exchangeRate', 'exchange_rate')
  cmp('贸易术语', 'incoterm', 'incoterm')
  cmp('装运港', 'portOfLoading', 'port_of_loading')
  cmp('目的港', 'portOfDestination', 'port_of_destination')
  cmp('付款方式', 'paymentMethod', 'payment_method')
  cmp('定金比例', 'depositRatio', 'deposit_ratio')
  cmp('PI号', 'piNo', 'pi_no')
  cmp('客户PO', 'customerPo', 'customer_po')
  cmp('工厂', 'factory', 'factory')
  cmp('船名航次', 'vessel', 'vessel')
  cmp('封条号', 'sealNo', 'seal_no')
  cmp('备注', 'note', 'note')
  // 日期改动最容易扯皮：客户说交期改过没、报关卡的是哪一版——逐条记 before → after
  cmp('有效期', 'validUntil', 'valid_until')
  cmp('预计开船', 'expectedShipDate', 'expected_ship_date')
  cmp('预计到港', 'expectedArrivalDate', 'expected_arrival_date')
  cmp('工厂交期', 'factoryDueDate', 'factory_due_date')
  cmp('截关日', 'cutOffDate', 'cut_off_date')
  cmp('ETD', 'etdDate', 'etd_date')
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
export function voidOrder(id: number, reason = '', opts: { confirmDocs?: boolean } = {}): OrderDetail {
  const db = getDb()
  const cur = db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [id]) as
    | { order_no: string; payment_status: string }
    | null
  if (!cur) throw new Error('订单不存在')
  if (cur.payment_status === 'void') return getOrder(id)!
  // 凭据核对闸门：PI/CI 已发到客户手里、批次已出运的单不能一键作废——
  // 作废后系统退出应收口径，但客户手里的纸面凭据不会消失，报关/收汇在途的钱会和系统脱节。
  // 不拦死（真要作废是合法终态），但要人先核对再勾确认，操作历史里留下核对痕迹。
  const docCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM doc_versions WHERE order_id = ? AND voided_at IS NULL', [id]) as { n?: number } | null)
      ?.n ?? 0
  )
  const plCount = Number(
    (db.get('SELECT COUNT(*) AS n FROM packing_lists WHERE order_id = ? AND voided_at IS NULL', [id]) as { n?: number } | null)
      ?.n ?? 0
  )
  if ((docCount > 0 || plCount > 0) && !opts.confirmDocs) {
    const parts: string[] = []
    if (docCount > 0) parts.push(`${docCount} 版单据存档（PI/CI 可能已发到客户手里）`)
    if (plCount > 0) parts.push(`${plCount} 批箱单`)
    throw new Error(
      `这张订单还有 ${parts.join(' 和 ')}。作废后系统不再认账，但这些纸面凭据不会消失，` +
        `报关/收汇在途的钱会和系统脱节。请先核对这些凭据的处理，在作废确认框里勾选「凭据已核对」再作废。`
    )
  }
  transact(() => {
    db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', ['void', now(), id])
    // 下单抵扣的样品费不能跟着凭空消失：订单作废退出应收口径，
    // 打样单还挂着「已抵扣」的话，客户实际欠的样品费会从欠款榜、工作台同时蒸发。
    // 回退成未收（抵扣历史留在备注里），打样费回到该在的地方
    const offsetSamples = db.all(
      `SELECT id, sample_no, fee_note FROM sample_orders
       WHERE converted_order_id = ? AND fee_status = 'offset'`,
      [id]
    ) as Record<string, unknown>[]
    for (const s of offsetSamples) {
      db.run(
        `UPDATE sample_orders SET fee_status = 'unpaid',
          fee_note = ?, updated_at = ? WHERE id = ?`,
        [
          `${String(s.fee_note ?? '')}；订单 ${cur.order_no} 已作废，抵扣回退为未收`,
          now(),
          Number(s.id)
        ]
      )
      logEvent(
        id,
        'sample_offset_back',
        null,
        null,
        `打样单 ${String(s.sample_no ?? '')} 的样品费抵扣随订单作废回退为未收`
      )
    }
    logEvent(
      id,
      'void',
      cur.payment_status,
      'void',
      `作废订单 ${cur.order_no}${reason ? '：' + reason : ''}${
        docCount > 0 || plCount > 0 ? `（凭据已核对：${docCount} 版单据存档、${plCount} 批箱单）` : ''
      }`
    )
  })
  return getOrder(id)!
}

/**
 * 物理删除：只允许删「从没收过钱、也没有明细和任何凭据」的空单。
 * 有钱、有箱单、有单据存档、有照片的订单必须走「作废」——
 * 这些记录都是外发过或对过账的凭据，跟着订单一起删掉就再也查不回来了。
 */
export function deleteOrder(id: number): void {
  const db = getDb()
  const row = db.get(
    `SELECT o.order_no, o.payment_status,
            (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS pay_cnt,
            (SELECT COUNT(*) FROM order_settlements s WHERE s.order_id = o.id) AS settle_cnt,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_cnt,
            (SELECT COUNT(*) FROM packing_lists pl WHERE pl.order_id = o.id) AS pl_cnt,
            (SELECT COUNT(*) FROM doc_versions d WHERE d.order_id = o.id) AS doc_cnt,
            (SELECT COUNT(*) FROM order_photos ph WHERE ph.order_id = o.id) AS photo_cnt,
            (SELECT COUNT(*) FROM sample_orders so WHERE so.converted_order_id = o.id) AS sample_cnt
     FROM orders o WHERE o.id = ?`,
    [id]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('订单不存在')
  const orderNo = String(row.order_no ?? '')
  if (String(row.payment_status ?? '') === 'void') {
    throw new Error(`订单 ${orderNo} 已经作废，作废单是留档凭据，不能删除；要重新做生意请按新单重开。`)
  }
  const cnt = (k: string): number => Number(row[k] ?? 0)
  const bits: string[] = []
  if (cnt('item_cnt')) bits.push(`${cnt('item_cnt')} 行明细`)
  if (cnt('pay_cnt')) bits.push(`${cnt('pay_cnt')} 笔收款`)
  if (cnt('settle_cnt')) bits.push(`${cnt('settle_cnt')} 笔核销`)
  if (cnt('pl_cnt')) bits.push(`${cnt('pl_cnt')} 张装箱单`)
  if (cnt('doc_cnt')) bits.push(`${cnt('doc_cnt')} 份单据存档`)
  if (cnt('photo_cnt')) bits.push(`${cnt('photo_cnt')} 张照片`)
  if (cnt('sample_cnt')) bits.push(`由它转出的 ${cnt('sample_cnt')} 张打样单`)
  if (bits.length > 0) {
    throw new Error(
      `订单 ${orderNo} 已经有 ${bits.join('、')}，不能直接删（删了这些凭据和操作历史会一起没有）。请用「作废」：记录全留，只是不再计入销售额和待收款。`
    )
  }
  db.run('DELETE FROM orders WHERE id = ?', [id])
}

/**
 * 费用金额必须是有限数：输入框里删空会给出 NaN，JSON 一序列化就成了 null，
 * 落库后费用行看着在、金额却按 0 算，CI/PI 合计和应收会静默少掉一笔。
 */
function assertChargeAmounts(charges: QuotationCharge[]): void {
  for (const c of charges) {
    const amount = Number(c.amount)
    if (!Number.isFinite(amount)) {
      const who = String(c.label ?? '').trim() || '未命名费用'
      throw new Error(`费用「${who}」的金额不是有效数字（${String(c.amount)}），请填一个金额再保存。`)
    }
  }
}

/** 只改费用行（运费/保险），其他字段一个都不动 */
export function updateOrderCharges(orderId: number, charges: QuotationCharge[]): OrderDetail {
  const db = getDb()
  const before = db.get('SELECT charges FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
  if (!before) throw new Error('订单不存在')
  assertOrderWritable(orderId, '改费用行')
  assertChargeAmounts(charges)
  const clean = charges.filter((c) => c.label.trim())
  if (!sameCharges(parseCharges(before.charges), clean)) assertPricingEditable(orderId, '改费用行')
  // 改费用、留痕、重算状态必须同生同死：中途失败留着「费用改了、应收没重算」的单
  transact(() => {
    db.run('UPDATE orders SET charges=?, updated_at=? WHERE id=?', [JSON.stringify(clean), now(), orderId])
    const parts = describeChargeChange(parseCharges(before.charges), clean)
    logEvent(orderId, 'update', null, null, parts.length ? `修改费用：${parts.join('；')}` : '修改费用行')
    recomputePaymentStatus(orderId)
  })
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

/**
 * 行成本一律按订单币种存。
 * 前端传 costBase（工厂报的人民币价）时，这里按本单汇率折算——
 * 以前把 ¥30 直接当 $30 写进 unit_cost，毛利差一整个汇率。
 */
function resolveItemCost(orderId: number, item: { unitCost?: number | null; costBase?: number | null }): number | null {
  if (item.costBase !== undefined && item.costBase !== null) {
    const row = getDb().get('SELECT exchange_rate FROM orders WHERE id = ?', [orderId]) as
      | { exchange_rate?: number }
      | null
    return costInOrderCurrency(item.costBase, Number(row?.exchange_rate ?? 1))
  }
  return item.unitCost ?? null
}

/**
 * 同一个 款号×颜色×尺码 只许有一行明细。
 * 两行不同单价会按数量加权出一个中间价，已经出过 CI 的批次货值跟着变，
 * 纸面金额却被存档钉住——费用倒推出来就可能是负数。
 */
function assertSkuUnique(
  orderId: number,
  sku: { styleNo: string; color: string; size: string },
  exceptItemId?: number
): void {
  const row = getDb().get(
    `SELECT id FROM order_items
     WHERE order_id = ? AND style_no = ? AND color = ? AND size = ?${exceptItemId ? ' AND id != ?' : ''}
     LIMIT 1`,
    exceptItemId
      ? [orderId, sku.styleNo, sku.color, sku.size, exceptItemId]
      : [orderId, sku.styleNo, sku.color, sku.size]
  )
  if (!row) return
  const label = [sku.styleNo || '未填款号', sku.color, sku.size].filter(Boolean).join(' / ')
  throw new Error(
    `款号 ${label} 已经有明细了。同一款只能有一行：两行不同单价会按数量加权，把已经发出去的 CI 金额算乱。请直接改那一行的数量或单价。`
  )
}

/** 已经装进未作废批次的款号不许再加一行：那批的 CI 金额按当时明细算，补一行会把纸面金额改掉 */
function assertSkuNotPacked(orderId: number, sku: { styleNo: string; color: string; size: string }): void {
  const packed = packedQty(orderId, sku)
  if (packed <= 0) return
  const label = [sku.styleNo || '未填款号', sku.color, sku.size].filter(Boolean).join(' / ')
  throw new Error(
    `款号 ${label} 已经装了 ${packed} 件箱，不能再新加一行：这一批的 CI 金额是按当时明细的单价算的，补一行同款会让纸面金额对不上。要补货请改对应箱明细，或按新批次装。`
  )
}

/** 插一行的底层动作：数量/单价闸门 + 插入 + 逐行留痕（批量入口共用一个事务） */
function insertOrderItem(orderId: number, item: OrderItemInput): void {
  const db = getDb()
  const who = `款号 ${item.styleNo || '未填'}`
  assertQuantity(item.quantity, `${who} 的数量`)
  assertUnitPrice(item.unitPrice, `${who} 的单价`)
  const sku = { styleNo: item.styleNo, color: item.color ?? '', size: item.size ?? '' }
  assertSkuUnique(orderId, sku)
  assertSkuNotPacked(orderId, sku)
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
      resolveItemCost(orderId, item)
    ]
  )
  logEvent(orderId, 'item_add', null, null, `添加 SKU ${item.styleNo} ${item.color}/${item.size} × ${item.quantity}`)
}

export function addOrderItem(orderId: number, item: OrderItemInput): OrderDetail {
  return addOrderItems(orderId, [item])
}

/**
 * 批量加行：整批一个事务。
 * 以前是前端循环调 addItem——第 3 行没过校验时前两行已经躺在库里，
 * 订单明细半截，用户只看到一条报错，不知道单子已经多了两行来路不明的 SKU。
 */
export function addOrderItems(orderId: number, items: OrderItemInput[]): OrderDetail {
  const db = getDb()
  assertOrderWritable(orderId, '加明细')
  transact(() => {
    for (const item of items) insertOrderItem(orderId, item)
    db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
    // 件数变了，订单的「装够没有 / 走了没有」跟着变
    applyShipStatus(orderId)
    // 金额变了，应收总额 / 定金 / 待收都变了，收款状态要重算（可以往上也可以往下）
    recomputePaymentStatus(orderId)
  })
  return getOrder(orderId)!
}

/** 这一款（款号×颜色×尺码）在所有装箱单里已经装了多少件 */
function packedQty(orderId: number, sku: { styleNo: string; color: string; size: string }): number {
  return Number(
    (
      getDb().get(
        `SELECT COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
         WHERE pl.order_id = ? AND pl.voided_at IS NULL
           AND l.style_no = ? AND l.color = ? AND l.size = ?`,
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
  assertOrderWritable(orderId, '改明细')
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
  if (skuChanged) {
    // 换过去的款也必须守两条：明细不重复、不能撞上已经装箱的款
    assertSkuUnique(orderId, nextSku, itemId)
    assertSkuNotPacked(orderId, nextSku)
  }
  if (!skuChanged && patch.quantity !== undefined && Number(patch.quantity) < packed) {
    assertNotBelowPacked(orderId, curSku)
  }
  // 数量/单价闸门：只校验这次真的传了的键（没传是「不改」，不是「填 0」）
  const lineWho = `款号 ${nextSku.styleNo || '未填'} ${nextSku.color}/${nextSku.size}`
  if (patch.quantity !== undefined) assertQuantity(patch.quantity, `${lineWho} 的数量`)
  if (patch.unitPrice !== undefined) assertUnitPrice(patch.unitPrice, `${lineWho} 的单价`)
  if (patch.unitPrice !== undefined && Number(patch.unitPrice) !== Number(cur.unit_price)) {
    assertPricingEditable(orderId, '改明细单价')
  }
  // costBase：没传 = 不动；传了数字 = 按本单汇率折算；传 null = 主动清空（不能当成「没传」）
  const nextCost =
    patch.costBase !== undefined
      ? resolveItemCost(orderId, { costBase: patch.costBase })
      : patch.unitCost !== undefined
        ? patch.unitCost
        : (cur.unit_cost as number | null)
  const baseChanges = describeItemChange(cur, patch)
  const costNote =
    patch.costBase === undefined
      ? ''
      : `${baseChanges ? '；' : ''}成本按工厂价 ${patch.costBase ?? '清空'} 折算（本单汇率下 ${
          nextCost == null ? '—' : nextCost
        }）`
  const changes = baseChanges + costNote
  // 改行、留痕、重算状态必须一起成一起败：以前中途抛错会留下「行改了、状态没改」的单
  transact(() => {
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
        nextCost,
        itemId,
        orderId
      ]
    )
    db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
    if (changes) logEvent(orderId, 'item_update', null, null, `修改明细 ${patch.styleNo ?? cur.style_no}：${changes}`)
    // 件数变了，订单的「装够没有 / 走了没有」跟着变
    applyShipStatus(orderId)
    // 金额变了，收款状态要重算（加单加到收不够要从「已收款」退回「部分收款」）
    recomputePaymentStatus(orderId)
  })
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
  assertOrderWritable(orderId, '删明细')
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
  transact(() => {
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
  })
  return getOrder(orderId)!
}

/** 批量替换订单行（从商品库选款生成 SKU 矩阵时用） */
export function replaceOrderItems(orderId: number, items: OrderItemInput[]): OrderDetail {
  const db = getDb()
  assertOrderWritable(orderId, '整体替换明细')
  const packed = Number(
    (
      db.get(
        `SELECT COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
         WHERE pl.order_id = ? AND pl.voided_at IS NULL`,
        [orderId]
      ) as { qty?: number } | null
    )?.qty ?? 0
  )
  if (packed > 0) {
    throw new Error(
      `这张单已经装了 ${packed} 件箱，不能整体替换明细；请逐行调整，或先到「装箱单」里处理箱明细（已出运的批次要先把状态改回「已包装」）。`
    )
  }
  // 整批先过闸门再动库：不能删完旧明细才发现第 3 行数量是负数
  const seenSku = new Map<string, number>()
  items.forEach((it, i) => {
    const who = `第 ${i + 1} 行（款号 ${it.styleNo || '未填'}）`
    assertQuantity(it.quantity, `${who} 的数量`)
    assertUnitPrice(it.unitPrice, `${who} 的单价`)
    const key = [it.styleNo, it.color ?? '', it.size ?? ''].join('|')
    const first = seenSku.get(key)
    if (first !== undefined) {
      throw new Error(
        `${who} 和第 ${first} 行是同一个 款号/颜色/尺码。同一款只能有一行：两行不同单价会按数量加权，把批次货值算乱。请合并数量后重试。`
      )
    }
    seenSku.set(key, i + 1)
  })
  // 整批替换连同留痕、状态重算放进同一个事务：只删干净一半就失败，是最难查的那种单
  transact(() => {
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
          resolveItemCost(orderId, item)
        ]
      )
    }
    db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
    applyShipStatus(orderId)
    logEvent(orderId, 'item_replace', null, null, `批量生成 ${items.length} 个 SKU 行`)
    // 金额变了，收款状态要重算
    recomputePaymentStatus(orderId)
  })
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
              WHERE pl.order_id = oi.order_id AND pl.voided_at IS NULL
                AND pll.style_no = oi.style_no
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
  // 作废单不再有「待收」，但钱真的到账时要能落账：
  // 现金流口径（只排除草稿）本来就把作废单的到账算进月报——闸门拦死只会让银行流水与系统账脱节。
  // 这里开正门：必须写明来路；这笔钱只进收款流水与月报，不复活订单、不动待收（recompute 对终态直接返回）。
  // 失效单不走这条门：它还有「改回客户已确认」的活路，走正常收款流程。
  const cur = db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [orderId]) as
    | { order_no?: string; payment_status?: string }
    | null
  if (!cur) throw new Error('订单不存在')
  const curStatus = String(cur.payment_status ?? '')
  const isVoided = curStatus === 'void'
  if (curStatus === 'void') {
    if (!String(p.note ?? '').trim()) {
      throw new Error(`订单 ${String(cur.order_no ?? '')} 已作废：作废单的回款必须写明来路（备注里写清楚，例如“取消单客户退回的定金”），操作历史要能对上银行流水。`)
    }
  } else {
    assertOrderWritable(orderId, '登记收款')
  }
  // 草稿不进现金流（month_received / 月报 / 月度汇总都排除草稿），
  // 在草稿上登记收款，这笔钱会从所有到账报表里消失——先把状态推到「已发出」再收钱
  if (curStatus === 'draft') {
    throw new Error(
      `订单 ${String(cur.order_no ?? '')} 还是草稿：草稿不进现金流，登记了也不会出现在「本月到账」和月报里。请先把收款状态改成「已发出」或「已确认」，再登记收款。`
    )
  }
  const paidAt = String(p.paidAt ?? '').trim()
  // 空日期会让这笔钱从「本月收款」和月报里消失，只剩订单上的已收能看见
  if (!isLocalDate(paidAt)) {
    throw new Error('收款日期要填完整（例如 2026-10-24）。空日期的收款不会进本月收款和月报。')
  }
  // 钱不可能在未来到账：填成明年会把「本月到账」和账期催款一起带偏
  if (paidAt > localDate()) {
    throw new Error(
      `收款日期 ${paidAt} 还没到。请填银行水单上的实际到账日，最晚是今天（${localDate()}）。`
    )
  }
  const amount = Number(p.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('收款金额必须是大于 0 的数。')
  }
  // 汇率快照：这笔到账按「落款那天订单上的汇率」折算进月报，
  // 以后订单汇率再改（出单据前的窗口期是允许的），历史到账不许跟着漂
  const rate = Number(
    (db.get('SELECT exchange_rate FROM orders WHERE id = ?', [orderId]) as { exchange_rate?: number } | null)
      ?.exchange_rate ?? 1
  )
  transact(() => {
    db.run(
      `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, exchange_rate, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [orderId, paidAt, amount, p.method ?? 'T/T', p.bankRef ?? '', p.note ?? '', rate, now()]
    )
    logEvent(
      orderId,
      'payment',
      null,
      null,
      `${isVoided ? '作废单回款' : '收款'} ${amount.toFixed(2)}（${paidAt}${p.bankRef ? `，流水号 ${p.bankRef}` : `，${p.method ?? 'T/T'}`}）` +
        // 补录过去日期的到账也是按「录入时刻」的订单汇率钉快照：口径写进历史，月报对不上时查得到原因
        `；汇率按 ${rate} 钉快照`
    )
    recomputePaymentStatus(orderId)
  })
  return getOrder(orderId)!
}

export function deletePayment(orderId: number, paymentId: number, reason = ''): OrderDetail {
  const db = getDb()
  const row = db.get(
    `SELECT p.paid_at, p.amount, p.bank_ref, p.created_at, o.currency
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.id = ? AND p.order_id = ?`,
    [paymentId, orderId]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('这条收款记录已经不存在了，刷新页面后再试。')
  // 作废单只许更正「作废之后」登记的回款（录错了不删就成死账）；
  // 作废前的流水是留档凭据，跟客户手里的 PI/CI 对着账，不许改写。原因必填（下方统一校验）。
  const delStatus = String(
    (db.get('SELECT payment_status FROM orders WHERE id = ?', [orderId]) as { payment_status?: string } | null)
      ?.payment_status ?? ''
  )
  if (delStatus === 'void') {
    const voidedAt = String(
      (db.get(
        "SELECT at FROM order_events WHERE order_id = ? AND kind = 'void' ORDER BY id DESC LIMIT 1",
        [orderId]
      ) as { at?: string } | null)?.at ?? ''
    )
    const created = String(row.created_at ?? '')
    if (!voidedAt || !created || created <= voidedAt) {
      throw new Error(
        '订单已作废：作废前的收款是留档凭据（和客户手里的 PI/CI 对着账），不能再改写。只有作废后登记的回款才允许更正。'
      )
    }
  } else {
    assertOrderWritable(orderId, '删收款')
  }
  // 这笔钱可能已经用于短款核销/坏账追回：直接删掉，核销台账里就留着一个指向不存在流水的 payment_id
  const usedBy = db.get(
    'SELECT kind, amount, at FROM order_settlements WHERE order_id = ? AND payment_id = ? ORDER BY id LIMIT 1',
    [orderId, paymentId]
  ) as { kind?: string; amount?: number; at?: string } | null
  if (usedBy) {
    const kind = String(usedBy.kind ?? '')
    throw new Error(
      kind === 'recovery'
        ? `这笔收款是坏账追回时自动登记的（${String(usedBy.at ?? '')}，${Number(usedBy.amount ?? 0).toFixed(2)}），和核销台账绑在一起，不能删除。如果要退汇，请单独登记一笔反向收款并写明原因。`
        : `这笔收款已经用于核销（${String(usedBy.at ?? '')}，${Number(usedBy.amount ?? 0).toFixed(2)}），不能直接删除：删了核销台账会指向一条不存在的流水。请先撤销对应的核销记录，再删收款。`
    )
  }
  const why = String(reason ?? '').trim()
  // 删掉的是钱到账的凭据，操作历史必须能回答「删了多少钱、哪一天、哪笔流水、为什么」
  if (!why) {
    throw new Error('删除收款要写原因（例如“金额录错”“客户退汇”），操作历史里要留痕。')
  }
  const amount = Number(row.amount ?? 0)
  const currency = String(row.currency ?? '')
  const bankRef = String(row.bank_ref ?? '')
  const paidAt = String(row.paid_at ?? '')
  transact(() => {
    db.run('DELETE FROM payments WHERE id = ? AND order_id = ?', [paymentId, orderId])
    logEvent(
      orderId,
      'payment_delete',
      null,
      null,
      `删除收款 ${currency} ${amount.toFixed(2)}（${paidAt}${bankRef ? `，流水号 ${bankRef}` : ''}）原因：${why}`
    )
    recomputePaymentStatus(orderId)
  })
  return getOrder(orderId)!
}

/* ---------------- 核销 / 坏账 ---------------- */

export interface SettlementInput {
  kind: SettlementKind
  /** 金额；不填 = 当前待收全额 */
  amount?: number
  /** 业务发生日，默认今天 */
  at?: string
  reason: string
  evidence?: string
  /** 追回款：这笔钱实际到账的日期与流水号 */
  paidAt?: string
  bankRef?: string
  method?: string
}

export function listSettlements(orderId: number): Settlement[] {
  return (
    getDb().all('SELECT * FROM order_settlements WHERE order_id = ? ORDER BY at, id', [orderId]) as Record<
      string,
      unknown
    >[]
  ).map(mapSettlement)
}

function settlementSums(orderId: number): { shortage: number; badDebt: number; recovered: number } {
  const rows = getDb().all(
    `SELECT kind, COALESCE(SUM(amount), 0) AS total
     FROM order_settlements WHERE order_id = ? GROUP BY kind`,
    [orderId]
  ) as { kind?: string; total?: number }[]
  let shortage = 0
  let badDebt = 0
  let recovered = 0
  for (const r of rows) {
    const total = Number(r.total ?? 0)
    if (r.kind === 'shortage') shortage = total
    else if (r.kind === 'bad_debt') badDebt = total
    else if (r.kind === 'recovery') recovered = total
  }
  return { shortage, badDebt, recovered }
}

/**
 * 登记一笔核销：
 *  - shortage 短款让利：从待收里扣，也进毛利；
 *  - bad_debt 坏账：从待收里扣，报表单列，不改进货毛利；
 *  - recovery 坏账追回：钱真的到账，先落一条收款，再冲减坏账余额。
 * 都只追加；要改就撤销后重登，历史里每一步都在。
 */
export function addSettlement(orderId: number, input: SettlementInput): OrderDetail {
  const db = getDb()
  const order = getOrder(orderId)
  if (!order) throw new Error('订单不存在')
  if (['draft', 'expired', 'void'].includes(order.paymentStatus)) {
    throw new Error('草稿、已失效、已作废的订单不能做核销或坏账。先把订单状态改成正式单，再处理欠款。')
  }
  const kind = input.kind
  if (kind !== 'shortage' && kind !== 'bad_debt' && kind !== 'recovery') {
    throw new Error('核销类型不对，只能是短款核销、坏账或坏账追回。')
  }
  const reason = String(input.reason ?? '').trim()
  if (!reason) throw new Error('核销 / 坏账要写原因（例如“银行扣费”“客户破产”），操作历史要留痕。')
  const at = String(input.at ?? '').trim() || localDate()
  if (!isLocalDate(at)) throw new Error('核销日期要填完整（例如 2026-10-24）。')
  // 核销/追回和收款同一口径：钱不会在未来发生，填成未来会把月报和状态一起带偏
  if (at > localDate()) {
    throw new Error(`核销日期 ${at} 还没到。请填实际发生的日期，最晚是今天（${localDate()}）。`)
  }
  const evidence = String(input.evidence ?? '').trim()

  const sums = settlementSums(orderId)
  const badDebtOutstanding = Math.max(0, sums.badDebt - sums.recovered)
  const currency = order.currency

  if (kind === 'recovery') {
    if (badDebtOutstanding <= 0.001) {
      throw new Error('这张单没有尚未追回的坏账，不能登记追回款；钱到账请走「记录收款」。')
    }
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('追回金额必须是大于 0 的数。')
    if (amount > badDebtOutstanding + 0.001) {
      throw new Error(
        `追回金额 ${amount.toFixed(2)} 超过了尚未追回的坏账 ${badDebtOutstanding.toFixed(2)}；超出的部分请按普通收款登记。`
      )
    }
    const paidAt = String(input.paidAt ?? '').trim() || at
    if (!isLocalDate(paidAt)) throw new Error('追回款的到账日期要填完整（例如 2026-10-24）。')
    if (paidAt > localDate()) {
      throw new Error(
        `追回款的到账日期 ${paidAt} 还没到。请填银行水单上的实际到账日，最晚是今天（${localDate()}）。`
      )
    }
    const rate = Number(order.exchangeRate ?? 1)
    transact(() => {
      db.run(
        `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, exchange_rate, created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [orderId, paidAt, amount, input.method ?? 'T/T', input.bankRef ?? '', `坏账追回：${reason}`, rate, now()]
      )
      const payId = Number(
        (db.get('SELECT last_insert_rowid() AS id') as { id?: number } | null)?.id ?? 0
      )
      db.run(
        `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [orderId, kind, amount, reason, evidence, null, payId, at, now()]
      )
      logEvent(
        orderId,
        'settlement',
        null,
        null,
        `坏账追回 ${currency} ${amount.toFixed(2)}（${paidAt}${input.bankRef ? `，流水号 ${input.bankRef}` : ''}）原因：${reason}`
      )
      recomputePaymentStatus(orderId)
    })
    return getOrder(orderId)!
  }

  const outstanding = order.remaining
  if (outstanding <= 0.001) {
    throw new Error('这张单已经没有待收了，不能核销。多收的钱请核对收款记录，不要用核销来平账。')
  }
  // 只有完全不填才按当前待收全额；填 0 或负数必须拦住，不能悄悄变成全额核销
  const amount = input.amount == null ? outstanding : Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('核销金额必须是大于 0 的数。')
  if (amount > outstanding + 0.001) {
    throw new Error(
      `核销金额 ${amount.toFixed(2)} 超过了当前待收 ${outstanding.toFixed(2)}；核销不能把单子做成多收。`
    )
  }
  const label = kind === 'shortage' ? '短款核销' : '坏账'
  transact(() => {
    db.run(
      `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [orderId, kind, amount, reason, evidence, null, null, at, now()]
    )
    logEvent(
      orderId,
      'settlement',
      null,
      null,
      `${label} ${currency} ${amount.toFixed(2)}（${at}）原因：${reason}${evidence ? `；证据：${evidence}` : ''}`
    )
    recomputePaymentStatus(orderId)
  })
  return getOrder(orderId)!
}

/** 撤销一笔核销：记一条负数并指向原记录，原记录不动 */
export function reverseSettlement(orderId: number, settlementId: number, reason = ''): OrderDetail {
  const db = getDb()
  const row = db.get('SELECT * FROM order_settlements WHERE id = ? AND order_id = ?', [
    settlementId,
    orderId
  ]) as Record<string, unknown> | null
  if (!row) throw new Error('这条核销记录已经不存在了，刷新页面后再试。')
  // 作废/失效单是留档凭据：撤销核销会改它的待收与坏账，不能再动
  assertOrderWritable(orderId, '撤销核销')
  const kind = String(row.kind) as SettlementKind
  const amount = Number(row.amount ?? 0)
  if (kind === 'recovery') {
    throw new Error('追回款是实际到账的钱，不能撤销核销；如果要退汇，请单独登记一笔反向收款并写明原因。')
  }
  if (amount <= 0) throw new Error('这条是撤销记录，不能再撤销一次。')
  const reversed = db.get('SELECT id FROM order_settlements WHERE reverses_id = ?', [settlementId])
  if (reversed) throw new Error('这笔核销已经撤销过了，刷新页面就能看到。')
  const why = String(reason ?? '').trim()
  if (!why) throw new Error('撤销核销要写原因，操作历史要留痕。')
  const label = SETTLEMENT_KIND_LABEL[kind] ?? kind
  transact(() => {
    db.run(
      `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [orderId, kind, -amount, why, '', settlementId, null, localDate(), now()]
    )
    logEvent(
      orderId,
      'settlement_reverse',
      null,
      null,
      `撤销${label} ${amount.toFixed(2)} 原因：${why}`
    )
    recomputePaymentStatus(orderId)
  })
  return getOrder(orderId)!
}

/**
 * 收款状态自动流转（双向）：
 *  - 收款 >= 总额 → 已结清
 *  - 收款 >= 定金（且 > 0）→ 已收款
 *  - 收款 > 0 → 部分收款
 *  - 一分没收 → 客户已确认
 *
 * 金额一律取 moneyForOrders（应收口径的唯一真源），不再在这里另写一份 SUM：
 * 两套公式迟早会因为费用/核销改动而打架，首页待收和状态标签就会各说各话。
 *
 * 关键：加单 / 减单 / 改数量 / 改单价 / 删行都会重算，
 * 所以「已收款」可以退回「部分收款」，「部分收款」也能升到「已结清」。
 * 人工设定的 draft / expired / void 保持不变；sent 只在真收到钱后往上走，
 * 否则客户已付定金，工作台还会天天催「客户还没确认」。
 */
export function recomputePaymentStatus(orderId: number): PaymentStatus {
  const db = getDb()
  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
  if (!order) throw new Error('订单不存在')
  const status = String(order.payment_status) as PaymentStatus
  // 草稿 / 已失效 / 已作废 不参与自动流转
  if (status === 'draft' || status === 'expired' || status === 'void') return status

  const money = moneyForOrders([
    { id: orderId, charges: order.charges, depositRatio: Number(order.deposit_ratio ?? 0) }
  ]).get(orderId)!
  const total = money.grandTotal
  const paid = money.paidAmount
  // 核销过的钱不用再收：短款 + 坏账算「结清」，撤销记负数自然退回
  const writtenOff = money.netWrittenOff
  const deposit = money.depositAmount

  // 注意：这里算出来的是「下一个状态」，跟当前状态无关，所以能往上走也能往下退
  let next: PaymentStatus = status
  if (total > 0 && paid + writtenOff >= total - 0.001) next = 'settled'
  else if (deposit > 0 && paid >= deposit - 0.001) next = 'paid'
  else if (paid > 0) next = 'partial'
  else next = status === 'sent' ? 'sent' : 'confirmed'

  if (next !== status) {
    db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
    logEvent(
      orderId,
      'status_auto',
      status,
      next,
      `收款状态自动流转为 ${PAYMENT_STATUS_LABEL[next as keyof typeof PAYMENT_STATUS_LABEL] ?? next}`
    )
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
  assertOrderWritable(orderId, '改出货状态')
  // 手工状态只能用这一份枚举：把「部分出运」这种派生值钉在订单上，
  // 没有批次兜底时它就永久挂着，列表和导出会显示一个本不该出现在手工位的状态
  if (!(SHIP_STATUS_ORDER as string[]).includes(next)) {
    throw new Error(
      `出货状态「${next}」不能手工设置——「部分出运」只由装箱单批次汇总得出，要让它变就得到「装箱单」里推进对应批次`
    )
  }
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
  // 与出货状态同一套守门：非法值一旦入库，这单就从待收、月报、催款里静默消失
  if (!(next in PAYMENT_STATUS_LABEL)) {
    const allowed = Object.values(PAYMENT_STATUS_LABEL).join(' / ')
    throw new Error(`「${String(next)}」不是收款状态，请选择：${allowed}`)
  }
  const cur = db.get('SELECT payment_status FROM orders WHERE id = ?', [orderId]) as
    | { payment_status: string }
    | null
  if (!cur) throw new Error('订单不存在')
  // 作废是留档终态：从这里改回 confirmed 就等于把一张已取消的单偷偷塞回台账和应收
  if (cur.payment_status === 'void' && next !== 'void') {
    throw new Error('这张单已作废，不能改回收款状态：作废是留档终态，要接着做生意请按新单重开。')
  }
  transact(() => {
    db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
    logEvent(orderId, 'payment_status', cur.payment_status, next, note)
  })
  return getOrder(orderId)!
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
  // 只带「真做过」的单：客户取消过的那张的港口、定金不能变成下一单的默认值
  const row = getDb().get(
    `SELECT * FROM orders WHERE customer_id = ? AND payment_status NOT IN ('draft','expired','void')
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
  const db = getDb()
  const row = db.get('SELECT * FROM order_photos WHERE id = ? AND order_id = ?', [photoId, orderId]) as Record<
    string,
    unknown
  > | null
  if (!row) return
  db.run('DELETE FROM order_photos WHERE id = ? AND order_id = ?', [photoId, orderId])
  // 文件也一起清掉（文件名是上传时唯一命名的）：只删 DB 行会把 images 目录越滚越大，
  // 备份还把这些孤儿一张不落地打包。删不掉不挡主流程，与商品图同口径。
  const fileName = String(row.file_name ?? '')
  if (fileName) {
    try {
      const p = join(imagesDir(), basename(fileName))
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* 文件已被手工移走：记录已清，不挡主流程 */
    }
  }
  // 验货照是出货争议时的证据，删掉必须留痕：谁、什么时候、删的是哪一张
  logEvent(
    orderId,
    'photo',
    null,
    null,
    `删除${String(row.kind) === 'container' ? '柜照' : '验货照'}${row.note ? `（${String(row.note)}）` : ''}`
  )
}
