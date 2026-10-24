import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { imagesDir, docsDir, dataDir } from '../db'
import * as products from '../services/products'
import * as customers from '../services/customers'
import * as orders from '../services/orders'
import * as quotations from '../services/quotations'
import * as samples from '../services/samples'
import * as packing from '../services/packing'
import * as dashboard from '../services/dashboard'
import * as settingsSvc from '../services/settings'
import * as docsSvc from '../services/docs'
import { createBackup } from '../services/backup'
import { registerUpdaterIpc } from '../services/updater'
import { copyFileSync } from 'fs'
import { randomUUID } from 'crypto'

/** 包装 handler，统一错误传递 */
function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
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

  /* ---- 客户 ---- */
  handle('customers:list', (keyword?: string) => customers.listCustomers(keyword))
  handle('customers:get', (id: number) => customers.getCustomer(id))
  handle('customers:save', (input: customers.CustomerInput) => customers.saveCustomer(input))
  handle('customers:delete', (id: number) => customers.deleteCustomer(id))
  handle('customers:stats', (id: number) => customers.customerStats(id))
  handle('customers:orders', (id: number) => customers.customerOrderBriefs(id))

  /* ---- 订单 ---- */
  handle('orders:list', (filter: Parameters<typeof orders.listOrders>[0]) => orders.listOrders(filter))
  handle('orders:get', (id: number) => orders.getOrder(id))
  handle('orders:create', (input: orders.OrderInput) => orders.createOrder(input))
  handle('orders:update', (id: number, input: orders.OrderInput) => orders.updateOrder(id, input))
  handle('orders:updateCharges', (id: number, charges: any[]) =>
    orders.updateOrderCharges(id, charges ?? [])
  )
  handle('orders:delete', (id: number) => orders.deleteOrder(id))
  /** 作废订单（客户取消 / 建错单）：记录全留，不进货值/待收/毛利 */
  handle('orders:void', (id: number, reason?: string) => orders.voidOrder(id, reason ?? ''))
  handle('orders:addItem', (orderId: number, item: orders.OrderItemInput) =>
    orders.addOrderItem(orderId, item)
  )
  handle('orders:updateItem', (orderId: number, itemId: number, patch: Partial<orders.OrderItemInput>) =>
    orders.updateOrderItem(orderId, itemId, patch)
  )
  handle('orders:removeItem', (orderId: number, itemId: number) => orders.removeOrderItem(orderId, itemId))
  handle('orders:replaceItems', (orderId: number, items: orders.OrderItemInput[]) =>
    orders.replaceOrderItems(orderId, items)
  )
  handle('orders:summarizeSkus', (orderId: number) => orders.summarizeSkus(orderId))
  handle('orders:addPayment', (orderId: number, p: any) => orders.addPayment(orderId, p))
  handle('orders:deletePayment', (orderId: number, paymentId: number, reason?: string) =>
    orders.deletePayment(orderId, paymentId, reason ?? '')
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
  handle('orders:lastExchangeRateInfo', () => orders.lastExchangeRateInfo())
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

  /* ---- 打样单（样品单）---- */
  handle('samples:list', (filter?: any) => samples.listSamples(filter ?? {}))
  handle('samples:get', (id: number) => samples.getSample(id))
  handle('samples:save', (input: any) => samples.saveSample(input))
  handle('samples:delete', (id: number) => samples.deleteSample(id))
  handle('samples:convert', (id: number, opts?: any) => samples.convertSampleToOrder(id, opts ?? {}))

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

  /* ---- 首页与报表 ---- */
  handle('dashboard:stats', () => dashboard.dashboard())
  handle('dashboard:reminders', () => dashboard.reminders())
  handle('report:monthly', () => dashboard.monthlyReport())

  /* ---- 设置 ---- */
  handle('settings:get', () => settingsSvc.getSettings())
  handle('settings:save', (s: any) => settingsSvc.saveSettings(s))

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
  handle('images:url', (fileName: string) => {
    if (!fileName) return ''
    const p = join(imagesDir(), fileName)
    if (!existsSync(p)) return ''
    return `file:///${p.replace(/\\/g, '/')}`
  })
  ipcMain.on('images:baseDir', (e) => {
    e.returnValue = imagesDir()
  })
  handle('images:readDataUrl', (fileName: string): string => {
    if (!fileName) return ''
    const p = join(imagesDir(), fileName)
    if (!existsSync(p)) return ''
    const ext = p.split('.').pop()?.toLowerCase() ?? 'jpg'
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    const buf = readFileSync(p)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  /* ---- 备份 / 导出 ---- */
  handle('backup:create', async () => {
    const file = await createBackup('manual')
    return file
  })
  handle('backup:reveal', async () => {
    // 直接打开备份目录（不弹选择框），让用户看到备份文件
    const dir = join(dataDir(), 'backups')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })
  handle('export:csv', async (kind: 'orders' | 'payments' | 'items') => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const names: Record<string, string> = {
      orders: '订单台账.csv',
      payments: '收款台账.csv',
      items: '款号明细台账.csv'
    }
    const res = await dialog.showSaveDialog(win, {
      title: '导出 Excel(CSV)',
      defaultPath: names[kind] ?? '导出.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return ''
    writeFileSync(res.filePath, dashboard.exportCsv(kind), 'utf8')
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
  }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: false, javascript: true, images: true }
    })
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(payload.html))
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: 'A4',
      preferCSSPageSize: true
    })
    printWin.destroy()
    const dir = join(docsDir(), payload.docNo)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const version = docsSvc.nextVersion(payload.docNo, payload.kind)
    const fileName = `${payload.docNo}_v${version}.pdf`
    const filePath = join(dir, fileName)
    writeFileSync(filePath, pdf)
    docsSvc.recordDocVersion({
      orderId: payload.orderId ?? null,
      quotationId: payload.quotationId ?? null,
      docNo: payload.docNo,
      kind: payload.kind,
      version,
      amount: payload.amount ?? 0,
      filePath
    })
    void win
    return { path: filePath, version }
  })
  handle('docs:list', (orderId: number) => docsSvc.listDocVersions(orderId))
  handle('docs:listQuotation', (quotationId: number) => docsSvc.listQuotationDocVersions(quotationId))
  handle('docs:nextVersion', (docNo: string, kind: string) => docsSvc.nextVersion(docNo, kind))
  handle('docs:reveal', async (filePath?: string) => {
    // N34：点「打开目录」要打开**这一版文件**所在的文件夹，而不是整个 docs 根目录
    if (filePath) {
      if (!existsSync(filePath)) throw new Error('文件已不存在（可能被手工删了）')
      shell.showItemInFolder(filePath)
      return filePath
    }
    const dir = docsDir()
    await shell.openPath(dir)
    return dir
  })
  handle('docs:openFile', async (filePath: string) => {
    // N34：每一版直接能打开看
    if (!filePath) throw new Error('没有文件')
    if (!existsSync(filePath)) throw new Error('文件已不存在（可能被手工删了）')
    const err = await shell.openPath(filePath)
    if (err) throw new Error(`打开失败：${err}`)
    return filePath
  })

  /* ---- 窗口 ---- */
  handle('window:hide', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win?.hide()
    return true
  })
  handle('window:printPdf', async (payload: { html: string; fileName: string; silent?: boolean }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: false, javascript: true, images: true }
    })
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(payload.html))
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: 'A4',
      preferCSSPageSize: true
    })
    printWin.destroy()
    if (payload.silent) {
      const out = join(imagesDir(), '..', payload.fileName)
      writeFileSync(out, pdf)
      return out
    }
    const res = await dialog.showSaveDialog(win, {
      title: '保存 PDF',
      defaultPath: payload.fileName,
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
