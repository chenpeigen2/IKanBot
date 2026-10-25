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
import { localMonthOf } from '../../src/shared/date'
import { NON_BILLING_STATUSES } from '../../src/shared/billing'
import type { CustomerReceivable, PackingAmount, PackingAmountLine, QuotationCharge } from '../../src/shared/types'

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
  const remaining = grandTotal - paidAmount - st.netWrittenOff
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
 * 一批订单的金额：明细 / 收款 / 核销各一次 IN 查询，不逐单查。
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
        depositRatio: ref.depositRatio
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
 * 作废的批次一条不算：那批没走成，钱也不该记在它头上。
 */
export function packingAmounts(orderId: number): PackingAmount[] {
  const db = getDb()
  const itemRows = db.all(
    'SELECT style_no, color, size, quantity, unit_price FROM order_items WHERE order_id = ?',
    [orderId]
  ) as Record<string, unknown>[]
  const orderRow = db.get('SELECT charges FROM orders WHERE id = ?', [orderId]) as { charges?: unknown } | null
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
  let shareSum = 0
  for (const b of list) {
    b.goods = r2(b.goodsExact)
    // 订单里没有这一款（升级前的老数据或敲错款号）时单价按 0：宁可少算，不编一个数出来
    b.charges = goodsAll > 0 ? r2((chargesTotal * b.goods) / goodsAll) : 0
    shareSum = r2(shareSum + b.charges)
  }
  const packedGoods = list.reduce((s, b) => s + b.goods, 0)
  if (list.length > 0 && goodsAll > 0 && Math.abs(packedGoods - goodsAll) < 0.005) {
    const last = list[list.length - 1]
    last.charges = r2(last.charges + r2(chargesTotal - shareSum))
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
 * 到账金额按「到账月」归集（基准币），现金流口径：只排除草稿单。
 *
 * 这是全项目唯一一份「某个月收到多少钱」的实现——工作台的本月收款、
 * 月度报表的收款列、月度汇总导出都从这里取，两处各写一遍 SQL
 * 迟早会漂出两个数（红线：算钱的 SQL 不许在报表里另起一套）。
 * 已作废/失效单的钱真到账了就是到账了，所以这里用 CASHFLOW 状态集合。
 */
export function receivedByMonth(): { month: string; amount: number }[] {
  const db = getDb()
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
  const rows = db.all(
    `SELECT p.paid_at AS paid_at, p.amount * o.exchange_rate AS amount_base
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${cash.sql}`,
    cash.params
  ) as Record<string, unknown>[]
  const by = new Map<string, number>()
  for (const r of rows) {
    // 老数据里可能有空日期或非 YYYY-MM-DD 的收款日：这些钱认到账，但不认月份，
    // 不能让它冒出一个 "null" 月把报表撑成垃圾行
    const m = localMonthOf(String(r.paid_at ?? ''))
    if (!/^\d{4}-\d{2}$/.test(m)) continue
    by.set(m, (by.get(m) ?? 0) + Number(r.amount_base ?? 0))
  }
  return [...by.entries()].map(([month, amount]) => ({ month, amount })).sort((a, b) => b.month.localeCompare(a.month))
}

/**
 * 客户维度欠款榜（基准币）：待收 + 该客户的打样未收。
 * 走 listOrderMoney 的同一批行，不另写算钱的 SQL。
 */
export function receivableByCustomer(): CustomerReceivable[] {
  const rows = listOrderMoney()
  const by = new Map<number, CustomerReceivable>()
  for (const r of rows) {
    const cur = by.get(r.customerId) ?? {
      customerId: r.customerId,
      customerName: r.customerName,
      orders: 0,
      goodsBase: 0,
      sampleBase: 0,
      totalBase: 0
    }
    cur.orders += 1
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
      totalBase: sampleBase
    })
  }
  for (const v of by.values()) v.totalBase = v.goodsBase + v.sampleBase
  return [...by.values()].sort((a, b) => b.totalBase - a.totalBase || a.customerName.localeCompare(b.customerName))
}

/**
 * 打样单待收（基准币，N23）：样品费 + 快递费，只有 fee_status='unpaid' 才算。
 * 汇率缺失的单不计入（否则折不准），它们在打样页上会亮「汇率未填」提醒补。
 */
export function sampleReceivable(customerId?: number): number {
  const db = getDb()
  // 取消的打样单不再向客户收钱：样品都没做/没寄，催款是错的
  const where = ["s.fee_status = 'unpaid'", "s.status != 'cancelled'"]
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
