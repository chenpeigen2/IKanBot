/**
 * 量一张单据 HTML 里「表头」和「合计行」每个格子渲染出来的实际 x 坐标。
 * 用法：node_modules/.bin/electron scripts/measure-doc.cjs out/shots/pi.html
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.disableHardwareAcceleration()
const file = process.argv[process.argv.length - 1]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 1400, show: false })
  await win.loadFile(path.resolve(file))
  await new Promise((r) => setTimeout(r, 800))
  const res = await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector('table')
    const ths = [...table.querySelectorAll('thead th')]
    const rows = [...table.querySelectorAll('tbody.totals tr')]
    const totalRow = rows[rows.length - 1]
    const tds = [...totalRow.querySelectorAll('td')]
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) } }
    return JSON.stringify({
      header: ths.map((th) => ({ t: th.innerText.replace(/\\n/g, '/'), ...box(th) })),
      total: tds.map((td) => ({ t: td.innerText.trim(), ...box(td) })),
      tableRight: Math.round(table.getBoundingClientRect().right)
    }, null, 1)
  })()`)
  console.log(res)
  app.quit()
})
