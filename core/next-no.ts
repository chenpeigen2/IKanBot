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

/**
 * 号段往前推一格，返回推完后的值。
 *
 * 必须写成 `value = value + 1` 让数据库自己加：读出来 +1 再写回去，
 * 两张同时建的单会读到同一个数、各发同一个号（桌面双击建单、
 * 报价转单撞上手工建单、后端多请求并发都是这个形状），
 * 而 order_no 没有唯一索引，撞了号事后查不出来。
 */
async function bumpCounter(db: Db, prefix: string): Promise<number> {
  const bumped = await db.run('UPDATE counters SET value = value + 1 WHERE name = ?', [prefix])
  if (bumped.changes !== 1) {
    // 这个号段今天第一次用到：建行同样走数据库的加法，别让并发各自插一行
    await db.run(
      'INSERT INTO counters(name, value) VALUES(?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1',
      [prefix]
    )
  }
  const row = await db.get('SELECT value FROM counters WHERE name = ?', [prefix])
  return Number(row?.value ?? 1)
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
  let next = await bumpCounter(db, prefix)
  let no = `${prefix}${String(next).padStart(3, '0')}`
  const resv = NO_RESERVATION[kind]
  if (resv) {
    // 跳号：库里已经被占的号（含手工插的）不能再生一次
    for (let i = 0; i < 100000; i++) {
      const hit = await db.get(`SELECT 1 FROM ${resv.table} WHERE ${resv.col} = ?`, [no])
      if (!hit) break
      next = await bumpCounter(db, prefix)
      no = `${prefix}${String(next).padStart(3, '0')}`
    }
  }
  return no
}
