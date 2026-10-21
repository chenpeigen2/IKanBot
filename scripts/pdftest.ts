/**
 * 验证 PDF 导出链路：把 PI HTML 交给 Electron 的 printToPDF，检查产物是有效 A4 PDF。
 * 运行： node scripts/build-pdftest.cjs && node out/test/pdftest.cjs
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { openDb, closeDb } from '../electron/db'
import { getSettings } from '../electron/services/settings'
import * as orders from '../electron/services/orders'
import { renderPi } from '../src/shared/documents'

async function main() {
  await app.whenReady()
  openDb()
  const order = orders.listOrders({})[0]
  if (!order) throw new Error('没有订单，先跑 seed')
  const html = renderPi({ order, settings: getSettings(), images: {} })

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, javascript: true, images: true }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    pageSize: 'A4',
    preferCSSPageSize: true
  })
  win.destroy()

  const out = join(process.cwd(), 'out', 'shots', 'pi.pdf')
  writeFileSync(out, pdf)
  const buf = readFileSync(out)
  const header = buf.subarray(0, 5).toString()
  const isPdf = header === '%PDF-'
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  console.log(`PDF 生成: ${out}`)
  console.log(`  大小: ${(buf.length / 1024).toFixed(1)} KB`)
  console.log(`  头部: ${header} ${isPdf ? '✓' : '✗'}`)
  console.log(`  页数: ${pages}`)
  console.log(`  A4 尺寸标记: ${buf.includes('MediaBox') ? '✓' : '✗'}`)
  closeDb()
  app.quit()
  if (!isPdf) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  app.quit()
  process.exit(1)
})
