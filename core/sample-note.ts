/**
 * 打样单的账本备注：打样域没有操作历史表，fee_note 上那句话就是唯一的留痕。
 *
 * 单独成模块是因为写它的不止打样域——客户预收抵扣/撤销落在打样单上时也要留一句，
 * 而打样域已经引用了抵扣域，抵扣域再回头 import 打样域就绕成了环。
 */
import type { Db } from './db'

export async function appendSampleFeeNote(db: Db, sampleOrderId: number, line: string): Promise<void> {
  const row = (await db.get('SELECT fee_note FROM sample_orders WHERE id = ?', [
    sampleOrderId
  ])) as { fee_note?: string } | null
  const prev = String(row?.fee_note ?? '').trim()
  await db.run('UPDATE sample_orders SET fee_note = ?, updated_at = ? WHERE id = ?', [
    prev ? `${prev}；${line}` : line,
    new Date().toISOString(),
    sampleOrderId
  ])
}
