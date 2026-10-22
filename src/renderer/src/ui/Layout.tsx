/**
 * 布局与表格容器。
 *
 * 收敛全站重复的结构：
 *   row + spacer（63 次）· field-row / field-row-3（26 次）
 *   table-wrap + table.data（46 次）· kv-grid（订单详情条款区）
 */
import type { ReactNode } from 'react'

/** 一行内容，spacer 把右侧内容推到最右 */
export function Row({
  children,
  className,
  gap,
  style
}: {
  children?: ReactNode
  className?: string
  gap?: number
  style?: React.CSSProperties
}) {
  return (
    <div
      className={className ? `row ${className}` : 'row'}
      style={gap != null ? { gap, ...style } : style}
    >
      {children}
    </div>
  )
}

/** 弹性占位，把后续内容推到最右 */
export function Spacer() {
  return <div className="spacer" />
}

/** 表单分栏：1~4 列 */
export function FieldRow({
  cols = 2,
  children,
  className
}: {
  cols?: 1 | 2 | 3 | 4
  children?: ReactNode
  className?: string
}) {
  const cls = cols === 1 ? 'field-row-1' : cols === 2 ? 'field-row' : `field-row-${cols}`
  return <div className={className ? `${cls} ${className}` : cls}>{children}</div>
}

/** 键值对网格（订单详情的「客户与条款」那种两列排布） */
export function KeyValue({
  items,
  cols = 2
}: {
  items: { label: ReactNode; value: ReactNode }[]
  cols?: 1 | 2 | 3
}) {
  return (
    <div className={`kv-grid kv-${cols}`}>
      {items.map((it, i) => (
        <div className="kv-item" key={i}>
          <span className="kv-label">{it.label}</span>
          <span className="kv-value">{it.value}</span>
        </div>
      ))}
    </div>
  )
}

/** 表格容器：横向滚动 + 空状态 */
export function TableWrap({ children }: { children?: ReactNode }) {
  return <div className="table-wrap">{children}</div>
}

export function DataTable({
  children,
  className
}: {
  children?: ReactNode
  className?: string
}) {
  return <table className={className ? `data ${className}` : 'data'}>{children}</table>
}

/** 进度条（自动更新下载用） */
export function Progress({
  percent,
  label
}: {
  percent: number
  label?: ReactNode
}) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className="progress">
      {label ? <div className="progress-label">{label}</div> : null}
      <div className="progress-track">
        <div className="progress-bar" style={{ width: `${p}%` }} />
      </div>
    </div>
  )
}
