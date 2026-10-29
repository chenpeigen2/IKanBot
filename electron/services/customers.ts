import { coreDb, getDb } from '../db'
import { mapCustomerStats } from '../db/mappers'
import { isBillingStatus, shownRemaining } from '../../src/shared/billing'
import { EXCLUDED_STATUSES, listOrderMoney, sampleReceivable } from './money'
import { customersCore, type CustomerInput } from '../../core/customers'
import type { CustomerStats } from '../../src/shared/types'

export type { CustomerInput }

/**
 * 客户档案本体已经搬到 core/customers.ts（本机与后端共用一份）。
 * 这里只剩两件还没搬的东西：聚合统计与订单摘要——它们吃 services/money.ts，
 * 而 money 已异步化（core/money.ts 的薄壳），这两件等有空再一起搬。
 */
const core = customersCore(coreDb)

export const listCustomers = (keyword = '', includeInactive = false) =>
  core.list(keyword, includeInactive)

export const getCustomer = (id: number) => core.get(id)

export const saveCustomer = (input: CustomerInput) => core.save(input)

export const setCustomerActive = (id: number, active: 0 | 1) => core.setActive(id, active)

export const sameNameCustomers = (company: string, selfId?: number) => core.sameName(company, selfId)

export const deleteCustomer = (id: number) => core.remove(id)

export const stylePriceHistory = (filter: { customerId?: number; styleNo?: string } = {}) =>
  core.stylePriceHistory(filter)

/**
 * 客户聚合统计：订单数、总金额、总毛利、未收金额。
 * 口径全部走 services/money.ts（唯一真源）：
 *  - 成交额 = Σ含费用合计
 *  - 未收   = Σ(含费用合计 − 已收)
 *  - 毛利   = Σ(货值 − 成本)，有成本没录全 → null（不可信）
 */
export async function customerStats(customerId: number): Promise<CustomerStats> {
  const rows = await listOrderMoney({ customerId })
  const totalAmount = rows.reduce((s, r) => s + r.grandTotalBase, 0)
  // 未收走统一口径（money.ts）：订单待收 + 打样未收（N23：客户页不能比工作台少数一笔打样费）
  const outstandingOrders = rows.reduce((s, r) => s + r.receivableBase, 0)
  const outstandingSamples = await sampleReceivable(customerId)
  const outstanding = outstandingOrders + outstandingSamples
  // 名下打样单总数：只打过样的客户也要能导出对账单
  const sampleCount = Number(
    (getDb().get('SELECT COUNT(*) AS c FROM sample_orders WHERE customer_id = ?', [customerId]) as
      | { c?: number }
      | null)?.c ?? 0
  )
  // 坏账不进待收，但客户页要能看见这家客户赖过多少钱
  const badDebt = rows.reduce((s, r) => s + r.badDebtBase, 0)
  const missingCostOrders = rows.filter((r) => r.missingCostItems > 0).length
  // 外币没填汇率的单：成交额/待收/毛利都按 0 折，上面的合计是「少算了这几单」的数。
  // 不亮出来，老板会拿着一个偏小的成交额去对账
  const rateMissingOrders = rows.filter((r) => r.rateMissing).length
  const totalProfitRaw = rows.reduce((s, r) => s + (r.profitBase ?? 0), 0)
  // 下面的历史列表会把草稿/失效/作废也列出来，成交额却不含它们；
  // 不写明条数，老板会以为系统漏单（N-口径一致）
  const excluded = getDb().all(
    `SELECT payment_status FROM orders WHERE customer_id = ? AND payment_status IN (${EXCLUDED_STATUSES.map(
      () => '?'
    ).join(',')})`,
    [customerId, ...EXCLUDED_STATUSES]
  ) as { payment_status?: string }[]
  return mapCustomerStats({
    order_count: rows.length,
    excluded_order_count: excluded.length,
    total_amount: totalAmount,
    // 有成本没录全的订单 → 毛利不可信（null），不许拿 0 成本凑一个漂亮的数；
    // 缺汇率的单同理：那一单的毛利根本没折进合计，算出来的也不是真毛利
    total_profit: missingCostOrders > 0 || rateMissingOrders > 0 ? null : totalProfitRaw,
    outstanding,
    outstanding_orders: outstandingOrders,
    outstanding_samples: outstandingSamples,
    sample_count: sampleCount,
    bad_debt: badDebt,
    missing_cost_orders: missingCostOrders,
    rate_missing_orders: rateMissingOrders
  })
}

/** 客户历史订单简要（金额口径走 services/money.ts） */
export async function customerOrderBriefs(customerId: number): Promise<{
  id: number
  orderNo: string
  piNo: string
  currency: string
  paymentStatus: string
  shipStatus: string
  /** 货值 */
  total: number
  /** 含费用合计（PI 上的 TOTAL） */
  grandTotal: number
  paid: number
  /** 待收（含费用合计 − 已收） */
  remaining: number
  /** 其中已用客户预收抵扣（不是现金到账，但这单的钱已经由客户账上的余额覆盖） */
  creditApplied: number
  /** 这条是否计入上面的「订单数 / 成交额」（草稿、失效、作废不计） */
  counted: boolean
  createdAt: string
}[]> {
  const rows = await listOrderMoney({ customerId, includeVoided: true })
  return rows.map((r) => ({
    id: r.orderId,
    orderNo: r.orderNo,
    piNo: r.piNo,
    currency: r.currency,
    paymentStatus: r.paymentStatus,
    shipStatus: r.shipStatus,
    total: r.goodsValue,
    grandTotal: r.grandTotal,
    paid: r.paidAmount,
    // 草稿 / 已失效 / 已作废的单在历史里保留，但不再向客户催款，待收按 0 显示
    // （口径见 src/shared/billing.ts，订单列表和客户页必须是同一个说法）
    remaining: shownRemaining(r.paymentStatus, r.receivable),
    // 待收里已经由客户账上余额覆盖的那一块：不露出来，「待收 500 + 已收 500」看着像
    // 还差 500 现金，实际那 500 早已抵扣掉，再催一遍就是重复收款
    creditApplied: isBillingStatus(r.paymentStatus) ? r.creditApplied : 0,
    counted: isBillingStatus(r.paymentStatus),
    createdAt: r.createdAt
  }))
}
