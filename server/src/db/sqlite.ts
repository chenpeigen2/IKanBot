import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, renameSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Db, Row, RunResult } from './types'

/** 本地模式与测试用：同步驱动包成 Promise，事务语义与 electron/db 的 transact 一致 */
export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const
  private db: Database
  private ownerPath = ''
  private depth = 0
  private seq = 0

  constructor(file: string) {
    const path = resolve(file)
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    clearStaleLock(path)
    this.db = new Database(path)
    this.ownerPath = lockOwnerPath(path)
    // 记下谁握着这个库：锁目录一直是空的，只有这份旁注分得清「真有人在用」和「上次没退干净」
    try {
      writeFileSync(this.ownerPath, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
    } catch (e) {
      console.warn('[db] 没能登记锁的主人（不影响这次打开）', e)
    }
    this.db.exec('PRAGMA foreign_keys = ON;')
    // 备份/恢复/桌面端偶尔会同时握着同一个文件，没有 busy_timeout 就是裸的 database is locked
    this.db.exec('PRAGMA busy_timeout = 5000;')
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return (this.db.get(sql, params as never) ?? undefined) as Row | undefined
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.db.all(sql, params as never) as Row[]
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = this.db.run(sql, params as never) as { lastInsertRowid?: number; changes?: number }
    return { lastInsertRowid: Number(r?.lastInsertRowid ?? 0), changes: Number(r?.changes ?? 0) }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  /**
   * 事务：最外层 BEGIN、嵌套 SAVEPOINT，语义与 electron/db 完全一致。
   *
   * 存档点标签只增不复用（RELEASE 会连带删掉它之后开的所有存档点，同名两条链会互相抹掉回滚点）；
   * 「连接在事务里、本地一层都没开」直接报错——那说明这层事务是别处开的（手写 BEGIN 或上次提交
   * 失败留下的残事务），把这段并进去会让两边回滚互相牵连。
   */
  async transact<T>(fn: () => Promise<T>): Promise<T> {
    // 以数据库自己的状态为准：调用方可能手写了 BEGIN
    const top = !this.db.inTransaction
    if (!top && this.depth === 0) {
      throw new Error(
        '事务插队：这个连接已经在事务里，但本地没有任何在途事务，这段写入不能并进别人的事务。' +
          '多半是别处手写了 BEGIN，或上一次提交失败后残事务没清——请先找到那一层，别把两段账并成一笔。'
      )
    }
    const tag = `tx_${this.seq++}`
    this.db.exec(top ? 'BEGIN' : `SAVEPOINT ${tag}`)
    this.depth++
    try {
      const result = await fn()
      this.db.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${tag}`)
      return result
    } catch (e) {
      if (top) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK')
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${tag}`)
        this.db.exec(`RELEASE SAVEPOINT ${tag}`)
      }
      throw e
    } finally {
      this.depth--
    }
  }

  async close(): Promise<void> {
    this.db.close()
    // 锁目录已随 close() 释放；旁注跟着走，别让下次启动去问一个已退出的 pid
    try {
      if (this.ownerPath) unlinkSync(this.ownerPath)
    } catch {
      /* 没有就算了 */
    }
  }
}

/**
 * node-sqlite3-wasm 用「建一个 <db>.lock 目录」当排他锁，正常 close() 会删。
 * 进程被强杀（Ctrl+C 没来得及关、taskkill、崩溃）时锁目录留在原地，
 * 下次启动直接抛 database is locked——本地跑服务最常见的一次性故障。
 *
 * 但**锁被握着的时候目录同样是空的**（驱动只 mkdir，不往里写东西），
 * 所以不能拿「空」当没人用：照旧 rmdir 会把另一个在跑的进程的锁抽走。
 * 现在靠同目录的 `.lock.owner`（持锁进程 pid）分辨：
 *   - 主人还活着 → 抛中文错，让人先关掉那一份；
 *   - 主人不在（或老版本没留旁注）→ 残留锁，改名挪开留案底，照常启动。
 */
function lockOwnerPath(file: string): string {
  return `${file}.lock.owner`
}

function readLockOwner(file: string): number | null {
  try {
    const pid = Number(readFileSync(lockOwnerPath(file), 'utf8').split('\n')[0].trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** ESRCH 才是「进程没了」；EPERM 说明进程在，只是不归我们管 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function removeLockOwner(file: string): void {
  try {
    unlinkSync(lockOwnerPath(file))
  } catch {
    /* 没有就算了 */
  }
}

function clearStaleLock(file: string): void {
  try {
    const lockPath = `${file}.lock`
    if (!existsSync(lockPath) || !statSync(lockPath).isDirectory()) {
      removeLockOwner(file)
      return
    }
    const ownerPid = readLockOwner(file)
    if (ownerPid != null && pidAlive(ownerPid)) {
      throw new Error(
        `这份数据正被另一个进程（${ownerPid}）用着：同一个库两个程序同时写，账会写坏。` +
          `请先停掉那一份再启动。若确认它已经不在了，把这个文件夹删掉再试：${lockPath}`
      )
    }
    removeLockOwner(file)
    const moved = `${lockPath}.stale-${Date.now()}`
    renameSync(lockPath, moved)
    console.warn(`[db] 清理残留锁：${moved}（属于已退出的进程 ${ownerPid ?? '未知，老版本没留旁注'}）`)
  } catch (e) {
    if ((e as Error).message?.includes('正被另一个')) throw e
    console.warn('[db] 清理残留锁失败，交给驱动报错', e)
  }
}
