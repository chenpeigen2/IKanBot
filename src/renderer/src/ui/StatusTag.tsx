/**
 * 状态标签。
 *
 * 之前有 PaymentTag / ShipTag / QuotationStatusTag / SampleStatusTag 四个组件，
 * 各自硬编码颜色，违反 design-system §3.4「同一状态只允许一套颜色」。
 * 现在统一到一张语义映射表：
 *
 *   neutral  草稿 / 未备货 / 已作废
 *   info     客户已确认 / 已备货 / 已转订单
 *   success  已收款 / 已结清 / 已签收
 *   warning  待确认 / 部分收款 / 备货中 / 汇率未填
 *   danger   已失效 / 已作废（需强调）
 */
import type {
  PaymentStatus,
  QuotationStatus,
  SampleStatus,
  ShipStatus
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

/* ---------------- 各业务状态的中文与语义色 ---------------- */

const PAYMENT: Record<PaymentStatus, { label: string; tone: StatusTone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  sent: { label: '待确认', tone: 'warning' },
  confirmed: { label: '客户已确认', tone: 'info' },
  partial: { label: '部分收款', tone: 'warning' },
  paid: { label: '已收款', tone: 'success' },
  settled: { label: '已结清', tone: 'success' },
  expired: { label: '已失效', tone: 'danger' },
  void: { label: '已作废', tone: 'neutral' }
}

const SHIP: Record<ShipStatus, { label: string; tone: StatusTone }> = {
  not_prepared: { label: '未备货', tone: 'neutral' },
  preparing: { label: '备货中', tone: 'warning' },
  packed: { label: '已包装', tone: 'info' },
  shipped: { label: '已出运', tone: 'info' },
  partial_shipped: { label: '部分出运', tone: 'info' },
  cleared: { label: '已清关', tone: 'success' },
  delivered: { label: '已签收', tone: 'success' }
}

const QUOTATION: Record<QuotationStatus, { label: string; tone: StatusTone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  sent: { label: '已发送', tone: 'warning' },
  confirmed: { label: '客户已确认', tone: 'info' },
  converted: { label: '已转订单', tone: 'success' },
  expired: { label: '已失效', tone: 'danger' }
}

const SAMPLE: Record<SampleStatus, { label: string; tone: StatusTone }> = {
  pending: { label: '待寄出', tone: 'neutral' },
  sent: { label: '已寄出', tone: 'warning' },
  received: { label: '已签收', tone: 'success' },
  cancelled: { label: '已取消', tone: 'neutral' }
}

export function PaymentTag({ status }: { status: PaymentStatus }) {
  const s = PAYMENT[status] ?? { label: status, tone: 'neutral' as StatusTone }
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>
}

export function ShipTag({ status }: { status: ShipStatus }) {
  const s = SHIP[status] ?? { label: status, tone: 'neutral' as StatusTone }
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>
}

export function QuotationStatusTag({ status }: { status: QuotationStatus }) {
  const s = QUOTATION[status] ?? { label: status, tone: 'neutral' as StatusTone }
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>
}

export function SampleStatusTag({ status }: { status: SampleStatus }) {
  const s = SAMPLE[status] ?? { label: status, tone: 'neutral' as StatusTone }
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>
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
