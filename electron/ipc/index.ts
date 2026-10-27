import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, basename, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { imagesDir, docsDir, dataDir, backupsDir } from '../db'
import * as products from '../services/products'
import * as customers from '../services/customers'
import * as orders from '../services/orders'
import * as quotations from '../services/quotations'
import * as samples from '../services/samples'
import * as packing from '../services/packing'
import * as dashboard from '../services/dashboard'
import * as money from '../services/money'
import * as credits from '../services/credits'
import * as settingsSvc from '../services/settings'
import * as docsSvc from '../services/docs'
import { createBackup, inspectBackup, listBackups, pickBackup, restoreBackup } from '../services/backup'
import { EXPORT_FILE_NAME } from '../../src/shared/types'
import type { ExportKind, OrderExportFilter } from '../../src/shared/types'
import { localDate } from '../../src/shared/date'
import { registerUpdaterIpc } from '../services/updater'
import { handle } from './handle'
import { copyFileSync } from 'fs'
import { randomUUID } from 'crypto'

/**
 * HTML → PDF。
 *
 * 以前整段 HTML（含商品图 data URL）塞进 loadURL 的 data: URL，
 * Chromium 的 URL 长度上限约 2MB，一张手机原图就能让存档/打印直接失败。
 * 改为先落临时 .html 再 loadFile，大小不受 URL 限制。
 * 无论成功失败都销毁窗口、删临时文件，避免打印进程越积越多。
 */
function escapeFooter(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export async function htmlToPdf(html: string, docLabel = ''): Promise<Buffer> {
  const file = join(tmpdir(), `ikanbot-print-${randomUUID()}.html`)
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, javascript: true, images: true }
  })
  const label = escapeFooter(docLabel)
  try {
    writeFileSync(file, String(html ?? ''), 'utf8')
    // 用标准 file URL 加载：Windows 用户名带空格/短路径时 loadFile 会拼出带反斜杠的 URL 而失败
    await printWin.loadURL(pathToFileURL(file).href)
    return await printWin.webContents.printToPDF({
      printBackground: true,
      // 多页单据每一页都要有页边距：边距由打印区域给，footer 才放得下单号与页码
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;padding:0 12mm;font-size:8px;color:#555;display:flex;justify-content:space-between;font-family:'Segoe UI','Microsoft YaHei',sans-serif">
        <span>${label}</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
      // 12mm / 14mm（英寸）：与单据原来的内边距一致，第一页几何不变
      margins: { top: 0.4724, bottom: 0.5512, left: 0.4724, right: 0.4724 },
      pageSize: 'A4',
      preferCSSPageSize: true
    })
  } finally {
    if (!printWin.isDestroyed()) printWin.destroy()
    try {
      unlinkSync(file)
    } catch {
      /* 临时文件删不掉不影响出单 */
    }
  }
}

/** 用户给的文件名只取最后一段，杜绝 ../../ 写出数据目录 */
function safePdfName(name: unknown): string {
  const base = basename(String(name ?? '').trim())
  if (!base || base === '.' || base === '..') return 'document.pdf'
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

export function registerIpc(): void {
  /* ---- 自动更新 ---- */
  registerUpdaterIpc()

  /* ---- 打开外部链接 ---- */
  handle('shell:openExternal', (url: string) => {
    if (!/^https?:\/\//.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  /* ---- 数据目录完整路径（给设置页展示） ---- */
  handle('app:dataDir', () => dataDir())
  handle('app:imagesDir', () => imagesDir())
  handle('app:backupsDir', () => join(dataDir(), 'backups'))
  /**
   * 一次把四个路径给出去。
   * 在进程里用 join 拼好，渲染页只负责显示——以前界面里手写 `${dataDir}\\ikanbot.db`，
   * 换个操作系统就是「C:\data\/backups」这种四不像，出问题时照着抄路径会抄到别处去。
   */
  handle('app:paths', () => ({
    data: dataDir(),
    db: join(dataDir(), 'ikanbot.db'),
    images: imagesDir(),
    docs: docsDir(),
    backups: backupsDir()
  }))

  /* ---- 商品 ---- */
  handle('products:list', (keyword?: string, includeInactive?: boolean) =>
    products.listProducts(keyword, includeInactive)
  )
  handle('products:get', (id: number) => products.getProduct(id))
  handle('products:save', (input: products.ProductInput) => products.saveProduct(input))
  handle('products:delete', (id: number) => products.deleteProduct(id))
  handle('products:copy', (id: number, newStyleNo: string) => products.copyProduct(id, newStyleNo))
  handle('products:images', (productId: number) => products.listProductImages(productId))
  handle('products:addImage', (productId: number, fileName: string, isPrimary?: boolean) =>
    products.addProductImage(productId, fileName, isPrimary)
  )
  handle('products:delImage', (id: number) => products.deleteProductImage(id))
  handle('products:setPrimary', (productId: number, imageId: number) =>
    products.setPrimaryImage(productId, imageId)
  )
  handle('products:setActive', (id: number, active: 0 | 1) => products.setProductActive(id, active))
  handle('products:referenceCount', (id: number) => products.productReferenceCount(id))
  handle('products:csvTemplate', () => products.CSV_TEMPLATE_HEADER)
  handle('products:importCsv', (text: string, mode?: 'skip' | 'overwrite') =>
    products.importProductsCsv(text, mode ?? 'skip')
  )

  /* ---- 客户 ---- */
  handle('customers:list', (keyword?: string, includeInactive?: boolean) =>
    customers.listCustomers(keyword, includeInactive)
  )
  handle('customers:get', (id: number) => customers.getCustomer(id))
  handle('customers:save', (input: customers.CustomerInput) => customers.saveCustomer(input))
  handle('customers:delete', (id: number) => customers.deleteCustomer(id))
  handle('customers:setActive', (id: number, active: 0 | 1) => customers.setCustomerActive(id, active))
  handle('customers:sameName', (company: string, selfId?: number) => customers.sameNameCustomers(company, selfId))
  handle('customers:stats', (id: number) => customers.customerStats(id))
  handle('customers:orders', (id: number) => customers.customerOrderBriefs(id))
  handle('customers:stylePriceHistory', (filter?: { customerId?: number; styleNo?: string }) =>
    customers.stylePriceHistory(filter ?? {})
  )

  /* ---- 订单 ---- */
  /**
   * 列表走瘦身版：整页固定几条查询，不再每张单展开 9 次。
   * 返回 OrderListPage { rows, total, owedBaseTotal, grandBaseTotal }：
   * total 是筛选后的总单数（分页要用它，不能拿本页行数充数），两个合计按整个筛选集算。
   * 需要整单展开的地方用 orders:get（详情页），别在列表上 hydrate。
   */
  handle('orders:list', (filter: orders.OrderListFilter & { limit?: number; offset?: number }) =>
    orders.listOrderRows(filter)
  )
  handle('orders:get', (id: number) => orders.getOrder(id))
  handle('orders:create', (input: orders.OrderInput) => orders.createOrder(input))
  handle('orders:update', (id: number, input: orders.OrderInput) => orders.updateOrder(id, input))
  handle('orders:setParties', (id: number, patch: Parameters<typeof orders.setOrderParties>[1]) =>
    orders.setOrderParties(id, patch)
  )
  handle('orders:updateCharges', (id: number, charges: any[], reason?: string) =>
    orders.updateOrderCharges(id, charges ?? [], reason ?? '')
  )
  handle('orders:delete', (id: number) => orders.deleteOrder(id))
  /** 作废订单（客户取消 / 建错单）：记录全留，不进货值/待收/毛利 */
  handle('orders:void', (id: number, reason?: string, opts?: { confirmDocs?: boolean }) =>
    orders.voidOrder(id, reason ?? '', { confirmDocs: opts?.confirmDocs === true })
  )
  handle('orders:addItem', (orderId: number, item: orders.OrderItemInput) =>
    orders.addOrderItem(orderId, item)
  )
  handle('orders:updateItem', (orderId: number, itemId: number, patch: Partial<orders.OrderItemInput>) =>
    orders.updateOrderItem(orderId, itemId, patch)
  )
  handle('orders:addItems', (orderId: number, items: orders.OrderItemInput[]) =>
    orders.addOrderItems(orderId, items)
  )
  handle('orders:removeItem', (orderId: number, itemId: number) => orders.removeOrderItem(orderId, itemId))
  handle('orders:replaceItems', (orderId: number, items: orders.OrderItemInput[]) =>
    orders.replaceOrderItems(orderId, items)
  )
  handle('orders:summarizeSkus', (orderId: number) => orders.summarizeSkus(orderId))
  handle('orders:addPayment', (orderId: number, p: any) => orders.addPayment(orderId, p))
  handle('orders:batchAddPayments', (entries: orders.BatchPaymentEntry[]) => orders.batchAddPayments(entries))
  handle('orders:deletePayment', (orderId: number, paymentId: number, reason?: string) =>
    orders.deletePayment(orderId, paymentId, reason ?? '')
  )
  handle('orders:listSettlements', (orderId: number) => orders.listSettlements(orderId))
  handle('orders:addSettlement', (orderId: number, input: orders.SettlementInput) =>
    orders.addSettlement(orderId, input)
  )
  handle('orders:reverseSettlement', (orderId: number, settlementId: number, reason?: string) =>
    orders.reverseSettlement(orderId, settlementId, reason ?? '')
  )
  handle('orders:setShipStatus', (orderId: number, status: any, note?: string) =>
    orders.setShipStatus(orderId, status, note)
  )
  handle('orders:setPaymentStatus', (orderId: number, status: any, note?: string) =>
    orders.setPaymentStatus(orderId, status, note)
  )
  handle('orders:events', (orderId: number) => orders.listEvents(orderId))
  handle('orders:ports', () => orders.listPorts())
  handle('orders:lastTerms', (customerId: number) => orders.lastOrderTerms(customerId))
  handle('orders:lastExchangeRate', () => orders.lastExchangeRate())
  handle('orders:lastExchangeRateInfo', (currency?: string) => orders.lastExchangeRateInfo(currency))
  handle('orders:photos', (orderId: number) => orders.listOrderPhotos(orderId))
  handle('orders:addPhoto', (orderId: number, fileName: string, kind?: string, note?: string) =>
    orders.addOrderPhoto(orderId, fileName, (kind as 'inspection' | 'container' | 'other') ?? 'inspection', note)
  )
  handle('orders:delPhoto', (orderId: number, photoId: number) => orders.deleteOrderPhoto(orderId, photoId))

  /* ---- 报价单 ---- */
  handle('quotations:list', (filter?: any) => quotations.listQuotations(filter ?? {}))
  handle('quotations:get', (id: number) => quotations.getQuotation(id))
  handle('quotations:save', (input: any) => quotations.saveQuotation(input))
  handle('quotations:delete', (id: number) => quotations.deleteQuotation(id))
  handle('quotations:updateMeta', (id: number, meta: any) => quotations.updateQuotationMeta(id, meta))
  handle('quotations:events', (id: number) => quotations.listQuotationEvents(id))
  handle('quotations:convert', (id: number, opts?: any) => quotations.convertToOrder(id, opts ?? {}))
  handle('quotations:versions', (id: number) => quotations.listQuotationVersions(id))

  /* ---- 打样单（样品单）---- */
  handle('samples:list', (filter?: any) => samples.listSamples(filter ?? {}))
  handle('samples:get', (id: number) => samples.getSample(id))
  handle('samples:save', (input: any) => samples.saveSample(input))
  handle('samples:delete', (id: number) => samples.deleteSample(id))
  handle('samples:convert', (id: number, opts?: any) => samples.convertSampleToOrder(id, opts ?? {}))
  handle('samples:listPayments', (id: number) => samples.listSamplePayments(id))
  handle('samples:addPayment', (id: number, p: any) => samples.addSamplePayment(id, p ?? {}))
  handle('samples:deletePayment', (id: number, paymentId: number, reason: string) =>
    samples.deleteSamplePayment(id, paymentId, reason)
  )

  /* ---- 装箱单 ---- */
  handle('pl:list', (orderId: number) => packing.listPackingLists(orderId))
  handle('pl:create', (input: packing.PackingListInput) => packing.createPackingList(input))
  handle('pl:delete', (orderId: number, plId: number) => packing.deletePackingList(orderId, plId))
  handle('pl:updateInfo', (orderId: number, plId: number, patch: any) =>
    packing.updatePackingListInfo(orderId, plId, patch)
  )
  handle('pl:updateLine', (orderId: number, plId: number, lineId: number, patch: any) =>
    packing.updatePackingListLine(orderId, plId, lineId, patch)
  )
  handle('pl:addLine', (orderId: number, plId: number, line: any) =>
    packing.addPackingListLine(orderId, plId, line)
  )
  handle('pl:deleteLine', (orderId: number, plId: number, lineId: number) =>
    packing.deletePackingListLine(orderId, plId, lineId)
  )
  handle('pl:void', (orderId: number, plId: number, reason?: string) =>
    packing.voidPackingList(orderId, plId, reason ?? '')
  )
  handle('pl:unvoid', (orderId: number, plId: number, reason?: string) =>
    packing.unvoidPackingList(orderId, plId, reason ?? '')
  )
  // 本批金额：唯一实现在 money.ts，纸面箱单/存档/批次列表都从这一个数取
  handle('pl:amounts', (orderId: number) => money.packingAmounts(orderId))

  /* ---- 首页与报表 ---- */
  handle('dashboard:stats', () => dashboard.dashboard())
  handle('dashboard:reminders', () => dashboard.reminders())
  handle('report:monthly', () => dashboard.monthlyReport())
  handle('report:receivables', () => money.receivableByCustomer())
  handle('report:customerOrderRows', (customerId: number) => money.customerOpenRows(customerId))

  /* ---- 客户预收（R27）：余额派生，抵扣另记台账 ---- */
  handle('credits:balance', (customerId: number) => money.customerCreditBalance(customerId))
  handle('credits:apply', (input: credits.ApplyCreditInput) => credits.applyCredit(input))
  handle('credits:reverse', (applicationId: number, reason: string) =>
    credits.reverseCredit(applicationId, reason)
  )
  handle('credits:refund', (input: credits.RefundCreditInput) => credits.refundCredit(input))
  handle('credits:reverseRefund', (refundId: number, reason: string) => credits.reverseRefund(refundId, reason))

  /* ---- 设置 ---- */
  handle('settings:get', () => settingsSvc.getSettings())
  handle('settings:save', (s: any) => settingsSvc.saveSettings(s))
  handle('settings:baseLocked', () => settingsSvc.baseCurrencyLocked())

  /* ---- 图片 ---- */
  handle('images:pick', async (): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: '选择商品图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
    })
    if (res.canceled) return []
    const out: string[] = []
    for (const src of res.filePaths) {
      const ext = src.split('.').pop()?.toLowerCase() ?? 'jpg'
      const name = `${randomUUID()}.${ext}`
      copyFileSync(src, join(imagesDir(), name))
      out.push(name)
    }
    return out
  })
  handle('images:importLogo', async (): Promise<string> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: '选择公司 Logo',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'svg'] }]
    })
    if (res.canceled) return ''
    const src = res.filePaths[0]
    const ext = src.split('.').pop()?.toLowerCase() ?? 'png'
    const name = `logo-${randomUUID()}.${ext}`
    copyFileSync(src, join(imagesDir(), name))
    return name
  })
  /**
   * 图片只能取数据图片目录里的直接文件。
   * fileName 是渲染进程传上来的，原来直接 join——传 '../../xxx' 就能读到系统任意文件。
   * 这里砍掉路径成分（只认文件名）并再确认结果确实落在图片目录内。
   */
  const safeImage = (fileName: string): string | null => {
    if (!fileName) return null
    const name = basename(String(fileName))
    if (!name || name === '.' || name === '..') return null
    const dir = resolve(imagesDir())
    const p = resolve(dir, name)
    if (!p.startsWith(dir + sep)) return null
    return existsSync(p) ? p : null
  }
  handle('images:url', (fileName: string) => {
    const p = safeImage(fileName)
    if (!p) return ''
    return pathToFileURL(p).href
  })
  handle('images:discard', (names: unknown): void => {
    // 批量上传中途失败：当次已拷进图片目录、但没登记进库的文件必须清掉，
    // 否则备份会把孤儿一张不落地打包，磁盘占用永久放大
    for (const n of Array.isArray(names) ? names : []) {
      if (typeof n !== 'string') continue
      const p = safeImage(n)
      if (!p) continue
      try {
        unlinkSync(p)
      } catch {
        /* 删不掉不挡主流程 */
      }
    }
  })
  ipcMain.on('images:baseDir', (e) => {
    e.returnValue = imagesDir()
  })
  handle('images:readDataUrl', (fileName: string): string => {
    const p = safeImage(fileName)
    if (!p) return ''
    const ext = p.split('.').pop()?.toLowerCase() ?? 'jpg'
    // SVG 也得按自己的 MIME 进来：一律当 jpeg 会让纸面 logo 直接空白
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'svg'
              ? 'image/svg+xml'
              : 'image/jpeg'
    const buf = readFileSync(p)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  /* ---- 备份 / 导出 ---- */
  handle('backup:create', async () => {
    const file = await createBackup('manual')
    return file
  })
  handle('backup:list', () => listBackups())
  handle('backup:pick', () => pickBackup())
  handle('backup:inspect', (path: string) => inspectBackup(path))
  handle('backup:restore', async (path: string) => restoreBackup(path))
  handle('backup:reveal', async () => {
    // 直接打开备份目录（不弹选择框），让用户看到备份文件
    const dir = join(dataDir(), 'backups')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })
  handle('export:csv', async (kind: ExportKind, filter?: OrderExportFilter) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    // 先算再弹框：对账单没有内容时要在用户挑路径之前就拦住，别让人选完文件才看到报错
    const csv = dashboard.exportCsv(kind, filter)
    // 文件名带上导出当天：两张台账撞在一起时，得能看出哪份是哪一次刷的数；
    // 对账单还要带客户名，同一天导两家不能同名
    const name =
      kind === 'statement' && filter?.customerId
        ? dashboard.statementFileName(filter.customerId)
        : EXPORT_FILE_NAME[kind].replace(/\.csv$/, `_${localDate()}.csv`)
    const res = await dialog.showSaveDialog(win, {
      title: '导出 Excel(CSV)',
      defaultPath: name,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return ''
    writeFileSync(res.filePath, csv, 'utf8')
    return res.filePath
  })

  /* ---- 单据存档 ---- */
  handle('docs:save', async (payload: {
    html: string
    fileName: string
    docNo: string
    kind: 'pi' | 'pl' | 'ci' | 'quotation'
    orderId?: number | null
    quotationId?: number | null
    amount?: number
    /** 纸面上印的版次；与系统实际下一版不一致时拒绝，避免纸面与存档错位 */
    expectedVersion?: number
    /** 整单/批次 CI 重叠时，用户已在弹窗里看着重叠金额勾过确认 */
    confirmOverlap?: boolean
  }) => {
    if (payload.kind === 'ci' && payload.orderId != null) {
      docsSvc.assertCiNoOverlap(Number(payload.orderId), payload.docNo, payload.confirmOverlap === true)
    }
    // 漏传金额不能按 0 存：存档金额是这张纸的凭据——批次 CI 记的是本批金额，PI/报价记的是整单金额，
    // 钉成 0 以后对账只剩一张 0 元的纸（预览没带金额就存，只能重开预览）
    const archiveAmount = payload.amount
    if (archiveAmount == null) {
      throw new Error(
        `这张 ${String(payload.kind).toUpperCase()} 没带金额，不能存档：存档金额是事后对账的依据，不能按 0 记。请关掉预览重新打开再存。`
      )
    }
    const pdf = await htmlToPdf(payload.html, payload.docNo)
    const saved = docsSvc.saveDocFile({
      pdf,
      docNo: payload.docNo,
      kind: payload.kind,
      orderId: payload.orderId ?? null,
      quotationId: payload.quotationId ?? null,
      amount: archiveAmount,
      expectedVersion: payload.expectedVersion,
      confirmOverlap: payload.confirmOverlap === true
    })
    return { path: saved.absolutePath, filePath: saved.filePath, version: saved.version }
  })
  handle('docs:list', (orderId: number) => docsSvc.listDocVersions(orderId))
  handle('docs:listQuotation', (quotationId: number) => docsSvc.listQuotationDocVersions(quotationId))
  handle('docs:void', (versionId: number, reason?: string) => docsSvc.voidDocVersion(versionId, reason ?? ''))
  handle('docs:nextVersion', (docNo: string, kind: string) => docsSvc.nextVersion(docNo, kind))
  handle('docs:reveal', async (filePath?: string) => {
    // N34：点「打开目录」要打开**这一版文件**所在的文件夹，而不是整个 docs 根目录
    if (filePath) {
      const abs = docsSvc.resolveDocPath(filePath)
      if (!existsSync(abs)) throw new Error('文件已不存在（可能被手工删了）')
      shell.showItemInFolder(abs)
      return abs
    }
    const dir = docsDir()
    await shell.openPath(dir)
    return dir
  })
  handle('docs:openFile', async (filePath: string) => {
    // N34：每一版直接能打开看
    if (!filePath) throw new Error('没有文件')
    const abs = docsSvc.resolveDocPath(filePath)
    if (!existsSync(abs)) throw new Error('文件已不存在（可能被手工删了）')
    const err = await shell.openPath(abs)
    if (err) throw new Error(`打开失败：${err}`)
    return abs
  })

  /* ---- 窗口 ---- */
  handle('window:hide', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win?.hide()
    return true
  })
  handle('window:printPdf', async (payload: { html: string; fileName: string; silent?: boolean; docNo?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    const fileName = safePdfName(payload.fileName)
    // 页脚印这一份纸的单号：散页后也能认出它属于哪张单
    const pdf = await htmlToPdf(payload.html, payload.docNo || basename(fileName, '.pdf'))
    if (payload.silent) {
      const dir = join(dataDir(), 'exports')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const out = join(dir, fileName)
      writeFileSync(out, pdf)
      return out
    }
    const res = await dialog.showSaveDialog(win, {
      title: '保存 PDF',
      defaultPath: fileName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return ''
    writeFileSync(res.filePath, pdf)
    return res.filePath
  })
  handle('window:print', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win?.webContents.print({ silent: false, printBackground: true })
    return true
  })
}
