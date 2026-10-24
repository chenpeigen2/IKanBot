/**
 * 「这张单还要不要向客户收钱」的唯一口径。
 *
 * 以前订单列表、客户页、催款提醒各写各的：列表只把「已作废」的待收抹成 0，
 * 客户页按草稿/失效/作废三个都不催，催款提醒又是第三套写法。
 * 跟单员在三个页面看到三个说法，对账时以为系统少算了一笔。
 *
 * 规矩：草稿 / 已失效 / 已作废 = 不催款（单子还在，钱不算账上）。
 * 要改这个集合只改这一处，services/money.ts 的 EXCLUDED_STATUSES 引用它。
 */
import type { PaymentStatus } from './types'

/** 不催款、也不计入销售额/毛利的收款状态 */
export const NON_BILLING_STATUSES: PaymentStatus[] = ['draft', 'expired', 'void']

/** 这个状态还要不要向客户收钱 */
export function isBillingStatus(status: string | null | undefined): boolean {
  return !NON_BILLING_STATUSES.includes(status as PaymentStatus)
}

/**
 * 界面上「待收」该显示多少。
 * 不催款的单一律 0（该显示「—」的地方由 isBillingStatus 判断），
 * 多收的部分不算待收，所以这里把负数收在 0。
 */
export function shownRemaining(status: string | null | undefined, remaining: number | null | undefined): number {
  if (!isBillingStatus(status)) return 0
  const v = Number(remaining ?? 0)
  return v > 0 ? v : 0
}
