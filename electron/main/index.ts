import { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { openDb, closeDb } from '../db'
import { registerIpc } from '../ipc'
import { autoBackupOnStart } from '../services/backup'
import { TRAY_ICON_BASE64 } from '../resources/trayIcon'

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null

/**
 * 开发期截图模式：IKAN_SHOT=<route> 时启动后自动截图并退出。
 * 用于人工核对 UI 渲染效果。
 */
const shotRoute = process.env['IKAN_SHOT']

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

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_BASE64)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setToolTip('IKanBot')
  tray.setContextMenu(menu)
}

app.whenReady().then(() => {
  openDb()
  registerIpc()
  autoBackupOnStart()
  createWindow()
  if (!shotRoute) createTray()

  // 一键隐藏到托盘
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    mainWindow?.hide()
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
