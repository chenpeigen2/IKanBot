/**
 * 应用内自动更新。
 *
 * 流程：检查更新 → 下载 → 重启安装。
 * 事件通过 IPC 推给渲染进程（设置页里能看到进度）。
 *
 * 关于签名：本项目未做代码签名（自签名/商业证书都没有），
 * 所以必须关掉更新包的签名校验，否则 electron-updater 会报
 * "Cannot check for updates, signature is missing" 而永远查不到新版本。
 * 代价是更新包本身没有来源校验——因为它来自你自己的 GitHub Release。
 */
import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
// 壳只有一处：{ok,data}/{ok,error} 由 handle() 统一包，preload 的 call() 才解得开
import { handle } from '../ipc/handle'
import { createBackup } from './backup'

export interface UpdateInfo {
  /** 当前状态：idle / checking / available / not-available / downloading / downloaded / error */
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  /** 新版本号（如果有） */
  version?: string
  /** 新版本发布说明 */
  releaseNotes?: string
  /** 发布日期 */
  releaseDate?: string
  /** 下载进度 0~100 */
  percent?: number
  /** 已下载 / 总大小（字节） */
  transferred?: number
  total?: number
  /** 速度（字节/秒） */
  speed?: number
  /** 错误信息 */
  message?: string
  /** 应用当前版本 */
  currentVersion: string
}

/** 是否为打包后的环境（开发模式下自动更新不工作） */
export function isUpdaterAvailable(): boolean {
  return app.isPackaged
}

let mainWindow: BrowserWindow | null = null
let downloadedUpdate = false
/** 事件监听只挂一次：mac 关窗后重建窗口会再调 initUpdater，重复 on 会让状态推送越来越多次 */
let listenersWired = false

/**
 * 更新状态的唯一真源。
 * 以前每个 IPC 各自 return 一份快照，进度靠事件推——两边一打架，
 * 界面上就出现「下载完了按钮又灰回去」。现在只认这一份：事件写它，IPC 读它。
 */
let lastState: UpdateInfo = { status: 'idle', currentVersion: app.getVersion() }

function setState(patch: Partial<UpdateInfo>): UpdateInfo {
  lastState = { ...lastState, currentVersion: app.getVersion(), ...patch }
  return lastState
}

/** 更新日志写到数据目录，排查"检查更新没反应"用 */
function logUpdate(msg: string): void {
  try {
    const fs = require('fs')
    const path = require('path')
    const { dataDir } = require('../db')
    const f = path.join(dataDir(), 'updater.log')
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win

  // 开发模式下不检查（否则会一直报错），但界面要能提示
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  // 未签名应用：关掉更新包签名校验
  if (process.platform === 'win32') {
    ;(autoUpdater as unknown as { verifyUpdateCodeSignature: boolean }).verifyUpdateCodeSignature =
      false
  }

  autoUpdater.autoDownload = false
  // 不自动装：更新包下好后停在硬盘上，等人点「重启安装」。
  // 开着 autoInstallOnAppQuit 的话，用户某天随手关掉程序，回来发现版本换了、
  // 数据格式跟着迁了新一版，而出问题的那笔单子正是在这次改动之前录的——查无可查。
  autoUpdater.autoInstallOnAppQuit = false
  // 把更新日志写到文件，方便排查"检查更新没反应"这类问题
  autoUpdater.logger = {
    info: (m: string) => logUpdate(`[info] ${m}`),
    warn: (m: string) => logUpdate(`[warn] ${m}`),
    error: (m: string) => logUpdate(`[error] ${m}`),
    debug: (m: string) => logUpdate(`[debug] ${m}`)
  }

  const send = (payload: Partial<UpdateInfo>) => {
    const state = setState(payload)
    logUpdate(`[state] ${state.status} ${state.version ?? ''} ${state.message ?? ''}`)
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('updater:event', state)
  }

  if (listenersWired) return
  listenersWired = true

  autoUpdater.on('checking-for-update', () => {
    // 重新检查就把上一轮的结论清空，不然界面上还挂着上次的「发现新版本 vNNN」
    downloadedUpdate = false
    send({ status: 'checking', version: '', releaseNotes: '', percent: 0, transferred: 0, total: 0, message: '' })
  })

  autoUpdater.on('update-available', (info) => {
    send({
      status: 'available',
      version: String(info.version ?? ''),
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      releaseDate: info.releaseDate ?? ''
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    send({ status: 'not-available', version: String(info.version ?? '') })
  })

  autoUpdater.on('download-progress', (p) => {
    send({
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdate = true
    send({
      status: 'downloaded',
      version: String(info.version ?? ''),
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
    })
  })

  autoUpdater.on('error', (err) => {
    send({ status: 'error', message: friendlyError(err) })
  })
}

/** 把英文/技术性错误翻成人话 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/Cannot check for updates.*signature/i.test(raw)) {
    return '无法校验更新包签名。本程序未做代码签名，请到 GitHub Releases 手动下载新版本。'
  }
  if (/No published versions|404|Not Found/i.test(raw)) {
    return '没有找到已发布的版本（GitHub Releases 是空的）。'
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) {
    return '连不上 GitHub，请检查网络后重试。'
  }
  if (/proxy/i.test(raw)) {
    return '网络代理导致无法连接 GitHub。'
  }
  return raw
}

export function registerUpdaterIpc(): void {
  handle('updater:check', async (): Promise<UpdateInfo> => {
    const base: UpdateInfo = { status: 'idle', currentVersion: app.getVersion() }
    if (!isUpdaterAvailable()) {
      return {
        ...base,
        status: 'error',
        message: '开发模式下不能检查更新，请用打包后的程序测试。'
      }
    }
    // macOS 产物没有 Apple 开发者签名，Squirrel 无法安装更新；与其报一串英文错误，不如直接说清楚
    if (process.platform === 'darwin') {
      return {
        ...base,
        status: 'error',
        message: 'macOS 版暂未做代码签名，应用内自动更新用不了。请到 GitHub Releases 手动下载新的安装包。'
      }
    }
    try {
      // 结果由 update-available / update-not-available 事件写进 lastState，
      // 这里只负责等它跑完再把那一份交出去
      await autoUpdater.checkForUpdates()
      return lastState
    } catch (e) {
      return setState({ status: 'error', message: friendlyError(e) })
    }
  })

  handle('updater:download', async (): Promise<UpdateInfo> => {
    const base: UpdateInfo = { status: 'idle', currentVersion: app.getVersion() }
    if (!isUpdaterAvailable()) {
      return { ...base, status: 'error', message: '开发模式下不能下载更新。' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return lastState
    } catch (e) {
      return setState({ status: 'error', message: friendlyError(e) })
    }
  })

  handle('updater:install', async (): Promise<{ ok: boolean; message?: string }> => {
    if (!downloadedUpdate) {
      return { ok: false, message: '还没有下载好新版本，请先点下载。' }
    }
    // 装新版 = 换程序 + 可能顺带迁移数据结构，是不可逆的。
    // 先压一份能回得去的备份，压不出来就别装——装坏了连退路都没有。
    try {
      await createBackup('pre-update')
    } catch (e) {
      const msg = (e as Error).message
      logUpdate(`[install] 更新前备份失败，拒绝安装: ${msg}`)
      return {
        ok: false,
        message: `更新前的备份没成功，所以没有安装：${msg}。请先手动备份成功再更新。`
      }
    }
    // isSilent=false → 弹出安装界面；isForceRunAfter=true → 装完自动启动
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })

  handle('updater:version', (): string => app.getVersion())

  /** 界面挂载时先问一次：状态存在主进程这份 lastState 里，刷新页面也不会丢 */
  handle('updater:state', (): UpdateInfo => lastState)
}
