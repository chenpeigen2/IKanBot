/**
 * 提示条。
 *
 * 全站 18 处 `alert info` / `alert warn` / `alert error` 的收敛。
 * 语义只有四档，不要自己发明颜色：
 *   info    说明/中性信息
 *   warn    需要注意但不致命
 *   error   出错了/操作失败
 *   success 成功/已生效
 */
import type { ReactNode } from 'react'

export type AlertKind = 'info' | 'warn' | 'error' | 'success'

export function Alert({
  kind = 'info',
  children,
  className
}: {
  kind?: AlertKind
  children?: ReactNode
  className?: string
}) {
  return <div className={className ? `alert ${kind} ${className}` : `alert ${kind}`}>{children}</div>
}
