/** 测试用 electron 桩：把数据目录指向临时目录。 */
const os = require('os')
const fs = require('fs')
const path = require('path')

const root = process.env.IKAN_TEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'ikanbot-test-'))

module.exports = {
  app: {
    isPackaged: false,
    getAppPath: () => root,
    getPath: () => root
  },
  ipcMain: { handle() {}, on() {} },
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
