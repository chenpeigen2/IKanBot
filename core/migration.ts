import type { Db } from './db'
import { moneyCore } from './money'

/**
 * 整库搬迁对账（第七节第 2 条第一版，SQLite→SQLite）。
 *
 * 恢复完成后跑一遍：核心表逐表行数 + 三个能从表里直接算出来的口径指纹
 * （收款合计、单号唯一性、抵扣台账合计）。行数对不上、单号出现重复，就是搬坏了——
 * 报告逐项亮出来，别让「恢复成功」四个字替人背书。
 *
 * 客户预收余额是派生值（「已收但不属于任何一张单」减去抵扣台账），不落单列；
 * 这里先取抵扣台账自身的合计作完整性指纹（撤销行不算），派生余额的逐客户抽查留第二版
 * （要在搬迁口径里重算 payments 派生，和 credits 域共用同一份算法才有意义）。
 */

export interface MigrationReport {
  /** 核心表逐表行数（缺表/对不上 = 搬坏了） */
  tables: Record<string, number>
  /** 收款合计（直接 SUM） */
  paymentTotal: number
  /** 订单总行数与去重单号数：两者相等 = 单号唯一约束在搬迁后仍然成立 */
  orderNoCount: number
  orderNoDistinct: number
  /** 抵扣台账合计（reversed_at 非空的撤销行不算） */
  creditAppliedTotal: number
  /** 逐客户预收派生余额（非零行；与客户页「可用预收」同一份 money 域算法，R68） */
  creditBalances: MigrationCreditRow[]
}

/** 逐客户预收派生余额的一行：只列非零的（搬迁后与原库逐项对，第七节「customerCreditBalance 抽查」） */
export interface MigrationCreditRow {
  customerId: number
  company: string
  currency: string
  available: number
}

/** 对账要覆盖的核心表：单据、明细、主档、流水、留痕、台账（不含设置/缓存类） */
const CORE_TABLES = [
  'orders',
  'order_items',
  'customers',
  'products',
  'quotations',
  'quotation_items',
  'sample_orders',
  'sample_order_items',
  'payments',
  'order_events',
  'packing_lists',
  'credit_applications'
] as const

export async function migrationReport(db: Db): Promise<MigrationReport> {
  const tables: Record<string, number> = {}
  for (const t of CORE_TABLES) {
    const row = (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)) as { n?: number } | null
    tables[t] = Number(row?.n ?? 0)
  }
  const pay = (await db.get('SELECT COALESCE(SUM(amount), 0) AS total FROM payments')) as { total?: number } | null
  const noCount = (await db.get('SELECT COUNT(*) AS n FROM orders')) as { n?: number } | null
  const noDistinct = (await db.get('SELECT COUNT(DISTINCT order_no) AS n FROM orders')) as { n?: number } | null
  const credit = (await db.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM credit_applications WHERE reversed_at IS NULL'
  )) as { total?: number } | null
  // 逐客户预收派生余额：候选客户 = 「收过钱的单」的客户 ∪ 「抵扣台账里有动静」的客户
  //——没用掉的预收不落 credit_applications（那张表只记用掉的），只查台账会漏掉刚多收的客户
  //（R68 第一版就栽在这）。余额本身逐个调 money 域的同一份算法（与客户页「可用预收」同源，
  // 这里不许另写一份），零余额的过滤掉。
  const cand = (await db.all(
    `SELECT DISTINCT customer_id AS id FROM (
       SELECT o.customer_id AS customer_id FROM payments p JOIN orders o ON o.id = p.order_id
       UNION
       SELECT ca.customer_id AS customer_id FROM credit_applications ca
     ) WHERE customer_id IS NOT NULL`
  )) as { id?: number }[]
  const companies = new Map<number, string>()
  for (const r of cand) {
    const id = Number(r.id)
    const row = (await db.get('SELECT company FROM customers WHERE id = ?', [id])) as { company?: string } | null
    companies.set(id, String(row?.company ?? `#${id}`))
  }
  const balances = moneyCore(db).customerCreditBalance
  const creditBalances: MigrationCreditRow[] = []
  for (const r of cand) {
    const id = Number(r.id)
    for (const cur of await balances(id)) {
      if (cur.available <= 0.001) continue
      creditBalances.push({ customerId: id, company: companies.get(id) ?? `#${id}`, currency: cur.currency, available: cur.available })
    }
  }
  creditBalances.sort((a, b) => a.customerId - b.customerId || a.currency.localeCompare(b.currency))

  return {
    tables,
    paymentTotal: Number(pay?.total ?? 0),
    orderNoCount: Number(noCount?.n ?? 0),
    orderNoDistinct: Number(noDistinct?.n ?? 0),
    creditAppliedTotal: Number(credit?.total ?? 0),
    creditBalances
  }
}

/**
 * 搬迁对账两份逐项对（R70）：before = 包里「导出那一刻」的对账，after = 恢复完成后现算的。
 * 恢复就是把库换成包内容——两份必须全零差；对不上说明包或恢复有一头坏了。
 * ok = 全零差（表行数、收款合计、单号计数、抵扣台账、逐客户余额全部一致）。
 */
export interface MigrationDiff {
  ok: boolean
  tables: Record<string, { before: number; after: number }>
  paymentTotal: { before: number; after: number }
  orderNoCount: { before: number; after: number }
  orderNoDistinct: { before: number; after: number }
  creditAppliedTotal: { before: number; after: number }
  creditBalances: { before: MigrationCreditRow[]; after: MigrationCreditRow[] }
}

const sameRows = (a: MigrationCreditRow[], b: MigrationCreditRow[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => x.customerId === b[i].customerId && x.currency === b[i].currency && Math.abs(x.available - b[i].available) < 0.001)

export function diffMigrationReports(before: MigrationReport, after: MigrationReport): MigrationDiff {
  const tables: MigrationDiff['tables'] = {}
  const allTables = new Set([...Object.keys(before.tables ?? {}), ...Object.keys(after.tables ?? {})])
  for (const t of allTables) {
    const b = Number(before.tables?.[t] ?? 0)
    const a = Number(after.tables?.[t] ?? 0)
    if (b !== a) tables[t] = { before: b, after: a }
  }
  const paymentTotal = { before: Number(before.paymentTotal ?? 0), after: Number(after.paymentTotal ?? 0) }
  const orderNoCount = { before: Number(before.orderNoCount ?? 0), after: Number(after.orderNoCount ?? 0) }
  const orderNoDistinct = { before: Number(before.orderNoDistinct ?? 0), after: Number(after.orderNoDistinct ?? 0) }
  const creditAppliedTotal = { before: Number(before.creditAppliedTotal ?? 0), after: Number(after.creditAppliedTotal ?? 0) }
  const creditBalances = { before: before.creditBalances ?? [], after: after.creditBalances ?? [] }
  const ok =
    Object.keys(tables).length === 0 &&
    Math.abs(paymentTotal.before - paymentTotal.after) < 0.001 &&
    orderNoCount.before === orderNoCount.after &&
    orderNoDistinct.before === orderNoDistinct.after &&
    Math.abs(creditAppliedTotal.before - creditAppliedTotal.after) < 0.001 &&
    sameRows(creditBalances.before, creditBalances.after)
  return { ok, tables, paymentTotal, orderNoCount, orderNoDistinct, creditAppliedTotal, creditBalances }
}
