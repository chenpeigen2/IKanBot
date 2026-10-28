/** 测试用 electron 桩：把数据目录指向临时目录。 */
const os = require('os')
const fs = require('fs')
const path = require('path')

const root = process.env.IKAN_TEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'ikanbot-test-'))

/**
 * 记下注册的 handler：双模式测试要像渲染进程那样真调一次 IPC，
 * 验的是「转发器按模式分流」这条线，而不是绕过它直接调 service。
 */
const handlers = new Map()

module.exports = {
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getAppPath: () => root,
    getPath: () => root
  },
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    on() {}
  },
  __handlers: handlers,
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  globalShortcut: { register() {} },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => true }),
    createEmpty: () => ({})
  }
}
