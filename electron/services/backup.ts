import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { dataDir, imagesDir, backupsDir } from '../db'
import { createZip, collectDir } from './zip'

/**
 * 备份：把 db + images 打包成一个 zip（纯 JS 实现，无外部依赖）。
 */
export async function createBackup(note = ''): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const name = `ikanbot-${stamp}${note ? `-${note}` : ''}.zip`
  const target = join(backupsDir(), name)

  const entries = []
  const dbFile = join(dataDir(), 'ikanbot.db')
  if (existsSync(dbFile)) {
    entries.push({ name: 'ikanbot.db', data: readFileSync(dbFile) })
  }
  entries.push(...collectDir(imagesDir(), 'images'))

  const buf = createZip(entries)
  writeFileSync(target, buf)

  pruneBackups(30)
  return target
}

/** 保留最近 N 份备份 */
export function pruneBackups(keep = 30): void {
  const dir = backupsDir()
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('ikanbot-') && f.endsWith('.zip'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const old of files.slice(keep)) {
    try {
      unlinkSync(join(dir, old.f))
    } catch {
      /* 忽略删除失败 */
    }
  }
}

/** 启动时自动备份一次（同一天已有则跳过） */
export function autoBackupOnStart(): void {
  try {
    const dir = backupsDir()
    const files = readdirSync(dir).filter((f) => f.endsWith('.zip'))
    const latest = files
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]
    if (latest && sameDay(latest.t, Date.now())) return
    void createBackup('auto')
  } catch {
    /* 备份失败不应阻塞启动 */
  }
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}
