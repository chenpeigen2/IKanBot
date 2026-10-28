import type { Db } from './db'

/**
 * 序列号生成：PI20260320001。桌面与后端共用这一份。
 *
 * 每个号段占哪张表。单号是凭据（客户拿单号对账），
 * 恢复备份 / 手工导库之后计数器可能落后于库里已有的号，
 * 生成时必须查重跳号，绝不能撞号。
 */
const NO_RESERVATION: Record<string, { table: string; col: string }> = {
  SO: { table: 'orders', col: 'order_no' },
  PI: { table: 'orders', col: 'pi_no' },
  PL: { table: 'packing_lists', col: 'pl_no' },
  Q: { table: 'quotations', col: 'q_no' },
  SMP: { table: 'sample_orders', col: 'sample_no' },
  SM: { table: 'sample_orders', col: 'sample_no' }
}

export async function nextNo(
  db: Db,
  kind: 'PI' | 'PL' | 'SO' | 'Q' | 'SM' | 'SMP',
  date = new Date()
): Promise<string> {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const prefix = `${kind}${y}${m}${d}`
  const row = await db.get('SELECT value FROM counters WHERE name = ?', [prefix])
  let next = Number(row?.value ?? 0) + 1
  let no = `${prefix}${String(next).padStart(3, '0')}`
  const resv = NO_RESERVATION[kind]
  if (resv) {
    // 跳号：库里已经被占的号（含手工插的）不能再生一次
    for (let i = 0; i < 100000; i++) {
      const hit = await db.get(`SELECT 1 FROM ${resv.table} WHERE ${resv.col} = ?`, [no])
      if (!hit) break
      next += 1
      no = `${prefix}${String(next).padStart(3, '0')}`
    }
  }
  await db.run(
    'INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    [prefix, next]
  )
  return no
}
