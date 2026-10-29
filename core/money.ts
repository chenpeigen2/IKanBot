/**
 * 金额口径唯一真源：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
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
 *
 * 分层（M1-4）：
 *   纯算式（parseCharges / computeOrderMoney / depositDueOf / summarizeSettlements / …）不碰库，
 *   在模块顶层同步导出，两端都能直接用；要读库的 21 个函数收进 moneyCore(db)，
 *   驱动换成异步 Db 接口，SQL 与口径仍然只有这一份。桌面那层壳只负责把本机 Db 接进来。
 */
import { localMonthOf, localDateOf, localDate } from '../src/shared/date'
import { ciNoOf } from '../src/shared/documents'
import { NON_BILLING_STATUSES, isBillingStatus } from '../src/shared/billing'
import { settingsCore } from './settings'
import type {
  CustomerCreditApplication,
  CustomerCreditCurrency,
  CustomerCreditRefund,
  CustomerCreditSource,
  CustomerReceivable,
  PackingAmount,
  PackingAmountLine,
  QuotationCharge
} from '../src/shared/types'
import { PAYMENT_STATUS_LABEL, SAMPLE_FEE_STATUS_LABEL, SAMPLE_STATUS_LABEL } from '../src/shared/types'
import type { Db } from './db'

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

/**
 * 费用行变更说明（人话），订单和报价单的留痕共用这一份。
 *
 * 不能按名称建 Map 比对：两张「运费」行改其中一张，Map 会互相覆盖，
 * 留痕写成「运费 300 → 50」却没说动的是哪一张、另一张去哪了。
 * 这里按名称分组、组内金额当多重集配对：相等的先消掉，剩下的才是真的增/删/改。
 *
 * @param word 名称前的限定词，订单信息变更里要写「新增费用 运费 100」，
 *             改费用行的留痕已经包在「修改费用：」里，就只要「新增 运费 100」
 */
export function describeChargeChange(
  oldCharges: QuotationCharge[],
  newCharges: QuotationCharge[],
  word = ''
): string[] {
  const parts: string[] = []
  const labels = [...new Set([...oldCharges, ...newCharges].map((c) => c.label))]
  for (const label of labels) {
    const olds = oldCharges
      .filter((c) => c.label === label)
      .map((c) => Number(c.amount))
      .sort((a, b) => a - b)
    const news = newCharges
      .filter((c) => c.label === label)
      .map((c) => Number(c.amount))
      .sort((a, b) => a - b)
    const pool = [...olds]
    const changed: number[] = []
    for (const amt of news) {
      const i = pool.indexOf(amt)
      if (i >= 0) pool.splice(i, 1)
      else changed.push(amt)
    }
    // 多出来的新金额和没配掉的老金额按序配对说成「改」，两边数量一样就是纯改、多出来的是新增
    for (const amt of changed) {
      const old = pool.shift()
      if (old === undefined) parts.push(`新增${word} ${label} ${amt}`)
      else parts.push(word ? `${word} ${label} ${old} → ${amt}` : `${label} ${old} → ${amt}`)
    }
    for (const amt of pool) parts.push(`删除${word} ${label} ${amt}`)
  }
  return parts
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
  /**
   * 追回款里真正抵掉坏账的那一截（≤ 坏账）。
   * 它不是客户多付的钱，是还那笔已经核销掉的欠款——算客户预收余额时必须扣掉，
   * 否则同一笔钱既当坏账损失、又能抵别的单、还能退给客户。
   */
  recoveredApplied: number
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
  /** 追回款里抵掉坏账的那一截：是还欠款，不是客户多付（见 SettlementTotals） */
  badDebtRecovered: number
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
    netWrittenOff: shortage + badDebt - recoveredApplied,
    recoveredApplied
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
    netWrittenOff: st.netWrittenOff,
    badDebtRecovered: st.recoveredApplied
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
  /** 库里存的汇率原值（本币单可能是历史垃圾，只用于展示「当时填的什么」） */
  exchangeRate: number
  /**
   * 折算基准币真正用的汇率：本币单固定 1、外币没填过为 0（折不出来）。
   * 任何「拿汇率去乘」的地方都只能用这个数——用 exchangeRate 乘，
   * 本币单会被历史垃圾值放大，和 grandTotalBase/costBase 说的不是一个数。
   */
  baseRate: number
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
  /** 毛利折基准币；成本没录全的单没有毛利可言，是 null（不许拿 0 凑一个好看的数） */
  profitBase: number | null
  /** 外币单汇率没填过：折不出基准币，上面的 *Base 全是 0，靠「汇率待修」追人补 */
  rateMissing: boolean
  /** 尚未追回的坏账（基准币） */
  badDebtBase: number
}

/**
 * 定金还差多少（原币）：到账、预收抵扣、已核销的短款/坏账都算有「着落」。
 * 工作台的催定金、待收四桶、尾款提醒的压制条件共用这一份，
 * 否则会出现「提醒说还差 10、桶里算 30、尾款永远不催」。
 */
export function depositDueOf(
  r: Pick<OrderMoneyRow, 'depositAmount' | 'receivable' | 'paidAmount' | 'netWrittenOff' | 'creditApplied'>
): number {
  if (!(r.depositAmount > 0)) return 0
  return Math.max(
    0,
    Math.min(r.receivable, r.depositAmount - r.paidAmount - r.netWrittenOff - r.creditApplied)
  )
}

/**
 * 一笔钱折成基准币：折不出就给 null，不许拿 0 或原币凑一个数。
 *
 * 三种情况：本币单不需要汇率（老数据里汇率是默认 0，折成 0 就凭空少一笔钱）；
 * 外币单汇率没填过（≤0）折不出 → null，由调用方露出「N 笔未折算」；
 * 外币单汇率正好 1:1 = 建单时没人盘过，那是「汇率待修」提醒负责追人的事，
 * 这里照旧按 1 折——待收、销售额、毛利用的是同一个存值，现金流不许偷偷换一套规矩。
 */
export function baseAmountOf(
  currency: string,
  baseCurrency: string,
  rate: number,
  amount: number
): number | null {
  if (currency === baseCurrency) return amount
  if (!(rate > 0)) return null
  return amount * rate
}

/**
 * 折算基准币真正要乘的那个汇率：订单台账、订单列表、对账单、打样台账共用这一份。
 *
 * 本币单固定 1——库里那一列可能是升级前的历史值（当年建单也逼人填汇率，
 * 有人顺手填了 7.15），拿它乘会把一张 CNY 单折成 7.15 倍；
 * 外币单没填过就返回 0，由 rateMissing 标出来让「汇率待修」追人。
 */
export function baseRateOf(currency: string, baseCurrency: string, storedRate: number): number {
  if (currency === baseCurrency) return 1
  return storedRate > 0 ? storedRate : 0
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
  /** 折成基准币；汇率没填过就是 null（宁可空着，不拿 1:1 或 0 凑一个数） */
  amountBase: number | null
  method: string
  bankRef: string
  note: string
}

/**
 * 预收退款流水（R30）：钱从公司账上退给客户，是现金**流出**。
 *
 * 为什么不并进 cashFlowRows：
 *  - 月报/工作台的「收款」是毛流入口径，退款不是收款；
 *  - 对账单已经把退款单独列行（取自客户余额），并进 cashFlowRows 会列两遍；
 *  - customer_refunds 没有汇率快照，硬折基准币只能猜一个汇率。
 * 所以这里只给「收款台账」补一条原币负流水，基准币列留空，等有汇率快照再折。
 * 只认未撤销的退款：撤销代表钱没出去，不能留在台账里。
 */
export interface RefundFlowRow {
  refundId: number
  customerId: number
  customerName: string
  refundAt: string
  currency: string
  amount: number
  bankRef: string
  note: string
  actor: string
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
  /** 折基准币真正乘的汇率：本币 1、外币没填过 0（rateMissing） */
  baseRate: number
  /** 原币待收 */
  receivable: number
}

/** 一张打样单的金额底稿：待收、已收、对账单、欠款榜都从这一份取，不各写一条 SQL */
export interface SampleMoneyRow {
  sampleId: number
  sampleNo: string
  customerId: number
  status: string
  feeStatus: string
  currency: string
  exchangeRate: number
  /** 折基准币真正乘的汇率：本币 1、外币没填过 0 */
  baseRate: number
  /** 外币单汇率没填过：待收和台面金额都折不出来，要人去补 */
  rateMissing: boolean
  sampleDate: string
  /** 样品费（明细行合计） */
  sampleFee: number
  /** 样品费 + 快递费 */
  totalFee: number
  /** 真金白银收到的（payments 流水） */
  collected: number
  /** 转单时抵进订单的钱（不是现金，但账上已经收回） */
  offsetSettled: number
  /** 抵扣是否生效（feeStatus=offset 且转出订单在计费状态） */
  offsetLive: boolean
  /** 转出订单的付款状态原值；抵扣挂起时它不在计费状态 */
  convertedStatus: string
  /** 已收回 = 实收 + 抵扣；旧「已收无流水」按全额认 */
  recovered: number
  /**
   * 这张单多出来的钱（原币，进客户预收结余）：
   *   取消 / 客户免单 —— 单子不再收钱，已经进来的现金必须有个去处，全额算多付；
   *   其余 —— 实收 + 生效的抵扣 − 应收，只认超出单据的那截。
   * 对账单的「预收结余」行和 customerCreditBalance 共用这个数（R48）：
   * 以前对账单只看现金（collected − totalFee），抵扣过的单两边各说一套，
   * 客户页写着「可用 300」，发出去的对账单却一行都不提。
   */
  prepaid: number
  /** 标了「已收」但一条单笔水单都没有（升级前的老记录），recovered 走的是全额兜底 */
  legacyPaidNoFlow: boolean
  /** 用客户预收抵扣的金额（非现金，R27） */
  creditApplied: number
  /** 已收回的钱转进了哪张订单（抵扣单才有） */
  convertedOrderNo: string
}

/** 对账单用的打样行：已收齐/已抵扣/已免单/取消过但收过钱的都要在表上 */
export interface SampleBillRow {
  sampleId: number
  sampleNo: string
  status: string
  feeStatus: string
  currency: string
  exchangeRate: number
  /** 折基准币真正乘的汇率：本币 1、外币没填过 0 */
  baseRate: number
  sampleDate: string
  totalFee: number
  /** 已收回（实收 + 抵扣；旧记录按全额） */
  recovered: number
  /** 标了「已收」但没有单笔水单（升级前的老记录）：钱认，对账单上要能区分 */
  legacyPaidNoFlow: boolean
  /** 用客户预收抵扣的金额（非现金，R27） */
  creditApplied: number
  /** 原币待收 */
  open: number
  /** 客户多付的原币（预收结余） */
  prepaid: number
  convertedOrderNo: string
  /** 抵扣挂起：转出订单草稿/失效/作废，样品费回到待收（与工作台、打样页同一口径） */
  offsetSuspended: boolean
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

export type { CustomerCreditApplication, CustomerCreditCurrency, CustomerCreditRefund, CustomerCreditSource }

/* ---------------- 读库函数（驱动无关） ---------------- */

export function moneyCore(db: Db) {
  /**
   * 订单上已经抵扣的客户预收（原币，R27）。只认未撤销的行。
   * 传一批 id 时一条 SQL 搞定；列表、详情、对账单都必须从这里取，
   * 不许各自去 SUM credit_applications。
   */
  async function creditAppliedForOrders(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>()
    if (!ids.length) return out
    const ph = ids.map(() => '?').join(',')
    const rows = (await db.all(
      `SELECT target_id, SUM(amount) AS amount FROM credit_applications
     WHERE target_kind = 'order' AND reversed_at IS NULL AND target_id IN (${ph})
     GROUP BY target_id`,
      ids
    )) as Record<string, unknown>[]
    for (const r of rows) out.set(Number(r.target_id), Number(r.amount ?? 0))
    return out
  }

  async function creditAppliedForOrder(id: number): Promise<number> {
    return (await creditAppliedForOrders([id])).get(id) ?? 0
  }

  /** 打样单上已经抵扣的客户预收（原币，R27） */
  async function creditAppliedForSamples(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>()
    if (!ids.length) return out
    const ph = ids.map(() => '?').join(',')
    const rows = (await db.all(
      `SELECT target_id, SUM(amount) AS amount FROM credit_applications
     WHERE target_kind = 'sample' AND reversed_at IS NULL AND target_id IN (${ph})
     GROUP BY target_id`,
      ids
    )) as Record<string, unknown>[]
    for (const r of rows) out.set(Number(r.target_id), Number(r.amount ?? 0))
    return out
  }

  async function creditAppliedForSample(id: number): Promise<number> {
    return (await creditAppliedForSamples([id])).get(id) ?? 0
  }

  /**
   * 一批订单的金额：明细 / 收款 / 核销 / 预收抵扣各一次 IN 查询，不逐单查。
   *
   * 列表页以前每张单跑 9 条查询，几百张单一点要等两秒多；
   * 批量版本把整页压成 3 条，算法仍然是 computeOrderMoney 那一个。
   */
  async function moneyForOrders(refs: MoneyRef[]): Promise<Map<number, OrderMoney>> {
    const out = new Map<number, OrderMoney>()
    if (refs.length === 0) return out
    const ids = refs.map((r) => r.id)
    const ph = ids.map(() => '?').join(',')
    const creditByOrder = await creditAppliedForOrders(ids)
    const itemRows = (await db.all(
      `SELECT order_id, quantity, unit_price, unit_cost FROM order_items WHERE order_id IN (${ph})`,
      ids
    )) as Record<string, unknown>[]
    const payRows = (await db.all(`SELECT order_id, amount FROM payments WHERE order_id IN (${ph})`, ids)) as Record<
      string,
      unknown
    >[]
    const settleRows = (await db.all(
      `SELECT order_id, kind, amount FROM order_settlements WHERE order_id IN (${ph})`,
      ids
    )) as Record<string, unknown>[]

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
  async function listOrderMoney(filter: MoneyListFilter = {}): Promise<OrderMoneyRow[]> {
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

    const rows = (await db.all(
      `SELECT o.id, o.order_no, o.pi_no, o.customer_id, c.company AS customer_name, c.country,
            o.currency, o.exchange_rate, o.payment_status, o.ship_status, o.deposit_ratio, o.charges, o.created_at,
            o.incoterm, o.port_of_loading, o.port_of_destination, o.payment_method, o.customer_po, o.expected_ship_date,
            o.exchange_rate_date
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC, o.id DESC`,
      params
    )) as Record<string, unknown>[]
    if (rows.length === 0) return []

    const byId = await moneyForOrders(
      rows.map((r) => ({
        id: Number(r.id),
        charges: r.charges,
        depositRatio: Number(r.deposit_ratio ?? 0)
      }))
    )

    const base = (await settingsCore(db).get()).baseCurrency
    return rows.map((r) => {
      const id = Number(r.id)
      const m = byId.get(id) ?? computeOrderMoney({ items: [], charges: [], payments: [], depositRatio: 0 })
      const currency = String(r.currency ?? 'USD')
      const rateRaw = Number(r.exchange_rate ?? 0)
      // 本币单本来就没有折算（老数据那一列是默认 0）：按 1 折，别把一笔真钱折成 0。
      // 外币单汇率没填过（0 或空）折不出来，不许蒙成 1:1——把一笔 USD 当本币记进
      // 销售额和待收，数字看着合理却全是错的。这里折成 0 并亮出 rateMissing，
      // 由「汇率待修」提醒去追人补（与打样未收同一口径）。
      const isHomeCurrency = currency === base
      const rateMissing = !isHomeCurrency && !(rateRaw > 0)
      // 折算用的汇率：本币单永远是 1（那一列存的是历史垃圾也别拿它乘），
      // 外币单没填过就按 0 折（折不出来，交给「汇率待修」追人），照旧吐出存值
      const rate = baseRateOf(currency, base, rateRaw)
      const createdAt = String(r.created_at ?? '')
      return {
        ...m,
        orderId: id,
        orderNo: String(r.order_no ?? ''),
        piNo: String(r.pi_no ?? ''),
        customerId: Number(r.customer_id),
        customerName: String(r.customer_name ?? ''),
        country: String(r.country ?? ''),
        currency,
        exchangeRate: rateRaw,
        baseRate: rate,
        rateMissing,
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
        // 成本没录全的单没有毛利可言：profitRaw 是「当成本为 0」算出来的，
        // 直接折进基准币就等于凭空报一笔高毛利。没有就是 null，让调用方去追（与 profit 同一个说法）。
        // 外币单没填汇率同样折不出来：报 0 等于断言「这单没赚钱」，也一并 null
        profitBase: m.profit === null || rateMissing ? null : m.profit * rate,
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
  async function packingAmounts(orderId: number): Promise<PackingAmount[]> {
    const itemRows = (await db.all(
      'SELECT style_no, color, size, quantity, unit_price FROM order_items WHERE order_id = ?',
      [orderId]
    )) as Record<string, unknown>[]
    const orderRow = (await db.get('SELECT pi_no, charges FROM orders WHERE id = ?', [orderId])) as
      | { pi_no?: string; charges?: unknown }
      | null
    // 每个批次最新一版 CI 的纸面总额（按批次号精确匹配；老版整单 CI 不参与）。
    // 作废的版本不算：作废就是摘掉「纸面依据」资格，金额回到按当前数据重算
    const archivedCi = new Map<string, number>()
    const piNo = String(orderRow?.pi_no ?? '').trim()
    if (piNo) {
      const ciRows = (await db.all(
        `SELECT doc_no, version, amount FROM doc_versions
       WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL ORDER BY version`,
        [orderId]
      )) as { doc_no?: string; version?: number; amount?: number }[]
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

    const lineRows = (await db.all(
      `SELECT pl.id AS pl_id, pl.pl_no, l.style_no, l.color, l.size, l.quantity
     FROM packing_lists pl JOIN packing_list_lines l ON l.packing_list_id = pl.id
     WHERE pl.order_id = ? AND pl.voided_at IS NULL
     ORDER BY pl.id, l.id`,
      [orderId]
    )) as Record<string, unknown>[]
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
  async function totalReceivable(filter: MoneyListFilter = {}): Promise<number> {
    const orders = (await listOrderMoney(filter)).reduce((s, r) => s + r.receivableBase, 0)
    const samples = await sampleReceivable(filter.customerId)
    return orders + samples
  }

  /**
   * 全项目唯一一份「收到的钱」的取数：月报到账、收款台账导出、客户对账单都从这里取。
   * 打样费的抵扣（offset）绝不落 payments——订单负费用行已经计过一次，
   * 再落一条就是同一笔钱算两遍。所以这里只有订单流水 + 打样实收流水两类。
   * 传 customerId 时两个分支各自过滤：混用参数会让一张水单带着全公司的钱出去。
   */
  async function cashFlowRows(filter: { customerId?: number } = {}): Promise<CashFlowRow[]> {
    const base = (await settingsCore(db).get()).baseCurrency
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
    const rows = (await db.all(
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
    )) as Record<string, unknown>[]
    return rows.map((r) => {
      const docType = String(r.doc_type) === 'sample' ? 'sample' : 'order'
      const status = String(r.doc_status ?? '')
      const amount = Number(r.amount ?? 0)
      const currency = String(r.currency ?? '')
      // 折算用的汇率与台账同一份派生：本币旧单存着的 7.15 不许印到对账单上，
      // 外币没填汇率才是 0（折不出来，给 null 让报表说「N 笔未折算」）
      const rate = baseRateOf(currency, base, Number(r.exchange_rate ?? 0))
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
        currency,
        paidAt: String(r.paid_at ?? ''),
        exchangeRate: rate,
        amount,
        // 汇率没填过的外币单折不出基准币：给 null，让报表露出「N 笔未折算」，
        // 而不是悄悄算成 0（银行里真有过这笔钱）
        amountBase: baseAmountOf(currency, base, rate, amount),
        method: String(r.method ?? ''),
        bankRef: String(r.bank_ref ?? ''),
        note: String(r.note ?? '')
      } as CashFlowRow
    })
  }

  async function refundFlowRows(filter: { customerId?: number } = {}): Promise<RefundFlowRow[]> {
    const where = ['r.reversed_at IS NULL']
    const params: (string | number)[] = []
    if (filter.customerId != null) {
      where.push('r.customer_id = ?')
      params.push(filter.customerId)
    }
    const rows = (await db.all(
      `SELECT r.id, r.customer_id, c.company AS customer_name, r.currency, r.refund_at, r.amount,
            r.bank_ref, r.note, r.actor
     FROM customer_refunds r JOIN customers c ON c.id = r.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.refund_at DESC, r.id DESC`,
      params
    )) as Record<string, unknown>[]
    return rows.map((r) => ({
      refundId: Number(r.id ?? 0),
      customerId: Number(r.customer_id ?? 0),
      customerName: String(r.customer_name ?? ''),
      refundAt: String(r.refund_at ?? ''),
      currency: String(r.currency ?? ''),
      amount: Number(r.amount ?? 0),
      bankRef: String(r.bank_ref ?? ''),
      note: String(r.note ?? ''),
      actor: String(r.actor ?? '')
    }))
  }

  /**
   * 到账金额按「到账月」归集（基准币），现金流口径：只排除草稿单。
   *
   * 这是全项目唯一一份「某个月收到多少钱」的实现——工作台的本月收款、
   * 月度报表的收款列、月度汇总导出都从这里取，两处各写一遍 SQL
   * 迟早会漂出两个数（红线：算钱的 SQL 不许在报表里另起一套）。
   * 已作废/失效单的钱真到账了就是到账了，所以这里用 CASHFLOW 状态集合。
   * 打样费（R25）也走同一份流水：实收落 payments，抵扣不落。
   * `unconverted` 是这个月有几笔**没能折进** amount 的流水（外币单汇率没填）：
   * 钱确实到过账，只是折不出基准币，必须让界面把笔数露出来，而不是让它从合计里静默消失。
   */
  async function receivedByMonth(): Promise<{ month: string; amount: number; unconverted: number }[]> {
    const by = new Map<string, { amount: number; unconverted: number }>()
    for (const r of await cashFlowRows()) {
      // 老数据里可能有空日期或非 YYYY-MM-DD 的收款日：这些钱认到账，但不认月份，
      // 不能让它冒出一个 "null" 月把报表撑成垃圾行
      const m = localMonthOf(r.paidAt)
      if (!/^\d{4}-\d{2}$/.test(m)) continue
      const cur = by.get(m) ?? { amount: 0, unconverted: 0 }
      if (r.amountBase === null) cur.unconverted += 1
      else cur.amount += r.amountBase
      by.set(m, cur)
    }
    return [...by.entries()]
      .map(([month, v]) => ({ month, amount: v.amount, unconverted: v.unconverted }))
      .sort((a, b) => b.month.localeCompare(a.month))
  }

  /**
   * 退款按「出账月」归集：这是一笔钱离开公司，和 receivedByMonth 的现金流入方向相反，
   * 绝不能并进那份数（并了月报的「收款」就变成了净额，客户对不上水单）。
   * customer_refunds 没有汇率快照，所以只按原币分列，展示层说明「不含退款」即可。
   */
  async function refundedByMonth(): Promise<{ month: string; count: number; byCurrency: { currency: string; amount: number }[] }[]> {
    const by = new Map<string, { count: number; cur: Map<string, number> }>()
    for (const r of await refundFlowRows()) {
      const m = localMonthOf(r.refundAt)
      if (!/^\d{4}-\d{2}$/.test(m)) continue
      const hit = by.get(m) ?? { count: 0, cur: new Map<string, number>() }
      hit.count += 1
      hit.cur.set(r.currency, (hit.cur.get(r.currency) ?? 0) + r.amount)
      by.set(m, hit)
    }
    return [...by.entries()]
      .map(([month, v]) => ({
        month,
        count: v.count,
        byCurrency: [...v.cur.entries()].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency))
      }))
      .sort((a, b) => b.month.localeCompare(a.month))
  }

  /**
   * 客户维度欠款榜（基准币）：待收 + 该客户的打样未收。
   * 走 listOrderMoney 的同一批行，不另写算钱的 SQL。
   */
  async function receivableByCustomer(): Promise<CustomerReceivable[]> {
    const rows = await listOrderMoney()
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
    // 打样待收也走 sampleOpenRows 这一份口径：R29 起「转单抵扣挂起」（订单退回草稿/失效）
    // 的样品费会重新出现在待收里。以前这里按 fee_status='unpaid' 另查一遍，
    // 只有挂起抵扣打样单的客户会整家从欠款榜消失，榜合计又对不上工作台待收。
    const sampleBaseByCustomer = new Map<number, number>()
    for (const r of await sampleOpenRows()) {
      // 汇率没填时折不出来，不上榜；打样页会提醒补汇率
      if (!(r.baseRate > 0)) continue
      const base = r.receivable * r.baseRate
      if (base <= 0.001) continue
      sampleBaseByCustomer.set(r.customerId, (sampleBaseByCustomer.get(r.customerId) ?? 0) + base)
    }
    for (const [id, v] of by) v.sampleBase = sampleBaseByCustomer.get(id) ?? 0
    // 只打过样、还没下过单的客户也要上榜：打样费也是应收。
    const sampleOnlyIds = [...sampleBaseByCustomer.keys()].filter((id) => !by.has(id))
    if (sampleOnlyIds.length) {
      const names = (await db.all(
        `SELECT id, company FROM customers WHERE id IN (${sampleOnlyIds.map(() => '?').join(',')})`,
        sampleOnlyIds
      )) as { id?: number; company?: string }[]
      const nameById = new Map(names.map((n) => [Number(n.id ?? 0), String(n.company ?? '')]))
      for (const id of sampleOnlyIds) {
        const sampleBase = sampleBaseByCustomer.get(id) ?? 0
        if (sampleBase <= 0.001) continue
        by.set(id, {
          customerId: id,
          customerName: nameById.get(id) ?? '',
          orders: 0,
          goodsBase: 0,
          sampleBase,
          totalBase: sampleBase,
          oldestUnpaidDate: null,
          oldestUnpaidDays: 0
        })
      }
    }
    for (const v of by.values()) v.totalBase = v.goodsBase + v.sampleBase
    // 敞口为 0 的客户不上欠款榜：收齐了还挂在榜上，业务员会以为账没对清
    return [...by.values()]
      .filter((v) => v.totalBase > 0.001)
      .sort((a, b) => b.totalBase - a.totalBase || a.customerName.localeCompare(b.customerName))
  }

  async function sampleMoneyRows(customerId?: number): Promise<SampleMoneyRow[]> {
    const params: (string | number)[] = []
    let where = ''
    if (customerId != null) {
      where = 'WHERE s.customer_id = ?'
      params.push(customerId)
    }
    const rows = (await db.all(
      `SELECT s.id, s.sample_no, s.customer_id, s.status, s.fee_status, s.currency, s.exchange_rate,
            s.sample_date, s.express_fee, s.offset_amount, co.order_no AS converted_order_no,
            co.payment_status AS converted_order_status,
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
    )) as Record<string, unknown>[]
    // 打样单也认本位币：CNY 打样单不该被逼着填 7.15，更不该按 7.15 折进待收
    const baseCurrency = (await settingsCore(db).get()).baseCurrency
    return rows.map((r) => {
      const sampleFee = Number(r.sample_fee ?? 0)
      const expressFee = Number(r.express_fee ?? 0)
      const totalFee = sampleFee + expressFee
      const collected = Number(r.collected ?? 0)
      const feeStatus = String(r.fee_status ?? 'unpaid')
      const offsetAmount = Number(r.offset_amount ?? 0)
      // 抵扣挂在转出的那张订单上：订单还是草稿/已失效/已作废时，它不在应收口径里，
      // 抵扣就还没真正生效，样品费必须回到待收。否则这笔钱在应收、欠款榜、提醒三处同时蒸发；
      // 订单恢复成计费状态后自动再抵，不需要改 fee_status（避免来回改状态时双扣）。
      const convertedStatus = String(r.converted_order_status ?? '')
      const offsetLive = feeStatus === 'offset' && (!convertedStatus || isBillingStatus(convertedStatus))
      // 老抵扣单 offset_amount=0（当年只抵样品费）；新单按实际抵扣额，含快递费
      const offsetSettled = offsetLive ? (offsetAmount > 0 ? offsetAmount : sampleFee) : 0
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
      // 「已收」却一笔单笔水单都没有 = 升级前手工勾的标记。钱认，但要能一眼看出
      // 这笔没有水单可对账，不能和客户自己下的银行流水混成一堆。
      const legacyPaidNoFlow = feeStatus === 'paid' && collected <= 0.001 && totalFee > 0.001
      // 多收的钱（进客户预收结余）：唯一一份算法，对账单与预收区共用。
      // 取消/免单的单子不再收钱，已经进来的现金必须有个去处，全额算多付；
      // 其余按「实收 + 生效的抵扣 − 应收」——只看现金会把抵扣过的单漏掉，
      // 客户页写着「可用 300」、发出去的对账单却一行都不提（R48 一个数只许一张嘴）。
      const prepaid =
        String(r.status ?? '') === 'cancelled' || feeStatus === 'waived'
          ? collected
          : Math.max(0, collected + offsetSettled - totalFee)
      const storedRate = Number(r.exchange_rate ?? 0)
      const currency = String(r.currency ?? 'USD')
      return {
        sampleId: Number(r.id),
        sampleNo: String(r.sample_no ?? ''),
        customerId: Number(r.customer_id),
        status: String(r.status ?? ''),
        feeStatus,
        currency,
        exchangeRate: storedRate,
        baseRate: baseRateOf(currency, baseCurrency, storedRate),
        rateMissing: currency !== baseCurrency && !(storedRate > 0),
        sampleDate: String(r.sample_date ?? ''),
        sampleFee,
        totalFee,
        collected,
        prepaid,
        offsetSettled,
        offsetLive,
        convertedStatus,
        recovered,
        legacyPaidNoFlow,
        creditApplied: Number(r.credit_applied ?? 0),
        convertedOrderNo: String(r.converted_order_no ?? '')
      }
    })
  }

  async function sampleOpenRows(customerId?: number): Promise<SampleOpenRow[]> {
    const out: SampleOpenRow[] = []
    for (const r of await sampleMoneyRows(customerId)) {
      // 只有未收的单还挂着应收；取消的单不收钱。
      // 抵扣单要看转出订单是否生效：订单退回草稿/失效时 offsetSettled 归零，
      // 样品费会在这里重新出现（与对账单、提醒同一份口径）。
      if (r.status === 'cancelled') continue
      if (r.feeStatus !== 'unpaid' && r.feeStatus !== 'offset') continue
      if (r.offsetSettled > 0.001) continue
      // 预收抵扣过的部分已经由客户余额覆盖，不再计待收
      const left = r.totalFee - r.recovered - r.creditApplied
      if (left <= 0.001) continue
      out.push({
        sampleId: r.sampleId,
        sampleNo: r.sampleNo,
        customerId: r.customerId,
        status: r.status,
        currency: r.currency,
        exchangeRate: r.exchangeRate,
        baseRate: r.baseRate,
        receivable: left
      })
    }
    return out
  }

  async function sampleStatementRows(customerId: number): Promise<SampleBillRow[]> {
    const out: SampleBillRow[] = []
    for (const r of await sampleMoneyRows(customerId)) {
      // 一分钱没涉及过的免费样不用上表，否则对账单全是噪声；
      // 取消的单只有真的收过钱（或抵扣过）才留一行，让客户认得出这笔钱
      if (r.totalFee <= 0.001 && r.collected <= 0.001 && r.offsetSettled <= 0.001) continue
      if (r.status === 'cancelled' && r.collected <= 0.001 && r.offsetSettled <= 0.001 && r.creditApplied <= 0.001)
        continue
      const cancelled = r.status === 'cancelled'
      // 与 sampleOpenRows 同一口径：未收，或抵扣单的转出订单还没生效（草稿/失效/作废）
      const open =
        !cancelled &&
        (r.feeStatus === 'unpaid' || (r.feeStatus === 'offset' && r.offsetSettled <= 0.001))
          ? Math.max(0, r.totalFee - r.recovered - r.creditApplied)
          : 0
      // 多付的钱要单独摆出来：压进待收里会变成负数，客户以为我们算错了。
      // 数额直接吃 sampleMoneyRows 那份 prepaid（与预收结余同一个数，不再另算一遍）
      out.push({
        sampleId: r.sampleId,
        sampleNo: r.sampleNo,
        status: r.status,
        feeStatus: r.feeStatus,
        currency: r.currency,
        exchangeRate: r.exchangeRate,
        baseRate: r.baseRate,
        sampleDate: r.sampleDate,
        totalFee: r.totalFee,
        recovered: r.recovered,
        legacyPaidNoFlow: r.legacyPaidNoFlow,
        creditApplied: r.creditApplied,
        open,
        prepaid: r.prepaid,
        convertedOrderNo: r.convertedOrderNo,
        offsetSuspended: !cancelled && r.feeStatus === 'offset' && r.offsetSettled <= 0.001
      })
    }
    return out
  }

  /**
   * 打样单待收（基准币，N23/R25）与「折不出来的张数」。
   * 汇率缺失的单不计入合计（否则折不准），但也不能当它不存在：
   * 客户页要照着 rateMissing 说出「还有 N 张没折进去」，否则一单 USD 样品费
   * 在页面上就是 0，业务员不再催。
   */
  async function sampleReceivableBreakdown(
    customerId?: number
  ): Promise<{ total: number; rateMissing: number }> {
    let total = 0
    let rateMissing = 0
    for (const r of await sampleOpenRows(customerId)) {
      if (!(r.baseRate > 0)) {
        rateMissing += 1
        continue
      }
      total += r.receivable * r.baseRate
    }
    return { total, rateMissing }
  }

  async function sampleReceivable(customerId?: number): Promise<number> {
    return (await sampleReceivableBreakdown(customerId)).total
  }

  async function customerOpenRows(customerId: number): Promise<CustomerOpenRow[]> {
    const orders: CustomerOpenRow[] = (await listOrderMoney({ customerId }))
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
    const samples: CustomerOpenRow[] = (await sampleOpenRows(customerId))
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
  async function customerReceivable(customerId: number): Promise<number> {
    return totalReceivable({ customerId })
  }

  /* ---------------- 客户预收（R27） ---------------- */

  /**
   * 客户预收余额：**不另存一份钱**，全部从 payments 的现状派生。
   *
   * 口径（与对账单「预收结余」行同一份）：
   *   正常单   —— 实收超过含费用合计的部分（客户多付；核销不是钱，不参与这条减法）
   *   作废/失效 —— 已经收到的全部现金（这单不再欠钱，钱必须有去处）
   *   打样单   —— 取消/免单时收到的全部现金；其余按「实收 + 抵扣 − 应收」算多付
   *   减：未撤销的抵扣台账
   *   减：已退还客户的退款（R28）
   *
   * 抵扣与退款都不是现金流入，所以这里绝不碰 payments，也绝不进现金流/毛利。
   */
  async function customerCreditBalance(customerId: number): Promise<CustomerCreditCurrency[]> {
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

    for (const r of await listOrderMoney({ customerId, includeVoided: true })) {
      // 草稿还没成为正式生意，钱不该已经到账；真到了也不认（现金流同样排除草稿）
      if (r.paymentStatus === 'draft') continue
      // 合计 ≤ 0 的单（样品费抵扣大于货值等）没有「多付」可退：只有真的收进来的现金算余额。
      // 旧口径直接把 −grandTotal 当多付，会凭空生成一笔客户预收，甚至能退真钱出去。
      //
      // 核销（短款/坏账）不参与这里的减法：那是「我们知道这笔收不回来」，
      // 不是客户多付的钱。以前写成 实收 + 核销 − 合计，一旦单据金额被改小，
      // 多出来的核销额就变成一笔从没收到的预收——能抵别的单、还能退真钱出去（R50）。
      // 作废/失效单：收到的现金都在这单上没有去处，算客户预收——除了坏账追回那一截。
      // 追回款是客户把已经核销掉的欠款补上了，不是多付；算成预收等于同一笔钱
      // 既记了坏账损失、又能抵别的单、还能退真钱出去。
      const amount = isBillingStatus(r.paymentStatus)
        ? r.grandTotal > 0
          ? Math.max(0, r.paidAmount - r.grandTotal)
          : Math.max(0, r.paidAmount)
        : Math.max(0, r.paidAmount - r.badDebtRecovered)
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

    for (const r of await sampleMoneyRows(customerId)) {
      // 多付的数只有一份算法（sampleMoneyRows.prepaid），对账单与预收结余共用
      const amount = r.prepaid
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

    const appRows = (await db.all(
      `SELECT ca.id, ca.currency, ca.amount, ca.target_kind, ca.target_id, ca.applied_at, ca.note, ca.actor,
            COALESCE(o.order_no, s.sample_no, '') AS target_no
     FROM credit_applications ca
     LEFT JOIN orders o ON ca.target_kind = 'order' AND o.id = ca.target_id
     LEFT JOIN sample_orders s ON ca.target_kind = 'sample' AND s.id = ca.target_id
     WHERE ca.customer_id = ? AND ca.reversed_at IS NULL
     ORDER BY ca.applied_at, ca.id`,
      [customerId]
    )) as Record<string, unknown>[]
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

    const refundRows = (await db.all(
      `SELECT id, currency, amount, refund_at, bank_ref, note, actor
     FROM customer_refunds
     WHERE customer_id = ? AND reversed_at IS NULL
     ORDER BY refund_at, id`,
      [customerId]
    )) as Record<string, unknown>[]
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
  async function customerCreditAvailable(customerId: number, currency: string): Promise<number> {
    const hit = (await customerCreditBalance(customerId)).find((c) => c.currency === currency)
    return hit?.available ?? 0
  }

  return {
    creditAppliedForOrders,
    creditAppliedForOrder,
    creditAppliedForSamples,
    creditAppliedForSample,
    moneyForOrders,
    listOrderMoney,
    packingAmounts,
    totalReceivable,
    cashFlowRows,
    refundFlowRows,
    receivedByMonth,
    refundedByMonth,
    receivableByCustomer,
    sampleMoneyRows,
    sampleOpenRows,
    sampleStatementRows,
    sampleReceivable,
    sampleReceivableBreakdown,
    customerOpenRows,
    customerReceivable,
    customerCreditBalance,
    customerCreditAvailable
  }
}

export type MoneyCore = ReturnType<typeof moneyCore>
