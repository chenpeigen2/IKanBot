import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync, rmSync, mkdirSync } from 'fs'
import { join, resolve, sep, dirname } from 'path'
import { app, dialog } from 'electron'
import { Database } from 'node-sqlite3-wasm'
import { dataDir, imagesDir, backupsDir, docsDir, closeDb, openDb, getDb } from '../db'
import { LATEST_DB_VERSION } from '../db/schema'
import { createZip, collectDir, readZip, verifyZip, type ZipEntry } from './zip'
import { markBackupFail, markBackupOk } from './settings'
import { localDate } from '../../src/shared/date'

/**
 * 备份：把 db + images + 单据存档（docs 下的 PDF）打包成一个 zip。
 * 只备 db 不备 docs，恢复后存档表还在、原单却一版都打不开，退税和收款纠纷时等于没凭据。
 *
 * 写盘走「先写 .part，验货通过再改名」：
 * 直接在最终文件名上写，中途断电 / 磁盘满 / 进程被杀会留下一个名字看着正常、
 * 内容却是半截的 zip。人只认文件名，第二天出事了才发现备份是空的。
 */
export async function createBackup(note = ''): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const name = `ikanbot-${stamp}${note ? `-${note}` : ''}.zip`
  const target = join(backupsDir(), name)
  const temp = `${target}.part`

  try {
    const entries = collectBackupEntries()
    const buf = createZip(entries)
    writeFileSync(temp, buf)
    // 从盘上重新读回来验：光看内存里那份不算数，写坏的是盘上那几个字节
    const onDisk = readFileSync(temp)
    verifyZip(onDisk, entries)
    renameSync(temp, target)
    pruneBackups(30)
    markBackupOk(new Date().toISOString())
    // 快照降级过的备份能用于恢复，但不是事务一致快照：留一句在 lastBackupError 里，
    // 工作台会挂起提示，别让人以为这份和平时的是同一种口径
    if (snapshotFallbackReason) {
      markBackupFail(
        `备份已生成，但数据库快照降级为直接拷贝（${snapshotFallbackReason}）。这份备份可用于恢复，但不是事务一致快照，建议查明原因后再备一次。`
      )
    }
    return target
  } catch (e) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      /* 临时文件删不掉不影响报错 */
    }
    const msg = (e as Error).message
    markBackupFail(msg)
    throw new Error(msg)
  }
}

export function collectBackupEntries(): ZipEntry[] {
  const entries: ZipEntry[] = []
  const dbFile = join(dataDir(), 'ikanbot.db')
  if (existsSync(dbFile)) {
    entries.push({ name: 'ikanbot.db', data: snapshotDb(dbFile) })
  }
  entries.push(...collectDir(imagesDir(), 'images'))
  entries.push(...collectDir(docsDir(), 'docs'))
  return entries
}

/**
 * 数据库快照：VACUUM INTO 导出一份事务一致的副本再读进内存。
 * 直接 readFileSync(db 文件) 拷的是「任意一瞬间」的字节——外部进程（网盘/DB 工具）
 * 正在写时备出半截库，zip 能通过完整性校验，坏要等到恢复那天才暴露。
 * VACUUM INTO 失败（老 SQLite 不支持等）就退回直拷，主进程单线程下自己的事务不会拷半截。
 */
/** 本次备份里快照是否降级过（createBackup 收尾时读它去留痕，别的地方别用） */
let snapshotFallbackReason = ''

let snapshotSeq = 0

function snapshotDb(dbFile: string): Buffer {
  // 快照用一次性文件名：不必先删后建，也不会和别的备份互相踩。
  // 目标路径拼进 SQL 字面量：数据目录在用户名带单引号的机器上也不能炸。
  // VACUUM INTO 失败（老 SQLite 不支持、磁盘满等）就降级直拷——
  // 主进程单线程，拷的是自己的事务边界外的静止文件，不会拷出半截；
  // 降级原因留在 lastBackupError 里，工作台会挂提示。
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
    return data
  } catch (e) {
    snapshotFallbackReason = (e as Error).message
    console.warn('[backup] VACUUM INTO 快照失败，本次降级为直接拷贝：', snapshotFallbackReason)
    return readFileSync(dbFile)
  }
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

/**
 * 启动时自动备份一次（同一天已有则跳过）。
 * 以前每次启动都打包：崩溃重启几次就把 30 份历史挤成同一天，
 * 真出事要退回上周时一份都没有。设置页和这里的注释都写「每天一次」，得兑现。
 */
export function autoBackupOnStart(): void {
  const dir = backupsDir()
  const today = localDate()
  const doneToday = readdirSync(dir).some((f) => {
    if (!/^ikanbot-\d{14}-auto\.zip$/.test(f)) return false
    try {
      return localDate(new Date(statSync(join(dir, f)).mtimeMs)) === today
    } catch {
      return false
    }
  })
  if (doneToday) return
  // 备份失败不能拖住启动，但也不能当没事发生：
  // 记进设置里的 lastBackupError，工作台会一直挂着「最近一次备份没成功」，
  // 免得软件悄悄用了半年，某天要恢复时才发现一份能用的都没有。
  void createBackup('auto').catch((e) => {
    console.warn('[backup] 自动备份失败', e)
  })
}

/* ------------------------------------------------------------------ *
 * 恢复备份
 * ------------------------------------------------------------------ */

/** 备份包里允许出现的顶层目录；其余一律拒绝，免得有人拿别的 zip 来点这个按钮 */
const RESTORE_ALLOWED = ['ikanbot.db', `images${sep}`, `docs${sep}`, 'images/', 'docs/']

function isAllowedEntry(name: string): boolean {
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) return false
  if (name.split(/[\\/]/).some((part) => part === '..')) return false
  return RESTORE_ALLOWED.some((p) => name === p || name.startsWith(p))
}

/** 把备份里的相对路径落到 dir 下，并确认没有跳出 dir */
function containedPath(dir: string, rel: string): string {
  const target = resolve(dir, rel.replace(/[\\/]/g, sep))
  const root = resolve(dir)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`备份里的路径「${rel}」指向了数据目录外面，这份包不能用`)
  }
  return target
}

/** 本程序认识的最高库版本：比它新说明备份来自升级版程序，降回去必丢数据 */
const MAX_KNOWN_VERSION = LATEST_DB_VERSION

/** 用一个临时文件把备份里的库打开看一眼，确认没坏、版本没超前 */
function inspectRestoredDb(dbData: Buffer, stamp: string): void {
  const probeDir = join(dataDir(), `.restore-check-${stamp}`)
  const probeFile = join(probeDir, 'check.db')
  mkdirSync(probeDir, { recursive: true })
  let database: Database | null = null
  try {
    writeFileSync(probeFile, dbData)
    database = new Database(probeFile)
    const check = database.get('PRAGMA quick_check') as { quick_check?: string } | null
    if (String(check?.quick_check ?? '') !== 'ok') {
      throw new Error('备份里的数据库自检没通过，这份包不能用')
    }
    const v = Number((database.get('PRAGMA user_version') as { user_version?: number })?.user_version ?? 0)
    if (v > MAX_KNOWN_VERSION) {
      throw new Error(
        `这份备份来自更新的程序版本（数据格式 v${v}，当前只认到 v${MAX_KNOWN_VERSION}）。` +
          `请先把程序升级到该版本或更高，再恢复。`
      )
    }
    const orders = database.get('SELECT COUNT(*) AS n FROM orders') as { n: number } | null
    const payments = database.get('SELECT COUNT(*) AS n FROM payments') as { n: number } | null
    if (!orders || !payments) throw new Error('备份里的数据库缺少核心数据表，这份包不能用')
  } finally {
    try {
      database?.close()
    } catch {
      /* 探完就扔 */
    }
    try {
      rmSync(probeDir, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
}

/** 一次附件目录替换的现场：换库失败时要靠它穿回原样 */
interface DirSwap {
  dir: string
  holding: string
  /** 旧内容被挪去了 holding（原来的目录非空） */
  moved: boolean
  /** 恢复前这个目录本来就在（哪怕是空的） */
  existed: boolean
}

/**
 * 把一个目录整体换成备份里的内容（备份里没有的就当已删）。
 *
 * 旧内容只挪进 holding，不在这里删：库还没换，换库那一步失败时这两份旧图/旧存档
 * 还得穿回去。旧目录的清理交给 dropHolding，等整套替换确认成功再做。
 */
function replaceDir(dir: string, prefix: string, entries: ZipEntry[], stamp: string): DirSwap {
  const mine = `${prefix}/`
  const wanted = entries.filter((e) => e.name.startsWith(mine))
  const holding = `${dir}.pre-restore-${stamp}`
  const existed = existsSync(dir)
  const moved = existed && readdirSync(dir).length > 0
  if (existsSync(holding)) rmSync(holding, { recursive: true, force: true })
  if (moved) {
    // 先整体挪走再铺新的：直接删的话，铺到一半崩了就是两头空
    renameSync(dir, holding)
  }
  mkdirSync(dir, { recursive: true })
  try {
    for (const e of wanted) {
      const rel = e.name.slice(mine.length)
      if (!rel) continue
      const target = containedPath(dir, rel)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, e.data)
    }
  } catch (e) {
    // 铺坏了就原路退回去，别让用户的图库和存档停在半套状态
    rmSync(dir, { recursive: true, force: true })
    if (moved) renameSync(holding, dir)
    throw e
  }
  return { dir, holding, moved, existed }
}

/** 换库失败时把附件目录穿回恢复前的样子（原来没有的目录就让它消失） */
function undoReplace(swap: DirSwap): void {
  rmSync(swap.dir, { recursive: true, force: true })
  if (swap.moved) renameSync(swap.holding, swap.dir)
  else if (swap.existed) mkdirSync(swap.dir, { recursive: true })
}

/** 整套恢复成功后，旧附件目录才真正可以扔了 */
function dropHolding(swap: DirSwap): void {
  if (!swap.moved || !existsSync(swap.holding)) return
  try {
    rmSync(swap.holding, { recursive: true, force: true })
  } catch {
    /* 旧目录删不掉不影响新数据，下次恢复会先清掉同名 holding */
  }
}

/** 备份包里的文件清单摘要：恢复确认框上要让人看一眼「这是哪天、有几单」的包 */
export interface BackupPreview {
  path: string
  /** 备份时间（从文件名里的时间戳还原，ISO） */
  takenAt: string | null
  fileSize: number
  entryCount: number
  hasDb: boolean
  /** 包里的订单数 / 收款数：恢复前必须看得见，不然等于闭眼按 */
  orderCount: number | null
  paymentCount: number | null
}

/** 从 `ikanbot-YYYYMMDDHHMMSS-auto.zip` 里抠出时间；抠不到返回 null（别人手放进来的文件） */
function stampFromName(name: string): string | null {
  const m = /^ikanbot-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/** 打开一个备份包看看里面是什么（不落任何盘），恢复确认框用 */
export function inspectBackup(rawPath: string): BackupPreview {
  const path = requireBackupPath(rawPath)
  const entries = readZip(readFileSync(path))
  const dbEntry = entries.find((e) => e.name === 'ikanbot.db')
  const probe: BackupPreview = {
    path,
    takenAt: stampFromName(path.split(/[\\/]/).pop() ?? ''),
    fileSize: statSync(path).size,
    entryCount: entries.length,
    hasDb: !!dbEntry,
    orderCount: null,
    paymentCount: null
  }
  if (!dbEntry) throw new Error('这个备份包里没有数据库文件，不能用来恢复')
  const stamp = `${Date.now()}`
  const probeDir = join(dataDir(), `.inspect-${stamp}`)
  const probeFile = join(probeDir, 'check.db')
  mkdirSync(probeDir, { recursive: true })
  let database: Database | null = null
  try {
    writeFileSync(probeFile, dbEntry.data)
    database = new Database(probeFile)
    probe.orderCount = Number((database.get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n)
    probe.paymentCount = Number((database.get('SELECT COUNT(*) AS n FROM payments') as { n: number }).n)
  } catch (e) {
    throw new Error(`这个备份包打不开来看：${(e as Error).message}`)
  } finally {
    try {
      database?.close()
    } catch {
      /* 探完就扔 */
    }
    try {
      rmSync(probeDir, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
  return probe
}

/**
 * 允许被当作备份打开的路径。
 * 备份目录里的文件天然可信；目录外的（比如用户拷到 U 盘上的）必须是刚刚在原生
 * 文件选择框里亲手点过的那一个才认——记在这里，渲染进程传一个随便的路径进来是读不到的。
 */
const dialogApproved = new Set<string>()

/** 原生选择框挑一个备份包；取消返回空串 */
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

/** 备份目录里的备份包列表（新→旧），设置页用来点选 */
export function listBackups(): Array<{ path: string; name: string; takenAt: string | null; size: number }> {
  const dir = backupsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('ikanbot-') && f.endsWith('.zip'))
    .map((f) => ({
      path: join(dir, f),
      name: f,
      takenAt: stampFromName(f),
      size: statSync(join(dir, f)).size
    }))
    .sort((a, b) => b.path.localeCompare(a.path))
}

/** 只接受备份目录里的 .zip，或刚在原生选择框里点过的那一个 */
function requireBackupPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('请先选择一个备份文件')
  const dir = resolve(backupsDir())
  const target = resolve(rawPath)
  if (!target.toLowerCase().endsWith('.zip')) throw new Error('只能选 .zip 的备份文件')
  const insideBackups = target === dir || target.startsWith(dir + sep)
  if (!insideBackups && !dialogApproved.has(target)) {
    throw new Error('只能从备份目录里选文件，或用「选择备份文件」按钮重新挑一个')
  }
  if (!existsSync(target)) throw new Error('这个备份文件已经不在了')
  return target
}

/**
 * 恢复备份：把当前 db / 图片 / 单据存档整体换成备份里的内容，然后重启程序。
 *
 * 顺序是有意的：先给「现在的样子」压一份 pre-restore 备份，再动手。
 * 恢复本身是破坏性操作（选错包 = 覆盖掉这几天的活），留一份能反悔的东西比省一次磁盘写入重要得多。
 */
export async function restoreBackup(rawPath: string): Promise<{ restarted: boolean }> {
  const path = requireBackupPath(rawPath)
  const entries = readZip(readFileSync(path))
  for (const e of entries) {
    if (!isAllowedEntry(e.name)) {
      throw new Error(`备份包里有个不认识的文件「${e.name}」，为了安全这份包不能用`)
    }
  }
  const dbEntry = entries.find((e) => e.name === 'ikanbot.db')
  if (!dbEntry) throw new Error('这个备份包里没有数据库文件，不能用来恢复')

  inspectRestoredDb(dbEntry.data, `${Date.now()}`)

  // 反悔药：把当前数据整体存一份，恢复错了还能穿回来
  await createBackup('pre-restore')

  closeDb()
  const dir = dataDir()
  const dbFile = join(dir, 'ikanbot.db')
  for (const junk of ['-wal', '-shm', '.lock']) {
    try {
      const p = `${dbFile}${junk}`
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    } catch {
      /* 残留文件删不掉，下面改名时会再报一次真错 */
    }
  }

  const stamp = `${Date.now()}`
  const dbTemp = `${dbFile}.restoring`
  const swaps: DirSwap[] = []
  try {
    writeFileSync(dbTemp, dbEntry.data)
    // 图片和存档先换，库最后换：两个附件目录铺坏了还能用旧库继续干活；
    // 反过来（库先换）中途失败就是「新库配旧图片」，业务数字和凭据来自两个时间点。
    swaps.push(replaceDir(imagesDir(), 'images', entries, stamp))
    swaps.push(replaceDir(docsDir(), 'docs', entries, stamp))
    renameSync(dbTemp, dbFile)
  } catch (e) {
    try {
      rmSync(dbTemp, { force: true })
    } catch {
      /* 临时文件删不掉不影响原库 */
    }
    // 附件目录已经换过就得先穿回去：旧库配着备份里的图和存档，也是两个时间点拼起来的账。
    // 以前这里把旧目录在 replaceDir 里就删了，换库一失败图片和存档就回不来。
    let intact = true
    for (const swap of [...swaps].reverse()) {
      try {
        undoReplace(swap)
      } catch {
        intact = false
      }
    }
    // closeDb 之后 getDb 会抛「尚未初始化」；重新挂上原库，
    // 让程序还能继续用，而不是把用户留在一个打不开任何页面的壳里。
    try {
      openDb()
    } catch {
      /* 原库也打不开就只能交给上层重启 */
    }
    throw new Error(
      intact
        ? `恢复中途失败：${(e as Error).message}。数据库、图片和单据存档都已经退回恢复前的样子，原来的数据还能继续用；请检查磁盘空间后重试。`
        : `恢复中途失败：${(e as Error).message}。原来的数据库还在，但有附件目录没能退回去，可能停在半旧半新的状态。请先到「数据备份」立即备份一份当前数据，再联系技术支持。`
    )
  }

  // 库、图片、存档三样都换成功了，旧附件目录才可以扔
  swaps.forEach(dropHolding)

  // 数据已经换干净了，但内存里的库句柄、设置缓存全是旧的——只能重开一次
  app.relaunch()
  app.exit(0)
  return { restarted: true }
}
