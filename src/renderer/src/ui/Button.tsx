/**
 * 按钮。
 *
 * 把全站 39 处 `className="btn"`、31 处 `btn primary`、以及各种
 * `btn sm ghost` / `btn ghost danger` 的自由组合收敛到一个地方。
 *
 * 变体与语义（见 docs/ui/design-system.md §5.1）：
 *   primary  主要动作（一个页面最多一个）
 *   default  次要动作
 *   ghost    弱化动作（表格行内操作）
 *   danger   破坏性动作（删除/作废）
 *   sm       小尺寸（表格内、弹窗 footer）
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 左侧图标 */
  icon?: ReactNode
  /** 占满一行（弹窗 footer 常用） */
  block?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = ['btn']
  if (variant === 'primary') cls.push('primary')
  if (variant === 'ghost') cls.push('ghost')
  if (variant === 'danger') cls.push('danger')
  if (variant === 'subtle') cls.push('subtle')
  if (size === 'sm') cls.push('sm')
  if (block) cls.push('block')
  if (className) cls.push(className)
  return (
    <button type={type} className={cls.join(' ')} {...rest}>
      {icon ? <span className="btn-icon">{icon}</span> : null}
      {children}
    </button>
  )
}
