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
