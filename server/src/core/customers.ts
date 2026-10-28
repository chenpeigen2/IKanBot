import type { Db } from '../db/types'

export interface CustomerRow {
  id: number
  company: string
  country: string | null
  active: number
}

/**
 * M0 样板域：证明同一份业务函数能跑在 SQLite 与 MySQL 两个后端上。
 * M1 会把 electron/services 里的完整实现（含搜索转义与 mapCustomer）整体搬进来，
 * 届时本文件删掉——不要在两边各留一份。
 */
export async function listCustomers(
  db: Db,
  opts: { includeInactive?: boolean } = {}
): Promise<CustomerRow[]> {
  const where = opts.includeInactive ? '' : 'WHERE active = 1'
  const rows = await db.all(
    `SELECT id, company, country, active FROM customers ${where} ORDER BY company`
  )
  return rows as unknown as CustomerRow[]
}
