import { useEffect, useState, useCallback, createContext, useContext, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { localDateOf } from '../../shared/date'

/* ---------------- 轻量 UI 组件 ---------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  size
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'wide' | 'xwide'
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`}>
        <div className="modal-head">
          {title}
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Empty({
  text,
  hint,
  action
}: {
  text: string
  /** 补充说明：告诉用户下一步该做什么 */
  hint?: string
  /** 引导操作按钮 */
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-title">{text}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

/* ---------------- 溢出菜单（页头「更多」） ---------------- */

export type MenuItem = {
  text: string
  danger?: boolean
  onClick: () => void
}

/**
 * 页头动作太多时收进「⋯」菜单，避免同一排出现三四种按钮形态。
 * 菜单里只有文字，没有图标；危险操作统一标红。
 */
export function Menu({
  label,
  items,
  sm
}: {
  label: React.ReactNode
  items: MenuItem[]
  /** 列表页操作列里用小号触发器（表内不能撑高行） */
  sm?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className={`btn ghost ${sm ? 'sm' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.text}
              className={`menu-item ${it.danger ? 'danger' : ''}`}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
            >
              {it.text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- 列表页行内操作菜单（⋯） ---------------- */

/**
 * 表格操作列里的「⋯」菜单。
 * 用 portal 挂到 body 上并按视口定位：表格容器是 overflow-x:auto，
 * 绝对定位的菜单会被裁掉，portal 才不会被裁。
 */
export function ActionMenu({
  items,
  label = '⋯'
}: {
  items: MenuItem[]
  label?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const w = 150
      let left = r.right - w
      if (left < 8) left = 8
      setPos({ top: r.bottom + 4, left })
    }
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        className="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        {label}
      </button>
      {open && pos
        ? createPortal(
            <div className="menu-pop fixed" ref={popRef} style={{ top: pos.top, left: pos.left }} role="menu">
              {items.map((it) => (
                <button
                  key={it.text}
                  className={`menu-item ${it.danger ? 'danger' : ''}`}
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpen(false)
                    it.onClick()
                  }}
                >
                  {it.text}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/* ---------------- 导航图标（R2-S8） ---------------- */

/**
 * 侧边栏 8 个图标：统一 16×16 视窗、线性笔画（stroke-width 1.5）、currentColor。
 * 以前用 Unicode 字符（◧ ✎ ▤ ✂ ▣ ☰ ▦ ⚙），来自不同 fallback 字体，
 * 笔画重量差很多（实心方块 vs 细铅笔），扫视时会先被重的那几个吸走。
 */
export type NavIconName =
  | 'dashboard'
  | 'quotation'
  | 'order'
  | 'sample'
  | 'products'
  | 'customers'
  | 'reports'
  | 'settings'

const NAV_ICON_PATHS: Record<NavIconName, React.ReactNode> = {
  // 工作台：四宫格
  dashboard: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  // 报价：单子 + 笔
  quotation: (
    <>
      <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M9.5 2v3.5H13" />
      <path d="M5 8.5h6M5 11.5h4" />
    </>
  ),
  // 订单：单据列表
  order: (
    <>
      <path d="M4 2h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M6 5.5h4M6 8.5h4M6 11.5h2" />
    </>
  ),
  // 打样单：包裹
  sample: (
    <>
      <path d="M8 1.8 14 5v6l-6 3.2L2 11V5l6-3.2z" />
      <path d="M2 5l6 3.2L14 5" />
      <path d="M8 8.2v6" />
    </>
  ),
  // 商品库：标签
  products: (
    <>
      <path d="M2.5 2.5h5.2L14 8.8l-5.3 5.3L2.5 8z" />
      <circle cx="5.6" cy="5.6" r="1.1" />
    </>
  ),
  // 客户：人
  customers: (
    <>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 14c0-2.9 2.3-4.6 5.2-4.6s5.2 1.7 5.2 4.6" />
    </>
  ),
  // 报表：柱状图
  reports: (
    <>
      <path d="M2 14h12" />
      <rect x="3" y="8" width="2.6" height="4" rx="0.6" />
      <rect x="6.8" y="5" width="2.6" height="7" rx="0.6" />
      <rect x="10.5" y="2.5" width="2.6" height="9.5" rx="0.6" />
    </>
  ),
  // 设置：齿轮
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" />
    </>
  )
}

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {NAV_ICON_PATHS[name]}
      </svg>
    </span>
  )
}

/* ---------------- Toast ---------------- */

type ToastItem = { id: number; text: string; kind: 'ok' | 'error' }
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {})

/**
 * 明细行的前端身份。
 * 未保存的行没有数据库 id，用数组下标当 React key 会串位：
 * 删掉中间一行后，后面所有行整体前移，焦点和输入法里的半个字全落错格子——
 * 用户看到的就是「款号跑到别的颜色上」。所以行建出来就钉一个用完即弃的稳定标记。
 * 只给 UI 用，提交前从明细载荷里去掉（各编辑器在组 payload 时只挑业务字段）。
 */
export function clientKey(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 输入防抖：搜索框每敲一个字就打一次查询，敲得快时一秒能发七八次。
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

/**
 * 请求竞态门。
 * 慢的那次查询可能比新的那次先回来，结果就是把旧关键词的列表盖在新关键词上——
 * 用户看到的是「搜了个寂寞」。每次请求先 begin() 领一个号，回来时 isCurrent() 才允许落盘。
 */
export function useLoadGuard(): () => { isCurrent: () => boolean } {
  const seq = useRef(0)
  return () => {
    seq.current += 1
    const my = seq.current
    return { isCurrent: () => seq.current === my }
  }
}

export function useToast() {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((s) => {
      // 同一条提示不弹两遍（同一个错误被捕获两次时，只弹一次）
      if (s.some((i) => i.text === text)) return s
      return [...s, { id, text, kind }]
    })
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), kind === 'error' ? 5200 : 2600)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((i) => (
          <div key={i.id} className={`toast ${i.kind === 'error' ? 'error' : ''}`}>
            {i.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------------- 格式化 ---------------- */

export function money(v: number | null | undefined, currency = ''): string {
  const n = Number(v ?? 0)
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency} ${s}` : s
}

/**
 * 金额显示：缺数据写「—」，真算出来是 0 仍然写 0.00。
 * 区分"没录"和"真的是 0"——两者混在一起会让人以为漏单。
 */
export function moneyOrDash(v: number | null | undefined, currency = ''): string {
  if (v == null || Number.isNaN(Number(v))) return '—'
  return money(v, currency)
}

export function num(v: number | null | undefined): string {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function today(): string {
  // 本地日期（不要用 toISOString，那是 UTC 日期）
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  // 时间戳按本地日期显示（slice 出来的是 UTC 日期，凌晨会差一天）
  return localDateOf(String(iso))
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 状态标签已收敛到 ui/StatusTag.tsx（统一语义色映射），这里转出保持旧 import 路径可用
export {
  StatusTag,
  PaymentTag,
  ShipTag,
  QuotationStatusTag,
  SampleStatusTag,
  SampleFeeTag,
  SAMPLE_FEE_LABEL,
  type StatusTone
} from './ui/StatusTag'

// 组件库统一出口（直接指到各组件文件，避免 ./ui/index.ts 再导回本文件造成循环）
export { Button, type ButtonVariant, type ButtonSize } from './ui/Button'
export { Card, CardBody } from './ui/Card'
export { Field, Input, Select, Textarea } from './ui/Field'
export { Alert, type AlertKind } from './ui/Alert'
export { Row, Spacer, FieldRow, KeyValue, TableWrap, DataTable, Progress } from './ui/Layout'
