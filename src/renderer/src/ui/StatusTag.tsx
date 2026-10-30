/**
 * 状态标签。
 *
 * 之前有 PaymentTag / ShipTag / QuotationStatusTag / SampleStatusTag 四个组件，
 * 各自硬编码颜色，违反 design-system §3.4「同一状态只允许一套颜色」。
 * 现在统一到一张语义映射表：
 *
 *   neutral  草稿 / 未备货 / 已作废
 *   info     客户已确认 / 已备货 / 已转订单
 *   success  定金已收 / 已结清 / 已签收
 *   warning  待确认 / 部分收款 / 备货中 / 汇率未填
 *   danger   已失效 / 已作废（需强调）
 */
import type {
  PaymentStatus,
  QuotationStatus,
  SampleStatus,
  ShipStatus
} from '../../../shared/types'
import {
  PAYMENT_STATUS_LABEL,
  QUOTATION_STATUS_LABEL,
  SAMPLE_STATUS_LABEL,
  SHIP_STATUS_LABEL
} from '../../../shared/types'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'grey',
  info: 'blue',
  success: 'green',
  warning: 'amber',
  danger: 'red'
}

export function StatusTag({
  tone,
  children,
  title
}: {
  tone: StatusTone
  children: React.ReactNode
  title?: string
}) {
  return (
    <span className={`tag ${TONE_CLASS[tone]}`} title={title}>
      {children}
    </span>
  )
}

/* ---------------- 各业务状态的语义色 ----------------
 * 文案一律取 shared/types 里那份（同一个状态在标签、下拉、导出里必须是同一个词），
 * 这里只保留颜色，不另抄一份中文。 */

const PAYMENT_TONE: Record<PaymentStatus, StatusTone> = {
  draft: 'neutral',
  sent: 'warning',
  confirmed: 'info',
  partial: 'warning',
  paid: 'success',
  settled: 'success',
  expired: 'danger',
  void: 'neutral'
}

const SHIP_TONE: Record<ShipStatus, StatusTone> = {
  not_prepared: 'neutral',
  preparing: 'warning',
  packed: 'info',
  shipped: 'info',
  partial_shipped: 'info',
  cleared: 'success',
  delivered: 'success'
}

const QUOTATION_TONE: Record<QuotationStatus, StatusTone> = {
  draft: 'neutral',
  sent: 'warning',
  confirmed: 'info',
  converted: 'success',
  expired: 'danger'
}

const SAMPLE_TONE: Record<SampleStatus, StatusTone> = {
  pending: 'neutral',
  sent: 'warning',
  received: 'success',
  cancelled: 'neutral'
}

export function PaymentTag({ status }: { status: PaymentStatus }) {
  return <StatusTag tone={PAYMENT_TONE[status] ?? 'neutral'}>{PAYMENT_STATUS_LABEL[status] ?? status}</StatusTag>
}

export function ShipTag({ status }: { status: ShipStatus }) {
  return <StatusTag tone={SHIP_TONE[status] ?? 'neutral'}>{SHIP_STATUS_LABEL[status] ?? status}</StatusTag>
}

export function QuotationStatusTag({ status }: { status: QuotationStatus }) {
  return (
    <StatusTag tone={QUOTATION_TONE[status] ?? 'neutral'}>{QUOTATION_STATUS_LABEL[status] ?? status}</StatusTag>
  )
}

export function SampleStatusTag({ status }: { status: SampleStatus }) {
  return <StatusTag tone={SAMPLE_TONE[status] ?? 'neutral'}>{SAMPLE_STATUS_LABEL[status] ?? status}</StatusTag>
}

/** 打样费收款状态 */
export type SampleFeeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const SAMPLE_FEE_LABEL: Record<string, { label: string; tone: SampleFeeTone }> = {
  unpaid: { label: '未收', tone: 'warning' },
  paid: { label: '已收', tone: 'success' },
  offset: { label: '已抵扣', tone: 'info' },
  waived: { label: '客户免单', tone: 'neutral' }
}

export function SampleFeeTag({ status }: { status: string }) {
  const s = SAMPLE_FEE_LABEL[status] ?? { label: status, tone: 'neutral' as SampleFeeTone }
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>
}
