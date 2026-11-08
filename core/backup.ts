import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync, rmSync, mkdirSync } from 'fs'
import { join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { createZip, collectDir, readZip, verifyZip, ZIP_MAX_BYTES, type ZipBudget, type ZipEntry } from './zip'
import { bizError } from '../src/shared/errors'
import { localDate } from '../src/shared/date'
import { LATEST_DB_VERSION } from '../electron/db/schema'

/**
 * 备份（R61 起桌面与服务器共用这一份判据）：
 * 把 db + images + 单据存档（docs 下的 PDF）打包成一个 zip。
 * 只备 db 不备 docs，恢复后存档表还在、原单却一版都打不开，退税和收款纠纷时等于没凭据。
 *
 * 写盘走「先写 .part，验货通过再改名」：
 * 直接在最终文件名上写，中途断电 / 磁盘满 / 进程被杀会留下一个名字看着正常、
 * 内容却是半截的 zip。人只认文件名，第二天出事了才发现备份是空的。
 *
 * 数据库快照、探包开库、换库前后开关连接、恢复成功后的收尾、记账（lastBackupAt/Error）
 * 都由 hooks 注入：桌面接本机 SQLite 与 relaunch，服务器接自己的连接与目录；
 * 判据（排队、按天去重、降级留痕、恢复回滚、路径守卫）只此一份。
 */

export interface BackupDirs {
  dataDir(): string
  backupsDir(): string
  imagesDir(): string
  docsDir(): string
  /** 库文件绝对路径（桌面固定 dataDir/ikanbot.db，服务器由环境变量定，不赶同名） */
  dbFile(): string
}

export interface BackupHooks {
  /**
   * 数据库快照：优先事务一致（VACUUM INTO / mysqldump --single-transaction），
   * 降级为直拷时把原因带回（会被写进 lastBackupError 留痕）。
   */
  snapshotDb(dbFile: string): { data: Buffer; fallback?: string }
  /** 开一个临时库验包（quick_check / user_version / 核心表在不在） */
  openProbe(file: string): { get(sql: string, params?: unknown[]): unknown; close(): void }
  /** 换库前关掉现有连接；失败时重新接回原库 */
  closeDb(): void | Promise<void>
  openDb(): void | Promise<void>
  /** 备份成功记账（settings.lastBackupAt） */
  markOk(iso: string): Promise<void>
  /** 备份失败/降级记账（settings.lastBackupError） */
  markFail(message: string): Promise<void>
  /** 恢复成功换完库后的收尾：桌面 relaunch+exit，服务器重开连接 */
  afterRestore(): void | Promise<void>
  /** 桌面：这个路径是不是刚在原生选择框里亲手点过的（备份目录外的 zip 的唯一放行理由） */
  isApprovedPath(path: string): boolean
  /**
   * 恢复成功后要不要把「恢复在途」的旗子继续举着。
   * 桌面：举着——进程马上 relaunch 重启，死之前的每一笔写都得拦（e2e 的闸门断言也认它）。
   * 服务器：不举——连接已重开，恢复完接着服务，闸门立即放开。
   */
  keepRestoringAfterRestore?: boolean
  /** 服务器上有没有图/单据目录之外还该打进包的目录——现在没有，留接口不硬做 */
  extraEntries?(): ZipEntry[]
  /**
   * 打包时现算一份搬迁对账进包（R70，可选）：包里带「导出那一刻」的 12 表行数与口径指纹，
   * 恢复完成后现算一份逐项对——两份全零差才说明包和恢复两头都好。没有实现（旧测试桩）就
   * 不进包，行为与 R70 之前一致。
   */
  migrationReport?(): Promise<import('./migration').MigrationReport | null>
}

export function backupCore(dirs: BackupDirs, hooks: BackupHooks) {
  /**
   * 备份排队跑，一次只压一份包。
   * 为什么要排队：文件名只精确到秒，同一秒里来两次（每小时的自动备份撞上人手点「立即备份」，
   * 或恢复前的那份 pre-restore 撞上别的）就会算出同一个 target；
   * 而临时文件名是固定的 `.part`——一边刚 renameSync 把包挪走，另一边还在往同名路径写，
   * 轻则两份挤成一份、重则改名撞已存在的文件报错，把已经写好的备份记成「备份失败」。
   * 分不开锁反而简单：打包本身几百毫秒，让人多等一秒不构成问题。
   */
  let backupChain: Promise<unknown> = Promise.resolve()

  function createBackup(note = ''): Promise<string> {
    const task = backupChain.then(
      () => writeBackup(note),
      () => writeBackup(note)
    )
    // 队列尾巴把失败咽掉，否则一次备份炸了，以后每次备份都排在一条 rejected promise 上
    backupChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  /**
   * 名字撞上已有的包就往后加 -2、-3。
   * 排队（backupChain）解决的是「两个调用交错」，解决不了「同秒算出同一个名字」：
   * 一次成功备份几百毫秒，人手点「立即备份」紧着自动备份落在同一秒是完全可能的，
   * 而 renameSync 在 Windows 上会直接把上一份顶掉——恢复点静默少一份，
   * 出事那天翻备份列表还以为历史都在。宁可文件名丑一点。
   */
  function uniqueBackupName(dir: string, name: string): string {
    if (!existsSync(join(dir, name))) return name
    const stem = name.replace(/\.zip$/, '')
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}.zip`
      if (!existsSync(join(dir, candidate))) return candidate
    }
  }

  /** 本次打包里没能读进来的文件（正被删、被占用、没权限） */
  let skippedFiles: string[] = []
  /** 本次备份里快照是否降级过（writeBackup 收尾时读它去留痕） */
  let snapshotFallbackReason = ''

  /**
   * 清恢复/检查留下的孤儿目录（R46 挂账 #4）：恢复流程的正常路径会自己收走
   * 探针目录（.restore-check-* / .inspect-*）、恢复前的 holding（*.pre-restore-*）
   * 和换库临时文件（*.restoring），但崩溃/断电会漏——服务端上没人看就一年攒一年。
   * 在备份开头顺手扫：恢复在途绝不插手（restoring 为真直接返回）；超过 24 小时
   * 的才算孤儿——真在跑的恢复不会花一天，新探针/新 holding 不会被误伤。
   */
  function pruneOrphanRestores(): void {
    if (restoring) return
    const root = dirs.dataDir()
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of names) {
      const isOrphan =
        /^\.restore-check-/.test(name) || /^\.inspect-/.test(name) || /\.pre-restore-/.test(name) || /\.restoring$/.test(name)
      if (!isOrphan) continue
      const p = join(root, name)
      try {
        if (statSync(p).mtimeMs >= cutoff) continue // 刚出现的，可能真在跑
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* 一个删不动不影响别的，下次备份再试 */
      }
    }
  }

  async function writeBackup(note: string): Promise<string> {
    // 上一轮的降级原因不许带进这一轮：一次 VACUUM 失败之后，
    // 每次成功备份都会被追一句陈旧的「快照降级」，还把下一次的真错盖掉
    snapshotFallbackReason = ''
    skippedFiles = []
    // 顺手清上一次恢复漏下的孤儿目录（恢复在途时它自己会闭嘴）
    pruneOrphanRestores()
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    // 备份目录不存在就现建（服务器侧目录从没被打开过时是空的）：
    // 不能因为目录还没人创建过就把第一次备份记成失败
    if (!existsSync(dirs.backupsDir())) mkdirSync(dirs.backupsDir(), { recursive: true })
    const name = uniqueBackupName(dirs.backupsDir(), `ikanbot-${stamp}${note ? `-${note}` : ''}.zip`)
    const target = join(dirs.backupsDir(), name)
    // 临时名带 uuid：万一有别的进程（或上一轮没清干净的调用）也在写同一秒的包，
    // 两边不会互相把对方的半截文件当自己的临时文件改名走
    const temp = `${target}.${process.pid}-${randomUUID()}.part`

    try {
      const entries = collectBackupEntries()
      // 搬迁对账进包（R70）：打包的是「此刻的库」，对账也算「此刻的库」——
      // 两次查询之间有间隙，切库窗口本来就停写（第七节），接受
      if (hooks.migrationReport) {
        try {
          const mr = await hooks.migrationReport()
          if (mr) entries.push({ name: 'migration-report.json', data: Buffer.from(JSON.stringify(mr, null, 2)) })
        } catch (e) {
          // 对账算不出来不能把备份也拖死：包照打，只是这一份没有对账可比
          console.warn('[backup] 搬迁对账没算出来，本包不含对账：', (e as Error).message)
        }
      }
      const buf = createZip(entries)
      writeFileSync(temp, buf)
      // 从盘上重新读回来验：光看内存里那份不算数，写坏的是盘上那几个字节
      const onDisk = readFileSync(temp)
      verifyZip(onDisk, entries)
      renameSync(temp, target)
    } catch (e) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        /* 临时文件删不掉不影响报错 */
      }
      const msg = (e as Error).message
      // 记原因这一步自己坏了不能把原始失败顶掉（closeDb 之后 markBackupFail 会再抛一句
      // 「数据库尚未初始化」，用户看到的那句话就跟备份为什么坏了没关系）
      try {
        await hooks.markFail(msg)
      } catch (markErr) {
        console.warn('[backup] 备份失败原因没记进设置：', markErr)
      }
      // 原始错误原样往外抛，不能 new Error(msg) 重包：一重包 .code/.path 就丢了，
      // 服务器那头的错误映射认不出这是 EACCES，用户看到的又变成「服务器内部错误」
      // 五个字（r61-verify 账：备份目录 chmod 000 那次就是这么漏的）。
      throw e
    }

    // 包已经落盘了：下面全是善后与留痕，任何一步坏了都不许把成功的备份说成失败
    pruneBackups(30)
    const degrade = snapshotFallbackReason
    const missing = [...skippedFiles]
    try {
      if (degrade || missing.length) {
        // 快照降级过的备份能用于恢复，但不是事务一致快照：留一句在 lastBackupError 里，
        // 工作台会挂起提示，别让人以为这份和平时的是同一种口径。
        // 没能打进包的文件同理：包是好的，只是不全——「备份成功」这四个字不能白给。
        const parts: string[] = []
        if (missing.length) {
          parts.push(
            `有 ${missing.length} 个文件没能打进这一份：${missing.slice(0, 5).join('；')}` +
              (missing.length > 5 ? `；另有 ${missing.length - 5} 个` : '')
          )
        }
        if (degrade) parts.push(`数据库快照降级为直接拷贝（${degrade}）`)
        await hooks.markFail(
          `备份已生成，但${parts.join('；')}。这份备份不全，恢复时上面那些东西回不来，请查明原因后再备一次。`
        )
      } else {
        await hooks.markOk(new Date().toISOString())
      }
    } catch (markErr) {
      console.warn('[backup] 备份结果没记进设置：', markErr)
    }
    return target
  }

  function collectBackupEntries(): ZipEntry[] {
    const entries: ZipEntry[] = []
    const dbFile = dirs.dbFile()
    const snap = existsSync(dbFile) ? hooks.snapshotDb(dbFile) : null
    if (snap) {
      if (snap.fallback) snapshotFallbackReason = snap.fallback
      entries.push({ name: 'ikanbot.db', data: snap.data })
    }
    // 图片/单据存档先按盘上的体积合计：越线就不读，别等全读进内存才发现包超了 4GB
    const budget: ZipBudget = { used: snap?.data.length ?? 0, limit: ZIP_MAX_BYTES }
    entries.push(...collectDir(dirs.imagesDir(), 'images', skippedFiles, budget))
    entries.push(...collectDir(dirs.docsDir(), 'docs', skippedFiles, budget))
    if (hooks.extraEntries) entries.push(...hooks.extraEntries())
    return entries
  }

  /** 列目录不许把备份本身拖下水：网盘/杀软一口咬住 backups 目录时 readdir 会抛 EPERM/ENOENT */
  function safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  /** 保留最近 N 份备份 */
  function pruneBackups(keep = 30): void {
    const dir = dirs.backupsDir()
    // readdir 和 stat 之间文件可能被网盘/杀软挪走：prune 只是善后，
    // 任何异常都不能让已经成功的备份被记成失败（createBackup 会进 catch 去 markBackupFail）
    const files = safeReaddir(dir)
      .filter((f) => f.startsWith('ikanbot-') && f.endsWith('.zip'))
      .map((f) => {
        try {
          return { f, t: statSync(join(dir, f)).mtimeMs }
        } catch {
          return { f, t: 0 }
        }
      })
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(keep)) {
      try {
        unlinkSync(join(dir, old.f))
      } catch {
        /* 忽略删除失败 */
      }
    }
    // 半截的 .part 顺手清掉：断电/被杀时留下的，名字里带 .zip 不算数、
    // 界面看不见，却实实在在占着磁盘（一份包 = 全部图片+存档的大小）
    const halfWritten = safeReaddir(dir).filter((f) => f.endsWith('.part'))
    for (const f of halfWritten) {
      try {
        const p = join(dir, f)
        if (Date.now() - statSync(p).mtimeMs > 60 * 60 * 1000) unlinkSync(p)
      } catch {
        /* 同上，善后不报错 */
      }
    }
  }

  /**
   * 自动备份一次（同一天已有则跳过）。桌面启动时跑一次、常驻时每小时喊一次；
   * 服务器侧同理（onModuleInit + 每小时定时器）——「每天一备」的承诺按自然日兑现，
   * 不按进程生命周期。
   * 以前每次启动都打包：崩溃重启几次就把 30 份历史挤成同一天，
   * 真出事要退回上周时一份都没有。设置页和这里的注释都写「每天一次」，得兑现。
   */
  function autoBackupOnStart(): void {
    // 恢复在途时不插队：这会儿打包出来的是「旧库 + 已经铺好的新图片」那种半截组合，
    // 名字却像个正常备份，等着哪天被人选来恢复。恢复自己的反悔药由 restoreBackup 压。
    if (restoring) {
      console.log('[backup] 正在恢复备份，这一次自动备份跳过')
      return
    }
    const dir = dirs.backupsDir()
    const today = localDate()
    // -2 / -3 后缀是同秒撞名时加的，同样算「今天已经备过」
    const doneToday = safeReaddir(dir).some((f) => {
      if (!/^ikanbot-\d{14}-auto(-\d+)?\.zip$/.test(f)) return false
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

  /* ---------------- 恢复备份 ---------------- */

  /** 备份包里允许出现的顶层目录；其余一律拒绝，免得有人拿别的 zip 来点这个按钮 */
  // migration-report.json（R70）：打包时现算的搬迁对账——恢复侧只读它做逐项对，不落盘不参与换库
  const RESTORE_ALLOWED = ['ikanbot.db', `images${sep}`, `docs${sep}`, 'images/', 'docs/', 'migration-report.json']

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
      throw bizError(`备份里的路径「${rel}」指向了数据目录外面，这份包不能用`)
    }
    return target
  }

  /**
   * 探针开库后的三道闸（自检 / 版本 / 见 inspectRestoredDb 与 inspectBackup——两条路
   * 必须同一道闸：R67 实锤 inspect 原先没做版本检查，搬上来的「未来包」能过摘要、
   * 拖到恢复才被拦；话术逐字共享，别让两条路各说各话）。
   */
  function assertDbProbeUsable(database: { get(sql: string, params?: unknown[]): unknown }): void {
    const check = database.get('PRAGMA quick_check') as { quick_check?: string } | null
    if (String(check?.quick_check ?? '') !== 'ok') {
      throw bizError('备份里的数据库自检没通过，这份包不能用')
    }
    const v = Number((database.get('PRAGMA user_version') as { user_version?: number })?.user_version ?? 0)
    if (v > LATEST_DB_VERSION) {
      throw bizError(
        `这份备份来自更新的程序版本（数据格式 v${v}，当前只认到 v${LATEST_DB_VERSION}）。` +
          `请先把程序升级到该版本或更高，再恢复。`
      )
    }
  }

  /** 用一个临时文件把备份里的库打开看一眼，确认没坏、版本没超前 */
  function inspectRestoredDb(dbData: Buffer, stamp: string): void {
    const probeDir = join(dirs.dataDir(), `.restore-check-${stamp}`)
    const probeFile = join(probeDir, 'check.db')
    mkdirSync(probeDir, { recursive: true })
    let database: ReturnType<typeof hooks.openProbe> | null = null
    try {
      writeFileSync(probeFile, dbData)
      database = hooks.openProbe(probeFile)
      assertDbProbeUsable(database)
      const orders = database.get('SELECT COUNT(*) AS n FROM orders') as { n: number } | null
      const payments = database.get('SELECT COUNT(*) AS n FROM payments') as { n: number } | null
      if (!orders || !payments) throw bizError('备份里的数据库缺少核心数据表，这份包不能用')
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

  /** 从 `ikanbot-YYYYMMDDHHMMSS-auto.zip` 里抠出时间；抠不到返回 null（别人手放进来的文件） */
  function stampFromName(name: string): string | null {
    const m = /^ikanbot-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    if (!m) return null
    const [, y, mo, d, h, mi, s] = m
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
    return Number.isNaN(Date.parse(iso)) ? null : iso
  }

  /** 打开一个备份包看看里面是什么（不落任何盘），恢复确认框用 */
  /**
   * 收一份外来的整库包（搬迁：老桌面的整库传上来，R61 挂的「上传本机 zip 去恢复」口子）。
   * 字节落进备份目录（uniqueBackupName 防撞名），然后走与「列表里选一份」**完全同一条**
   * inspect 闸门（zip 结构、quick_check、版本守卫）——能进备份列表的包才配被恢复；
   * 验不过的包当场删掉，列表里不留垃圾。
   */
  function importBackupZip(bytes: Buffer, note = 'imported'): BackupPreview {
    if (!bytes || bytes.length === 0) throw bizError('收到的备份包是空的，上传可能没成功，请在本机重新导出。')
    if (bytes.length > ZIP_MAX_BYTES) throw bizError('这份包超过了备份大小上限，先在本机核对包是否完整。')
    if (!(bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      throw bizError('这不是一份 IKanBot 备份包（zip），请从老桌面重新导出整库。')
    }
    if (!existsSync(dirs.backupsDir())) mkdirSync(dirs.backupsDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const name = uniqueBackupName(dirs.backupsDir(), `ikanbot-${stamp}-${note || 'imported'}.zip`)
    const target = join(dirs.backupsDir(), name)
    writeFileSync(target, bytes)
    try {
      return inspectBackup(target)
    } catch (e) {
      try {
        rmSync(target, { force: true })
      } catch {
        /* 删不掉就留着（列表可见、可手删），别把真错误顶掉 */
      }
      throw e
    }
  }

  function inspectBackup(rawPath: string): BackupPreview {
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
    if (!dbEntry) throw bizError('这个备份包里没有数据库文件，不能用来恢复')
    const stamp = `${Date.now()}`
    const probeDir = join(dirs.dataDir(), `.inspect-${stamp}`)
    const probeFile = join(probeDir, 'check.db')
    mkdirSync(probeDir, { recursive: true })
    let database: ReturnType<typeof hooks.openProbe> | null = null
    try {
      writeFileSync(probeFile, dbEntry.data)
      database = hooks.openProbe(probeFile)
      // 与恢复路同一道闸（R67）：自检 + 版本守卫。搬上来的「未来包」要在摘要这一步
      // 就被人话拦下（「请先把程序升级到该版本或更高」），不能拖到恢复才炸
      assertDbProbeUsable(database)
      probe.orderCount = Number((database.get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n)
      probe.paymentCount = Number((database.get('SELECT COUNT(*) AS n FROM payments') as { n: number }).n)
    } catch (e) {
      throw bizError(`这个备份包打不开来看：${(e as Error).message}`)
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

  /** 只接受备份目录里的 .zip（桌面另有「原生选择框亲手点过」的放行，由 hooks 判） */
  function requireBackupPath(rawPath: string): string {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw bizError('请先选择一个备份文件')
    const dir = resolve(dirs.backupsDir())
    const target = resolve(rawPath)
    if (!target.toLowerCase().endsWith('.zip')) throw bizError('只能选 .zip 的备份文件')
    const insideBackups = target === dir || target.startsWith(dir + sep)
    if (!insideBackups && !hooks.isApprovedPath(target)) {
      throw bizError('只能从备份目录里选文件，或用「选择备份文件」按钮重新挑一个')
    }
    if (!existsSync(target)) throw bizError('这个备份文件已经不在了')
    return target
  }

  /** 备份目录里的备份包列表（新→旧），设置页用来点选 */
  function listBackups(): Array<{ path: string; name: string; takenAt: string | null; size: number }> {
    const dir = dirs.backupsDir()
    if (!existsSync(dir)) return []
    return safeReaddir(dir)
      .filter((f) => f.startsWith('ikanbot-') && f.endsWith('.zip'))
      .map((f) => ({
        path: join(dir, f),
        name: f,
        takenAt: stampFromName(f),
        // 文件可能恰好在 readdir 后被删（网盘/杀软）：少一个文件比设置页整个打不开强
        size: existsSync(join(dir, f)) ? statSync(join(dir, f)).size : 0
      }))
      .sort((a, b) => b.path.localeCompare(a.path))
  }

  /**
   * 恢复备份：把当前 db / 图片 / 单据存档整体换成备份里的内容。
   *
   * 顺序是有意的：先给「现在的样子」压一份 pre-restore 备份，再动手。
   * 恢复本身是破坏性操作（选错包 = 覆盖掉这几天的活），留一份能反悔的东西比省一次磁盘写入重要得多。
   */
  async function restoreBackup(rawPath: string): Promise<{ restarted: boolean }> {
    // 立旗之前先看旗是不是已经举着。恢复期间放行的恰好是 backup: 这一族（失败了还得让人
    // 重新挑一个包），于是第二个窗口能原样再进来一次：两次 runRestore 并发 closeDb、
    // 并发换目录，落在盘上的就是「A 包的库 + B 包的照片」，连 pre-restore 那份反悔药
    // 都可能被同名顶掉。恢复是唯一一个「做了两次比做一次更糟」的操作。
    if (restoring) throw bizError('已经在恢复备份了，请等它跑完（成功后程序会自动重启）。')
    // 立旗：从这里起，除了备份页自己的通道，别的读写一律先停一停（多用户时别人也在录单，
    // 服务端会把业务请求挡回去说「恢复期间请全员停手」）。
    // 关键是下面那句 await createBackup('pre-restore')——它是整段里让出执行权的地方，
    // 在途的一条 docs:save / orders 写请求正好能插进来提交：
    // 那份号称「恢复前的样子」的包就没包含它，而恢复完它又被新库盖掉，两头都不认账。
    restoring = true
    try {
      const r = await runRestore(rawPath)
      // 服务器侧连接已重开，旗子当场放下；桌面进程马上退出，旗子举到死（见 hooks 注释）
      if (hooks.keepRestoringAfterRestore !== true) restoring = false
      return r
    } catch (e) {
      // 能走到这里说明库还没换（包校验没过 / 反悔药没压成 / 附件目录已退回原样），
      // 原来的数据还是完整的，就把写通道放开——否则一次点错备份文件，
      // 这个进程到重启之前都再也没法记任何账。
      restoring = false
      throw e
    }
  }

  /**
   * 恢复正在进行（或已经换完库、等着重启）。
   * ipc 包装层读它来决定要不要挡住新的调用：这段时间写进去的记录，重启后就不存在了。
   */
  let restoring = false

  function isRestoring(): boolean {
    return restoring
  }

  async function runRestore(rawPath: string): Promise<{ restarted: boolean }> {
    const path = requireBackupPath(rawPath)
    const entries = readZip(readFileSync(path))
    for (const e of entries) {
      if (!isAllowedEntry(e.name)) {
        throw bizError(`备份包里有个不认识的文件「${e.name}」，为了安全这份包不能用`)
      }
    }
    const dbEntry = entries.find((e) => e.name === 'ikanbot.db')
    if (!dbEntry) throw new Error('这个备份包里没有数据库文件，不能用来恢复')

    inspectRestoredDb(dbEntry.data, `${Date.now()}`)

    // 反悔药：把当前数据整体存一份，恢复错了还能穿回来
    await createBackup('pre-restore')

    await hooks.closeDb()
    const dbFile = dirs.dbFile()
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
      swaps.push(replaceDir(dirs.imagesDir(), 'images', entries, stamp))
      swaps.push(replaceDir(dirs.docsDir(), 'docs', entries, stamp))
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
        await hooks.openDb()
      } catch {
        /* 原库也打不开就只能交给上层重启 */
      }
      throw bizError(
        intact
          ? `恢复中途失败：${(e as Error).message}。数据库、图片和单据存档都已经退回恢复前的样子，原来的数据还能继续用；请检查磁盘空间后重试。`
          : `恢复中途失败：${(e as Error).message}。原来的数据库还在，但有附件目录没能退回去，可能停在半旧半新的状态。请先到「数据备份」立即备份一份当前数据，再联系技术支持。`
      )
    }

    // 库、图片、存档三样都换成功了，旧附件目录才可以扔
    swaps.forEach(dropHolding)

    // 数据已经换干净了：桌面 relaunch 重启程序，服务器重开连接接着服务
    await hooks.afterRestore()
    return { restarted: true }
  }

  return {
    createBackup,
    uniqueBackupName,
    pruneBackups,
    collectBackupEntries,
    autoBackupOnStart,
    listBackups,
    inspectBackup,
    importBackupZip,
    restoreBackup,
    isRestoring
  }
}

export type BackupCore = ReturnType<typeof backupCore>

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
