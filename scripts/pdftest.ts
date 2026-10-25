/**
 * 验证 PDF 导出链路：把 PI HTML 交给 Electron 的 printToPDF，检查产物是有效 A4 PDF。
 * 同时验证多页单据：页边距与页码靠 printToPDF 的 margins/footer 承担，
 * 明细一多不能少页，也不能多印白页。
 * 运行： node scripts/build-pdftest.cjs && npx electron out/test/pdftest.cjs
 */
import { app } from 'electron'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { openDb, closeDb } from '../electron/db'
import { getSettings } from '../electron/services/settings'
import * as orders from '../electron/services/orders'
import { htmlToPdf } from '../electron/ipc'
import { renderPi } from '../src/shared/documents'

function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

// 测试模式要连续打两份 PDF：打印窗口销毁后不能让 Electron 按「窗口全关」退出
app.on('window-all-closed', () => {
  /* 由脚本自己 app.quit() */
})

async function main() {
  await app.whenReady()
  openDb()
  const order = orders.listOrders({})[0]
  if (!order) throw new Error('没有订单，先跑 seed')
  const settings = getSettings()

  const outDir = join(process.cwd(), 'out', 'shots')

  // 单页：几何必须还是原来的一张 A4，不能因为边距设置多印一张白页
  const shortHtml = renderPi({ order, settings, images: {} })
  const short = await htmlToPdf(shortHtml, order.piNo)
  writeFileSync(join(outDir, 'pi.pdf'), short)
  const shortPages = pageCount(short)

  // 多页：把明细复制到至少 40 行，应当自然分成 2 页以上，且不能爆炸成一片白纸
  const baseItems = order.items.length > 0 ? order.items : []
  if (baseItems.length === 0) throw new Error('这张订单没有明细，无法验证多页分页')
  const longItems = Array.from({ length: 8 }, () => baseItems)
    .flat()
    .map((it, i) => ({ ...it, id: it.id * 1000 + i }))
  const longOrder = { ...order, items: longItems }
  const longHtml = renderPi({ order: longOrder, settings, images: {} })
  const long = await htmlToPdf(longHtml, order.piNo)
  writeFileSync(join(outDir, 'pi-multipage.pdf'), long)
  const longPages = pageCount(long)

  const header = short.subarray(0, 5).toString()
  const failures: string[] = []
  if (header !== '%PDF-') failures.push(`短单头部不是 PDF：${header}`)
  if (!short.includes('MediaBox')) failures.push('短单没有 A4 尺寸标记')
  if (shortPages !== 1) failures.push(`短单应该是 1 页，实际 ${shortPages} 页（多出来的是空白页）`)
  if (longPages < 2) failures.push(`长单（${longItems.length} 行）应该分页，实际只有 ${longPages} 页`)
  if (longPages > 6) failures.push(`长单页数异常（${longPages} 页），检查是否每行都被单独挤成一页`)

  console.log(`单页 PDF: ${shortPages} 页，${(short.length / 1024).toFixed(1)} KB`)
  console.log(`多页 PDF: ${longPages} 页（${longItems.length} 行明细），${(long.length / 1024).toFixed(1)} KB`)
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`)
    closeDb()
    app.quit()
    process.exit(1)
  }
  console.log('  ✓ 分页与页数检查通过')
  closeDb()
  app.quit()
}

main().catch((e) => {
  console.error(e)
  app.quit()
  process.exit(1)
})
