import { AsyncLocalStorage } from 'node:async_hooks'
import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, renameSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Db, Row, RunResult } from './types'

/** 本地模式与测试用：同步驱动包成 Promise，事务语义与 electron/db 的 transact 一致 */
export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const
  private db: Database
  private ownerPath = ''
  /**
   * 「我现在这一段代码是不是跑在本实例开的事务里」。
   * 不能只数本地层数：同一条连接上并发的另一个请求（没有事务在手）也会读到 depth>0，
   * 把它的写入悄悄并进别人的事务——和 MySQL 那边用 AsyncLocalStorage 的理由一样。
   */
  private txScope = new AsyncLocalStorage<object>()
  private txToken = {}
  private seq = 0

  constructor(file: string) {
    const path = resolve(file)
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    clearStaleLock(path)
    try {
      this.db = new Database(path)
    } catch (e) {
      // 驱动只会甩一句英文 database is locked：真正的原因通常是另一份程序还握着锁，
      // 或者残留锁目录改不了名。给人一句能照着做的中文，原话留在括号里方便查
      const msg = String((e as Error)?.message ?? '')
      if (/database is locked/i.test(msg)) {
        throw new Error(
          `这份数据文件正被另一个程序占用（${path}）：同一个库两个程序同时写，账会写坏。` +
            `请先关掉另外打开的那一份再试；若确认没有别的程序在用它，把旁边的 ${path}.lock 文件夹删掉再启动。（${msg}）`
        )
      }
      throw e
    }
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
   * 「是不是嵌套」按当前异步调用链判定（AsyncLocalStorage），不按本地计数器：
   * 同一条连接上另一个并发请求没有事务在手，计数器却大于 0，会把它的写入
   * 悄悄并进别人的事务里一起提交/回滚。
   * 存档点标签只增不复用（RELEASE 会连带删掉它之后开的所有存档点，同名两条链会互相抹掉回滚点）；
   * 「连接在事务里、本调用链却没开事务」直接报错——那说明这层事务是别处开的（手写 BEGIN
   * 或上次提交失败留下的残事务），把这段并进去会让两边回滚互相牵连。
   */
  async transact<T>(fn: () => Promise<T>): Promise<T> {
    const nested = this.txScope.getStore() === this.txToken
    const connInTx = this.db.inTransaction
    if (!nested && connInTx) {
      throw new Error(
        '事务插队：这个连接已经在事务里，但这段代码不在那个事务的调用链上，不能并进别人的事务。' +
          '多半是别处手写了 BEGIN，或上一次提交失败后残事务没清——请先找到那一层，别把两段账并成一笔。'
      )
    }
    if (nested && !connInTx) {
      throw new Error(
        '事务插队：这段代码以为还在外层事务里，连接却已经退出了事务（多半是中间有人提交或回滚过）。' +
          '请查清是哪一层提前结束了事务，再继续。'
      )
    }
    const tag = `tx_${this.seq++}`
    this.db.exec(nested ? `SAVEPOINT ${tag}` : 'BEGIN')
    try {
      const result = await this.txScope.run(this.txToken, fn)
      this.db.exec(nested ? `RELEASE SAVEPOINT ${tag}` : 'COMMIT')
      return result
    } catch (e) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${tag}`)
        this.db.exec(`RELEASE SAVEPOINT ${tag}`)
      } else if (this.db.inTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw e
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
