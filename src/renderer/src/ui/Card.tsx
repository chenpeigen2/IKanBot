/**
 * 卡片。
 *
 * 全站 29 处 `card` / `card-head` / `card-body` 的重复结构。
 * card-head 右侧通常放操作按钮，这里用 actions 槽统一承载。
 */
import type { ReactNode } from 'react'

export interface CardProps {
  /** 卡片标题 */
  title?: ReactNode
  /** 标题右侧的操作区 */
  actions?: ReactNode
  /** 内容区的额外 class（tight = 去掉内边距，用于直接放表格） */
  bodyClass?: string
  /** 内容区不加 padding */
  tight?: boolean
  children?: ReactNode
  className?: string
}

export function Card({
  title,
  actions,
  bodyClass,
  tight,
  children,
  className
}: CardProps) {
  return (
    <div className={className ? `card ${className}` : 'card'}>
      {title !== undefined || actions ? (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? (
            <>
              <div className="spacer" />
              {actions}
            </>
          ) : null}
        </div>
      ) : null}
      <div className={bodyClass ? `card-body ${bodyClass}` : 'card-body'}>
        {children}
      </div>
    </div>
  )
}

/** 卡片内容区（不带标题的裸 body） */
export function CardBody({
  tight,
  className,
  children
}: {
  tight?: boolean
  className?: string
  children?: ReactNode
}) {
  const cls = ['card-body']
  if (tight) cls.push('tight')
  if (className) cls.push(className)
  return <div className={cls.join(' ')}>{children}</div>
}
