import { LATEST_DB_VERSION, MIGRATIONS } from '../../../electron/db/schema'
import type { Db } from './types'

/**
 * 建库/升级：与 electron/db 的 migrate 同一份 MIGRATIONS（schema 只有一处真源）。
 * 桌面端那份是同步驱动，这份是异步 Db，逻辑照抄、语义不变：
 * 库比程序新就拒绝打开——老程序改新结构会把数据改坏。
 */
export async function migrate(db: Db): Promise<void> {
  if (db.kind !== 'sqlite') return
  const row = await db.get('PRAGMA user_version')
  const current = Number(row?.['user_version'] ?? 0)
  if (current > LATEST_DB_VERSION) {
    throw new Error(
      `这个库的结构是 v${current}，当前服务只认到 v${LATEST_DB_VERSION}。` +
        `多半是拿了新版备份。请先升级服务端再打开，用老版本改新数据会把库改坏。`
    )
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    await db.transact(async () => {
      await db.exec(m.sql)
      await db.exec(`PRAGMA user_version = ${m.version}`)
    })
  }
}
