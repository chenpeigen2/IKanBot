/**
 * 本地日期工具。
 *
 * 单据上的日期一律用「本地日期」，跟单号保持一致。
 * 注意：不要用 toISOString().slice(0,10)，那是 UTC 日期，
 * 在 UTC+8 的凌晨 0~8 点会比本地日期少一天。
 */

export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 数据库里存的时间戳（UTC ISO 串）→ 本地日期。
 * 直接 slice(0,10) 拿到的是 UTC 日期，UTC+8 的凌晨 0~8 点会串到前一天，
 * 月底就会把整单记到上个月。已经是 YYYY-MM-DD 的本地日期原样返回。
 */
export function localDateOf(v: string | null | undefined): string {
  if (!v) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : localDate(d)
}

/** 本地月份 YYYY-MM（报表按月归集用） */
export function localMonthOf(v: string | null | undefined): string {
  return localDateOf(v).slice(0, 7)
}

/**
 * 是否严格的本地日期 YYYY-MM-DD。
 * 不用 Date 直接判断：2026-02-31 会被顺延成 3 月 3 日，看起来能过。
 */
export function isLocalDate(v: string | null | undefined): boolean {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00')
  return !Number.isNaN(d.getTime()) && localDate(d) === v
}

/** 在某个日期上加减天数，返回 YYYY-MM-DD */
export function addDays(dateStr: string, days: number): string {
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date()
  base.setDate(base.getDate() + days)
  return localDate(base)
}

/** 两个本地日期相差天数（b - a） */
export function daysBetween(a: string, b: string): number {
  const ta = new Date(a + 'T00:00:00').getTime()
  const tb = new Date(b + 'T00:00:00').getTime()
  return Math.round((tb - ta) / 86400000)
}
