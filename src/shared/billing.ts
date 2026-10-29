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

/**
 * 转单时勾「样品费抵货款」，会在订单上留一条负费用行，同时在打样单上记一笔 offset_amount。
 * 这两处是同一笔钱的两张脸，认脸就靠这个行名的前缀（后半段是印在纸面上的英文，改英文不影响认账）。
 */
export const SAMPLE_OFFSET_LABEL_PREFIX = '样品费及快递费抵扣'

/** 这笔样品费从订单上抵掉了多少钱（正数；没有抵扣行就是 0） */
export function sampleOffsetFromCharges(charges: { label: string; amount: number }[]): number {
  const sum = charges
    .filter((c) => String(c.label ?? '').trim().startsWith(SAMPLE_OFFSET_LABEL_PREFIX))
    .reduce((s, c) => s + (Number(c.amount) || 0), 0)
  return sum < 0 ? -sum : 0
}

/**
 * 一张打样单还没从客户身上收回来的钱——转单时能抵多少、订单上那条抵扣行最多能写多少，
 * 都只认这一个数。免收的没有可抵的；整笔已按水单收的不再抵第二遍；
 * 客户预收抵掉的那部分也不是还能再收的现金。
 *
 * 转单和改订单费用行是两条独立的路，以前各算各的：转单卡得死，事后在费用行里
 * 把抵扣改成样品费的三倍照样过，打样单就顶着一个收不回来的巨额「已抵扣」，
 * 样品欠款榜和对账单跟着一起失真。
 */
export function sampleOpenFeeOf(
  totalFee: number,
  feeStatus: string,
  collected: number,
  creditApplied: number
): number {
  if (feeStatus === 'waived') return 0
  const paidAlready = feeStatus === 'paid' ? Number(totalFee) || 0 : Number(collected) || 0
  const left = (Number(totalFee) || 0) - paidAlready - (Number(creditApplied) || 0)
  return left > 0 ? left : 0
}
