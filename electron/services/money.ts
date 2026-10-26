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
 *   待收     receivable  = 含费用合计 − 已收 − 核销（多收的部分不算待收，最小 0）
 *   毛利     profit      = 货值 + 负费用 − 成本 − 短款核销（成本有缺失 → null = 不可信）
 *
 * 核销与坏账（R2）：
 *   短款核销是让利，进毛利；坏账是信用损失，只从待收扣，不改进货毛利。
 *   两者都不进 payments（没有银行流水），月回款/收款台账仍只认真金白银。
 *
 * 毛利为什么要把负费用算进去（N-4）：
 *   正向费用（运费/保险）是代收代付的过手钱，客户多付我们也多付，不进毛利；
 *   负向费用（样品费抵扣 / 折让）是我们真金白银让掉的钱，必须从毛利里扣。
 *   不扣的话：打样转出来的 0 元抵扣单（收 0 元、成本 16.90）会显示「毛利 +33.10」，
 *   而报表销售额记 0 —— 同一单两个毛利，差 50 USD，纯属漂亮的假数字。
 */
import { getDb } from '../db'
import { localMonthOf, localDateOf, localDate } from '../../src/shared/date'
import { ciNoOf } from '../../src/shared/documents'
import { NON_BILLING_STATUSES, isBillingStatus } from '../../src/shared/billing'
import type {
  CustomerCreditApplication,
  CustomerCreditCurrency,
  CustomerCreditRefund,
  CustomerCreditSource,
  CustomerReceivable,
  PackingAmount,
  PackingAmountLine,
  QuotationCharge
} from '../../src/shared/types'
import { PAYMENT_STATUS_LABEL, SAMPLE_FEE_STATUS_LABEL, SAMPLE_STATUS_LABEL } from '../../src/shared/types'

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

/**
 * 工厂成本（基准币，工厂报的是人民币）折成订单币种。
 *
 * 汇率口径是「1 外币 = exchangeRate 基准币」，所以除不是乘。
 * 这一步必须由服务端做：以前前端把 ¥30 直接当 $30 写进 unit_cost，
 * 30 元成本在 USD 单里按 30 美元算，毛利整整差出一个汇率。
 */
export function costInOrderCurrency(costBase: number | null | undefined, exchangeRate: number): number | null {
  if (costBase == null) return null
  const base = Number(costBase)
  const rate = Number(exchangeRate)
  if (!Number.isFinite(base) || !Number.isFinite(rate) || rate <= 0) return null
  // 留 6 位小数：单价折算不能拿 2 位四舍五入去乘几百件
  return Math.round((base / rate) * 1e6) / 1e6
}

/** 核销台账里参与金额计算的一条 */
export interface SettlementInput {
  kind: string
  amount: number
}

/** 核销口径汇总（原币） */
export interface SettlementTotals {
  /** 短款让利合计（正数） */
  shortage: number
  /** 坏账核销合计（正数，已扣撤销） */
  badDebt: number
  /** 已追回金额（正数） */
  recovered: number
  /** 坏账尚未追回余额 = max(0, 坏账 − 追回) */
  badDebtOutstanding: number
  /** 核销合计（毛额）= 短款 + 坏账，界面上分开显示 */
  writtenOff: number
  /**
   * 从待收里扣掉的净核销 = 短款 + 坏账 − 已追回。
   * 追回款已经作为现金进了「已收」，不能再按坏账毛额扣一次，否则会显示成多收。
   */
  netWrittenOff: number
}

/** 计算口径的输入 */
export interface MoneyInput {
  items: MoneyItem[]
  charges: { amount: number }[]
  payments: { amount: number }[]
  /** 核销 / 坏账 / 追回台账；撤销记录是负数，直接相加 */
  settlements?: SettlementInput[]
  /** 定金比例，0.3 = 30% */
  depositRatio: number
  /**
   * 用客户预收抵扣的金额（原币，R27）。
   * 这不是现金：现金流里没有这条，毛利和单据总额也不能被它改动，
   * 只是「这笔待收已经由客户账上的余额覆盖」。
   */
  creditApplied?: number
}

/** 计算口径的输出 */
export interface OrderMoney {
  /** 货值（不含费用） */
  goodsValue: number
  /** 费用合计 */
  chargesTotal: number
  /** 含费用合计 = 货值 + 费用（PI / CI / 报价单 / PL 上的 TOTAL） */
  grandTotal: number
  /** 已收（真金白银的到账） */
  paidAmount: number
  /** 用客户预收抵扣的金额（非现金，R27）：只冲待收，不动已收、总额和毛利 */
  creditApplied: number
  /** 待收（原始值，可能因多收而为负） */
  remaining: number
  /** 真正要向客户收的钱：含费用合计 − 已收 − 预收抵扣，最小 0（多收不退） */
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
  /** 短款核销合计（让利，已从待收和毛利里扣） */
  shortageAmount: number
  /** 坏账核销合计（信用损失，只从待收扣） */
  badDebtAmount: number
  /** 坏账尚未追回余额 */
  badDebtOutstanding: number
  /** 核销合计 = 短款 + 坏账（毛额） */
  writtenOff: number
  /** 净核销 = 短款 + 坏账 − 已追回（用于算待收） */
  netWrittenOff: number
}

/** 核销台账汇总：撤销是负数，求和即可；追回只冲减坏账余额，不重开待收 */
export function summarizeSettlements(rows: SettlementInput[]): SettlementTotals {
  let shortage = 0
  let badDebt = 0
  let recovered = 0
  for (const r of rows ?? []) {
    const amount = Number(r.amount) || 0
    if (r.kind === 'shortage') shortage += amount
    else if (r.kind === 'bad_debt') badDebt += amount
    else if (r.kind === 'recovery') recovered += amount
  }
  // 追回只能冲减坏账本身；坏账撤销后，追回款就只是普通到账现金，不再抵扣核销
  const recoveredApplied = Math.min(recovered, Math.max(0, badDebt))
  return {
    shortage,
    badDebt,
    recovered,
    badDebtOutstanding: Math.max(0, badDebt - recovered),
    writtenOff: shortage + badDebt,
    netWrittenOff: shortage + badDebt - recoveredApplied
  }
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
  const st = summarizeSettlements(input.settlements ?? [])
  // 预收抵扣是「客户账上已有的钱换了个用途」：只冲待收，不算现金、不进毛利。
  // 负数或 NaN 一律按 0——台账里不该有，但界面/老数据传进来也不能把待收反向撑大。
  const creditApplied = Math.max(0, Number(input.creditApplied ?? 0) || 0)
  const remaining = grandTotal - paidAmount - st.netWrittenOff - creditApplied
  const missingCostItems = items.filter((i) => i.unitCost == null).length
  const totalCost = items.reduce((s, i) => s + Number(i.quantity || 0) * (i.unitCost ?? 0), 0)
  // 负向费用（抵扣/折让）从毛利里扣；正向费用（运费等过手钱）维持原口径不进毛利
  const negativeCharges = (input.charges ?? []).reduce(
    (s, c) => (Number(c.amount) < 0 ? s + Number(c.amount) : s),
    0
  )
  // 短款是让利，真金白银少收，进毛利；坏账是信用损失，报表单列，不改进货毛利
  const profitRaw = goodsValue + negativeCharges - totalCost - st.shortage
  return {
    goodsValue,
    chargesTotal,
    grandTotal,
    paidAmount,
    creditApplied,
    remaining,
    receivable: remaining > 0 ? remaining : 0,
    depositAmount: grandTotal * Number(input.depositRatio || 0),
    totalCost,
    missingCostItems,
    negativeCharges,
    // 成本有缺失 → 毛利不可信（null），不许拿 0 成本算出一个漂亮的数
    profit: missingCostItems > 0 ? null : profitRaw,
    profitRaw,
    totalQuantity: items.reduce((s, i) => s + Number(i.quantity || 0), 0),
    shortageAmount: st.shortage,
    badDebtAmount: st.badDebt,
    badDebtOutstanding: st.badDebtOutstanding,
    writtenOff: st.writtenOff,
    netWrittenOff: st.netWrittenOff
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
  /** 锁汇日期：汇率是哪天定下的（税务复核折算要用） */
  exchangeRateDate: string | null
  /** 折算成基准币的金额 */
  grandTotalBase: number
  receivableBase: number
  /** 预收抵扣折基准币（非现金） */
  creditAppliedBase: number
  goodsValueBase: number
  costBase: number
  profitBase: number
  /** 尚未追回的坏账（基准币） */
  badDebtBase: number
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

/**
 * 不参与销售额 / 毛利 / 待收款的状态（草稿单、已失效、已作废）。
 * 集合本身在 src/shared/billing.ts——列表、客户页、催款提醒和这里必须同一份，
 * 分成两处写过的结果就是三个页面对同一张单三种说法。
 */
export const EXCLUDED_STATUSES = NON_BILLING_STATUSES

/**
 * 现金流口径：只排除草稿单（还没成为正式订单）。
 * 已作废 / 已失效的订单如果真收到了钱，钱就在账上，必须留在收款流水里；
 * 只是不再计入销售额和待收。两个口径各自用一个常量，不许各写各的。
 */
export const CASHFLOW_EXCLUDED_STATUSES = ['draft']

/** 生成 "列 NOT IN (?,?,?)" 片段，配合上面两个状态集合用 */
export function notInStatuses(column: string, statuses: string[]): { sql: string; params: string[] } {
  return {
    sql: `${column} NOT IN (${statuses.map(() => '?').join(',')})`,
    params: [...statuses]
  }
}

/** 批量算金额时的一张单需要什么 */
export interface MoneyRef {
  /** orders.id */
  id: number
  /** orders.charges 原始 JSON（费用行） */
  charges: unknown
  /** orders.deposit_ratio */
  depositRatio: number
}

/**
 * 订单上已经抵扣的客户预收（原币，R27）。只认未撤销的行。
 * 传一批 id 时一条 SQL 搞定；列表、详情、对账单都必须从这里取，
 * 不许各自去 SUM credit_applications。
 */
export function creditAppliedForOrders(ids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (!ids.length) return out
  const ph = ids.map(() => '?').join(',')
  const rows = getDb().all(
    `SELECT target_id, SUM(amount) AS amount FROM credit_applications
     WHERE target_kind = 'order' AND reversed_at IS NULL AND target_id IN (${ph})
     GROUP BY target_id`,
    ids
  ) as Record<string, unknown>[]
  for (const r of rows) out.set(Number(r.target_id), Number(r.amount ?? 0))
  return out
}

export function creditAppliedForOrder(id: number): number {
  return creditAppliedForOrders([id]).get(id) ?? 0
}

/** 打样单上已经抵扣的客户预收（原币，R27） */
export function creditAppliedForSamples(ids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (!ids.length) return out
  const ph = ids.map(() => '?').join(',')
  const rows = getDb().all(
    `SELECT target_id, SUM(amount) AS amount FROM credit_applications
     WHERE target_kind = 'sample' AND reversed_at IS NULL AND target_id IN (${ph})
     GROUP BY target_id`,
    ids
  ) as Record<string, unknown>[]
  for (const r of rows) out.set(Number(r.target_id), Number(r.amount ?? 0))
  return out
}

export function creditAppliedForSample(id: number): number {
  return creditAppliedForSamples([id]).get(id) ?? 0
}

/**
 * 一批订单的金额：明细 / 收款 / 核销 / 预收抵扣各一次 IN 查询，不逐单查。
 *
 * 列表页以前每张单跑 9 条查询，几百张单一点要等两秒多；
 * 批量版本把整页压成 3 条，算法仍然是 computeOrderMoney 那一个。
 */
export function moneyForOrders(refs: MoneyRef[]): Map<number, OrderMoney> {
  const out = new Map<number, OrderMoney>()
  if (refs.length === 0) return out
  const db = getDb()
  const ids = refs.map((r) => r.id)
  const ph = ids.map(() => '?').join(',')
  const creditByOrder = creditAppliedForOrders(ids)
  const itemRows = db.all(
    `SELECT order_id, quantity, unit_price, unit_cost FROM order_items WHERE order_id IN (${ph})`,
    ids
  ) as Record<string, unknown>[]
  const payRows = db.all(`SELECT order_id, amount FROM payments WHERE order_id IN (${ph})`, ids) as Record<
    string,
    unknown
  >[]
  const settleRows = db.all(
    `SELECT order_id, kind, amount FROM order_settlements WHERE order_id IN (${ph})`,
    ids
  ) as Record<string, unknown>[]

  const settBy = new Map<number, SettlementInput[]>()
  for (const r of settleRows) {
    const id = Number(r.order_id)
    const arr = settBy.get(id) ?? []
    arr.push({ kind: String(r.kind ?? ''), amount: Number(r.amount ?? 0) })
    settBy.set(id, arr)
  }

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

  for (const ref of refs) {
    out.set(
      ref.id,
      computeOrderMoney({
        items: itemsBy.get(ref.id) ?? [],
        charges: parseCharges(ref.charges),
        payments: (paysBy.get(ref.id) ?? []).map((amount) => ({ amount })),
        settlements: settBy.get(ref.id) ?? [],
        depositRatio: ref.depositRatio,
        creditApplied: creditByOrder.get(ref.id) ?? 0
      })
    )
  }
  return out
}

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
    // created_at 是 UTC ISO 串，按月筛选必须换成本地月份，否则月底的单会串月
    where.push("strftime('%Y-%m', o.created_at, 'localtime') = ?")
    params.push(filter.month)
  }

  const rows = db.all(
    `SELECT o.id, o.order_no, o.pi_no, o.customer_id, c.company AS customer_name, c.country,
            o.currency, o.exchange_rate, o.payment_status, o.ship_status, o.deposit_ratio, o.charges, o.created_at,
            o.incoterm, o.port_of_loading, o.port_of_destination, o.payment_method, o.customer_po, o.expected_ship_date,
            o.exchange_rate_date
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC, o.id DESC`,
    params
  ) as Record<string, unknown>[]
  if (rows.length === 0) return []

  const byId = moneyForOrders(
    rows.map((r) => ({
      id: Number(r.id),
      charges: r.charges,
      depositRatio: Number(r.deposit_ratio ?? 0)
    }))
  )

  return rows.map((r) => {
    const id = Number(r.id)
    const m = byId.get(id) ?? computeOrderMoney({ items: [], charges: [], payments: [], depositRatio: 0 })
    const rate = Number(r.exchange_rate ?? 1)
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
      month: localMonthOf(createdAt),
      paymentStatus: String(r.payment_status ?? ''),
      shipStatus: String(r.ship_status ?? ''),
      incoterm: String(r.incoterm ?? ''),
      portOfLoading: String(r.port_of_loading ?? ''),
      portOfDestination: String(r.port_of_destination ?? ''),
      paymentMethod: String(r.payment_method ?? ''),
      customerPo: String(r.customer_po ?? ''),
      expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date),
      exchangeRateDate: r.exchange_rate_date == null ? null : String(r.exchange_rate_date),
      grandTotalBase: m.grandTotal * rate,
      receivableBase: m.receivable * rate,
      creditAppliedBase: m.creditApplied * rate,
      goodsValueBase: m.goodsValue * rate,
      costBase: m.totalCost * rate,
      profitBase: (m.profit ?? m.profitRaw) * rate,
      badDebtBase: m.badDebtOutstanding * rate
    }
  })
}

/**
 * 每个装箱批次的纸面金额（原币）——分批出运时每批都要有自己的箱单/发票金额。
 *
 * 本批货值 = Σ(箱内件数 × 订单同款单价)；运费保险这类费用按货值比例摊到各批。
 * 摊的分母用整单货值，所以只走了一半时，已出运的几批加起来就是那一半的钱，
 * 不会替还没装走的货提前收钱。全部装完时把分摊的分币差补给最后一批，
 * 保证各批金额相加正好等于 PI 的含费用合计（三份单据加起来对不上 PI，
 * 报关和退税核销时这条差异最难解释）。
 *
 * 已经出过 CI 的批次：纸面金额已经发给客户，系统重算不能把它改掉。
 * 那一批的费用不再按当前整单货值重新分摊，而是从存档 CI 的总额倒推——
 * 否则订单后来补几行货，旧批次的费用份额会悄悄变少/变多，和客户手里那张纸对不上。
 * 还没出过 CI 的批次只分「剩余费用」（总费用 − 已存档批次的费用），分母也换成
 * 剩余货值：拿整单 total 再摊一遍，多批 CI 的合计会超过订单总额，或者全部存档后
 * 把差额永久留在纸面之外。分币差只补给还没存档、且剩余货值已经全部装箱的那一批。
 *
 * 作废的批次一条不算：那批没走成，钱也不该记在它头上。
 */
export function packingAmounts(orderId: number): PackingAmount[] {
  const db = getDb()
  const itemRows = db.all(
    'SELECT style_no, color, size, quantity, unit_price FROM order_items WHERE order_id = ?',
    [orderId]
  ) as Record<string, unknown>[]
  const orderRow = db.get('SELECT pi_no, charges FROM orders WHERE id = ?', [orderId]) as
    | { pi_no?: string; charges?: unknown }
    | null
  // 每个批次最新一版 CI 的纸面总额（按批次号精确匹配；老版整单 CI 不参与）。
  // 作废的版本不算：作废就是摘掉「纸面依据」资格，金额回到按当前数据重算
  const archivedCi = new Map<string, number>()
  const piNo = String(orderRow?.pi_no ?? '').trim()
  if (piNo) {
    const ciRows = db.all(
      `SELECT doc_no, version, amount FROM doc_versions
       WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL ORDER BY version`,
      [orderId]
    ) as { doc_no?: string; version?: number; amount?: number }[]
    for (const r of ciRows) archivedCi.set(String(r.doc_no ?? ''), Number(r.amount ?? 0))
  }
  const money = computeOrderMoney({
    items: itemRows.map((r) => ({
      quantity: Number(r.quantity ?? 0),
      unitPrice: Number(r.unit_price ?? 0),
      unitCost: null
    })),
    charges: parseCharges(orderRow?.charges),
    payments: [],
    depositRatio: 0
  })

  // 同一款可能拆了好几行、单价还不一样：按数量加权，保证 Σ(件数 × 加权单价) 仍等于货值
  const skuPrice = new Map<string, { qty: number; amount: number }>()
  for (const r of itemRows) {
    const key = [String(r.style_no ?? ''), String(r.color ?? ''), String(r.size ?? '')].join('|')
    const cur = skuPrice.get(key) ?? { qty: 0, amount: 0 }
    cur.qty += Number(r.quantity ?? 0)
    cur.amount += Number(r.quantity ?? 0) * Number(r.unit_price ?? 0)
    skuPrice.set(key, cur)
  }
  const unitOf = (key: string): number => {
    const v = skuPrice.get(key)
    return v && v.qty > 0 ? v.amount / v.qty : 0
  }

  const lineRows = db.all(
    `SELECT pl.id AS pl_id, pl.pl_no, l.style_no, l.color, l.size, l.quantity
     FROM packing_lists pl JOIN packing_list_lines l ON l.packing_list_id = pl.id
     WHERE pl.order_id = ? AND pl.voided_at IS NULL
     ORDER BY pl.id, l.id`,
    [orderId]
  ) as Record<string, unknown>[]
  type BatchAcc = PackingAmount & {
    /** 未按分舍入的货值：先累加再舍入，批次合计才不会被逐行误差带偏 */
    goodsExact: number
    lineMap: Map<string, PackingAmountLine>
  }
  const byId = new Map<number, BatchAcc>()
  for (const r of lineRows) {
    const id = Number(r.pl_id)
    const cur =
      byId.get(id) ??
      ({
        plId: id,
        plNo: String(r.pl_no ?? ''),
        quantity: 0,
        goods: 0,
        charges: 0,
        total: 0,
        lines: [],
        chargeLines: [],
        unknownSkus: [],
        goodsExact: 0,
        lineMap: new Map()
      } satisfies BatchAcc)
    const styleNo = String(r.style_no ?? '')
    const color = String(r.color ?? '')
    const size = String(r.size ?? '')
    const key = [styleNo, color, size].join('|')
    const qty = Number(r.quantity ?? 0)
    cur.quantity += qty
    cur.goodsExact += qty * unitOf(key)
    const line = cur.lineMap.get(key) ?? { styleNo, color, size, quantity: 0, unitPrice: unitOf(key), amount: 0 }
    line.quantity += qty
    line.amount = line.quantity * line.unitPrice
    cur.lineMap.set(key, line)
    byId.set(id, cur)
  }
  const list = [...byId.values()]
  const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100

  const goodsAll = money.goodsValue
  const chargesTotal = money.chargesTotal
  const chargeRows = parseCharges(orderRow?.charges).filter((c) => c.label.trim())
  const pinned = new Set<number>()
  let pinnedGoods = 0
  let pinnedCharges = 0
  for (const b of list) {
    b.goods = r2(b.goodsExact)
    // 订单里没有这一款（升级前的老数据或敲错款号）时单价按 0：宁可少算，不编一个数出来
    // 存档在就钉（不看金额是否 > 0）：0 金额的 CI 也是纸面依据，重算等于改纸面
    if (archivedCi.has(piNo ? ciNoOf(piNo, b.plNo) : '')) {
      const archivedTotal = archivedCi.get(piNo ? ciNoOf(piNo, b.plNo) : '') ?? 0
      b.charges = r2(archivedTotal - b.goods)
      pinned.add(b.plId)
      pinnedGoods += b.goodsExact
      pinnedCharges = r2(pinnedCharges + b.charges)
    }
  }
  // 剩下能分的只有「还没被纸面金额占掉的费用」，分母也要扣掉已存档的货值
  const restCharges = r2(chargesTotal - pinnedCharges)
  const restGoods = goodsAll - pinnedGoods
  let shareSum = 0
  let unpinnedGoods = 0
  for (const b of list) {
    if (pinned.has(b.plId)) continue
    unpinnedGoods += b.goodsExact
    b.charges = restGoods > 0 ? r2((restCharges * b.goods) / restGoods) : 0
    shareSum = r2(shareSum + b.charges)
  }
  if (list.length > 0 && restGoods > 0 && Math.abs(unpinnedGoods - restGoods) < 0.005) {
    // 剩余货值已经全部装箱，才把分币差补到还能重算的批次上：
    // 落在存档批次上等于改纸面金额，落在还没装箱的货值上等于提前收费
    const last = [...list].reverse().find((b) => !pinned.has(b.plId))
    if (last) last.charges = r2(last.charges + r2(restCharges - shareSum))
  }
  for (const b of list) {
    b.total = r2(b.goods + b.charges)
    b.lines = [...b.lineMap.values()]
    // 费用行按货值比例分摊；分币差落在本批最后一行，保证各行相加 = b.charges
    b.chargeLines = chargeRows.map((c) => ({
      label: c.label,
      amount: goodsAll > 0 ? r2((Number(c.amount) || 0) * b.goods / goodsAll) : 0
    }))
    if (b.chargeLines.length) {
      const sum = r2(b.chargeLines.reduce((s, c) => s + c.amount, 0))
      const last = b.chargeLines[b.chargeLines.length - 1]
      last.amount = r2(last.amount + (b.charges - sum))
    }
    b.unknownSkus = [...new Set(b.lines.filter((l) => !skuPrice.has([l.styleNo, l.color, l.size].join('|'))).map((l) => l.styleNo))]
  }
  return list.map((b) => ({
    plId: b.plId,
    plNo: b.plNo,
    quantity: b.quantity,
    goods: b.goods,
    charges: b.charges,
    total: b.total,
    lines: b.lines,
    chargeLines: b.chargeLines,
    unknownSkus: b.unknownSkus
  }))
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
 * 一笔真金白银的到账流水（订单收款 + 打样费收款），折算汇率与所属单据口径一致。
 * 现金流口径只看订单草稿：草稿还没发出去，收到的钱是预收，不算这票的到账。
 * 打样单没有草稿概念，钱到账就算——取消/免单也一样，银行里真有这笔。
 */
export interface CashFlowRow {
  docType: 'order' | 'sample'
  /** 订单 id / 打样单 id：对账单按这个对齐，别拿单号（手改过、可能重号） */
  docId: number
  docNo: string
  piNo: string
  customerName: string
  statusText: string
  currency: string
  paidAt: string
  exchangeRate: number
  amount: number
  amountBase: number
  method: string
  bankRef: string
  note: string
}

/**
 * 全项目唯一一份「收到的钱」的取数：月报到账、收款台账导出、客户对账单都从这里取。
 * 打样费的抵扣（offset）绝不落 payments——订单负费用行已经计过一次，
 * 再落一条就是同一笔钱算两遍。所以这里只有订单流水 + 打样实收流水两类。
 * 传 customerId 时两个分支各自过滤：混用参数会让一张水单带着全公司的钱出去。
 */
export function cashFlowRows(filter: { customerId?: number } = {}): CashFlowRow[] {
  const db = getDb()
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
  const orderWhere = [cash.sql]
  const orderParams: (string | number)[] = [...cash.params]
  const sampleWhere: string[] = []
  const sampleParams: (string | number)[] = []
  if (filter.customerId != null) {
    orderWhere.push('o.customer_id = ?')
    orderParams.push(filter.customerId)
    sampleWhere.push('s.customer_id = ?')
    sampleParams.push(filter.customerId)
  }
  const rows = db.all(
    `SELECT 'order' AS doc_type, o.id AS doc_id, o.order_no AS doc_no, COALESCE(o.pi_no, '') AS pi_no,
            o.payment_status AS doc_status, c.company AS customer_name, o.currency AS currency,
            p.paid_at AS paid_at, COALESCE(p.exchange_rate, o.exchange_rate) AS exchange_rate,
            p.amount AS amount, p.method AS method, p.bank_ref AS bank_ref, p.note AS note
     FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
     WHERE ${orderWhere.join(' AND ')}
     UNION ALL
     SELECT 'sample' AS doc_type, s.id AS doc_id, s.sample_no AS doc_no, '' AS pi_no,
            s.status AS doc_status, c.company AS customer_name, s.currency AS currency,
            p.paid_at AS paid_at, COALESCE(p.exchange_rate, s.exchange_rate) AS exchange_rate,
            p.amount AS amount, p.method AS method, p.bank_ref AS bank_ref, p.note AS note
     FROM payments p JOIN sample_orders s ON s.id = p.sample_order_id
     JOIN customers c ON c.id = s.customer_id
     ${sampleWhere.length ? 'WHERE ' + sampleWhere.join(' AND ') : ''}
     ORDER BY paid_at DESC`,
    [...orderParams, ...sampleParams]
  ) as Record<string, unknown>[]
  return rows.map((r) => {
    const docType = String(r.doc_type) === 'sample' ? 'sample' : 'order'
    const status = String(r.doc_status ?? '')
    const exchangeRate = Number(r.exchange_rate ?? 0)
    const amount = Number(r.amount ?? 0)
    return {
      docType,
      docId: Number(r.doc_id ?? 0),
      docNo: String(r.doc_no ?? ''),
      piNo: String(r.pi_no ?? ''),
      customerName: String(r.customer_name ?? ''),
      statusText:
        docType === 'sample'
          ? `打样·${SAMPLE_STATUS_LABEL[status as keyof typeof SAMPLE_STATUS_LABEL] ?? status}`
          : PAYMENT_STATUS_LABEL[status as keyof typeof PAYMENT_STATUS_LABEL] ?? status,
      currency: String(r.currency ?? ''),
      paidAt: String(r.paid_at ?? ''),
      exchangeRate,
      amount,
      amountBase: amount * exchangeRate,
      method: String(r.method ?? ''),
      bankRef: String(r.bank_ref ?? ''),
      note: String(r.note ?? '')
    } as CashFlowRow
  })
}

/**
 * 到账金额按「到账月」归集（基准币），现金流口径：只排除草稿单。
 *
 * 这是全项目唯一一份「某个月收到多少钱」的实现——工作台的本月收款、
 * 月度报表的收款列、月度汇总导出都从这里取，两处各写一遍 SQL
 * 迟早会漂出两个数（红线：算钱的 SQL 不许在报表里另起一套）。
 * 已作废/失效单的钱真到账了就是到账了，所以这里用 CASHFLOW 状态集合。
 * 打样费（R25）也走同一份流水：实收落 payments，抵扣不落。
 */
export function receivedByMonth(): { month: string; amount: number }[] {
  const by = new Map<string, number>()
  for (const r of cashFlowRows()) {
    // 老数据里可能有空日期或非 YYYY-MM-DD 的收款日：这些钱认到账，但不认月份，
    // 不能让它冒出一个 "null" 月把报表撑成垃圾行
    const m = localMonthOf(r.paidAt)
    if (!/^\d{4}-\d{2}$/.test(m)) continue
    by.set(m, (by.get(m) ?? 0) + r.amountBase)
  }
  return [...by.entries()].map(([month, amount]) => ({ month, amount })).sort((a, b) => b.month.localeCompare(a.month))
}

/**
 * 客户维度欠款榜（基准币）：待收 + 该客户的打样未收。
 * 走 listOrderMoney 的同一批行，不另写算钱的 SQL。
 */
export function receivableByCustomer(): CustomerReceivable[] {
  const rows = listOrderMoney()
  const today = localDate()
  const by = new Map<number, CustomerReceivable>()
  for (const r of rows) {
    const cur = by.get(r.customerId) ?? {
      customerId: r.customerId,
      customerName: r.customerName,
      orders: 0,
      goodsBase: 0,
      sampleBase: 0,
      totalBase: 0,
      oldestUnpaidDate: null,
      oldestUnpaidDays: 0
    }
    // 「未结单数」只数还欠着钱的单：收齐的单挂在欠款榜上会让客户以为还有账没对清
    if (r.receivableBase > 0.001) {
      cur.orders += 1
      // 账龄跟着最老那笔未收走：老板看不出欠了 3 天还是 3 个月，催款先后就只能靠人记
      const created = localDateOf(r.createdAt)
      if (created && (cur.oldestUnpaidDate == null || created < cur.oldestUnpaidDate)) {
        cur.oldestUnpaidDate = created
        cur.oldestUnpaidDays = Math.max(0, Math.floor((Date.parse(today) - Date.parse(created)) / 86400000))
      }
    }
    cur.goodsBase += r.receivableBase
    by.set(r.customerId, cur)
  }
  for (const [id, v] of by) v.sampleBase = sampleReceivable(id)
  // 只打过样、还没下过单的客户也要上榜：打样费也是应收。
  // 以前只从订单行出发，这类客户的未收在欠款榜上根本不出现，榜上的合计
  // 也就对不上工作台「待收款金额」（那份是全公司口径，含打样费）。
  const sampleCustomers = getDb().all(
    `SELECT DISTINCT s.customer_id AS id, c.company AS company
     FROM sample_orders s JOIN customers c ON c.id = s.customer_id
     WHERE s.fee_status = 'unpaid' AND s.status != 'cancelled'`
  ) as { id?: number; company?: string }[]
  for (const r of sampleCustomers) {
    const id = Number(r.id ?? 0)
    if (!id || by.has(id)) continue
    const sampleBase = sampleReceivable(id)
    // 汇率没填时 sampleReceivable 返回 0：先不上榜，打样页会提醒补汇率
    if (sampleBase <= 0) continue
    by.set(id, {
      customerId: id,
      customerName: String(r.company ?? ''),
      orders: 0,
      goodsBase: 0,
      sampleBase,
      totalBase: sampleBase,
      oldestUnpaidDate: null,
      oldestUnpaidDays: 0
    })
  }
  for (const v of by.values()) v.totalBase = v.goodsBase + v.sampleBase
  // 敞口为 0 的客户不上欠款榜：收齐了还挂在榜上，业务员会以为账没对清
  return [...by.values()]
    .filter((v) => v.totalBase > 0.001)
    .sort((a, b) => b.totalBase - a.totalBase || a.customerName.localeCompare(b.customerName))
}

/**
 * 打样单待收明细（R25）：应收 = 样品费 + 快递费 − 已到的实收流水。
 * 只有 fee_status='unpaid' 的单还挂着应收；取消的单不收钱。
 * 行级明细与全公司合计共用这一份取数，界面上的数和待收总额才是同一个数。
 */
export interface SampleOpenRow {
  sampleId: number
  sampleNo: string
  customerId: number
  status: string
  currency: string
  exchangeRate: number
  /** 原币待收 */
  receivable: number
}

/** 一张打样单的金额底稿：待收、已收、对账单、欠款榜都从这一份取，不各写一条 SQL */
interface SampleMoneyRow {
  sampleId: number
  sampleNo: string
  customerId: number
  status: string
  feeStatus: string
  currency: string
  exchangeRate: number
  sampleDate: string
  /** 样品费（明细行合计） */
  sampleFee: number
  /** 样品费 + 快递费 */
  totalFee: number
  /** 真金白银收到的（payments 流水） */
  collected: number
  /** 转单时抵进订单的钱（不是现金，但账上已经收回） */
  offsetSettled: number
  /** 已收回 = 实收 + 抵扣；旧「已收无流水」按全额认 */
  recovered: number
  /** 用客户预收抵扣的金额（非现金，R27） */
  creditApplied: number
  /** 已收回的钱转进了哪张订单（抵扣单才有） */
  convertedOrderNo: string
}

function sampleMoneyRows(customerId?: number): SampleMoneyRow[] {
  const db = getDb()
  const params: (string | number)[] = []
  let where = ''
  if (customerId != null) {
    where = 'WHERE s.customer_id = ?'
    params.push(customerId)
  }
  const rows = db.all(
    `SELECT s.id, s.sample_no, s.customer_id, s.status, s.fee_status, s.currency, s.exchange_rate,
            s.sample_date, s.express_fee, s.offset_amount, co.order_no AS converted_order_no,
            COALESCE((SELECT SUM(si.quantity * si.unit_price) FROM sample_order_items si
                      WHERE si.sample_order_id = s.id), 0) AS sample_fee,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                      WHERE p.sample_order_id = s.id), 0) AS collected,
            COALESCE((SELECT SUM(ca.amount) FROM credit_applications ca
                      WHERE ca.target_kind = 'sample' AND ca.target_id = s.id
                        AND ca.reversed_at IS NULL), 0) AS credit_applied
     FROM sample_orders s LEFT JOIN orders co ON co.id = s.converted_order_id
     ${where}`,
    params
  ) as Record<string, unknown>[]
  return rows.map((r) => {
    const sampleFee = Number(r.sample_fee ?? 0)
    const expressFee = Number(r.express_fee ?? 0)
    const totalFee = sampleFee + expressFee
    const collected = Number(r.collected ?? 0)
    const feeStatus = String(r.fee_status ?? 'unpaid')
    const offsetAmount = Number(r.offset_amount ?? 0)
    // 老抵扣单 offset_amount=0（当年只抵样品费）；新单按实际抵扣额，含快递费
    const offsetSettled = feeStatus === 'offset' ? (offsetAmount > 0 ? offsetAmount : sampleFee) : 0
    // 旧「已向客户收」记录没有流水：按全额认，不能凭空造一条猜日期的流水
    const recovered =
      feeStatus === 'paid'
        ? collected > 0
          ? collected
          : totalFee
        : feeStatus === 'offset'
          ? collected + offsetSettled
          : feeStatus === 'unpaid'
            ? collected
            : 0
    return {
      sampleId: Number(r.id),
      sampleNo: String(r.sample_no ?? ''),
      customerId: Number(r.customer_id),
      status: String(r.status ?? ''),
      feeStatus,
      currency: String(r.currency ?? 'USD'),
      exchangeRate: Number(r.exchange_rate ?? 0),
      sampleDate: String(r.sample_date ?? ''),
      sampleFee,
      totalFee,
      collected,
      offsetSettled,
      recovered,
      creditApplied: Number(r.credit_applied ?? 0),
      convertedOrderNo: String(r.converted_order_no ?? '')
    }
  })
}

export function sampleOpenRows(customerId?: number): SampleOpenRow[] {
  const out: SampleOpenRow[] = []
  for (const r of sampleMoneyRows(customerId)) {
    // 只有未收的单还挂着应收；取消的单不收钱
    if (r.feeStatus !== 'unpaid' || r.status === 'cancelled') continue
    // 预收抵扣过的部分已经由客户余额覆盖，不再计待收
    const left = r.totalFee - r.collected - r.creditApplied
    if (left <= 0.001) continue
    out.push({
      sampleId: r.sampleId,
      sampleNo: r.sampleNo,
      customerId: r.customerId,
      status: r.status,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      receivable: left
    })
  }
  return out
}

/** 对账单用的打样行：已收齐/已抵扣/已免单/取消过但收过钱的都要在表上 */
export interface SampleBillRow {
  sampleId: number
  sampleNo: string
  status: string
  feeStatus: string
  currency: string
  exchangeRate: number
  sampleDate: string
  totalFee: number
  /** 已收回（实收 + 抵扣；旧记录按全额） */
  recovered: number
  /** 用客户预收抵扣的金额（非现金，R27） */
  creditApplied: number
  /** 原币待收 */
  open: number
  /** 客户多付的原币（预收结余） */
  prepaid: number
  convertedOrderNo: string
}

export function sampleStatementRows(customerId: number): SampleBillRow[] {
  const out: SampleBillRow[] = []
  for (const r of sampleMoneyRows(customerId)) {
    // 一分钱没涉及过的免费样不用上表，否则对账单全是噪声；
    // 取消的单只有真的收过钱（或抵扣过）才留一行，让客户认得出这笔钱
    if (r.totalFee <= 0.001 && r.collected <= 0.001 && r.offsetSettled <= 0.001) continue
    if (r.status === 'cancelled' && r.collected <= 0.001 && r.offsetSettled <= 0.001 && r.creditApplied <= 0.001)
      continue
    const cancelled = r.status === 'cancelled'
    const open =
      !cancelled && r.feeStatus === 'unpaid'
        ? Math.max(0, r.totalFee - r.collected - r.creditApplied)
        : 0
    // 多付的钱要单独摆出来：压进待收里会变成负数，客户以为我们算错了
    const over = r.collected - r.totalFee
    out.push({
      sampleId: r.sampleId,
      sampleNo: r.sampleNo,
      status: r.status,
      feeStatus: r.feeStatus,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      sampleDate: r.sampleDate,
      totalFee: r.totalFee,
      recovered: r.recovered,
      creditApplied: r.creditApplied,
      open,
      prepaid: over > 0.001 ? over : 0,
      convertedOrderNo: r.convertedOrderNo
    })
  }
  return out
}

/**
 * 打样单待收（基准币，N23/R25）：汇率缺失的单不计入（否则折不准），
 * 它们在打样页上会亮「汇率未填」提醒补。
 */
export function sampleReceivable(customerId?: number): number {
  let total = 0
  for (const r of sampleOpenRows(customerId)) {
    if (r.exchangeRate <= 0) continue
    total += r.receivable * r.exchangeRate
  }
  return total
}

/**
 * 客户名下所有还欠钱的单据（订单 + 打样单）——「水单拆分」按行分摊用。
 * R25 起打样费也走同一笔水单：客户一笔钱同时付订单和样品费是常事。
 */
export interface CustomerOpenRow {
  kind: 'order' | 'sample'
  docId: number
  docNo: string
  piNo: string
  statusText: string
  currency: string
  /** 原币待收 */
  receivable: number
}

export function customerOpenRows(customerId: number): CustomerOpenRow[] {
  const orders: CustomerOpenRow[] = listOrderMoney({ customerId })
    .filter((r) => r.receivable > 0.001)
    .map((r) => ({
      kind: 'order',
      docId: r.orderId,
      docNo: r.orderNo,
      piNo: r.piNo,
      statusText: PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus,
      currency: r.currency,
      receivable: r.receivable
    }))
  // 没填汇率的打样单摆进来也登记不了（服务层会拦），不如先让打样页提醒补汇率
  const samples: CustomerOpenRow[] = sampleOpenRows(customerId)
    .filter((r) => r.exchangeRate > 0)
    .map((r) => ({
      kind: 'sample',
      docId: r.sampleId,
      docNo: r.sampleNo,
      piNo: '',
      statusText: `打样·${SAMPLE_STATUS_LABEL[r.status as keyof typeof SAMPLE_STATUS_LABEL] ?? r.status}`,
      currency: r.currency,
      receivable: r.receivable
    }))
  return [...orders, ...samples]
}

/**
 * 某个客户的待收款（基准币）：订单 + 打样单，同一个口径。
 * 客户页「未收金额」用它。
 */
export function customerReceivable(customerId: number): number {
  return totalReceivable({ customerId })
}

/* ---------------- 客户预收（R27） ---------------- */

export type { CustomerCreditApplication, CustomerCreditCurrency, CustomerCreditRefund, CustomerCreditSource }

/**
 * 客户预收余额：**不另存一份钱**，全部从 payments 的现状派生。
 *
 * 口径（与对账单「预收结余」行同一份）：
 *   正常单   —— 实收 + 净核销 超过含费用合计的部分（客户多付）
 *   作废/失效 —— 已经收到的全部现金（这单不再欠钱，钱必须有去处）
 *   打样单   —— 取消/免单时收到的全部现金；其余按「实收 + 抵扣 − 应收」算多付
 *   减：未撤销的抵扣台账
 *   减：已退还客户的退款（R28）
 *
 * 抵扣与退款都不是现金流入，所以这里绝不碰 payments，也绝不进现金流/毛利。
 */
export function customerCreditBalance(customerId: number): CustomerCreditCurrency[] {
  const db = getDb()
  const by = new Map<string, CustomerCreditCurrency>()
  const bucket = (currency: string): CustomerCreditCurrency => {
    const cur = by.get(currency) ?? {
      currency,
      gross: 0,
      applied: 0,
      refunded: 0,
      available: 0,
      sources: [],
      applications: [],
      refunds: []
    }
    by.set(currency, cur)
    return cur
  }

  for (const r of listOrderMoney({ customerId, includeVoided: true })) {
    // 草稿还没成为正式生意，钱不该已经到账；真到了也不认（现金流同样排除草稿）
    if (r.paymentStatus === 'draft') continue
    const amount = isBillingStatus(r.paymentStatus)
      ? Math.max(0, r.paidAmount + r.netWrittenOff - r.grandTotal)
      : r.paidAmount
    if (amount <= 0.001) continue
    const b = bucket(r.currency)
    b.gross += amount
    b.sources.push({
      kind: 'order',
      docId: r.orderId,
      docNo: r.orderNo,
      piNo: r.piNo,
      date: localDateOf(r.createdAt),
      statusText:
        PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      amount
    })
  }

  for (const r of sampleMoneyRows(customerId)) {
    const amount =
      r.status === 'cancelled' || r.feeStatus === 'waived'
        ? r.collected
        : Math.max(0, r.collected + r.offsetSettled - r.totalFee)
    if (amount <= 0.001) continue
    const b = bucket(r.currency)
    b.gross += amount
    b.sources.push({
      kind: 'sample',
      docId: r.sampleId,
      docNo: r.sampleNo,
      piNo: '',
      date: r.sampleDate,
      statusText: `打样·${SAMPLE_STATUS_LABEL[r.status as keyof typeof SAMPLE_STATUS_LABEL] ?? r.status} · ${
        SAMPLE_FEE_STATUS_LABEL[r.feeStatus as keyof typeof SAMPLE_FEE_STATUS_LABEL] ?? r.feeStatus
      }`,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      amount
    })
  }

  const appRows = db.all(
    `SELECT ca.id, ca.currency, ca.amount, ca.target_kind, ca.target_id, ca.applied_at, ca.note, ca.actor,
            COALESCE(o.order_no, s.sample_no, '') AS target_no
     FROM credit_applications ca
     LEFT JOIN orders o ON ca.target_kind = 'order' AND o.id = ca.target_id
     LEFT JOIN sample_orders s ON ca.target_kind = 'sample' AND s.id = ca.target_id
     WHERE ca.customer_id = ? AND ca.reversed_at IS NULL
     ORDER BY ca.applied_at, ca.id`,
    [customerId]
  ) as Record<string, unknown>[]
  for (const r of appRows) {
    const b = bucket(String(r.currency ?? ''))
    const amount = Number(r.amount ?? 0)
    b.applied += amount
    b.applications.push({
      id: Number(r.id),
      currency: String(r.currency ?? ''),
      amount,
      targetKind: String(r.target_kind ?? '') === 'sample' ? 'sample' : 'order',
      targetId: Number(r.target_id ?? 0),
      targetNo: String(r.target_no ?? ''),
      appliedAt: String(r.applied_at ?? ''),
      note: String(r.note ?? ''),
      actor: String(r.actor ?? '')
    })
  }

  const refundRows = db.all(
    `SELECT id, currency, amount, refund_at, bank_ref, note, actor
     FROM customer_refunds
     WHERE customer_id = ? AND reversed_at IS NULL
     ORDER BY refund_at, id`,
    [customerId]
  ) as Record<string, unknown>[]
  for (const r of refundRows) {
    const b = bucket(String(r.currency ?? ''))
    const amount = Number(r.amount ?? 0)
    b.refunded += amount
    b.refunds.push({
      id: Number(r.id),
      currency: String(r.currency ?? ''),
      amount,
      refundAt: String(r.refund_at ?? ''),
      bankRef: String(r.bank_ref ?? ''),
      note: String(r.note ?? ''),
      actor: String(r.actor ?? '')
    })
  }

  const out: CustomerCreditCurrency[] = []
  for (const b of by.values()) {
    b.available = b.gross - b.applied - b.refunded
    if (
      Math.abs(b.gross) <= 0.001 &&
      Math.abs(b.applied) <= 0.001 &&
      Math.abs(b.refunded) <= 0.001
    )
      continue
    b.sources.sort((a, c) => a.date.localeCompare(c.date) || a.docNo.localeCompare(c.docNo))
    b.applications.sort((a, c) => a.appliedAt.localeCompare(c.appliedAt) || a.id - c.id)
    b.refunds.sort((a, c) => a.refundAt.localeCompare(c.refundAt) || a.id - c.id)
    out.push(b)
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency))
}

/** 某币种可用预收（原币；来源被改动时可能是负数） */
export function customerCreditAvailable(customerId: number, currency: string): number {
  const hit = customerCreditBalance(customerId).find((c) => c.currency === currency)
  return hit?.available ?? 0
}
