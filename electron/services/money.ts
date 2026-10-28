/**
 * 桌面侧的金额口径：算式、SQL 与守门全在 core/money.ts（后端跑同一份），
 * 这里只把本机的异步 Db 接进去，按原名重新导出——没有第二份实现。
 *
 * 纯算式（parseCharges / computeOrderMoney / depositDueOf / …）不碰库，
 * 直接原样透出给还在同步调用的服务与渲染层。
 */
import { coreDb } from '../db'
import { moneyCore } from '../../core/money'
import type {
  CashFlowRow,
  CustomerOpenRow,
  MoneyListFilter,
  MoneyRef,
  OrderMoney,
  OrderMoneyRow,
  RefundFlowRow,
  SampleBillRow,
  SampleMoneyRow,
  SampleOpenRow
} from '../../core/money'
import type { CustomerCreditCurrency, CustomerReceivable, PackingAmount } from '../../src/shared/types'

export {
  parseCharges,
  costInOrderCurrency,
  summarizeSettlements,
  computeOrderMoney,
  depositDueOf,
  notInStatuses,
  EXCLUDED_STATUSES,
  CASHFLOW_EXCLUDED_STATUSES
} from '../../core/money'

export type {
  MoneyItem,
  SettlementInput,
  SettlementTotals,
  MoneyInput,
  OrderMoney,
  OrderMoneyRow,
  MoneyListFilter,
  MoneyRef,
  CashFlowRow,
  RefundFlowRow,
  SampleOpenRow,
  SampleMoneyRow,
  SampleBillRow,
  CustomerOpenRow,
  CustomerCreditApplication,
  CustomerCreditCurrency,
  CustomerCreditRefund,
  CustomerCreditSource
} from '../../core/money'

const core = moneyCore(coreDb)

/**
 * 订单上已经抵扣的客户预收（原币，R27）。只认未撤销的行。
 * 传一批 id 时一条 SQL 搞定；列表、详情、对账单都必须从这里取，
 * 不许各自去 SUM credit_applications。
 */
export function creditAppliedForOrders(ids: number[]): Promise<Map<number, number>> {
  return core.creditAppliedForOrders(ids)
}

export function creditAppliedForOrder(id: number): Promise<number> {
  return core.creditAppliedForOrder(id)
}

/** 打样单上已经抵扣的客户预收（原币，R27） */
export function creditAppliedForSamples(ids: number[]): Promise<Map<number, number>> {
  return core.creditAppliedForSamples(ids)
}

export function creditAppliedForSample(id: number): Promise<number> {
  return core.creditAppliedForSample(id)
}

/** 一批订单的金额：明细 / 收款 / 核销 / 预收抵扣各一次 IN 查询，不逐单查 */
export function moneyForOrders(refs: MoneyRef[]): Promise<Map<number, OrderMoney>> {
  return core.moneyForOrders(refs)
}

/** 汇总口径：订单列表、订单详情、客户页、工作台、报表、CSV 导出全部用这一份数据 */
export function listOrderMoney(filter: MoneyListFilter = {}): Promise<OrderMoneyRow[]> {
  return core.listOrderMoney(filter)
}

/** 每个装箱批次的纸面金额（原币）——分批出运时每批都要有自己的箱单/发票金额 */
export function packingAmounts(orderId: number): Promise<PackingAmount[]> {
  return core.packingAmounts(orderId)
}

/** 全公司待收款（基准币）：Σ(订单含费用合计 − 已收) + Σ(打样单未收样品费+快递费) */
export function totalReceivable(filter: MoneyListFilter = {}): Promise<number> {
  return core.totalReceivable(filter)
}

/** 全项目唯一一份「收到的钱」的取数：月报到账、收款台账导出、客户对账单都从这里取 */
export function cashFlowRows(filter: { customerId?: number } = {}): Promise<CashFlowRow[]> {
  return core.cashFlowRows(filter)
}

/** 预收退款流水（R30）：钱从公司账上退给客户，是现金**流出** */
export function refundFlowRows(filter: { customerId?: number } = {}): Promise<RefundFlowRow[]> {
  return core.refundFlowRows(filter)
}

/** 到账金额按「到账月」归集（基准币），现金流口径：只排除草稿单 */
export function receivedByMonth(): Promise<{ month: string; amount: number }[]> {
  return core.receivedByMonth()
}

/** 退款按「出账月」归集：这是一笔钱离开公司，和 receivedByMonth 的方向相反 */
export function refundedByMonth(): Promise<{ month: string; count: number; byCurrency: { currency: string; amount: number }[] }[]> {
  return core.refundedByMonth()
}

/** 客户维度欠款榜（基准币）：待收 + 该客户的打样未收 */
export function receivableByCustomer(): Promise<CustomerReceivable[]> {
  return core.receivableByCustomer()
}

/** 一张打样单的金额底稿：待收、已收、对账单、欠款榜都从这一份取 */
export function sampleMoneyRows(customerId?: number): Promise<SampleMoneyRow[]> {
  return core.sampleMoneyRows(customerId)
}

/** 打样单待收明细（R25）：应收 = 样品费 + 快递费 − 已到的实收流水 */
export function sampleOpenRows(customerId?: number): Promise<SampleOpenRow[]> {
  return core.sampleOpenRows(customerId)
}

/** 对账单用的打样行：已收齐/已抵扣/已免单/取消过但收过钱的都要在表上 */
export function sampleStatementRows(customerId: number): Promise<SampleBillRow[]> {
  return core.sampleStatementRows(customerId)
}

/** 打样单待收（基准币，N23/R25）：汇率缺失的单不计入 */
export function sampleReceivable(customerId?: number): Promise<number> {
  return core.sampleReceivable(customerId)
}

/** 客户名下所有还欠钱的单据（订单 + 打样单）——「水单拆分」按行分摊用 */
export function customerOpenRows(customerId: number): Promise<CustomerOpenRow[]> {
  return core.customerOpenRows(customerId)
}

/** 某个客户的待收款（基准币）：订单 + 打样单，同一个口径 */
export function customerReceivable(customerId: number): Promise<number> {
  return core.customerReceivable(customerId)
}

/** 客户预收余额：**不另存一份钱**，全部从 payments 的现状派生 */
export function customerCreditBalance(customerId: number): Promise<CustomerCreditCurrency[]> {
  return core.customerCreditBalance(customerId)
}

/** 某币种可用预收（原币；来源被改动时可能是负数） */
export function customerCreditAvailable(customerId: number, currency: string): Promise<number> {
  return core.customerCreditAvailable(customerId, currency)
}
