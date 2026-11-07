import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Database } from 'node-sqlite3-wasm'
import { Inject } from '@nestjs/common'
import { backupCore, type BackupCore } from '../../../core/backup'
import { settingsCore } from '../../../core/settings'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { CONFIG } from '../config/config.module'
import type { ServerConfig } from '../config/config'

/** MySQL 上「备份/恢复还不做」的同一句话术：真要做得走 mysqldump，那是 M5 的活 */
const MYSQL_NOT_YET =
  '备份在 MySQL 库上还没做：要走 mysqldump 一致性快照，按计划单独落地。当前备份只支持 SQLite 库。'

/**
 * 备份域的 HTTP 门面（R61 备份簇上后端）：
 * 打包、排队、按天去重、降级留痕、恢复回滚、路径守卫全在 core/backup.ts，
 * 桌面本机模式走同一份——同一份数据备份/恢复后两边结果一致（双模式测试锁住）。
 *
 * 远端模式下备份发生在服务器：库 + 图片目录 + 单据存档目录整包打包；
 * 桌面端只做转发与进度展示，「每天启动一备 + 每小时补查」的节奏由这里的定时器兑现。
 */
@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly core: BackupCore | null
  private readonly sqliteFile: string | null
  private timer: NodeJS.Timeout | null = null

  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly config: ServerConfig) {
    if (config.db.kind !== 'sqlite') {
      this.core = null
      this.sqliteFile = null
      return
    }
    this.sqliteFile = config.db.file
    this.core = backupCore(
      {
        dataDir: () => dirname(String(this.sqliteFile)),
        backupsDir: () => this.config.backupsDir,
        imagesDir: () => this.config.imagesDir,
        docsDir: () => this.config.docsDir,
        dbFile: () => String(this.sqliteFile)
      },
      {
        /**
         * 快照走第二条连接 VACUUM INTO：主连接不用为备份停笔。
         * 失败（库被锁死、磁盘满）降级直拷，降级原因带回 core 留进 lastBackupError。
         */
        snapshotDb: (dbFile: string): { data: Buffer; fallback?: string } => {
          const snap = join(dirname(dbFile), `vac-snapshot-${Date.now()}-${snapshotSeq++}`)
          try {
            const probe = new Database(dbFile)
            try {
              probe.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`)
            } finally {
              probe.close()
            }
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
        /** 探包：一次性文件开独立连接，不碰主连接 */
        openProbe: (file: string) => {
          const database = new Database(file)
          return {
            get: (sql: string, params?: unknown[]) => database.get(sql, params as never),
            close: () => {
              database.close()
            }
          }
        },
        // 恢复换库前关连接 / 失败重接 / 成功后重开——SqliteDb.reopen 保证新库立即生效，
        // 服务器不用为恢复重启进程
        closeDb: async () => {
          await this.db.close()
        },
        openDb: () => {
          this.db.reopen?.(String(this.sqliteFile))
        },
        markOk: async (iso: string) => {
          await settingsCore(this.db).patchBackup({ lastBackupAt: iso, lastBackupError: null })
        },
        markFail: async (msg: string) => {
          await settingsCore(this.db).patchBackup({ lastBackupError: msg })
        },
        afterRestore: () => {
          this.db.reopen?.(String(this.sqliteFile))
          console.log('[backup] 恢复完成：库文件已替换，连接已重开')
        },
        // 服务器没有屏幕：备份目录外的 zip 没有「亲手点过」的放行理由
        isApprovedPath: () => false
      }
    )
  }

  /** 服务一起来就补查一次当天备过没有，之后每小时喊一次（当天已备过 core 自己会跳过） */
  onModuleInit(): void {
    if (!this.core) return
    this.timer = setInterval(() => {
      try {
        this.core?.autoBackupOnStart()
      } catch (e) {
        console.warn('[backup] 定时备份检查失败', e)
      }
    }, 60 * 60 * 1000)
    // 启动后稍等片刻再补一次：别跟迁移/引导用户抢启动那几秒
    setTimeout(() => {
      try {
        this.core?.autoBackupOnStart()
      } catch (e) {
        console.warn('[backup] 启动备份检查失败', e)
      }
    }, 10_000).unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async create(): Promise<string> {
    this.assertSqlite()
    return this.core!.createBackup('manual')
  }

  list(): Array<{ path: string; name: string; takenAt: string | null; size: number }> {
    if (!this.core) return []
    return this.core.listBackups()
  }

  inspect(rawPath: unknown) {
    this.assertSqlite()
    return this.core!.inspectBackup(requireBackupPath(rawPath))
  }

  async restore(_rawPath: unknown): Promise<{ restarted: boolean }> {
    this.assertSqlite()
    await this.core!.restoreBackup(requireBackupPath(_rawPath))
    // 服务器不重启进程（连接已重开）；桌面端拿到 restarted:false 后自己刷新界面
    return { restarted: false }
  }

  isRestoring(): boolean {
    return testRestoringOverride || (this.core?.isRestoring() ?? false)
  }

  /** HTTP 冒烟专用：真实恢复不好在测试里卡中间时刻，用钩子把「恢复在途」立起来验写闸门 */
  setRestoringForTest(on: boolean): void {
    testRestoringOverride = on
  }

  private assertSqlite(): void {
    if (!this.core) throw new Error(MYSQL_NOT_YET)
  }
}

let snapshotSeq = 0
let testRestoringOverride = false

/** 路径守卫：只认字符串，进 core 再判目录内与 .zip 后缀 */
function requireBackupPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请先选择一个备份文件')
  return raw
}
