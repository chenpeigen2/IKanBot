import { readFileSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { app, dialog } from 'electron'
import { Database } from 'node-sqlite3-wasm'
import { dataDir, imagesDir, backupsDir, docsDir, closeDb, openDb, getDb } from '../db'
import { backupCore } from '../../core/backup'
import type { BackupPreview } from '../../core/backup'
import { markBackupFail, markBackupOk } from './settings'

export type { BackupPreview }

/**
 * 备份门面（R61 起判据收进 core/backup.ts，桌面与服务器共用一份）：
 * 排队、按天去重、降级留痕、恢复回滚、路径守卫都在 core；
 * 这里只接本机的目录、SQLite 快照、原生选择框与 relaunch。
 * 远端模式的 backup:create/list/inspect/restore 走服务器（ipc/index.ts 里分流），
 * 那一侧跑的是同一份 core。
 */

/**
 * 允许被当作备份打开的路径。
 * 备份目录里的文件天然可信；目录外的（比如用户拷到 U 盘上的）必须是刚刚在原生
 * 文件选择框里亲手点过的那一个才认——记在这里，渲染进程传一个随便的路径进来是读不到的。
 */
const dialogApproved = new Set<string>()

const core = backupCore(
  {
    dataDir,
    backupsDir,
    imagesDir,
    docsDir
  },
  {
    /**
     * 事务一致快照：VACUUM INTO 失败（老 SQLite 不支持、磁盘满等）就降级直拷——
     * 主进程单线程，拷的是自己的事务边界外的静止文件，不会拷出半截；
     * 降级原因经 hooks 带回 core，写进 lastBackupError 留痕，工作台会挂提示。
     */
    snapshotDb(dbFile: string): { data: Buffer; fallback?: string } {
      // 快照用一次性文件名：不必先删后建，也不会和别的备份互相踩。
      // 目标路径拼进 SQL 字面量：数据目录在用户名带单引号的机器上也不能炸。
      const snap = join(dirname(dbFile), `vac-snapshot-${Date.now()}-${snapshotSeq++}`)
      try {
        const literal = `'${snap.replace(/'/g, "''")}'`
        getDb().exec(`VACUUM INTO ${literal}`)
        const data = readFileSync(snap)
        try {
          unlinkSync(snap)
        } catch {
          /* 快照删不掉不影响打包，文件名唯一不会互相踩 */
        }
        return { data }
      } catch (e) {
        console.warn('[backup] VACUUM INTO 快照失败，本次降级为直接拷贝：', (e as Error).message)
        return { data: readFileSync(dbFile), fallback: (e as Error).message }
      }
    },
    /** 探包：用一次性文件开一个独立连接看一眼，不碰主连接 */
    openProbe(file: string) {
      const database = new Database(file)
      return {
        get: (sql: string, params?: unknown[]) => database.get(sql, params as never),
        close: () => {
          database.close()
        }
      }
    },
    closeDb: () => {
      closeDb()
    },
    openDb: () => {
      openDb()
    },
    markOk: (iso: string) => markBackupOk(iso),
    markFail: (msg: string) => markBackupFail(msg),
    /** 恢复成功换完库：桌面程序重启一次（内存里的句柄/缓存全是旧的） */
    afterRestore(): void {
      app.relaunch()
      app.exit(0)
    },
    isApprovedPath: (p: string) => dialogApproved.has(resolve(p))
  }
)

let snapshotSeq = 0

export const createBackup = core.createBackup
export const uniqueBackupName = core.uniqueBackupName
export const pruneBackups = core.pruneBackups
export const collectBackupEntries = core.collectBackupEntries
export const autoBackupOnStart = core.autoBackupOnStart
export const listBackups = core.listBackups
export const inspectBackup = core.inspectBackup
export const restoreBackup = core.restoreBackup
export const isRestoring = core.isRestoring

/** 原生选择框挑一个备份包；取消返回空串（本机独有：服务器没有屏幕，远端模式恢复走列表） */
export function pickBackup(): string {
  const picked = dialog.showOpenDialogSync({
    title: '选择要恢复的备份文件',
    defaultPath: backupsDir(),
    filters: [{ name: 'IKanBot 备份', extensions: ['zip'] }],
    properties: ['openFile']
  })
  const file = picked?.[0] ?? ''
  if (file) dialogApproved.add(resolve(file))
  return file
}
