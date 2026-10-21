/**
 * 金额口径唯一真源。
 *
 * 背景：使用者已经三次因为「同一个数在几个地方不一样」吃大亏
 * （PI 改了 CI 没改 / 报表堵了工作台没堵 / 订单详情对了列表客户页 CSV 没对）。
 *
 * 规矩：
 *   1. 任何地方要算「货值 / 费用合计 / 含费用合计 / 待收 / 毛利」，一律调这个文件。
 *   2. 不许再在页面或别的 service 里各写各的 SQL。
 *   3. 成本没录全时，毛利一律返回 null（不可信），不许拿 0 成本凑一个漂亮数字。
 *
 * 三个权威数字：
 *   含费用合计 grandTotal = 货值 + 费用行（PI / CI / 报价单 / PL 都用它）
 *   待收     receivable  = 含费用合计 − 已收（多收的部分不算待收，最小 0）
 *   毛利     profit      = 货值 + 负费用 − 成本（成本有缺失 → null = 不可信）
 *
 * 毛利为什么要把负费用算进去（N-4）：
 *   正向费用（运费/保险）是代收代付的过手钱，客户多付我们也多付，不进毛利；
 *   负向费用（样品费抵扣 / 折让）是我们真金白银让掉的钱，必须从毛利里扣。
 *   不扣的话：打样转出来的 0 元抵扣单（收 0 元、成本 16.90）会显示「毛利 +33.10」，
 *   而报表销售额记 0 —— 同一单两个毛利，差 50 USD，纯属漂亮的假数字。
 */
import { getDb } from '../db'
import type { QuotationCharge } from '../../src/shared/types'

/** 解析费用行 JSON（运费/保险等） */
export function parseCharges(v: unknown): QuotationCharge[] {
  try {
    const parsed = JSON.parse(String(v ?? '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((c: any) => ({ label: String(c?.label ?? ''), amount: Number(c?.amount ?? 0) }))
      .filter((c: QuotationCharge) => c.label)
  } catch {
    return []
  }
}

/** 参与金额计算的一条明细 */
export interface MoneyItem {
  quantity: number
  unitPrice: number
  /** 行成本单价，null = 没录成本 */
  unitCost: number | null
}

/** 计算口径的输入 */
export interface MoneyInput {
  items: MoneyItem[]
  charges: { amount: number }[]
  payments: { amount: number }[]
  /** 定金比例，0.3 = 30% */
  depositRatio: number
}

/** 计算口径的输出 */
export interface OrderMoney {
  /** 货值（不含费用） */
  goodsValue: number
  /** 费用合计 */
  chargesTotal: number
  /** 含费用合计 = 货值 + 费用（PI / CI / 报价单 / PL 上的 TOTAL） */
  grandTotal: number
  /** 已收 */
  paidAmount: number
  /** 待收（原始值，可能因多收而为负） */
  remaining: number
  /** 真正要向客户收的钱：含费用合计 − 已收，最小 0（多收不退） */
  receivable: number
  /** 定金金额 = 含费用合计 × 定金比例 */
  depositAmount: number
  /** 已知成本合计 */
  totalCost: number
  /** 成本没录的行数 */
  missingCostItems: number
  /** 毛利：有成本缺失时为 null（不可信） */
  profit: number | null
  /** 抵扣 / 折让等负向费用合计（已计入毛利，界面上要写清楚口径） */
  negativeCharges: number
  /** 毛利的原始计算值（即使不可信也给，用于内部对比，界面上不许直接显示） */
  profitRaw: number
  /** 总件数 */
  totalQuantity: number
}

/**
 * 唯一的金额计算函数：PI / CI / 报价单 / PL / 订单详情 / 订单列表 /
 * 客户页 / 工作台 / 报表 / CSV 导出，全部走这里。
 */
export function computeOrderMoney(input: MoneyInput): OrderMoney {
  const items = input.items ?? []
  const goodsValue = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0), 0)
  const chargesTotal = (input.charges ?? []).reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const grandTotal = goodsValue + chargesTotal
  const paidAmount = (input.payments ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const remaining = grandTotal - paidAmount
  const missingCostItems = items.filter((i) => i.unitCost == null).length
  const totalCost = items.reduce((s, i) => s + Number(i.quantity || 0) * (i.unitCost ?? 0), 0)
  // 负向费用（抵扣/折让）从毛利里扣；正向费用（运费等过手钱）维持原口径不进毛利
  const negativeCharges = (input.charges ?? []).reduce(
    (s, c) => (Number(c.amount) < 0 ? s + Number(c.amount) : s),
    0
  )
  const profitRaw = goodsValue + negativeCharges - totalCost
  return {
    goodsValue,
    chargesTotal,
    grandTotal,
    paidAmount,
    remaining,
    receivable: remaining > 0 ? remaining : 0,
    depositAmount: grandTotal * Number(input.depositRatio || 0),
    totalCost,
    missingCostItems,
    negativeCharges,
    // 成本有缺失 → 毛利不可信（null），不许拿 0 成本算出一个漂亮的数
    profit: missingCostItems > 0 ? null : profitRaw,
    profitRaw,
    totalQuantity: items.reduce((s, i) => s + Number(i.quantity || 0), 0)
  }
}

/* ---------------- 批量（列表 / 汇总）口径 ---------------- */

/** 一张订单在汇总口径下的全部数字 */
export interface OrderMoneyRow extends OrderMoney {
  orderId: number
  orderNo: string
  piNo: string
  customerId: number
  customerName: string
  country: string
  currency: string
  exchangeRate: number
  createdAt: string
  /** YYYY-MM */
  month: string
  paymentStatus: string
  shipStatus: string
  incoterm: string
  portOfLoading: string
  portOfDestination: string
  paymentMethod: string
  customerPo: string
  expectedShipDate: string | null
  /** 折算成基准币的金额 */
  grandTotalBase: number
  receivableBase: number
  goodsValueBase: number
  costBase: number
  profitBase: number
}

/** 汇总时的筛选条件 */
export interface MoneyListFilter {
  /** 只要这些订单（已排除的默认不算） */
  includeVoided?: boolean
  customerId?: number
  /** 排除这些收款状态（草稿 / 已失效 / 已作废 默认都排除） */
  excludeStatuses?: string[]
  /** 只要这些收款状态 */
  onlyStatuses?: string[]
  /** YYYY-MM */
  month?: string
}

/** 不参与销售额 / 毛利 / 待收款的状态（草稿单、已失效、已作废） */
export const EXCLUDED_STATUSES = ['draft', 'expired', 'void']

/**
 * 汇总口径：把所有订单的货值 / 费用 / 已收 / 待收一次算出来，
 * 订单列表、订单详情、客户页、工作台、报表、CSV 导出全部用这一份数据。
 */
export function listOrderMoney(filter: MoneyListFilter = {}): OrderMoneyRow[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number)[] = []

  if (filter.onlyStatuses && filter.onlyStatuses.length) {
    where.push(`o.payment_status IN (${filter.onlyStatuses.map(() => '?').join(',')})`)
    params.push(...filter.onlyStatuses)
  } else if (!filter.includeVoided) {
    const ex = filter.excludeStatuses ?? EXCLUDED_STATUSES
    where.push(`o.payment_status NOT IN (${ex.map(() => '?').join(',')})`)
    params.push(...ex)
  }
  if (filter.customerId != null) {
    where.push('o.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.month) {
    where.push("strftime('%Y-%m', o.created_at) = ?")
    params.push(filter.month)
  }

  const rows = db.all(
    `SELECT o.id, o.order_no, o.pi_no, o.customer_id, c.company AS customer_name, c.country,
            o.currency, o.exchange_rate, o.payment_status, o.ship_status, o.deposit_ratio, o.charges, o.created_at,
            o.incoterm, o.port_of_loading, o.port_of_destination, o.payment_method, o.customer_po, o.expected_ship_date
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC, o.id DESC`,
    params
  ) as Record<string, unknown>[]
  if (rows.length === 0) return []

  const ids = rows.map((r) => Number(r.id))
  const ph = ids.map(() => '?').join(',')
  const itemRows = db.all(
    `SELECT order_id, quantity, unit_price, unit_cost FROM order_items WHERE order_id IN (${ph})`,
    ids
  ) as Record<string, unknown>[]
  const payRows = db.all(
    `SELECT order_id, amount FROM payments WHERE order_id IN (${ph})`,
    ids
  ) as Record<string, unknown>[]

  const itemsBy = new Map<number, MoneyItem[]>()
  for (const r of itemRows) {
    const id = Number(r.order_id)
    const arr = itemsBy.get(id) ?? []
    arr.push({
      quantity: Number(r.quantity ?? 0),
      unitPrice: Number(r.unit_price ?? 0),
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost)
    })
    itemsBy.set(id, arr)
  }
  const paysBy = new Map<number, number[]>()
  for (const r of payRows) {
    const id = Number(r.order_id)
    const arr = paysBy.get(id) ?? []
    arr.push(Number(r.amount ?? 0))
    paysBy.set(id, arr)
  }

  return rows.map((r) => {
    const id = Number(r.id)
    const rate = Number(r.exchange_rate ?? 1)
    const m = computeOrderMoney({
      items: itemsBy.get(id) ?? [],
      charges: parseCharges(r.charges),
      payments: (paysBy.get(id) ?? []).map((amount) => ({ amount })),
      depositRatio: Number(r.deposit_ratio ?? 0)
    })
    const createdAt = String(r.created_at ?? '')
    return {
      ...m,
      orderId: id,
      orderNo: String(r.order_no ?? ''),
      piNo: String(r.pi_no ?? ''),
      customerId: Number(r.customer_id),
      customerName: String(r.customer_name ?? ''),
      country: String(r.country ?? ''),
      currency: String(r.currency ?? 'USD'),
      exchangeRate: rate,
      createdAt,
      month: createdAt.slice(0, 7),
      paymentStatus: String(r.payment_status ?? ''),
      shipStatus: String(r.ship_status ?? ''),
      incoterm: String(r.incoterm ?? ''),
      portOfLoading: String(r.port_of_loading ?? ''),
      portOfDestination: String(r.port_of_destination ?? ''),
      paymentMethod: String(r.payment_method ?? ''),
      customerPo: String(r.customer_po ?? ''),
      expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date),
      grandTotalBase: m.grandTotal * rate,
      receivableBase: m.receivable * rate,
      goodsValueBase: m.goodsValue * rate,
      costBase: m.totalCost * rate,
      profitBase: (m.profit ?? m.profitRaw) * rate
    }
  })
}

/**
 * 全公司待收款（基准币）：Σ(订单含费用合计 − 已收) + Σ(打样单未收样品费+快递费)。
 * 工作台「待收款金额」用它，不许自己写 SQL。
 *
 * 打样费（N23）：公司垫的钱也是钱——未收（fee_status='unpaid'）的打样单，
 * 样品费+快递费按打样单记录的汇率折算后计入。
 */
export function totalReceivable(filter: MoneyListFilter = {}): number {
  const orders = listOrderMoney(filter).reduce((s, r) => s + r.receivableBase, 0)
  const samples = sampleReceivable(filter.customerId)
  return orders + samples
}

/**
 * 打样单待收（基准币，N23）：样品费 + 快递费，只有 fee_status='unpaid' 才算。
 * 汇率缺失的单不计入（否则折不准），它们在打样页上会亮「汇率未填」提醒补。
 */
export function sampleReceivable(customerId?: number): number {
  const db = getDb()
  const where = ["s.fee_status = 'unpaid'"]
  const params: (string | number)[] = []
  if (customerId != null) {
    where.push('s.customer_id = ?')
    params.push(customerId)
  }
  const rows = db.all(
    `SELECT s.exchange_rate, s.express_fee,
            COALESCE((SELECT SUM(si.quantity * si.unit_price) FROM sample_order_items si
                      WHERE si.sample_order_id = s.id), 0) AS sample_fee
     FROM sample_orders s
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  ) as Record<string, unknown>[]
  let total = 0
  for (const r of rows) {
    const rate = Number(r.exchange_rate ?? 0)
    if (rate <= 0) continue // 汇率没填 → 不计入（打样页有提醒）
    total += (Number(r.sample_fee ?? 0) + Number(r.express_fee ?? 0)) * rate
  }
  return total
}

/**
 * 某个客户的待收款（基准币）：订单 + 打样单，同一个口径。
 * 客户页「未收金额」用它。
 */
export function customerReceivable(customerId: number): number {
  return totalReceivable({ customerId })
}
