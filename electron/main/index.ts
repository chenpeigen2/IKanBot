import { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { openDb, closeDb } from '../db'
import { registerIpc } from '../ipc'
import { initUpdater } from '../services/updater'
import { autoBackupOnStart } from '../services/backup'
import { TRAY_ICON_BASE64 } from '../resources/trayIcon'

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null

/**
 * 开发期截图模式：IKAN_SHOT=<route> 时启动后自动截图并退出。
 * 用于人工核对 UI 渲染效果。
 */
const shotRoute = process.env['IKAN_SHOT']

/**
 * 同一份数据只许一个进程打开。
 * 双击图标两下、或者恢复备份后自动重启那一瞬间撞上老进程，就会起来两个窗口，
 * 各自开着同一个 sqlite 文件：一个在写、一个在读，轻则报错，重则把库写坏。
 * 第二个进程直接退出，并把已经开着的那个叫到前台。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      showMainWindow()
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'IKanBot 外贸单据系统',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // mac 上关窗不退出：引用要跟着窗口一起清掉，否则点托盘会拿到已销毁的实例
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 自动更新：需要窗口实例才能推进度
  initUpdater(mainWindow)

  if (shotRoute) {
    // 看门狗：截图模式无论如何必须在 90 秒内退出，不能把调用方挂死
    const watchdog = setTimeout(() => {
      console.warn('[shot] 看门狗触发，强制退出')
      app.exit(0)
    }, 90000)
    watchdog.unref?.()

    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`)
    })
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await mainWindow!.webContents.executeJavaScript(`window.location.hash = '#${shotRoute}'`)
        await new Promise((r) => setTimeout(r, 2000))
        // 自检（N-6）：截图前 hash 必须还是目标路由；万万一被启动时序吃掉，重设一次再截
        const hashNow = await mainWindow!.webContents.executeJavaScript(`location.hash`)
        if (hashNow !== `#${shotRoute}`) {
          console.warn(`[shot] hash 被改成 ${hashNow}，重设为 #${shotRoute}`)
          await mainWindow!.webContents.executeJavaScript(`window.location.hash = '#${shotRoute}'`)
          await new Promise((r) => setTimeout(r, 1500))
        }
        // 可选：截图前先执行一段脚本（如点击按钮打开弹窗）
        const extraJs = process.env['IKAN_SHOT_JS']
        if (extraJs) {
          await mainWindow!.webContents.executeJavaScript(extraJs)
          await new Promise((r) => setTimeout(r, 2000))
        }
      } catch (e) {
        console.warn(`[shot] 脚本执行失败: ${(e as Error).message}`)
      }
      const probe = await mainWindow!.webContents.executeJavaScript(`(() => {
        const m = document.querySelector('.main')
        return JSON.stringify({
          mainExists: !!m,
          mainChildren: m ? m.children.length : -1,
          mainHtml: m ? m.innerHTML.slice(0, 400) : '',
          rootChildren: document.getElementById('root')?.children.length,
          hash: location.hash
        })
      })()`)
      console.log('PROBE', probe)
      const img = await mainWindow!.webContents.capturePage()
      const dir = join(app.getAppPath(), 'out', 'shots')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `${process.env['IKAN_SHOT_NAME'] ?? 'shot'}.png`)
      writeFileSync(out, img.toPNG())
      console.log('saved', out)
      app.quit()
    })
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // cmd+W 关掉窗口后（darwin 不退出），托盘/快捷键要能把窗口重新建出来
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  // 托盘图标 = 应用图标的托盘版（深蓝底 + 粗 I + 缝衣针），与应用图标同一视觉语言。
  //
  // 提供 16/32/48 三档：DPI 100% 用 16，高分屏（150%/200%）自动用 32/48，
  // 高分辨率下托盘图标更大更清楚，不会像 256 缩下来那样糊成一团。
  const resDir = process.resourcesPath
  const devDir = join(app.getAppPath(), '..', 'electron', 'resources')
  const load = (name: string): Buffer | null => {
    for (const dir of [resDir, devDir]) {
      const p = join(dir, name)
      try {
        if (existsSync(p)) return readFileSync(p)
      } catch {
        /* 试下一个 */
      }
    }
    return null
  }

  const buf16 = load('tray-16.png')
  let icon = buf16 ? nativeImage.createFromBuffer(buf16) : nativeImage.createEmpty()
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(TRAY_ICON_BASE64)

  const buf32 = load('tray-32.png')
  if (buf32) icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: buf32 })
  const buf48 = load('tray-48.png')
  if (buf48) icon.addRepresentation({ scaleFactor: 3, width: 48, height: 48, buffer: buf48 })

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setToolTip('IKanBot')
  tray.setContextMenu(menu)

  // 左键单击托盘图标 → 显示窗口（不是右键菜单才显示）
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.focus()
    } else {
      showMainWindow()
    }
  })
}

app.whenReady().then(() => {
  try {
    openDb()
  } catch (e) {
    // 打不开库就弹人话窗口：给一堆栈只会让人截图来问，数据到底还在不在看不出来
    const msg = (e as Error).message
    console.error('[db] 打开失败', e)
    dialog.showErrorBox('打不开数据', msg)
    app.exit(1)
    return
  }
  registerIpc()
  autoBackupOnStart()
  createWindow()
  if (!shotRoute) createTray()

  // 一键隐藏到托盘
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    mainWindow?.hide()
  })
  // 一键从托盘恢复（和隐藏配对，免得藏起来只能点托盘）
  globalShortcut.register('CommandOrControl+Shift+J', () => {
    showMainWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  closeDb()
})
