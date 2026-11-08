import type { Db } from './db'

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
  return {
    tables,
    paymentTotal: Number(pay?.total ?? 0),
    orderNoCount: Number(noCount?.n ?? 0),
    orderNoDistinct: Number(noDistinct?.n ?? 0),
    creditAppliedTotal: Number(credit?.total ?? 0)
  }
}
