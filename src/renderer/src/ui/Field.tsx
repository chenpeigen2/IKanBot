/**
 * 表单域。
 *
 * 全站 129 处 `field` + 42 处 `hint` 的重复结构：
 *   <div className="field"><label>…</label><input …/><div className="hint">…</div></div>
 *
 * Field 负责外壳与 label，Input / Select / Textarea 负责控件本体，
 * 这样每个域的标签、说明、错误提示样式永远一致。
 */
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react'

export interface FieldProps {
  label?: ReactNode
  /** 标签右侧的补充说明（灰字小字） */
  labelExtra?: ReactNode
  /** 字段下方的说明文字 */
  hint?: ReactNode
  /** 错误提示（会盖过 hint） */
  error?: ReactNode
  /** 必填标记 */
  required?: boolean
  className?: string
  children?: ReactNode
}

export function Field({
  label,
  labelExtra,
  hint,
  error,
  required,
  className,
  children
}: FieldProps) {
  return (
    <div className={className ? `field ${className}` : 'field'}>
      {label !== undefined ? (
        <label>
          {label}
          {required ? <span className="req"> *</span> : null}
          {labelExtra ? <span className="label-extra">{labelExtra}</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 数值输入：右对齐 + 小数步进 */
  numeric?: boolean
}

export function Input({ numeric, className, ...rest }: TextInputProps) {
  const cls = ['input']
  if (numeric) cls.push('num')
  if (className) cls.push(className)
  return <input className={cls.join(' ')} {...rest} />
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** 小尺寸（下拉在表格行内用） */
  small?: boolean
}

export function Select({ small, className, children, ...rest }: SelectProps) {
  const cls = ['select']
  if (small) cls.push('sm')
  if (className) cls.push(className)
  return (
    <select className={cls.join(' ')} {...rest}>
      {children}
    </select>
  )
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={className ? `input ${className}` : 'input'} {...rest} />
}
