const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
app.disableHardwareAcceleration()
const file = process.argv[process.argv.length - 2]
const out = process.argv[process.argv.length - 1]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1300, show: false })
  await win.loadFile(path.resolve(file))
  await new Promise((r) => setTimeout(r, 1200))
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(path.resolve(out), img.toPNG())
  console.log('saved', path.resolve(out))
  app.quit()
})
