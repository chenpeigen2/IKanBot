import { contextBridge, ipcRenderer } from 'electron'
import type { IKanApi } from '../../src/shared/api'
import type { CustomerReceivable, ExportKind, MonthlyReportRow, PackingAmount } from '../../src/shared/types'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const api: IKanApi = {
  products: {
    list: (keyword?: string, includeInactive?: boolean) =>
      call<any[]>('products:list', keyword, includeInactive),
    get: (id: number) => call<any>('products:get', id),
    save: (input: any) => call<any>('products:save', input),
    remove: (id: number) => call<any>('products:delete', id),
    copy: (id: number, newStyleNo: string) => call<any>('products:copy', id, newStyleNo),
    images: (productId: number) => call<any[]>('products:images', productId),
    addImage: (productId: number, fileName: string, isPrimary?: boolean) =>
      call<any>('products:addImage', productId, fileName, isPrimary),
    delImage: (id: number) => call<void>('products:delImage', id),
    setPrimary: (productId: number, imageId: number) => call<void>('products:setPrimary', productId, imageId),
    setActive: (id: number, active: 0 | 1) => call<any>('products:setActive', id, active),
    referenceCount: (id: number) => call<any>('products:referenceCount', id),
    csvTemplate: () => call<string>('products:csvTemplate'),
    importCsv: (text: string, mode?: 'skip' | 'overwrite') => call<any>('products:importCsv', text, mode)
  },
  customers: {
    list: (keyword?: string, includeInactive?: boolean) =>
      call<any[]>('customers:list', keyword, includeInactive),
    get: (id: number) => call<any>('customers:get', id),
    save: (input: any) => call<any>('customers:save', input),
    remove: (id: number) => call<void>('customers:delete', id),
    setActive: (id: number, active: 0 | 1) => call<any>('customers:setActive', id, active),
    sameName: (company: string, selfId?: number) => call<any[]>('customers:sameName', company, selfId),
    stats: (id: number) => call<any>('customers:stats', id),
    orders: (id: number) => call<any[]>('customers:orders', id),
    stylePriceHistory: (filter?: { customerId?: number; styleNo?: string }) =>
      call<any[]>('customers:stylePriceHistory', filter)
  },
  orders: {
    list: (filter: any) => call<any[]>('orders:list', filter),
    get: (id: number) => call<any>('orders:get', id),
    create: (input: any) => call<any>('orders:create', input),
    update: (id: number, input: any) => call<any>('orders:update', id, input),
    setParties: (id: number, patch: { billTo?: any; shipTo?: any }) => call<any>('orders:setParties', id, patch),
    updateCharges: (id: number, charges: any[]) => call<any>('orders:updateCharges', id, charges),
    remove: (id: number) => call<void>('orders:delete', id),
    /** 作废订单（客户取消 / 建错单）：记录全留，不进货值/待收/毛利 */
    void: (id: number, reason?: string) => call<any>('orders:void', id, reason),
    addItem: (orderId: number, item: any) => call<any>('orders:addItem', orderId, item),
    updateItem: (orderId: number, itemId: number, patch: any) =>
      call<any>('orders:updateItem', orderId, itemId, patch),
    removeItem: (orderId: number, itemId: number) => call<any>('orders:removeItem', orderId, itemId),
    replaceItems: (orderId: number, items: any[]) => call<any>('orders:replaceItems', orderId, items),
    summarizeSkus: (orderId: number) => call<any[]>('orders:summarizeSkus', orderId),
    addPayment: (orderId: number, p: any) => call<any>('orders:addPayment', orderId, p),
    deletePayment: (orderId: number, paymentId: number, reason: string) =>
      call<any>('orders:deletePayment', orderId, paymentId, reason),
    listSettlements: (orderId: number) => call<any[]>('orders:listSettlements', orderId),
    addSettlement: (orderId: number, input: any) => call<any>('orders:addSettlement', orderId, input),
    reverseSettlement: (orderId: number, settlementId: number, reason: string) =>
      call<any>('orders:reverseSettlement', orderId, settlementId, reason),
    setShipStatus: (orderId: number, status: string, note?: string) =>
      call<any>('orders:setShipStatus', orderId, status, note),
    setPaymentStatus: (orderId: number, status: string, note?: string) =>
      call<any>('orders:setPaymentStatus', orderId, status, note),
    events: (orderId: number) => call<any[]>('orders:events', orderId),
    ports: () => call<{ loading: string[]; destination: string[] }>('orders:ports'),
    lastTerms: (customerId: number) => call<any>('orders:lastTerms', customerId),
    lastExchangeRate: () => call<number | null>('orders:lastExchangeRate'),
    lastExchangeRateInfo: () => call<{ rate: number; date: string } | null>('orders:lastExchangeRateInfo'),
    photos: (orderId: number) => call<any[]>('orders:photos', orderId),
    addPhoto: (orderId: number, fileName: string, kind?: string, note?: string) =>
      call<any>('orders:addPhoto', orderId, fileName, kind, note),
    delPhoto: (orderId: number, photoId: number) => call<void>('orders:delPhoto', orderId, photoId)
  },
  quotations: {
    list: (filter?: any) => call<any[]>('quotations:list', filter),
    get: (id: number) => call<any>('quotations:get', id),
    save: (input: any) => call<any>('quotations:save', input),
    remove: (id: number) => call<void>('quotations:delete', id),
    updateMeta: (id: number, meta: any) => call<any>('quotations:updateMeta', id, meta),
    events: (id: number) => call<any[]>('quotations:events', id),
    convert: (id: number, opts?: { paymentStatus?: 'draft' | 'sent'; revision?: number; override?: any }) =>
      call<any>('quotations:convert', id, opts),
    versions: (id: number) => call<any[]>('quotations:versions', id)
  },
  samples: {
    list: (filter?: any) => call<any[]>('samples:list', filter),
    get: (id: number) => call<any>('samples:get', id),
    save: (input: any) => call<any>('samples:save', input),
    remove: (id: number) => call<void>('samples:delete', id),
    convert: (id: number, opts?: any) => call<any>('samples:convert', id, opts)
  },
  docs: {
    save: (payload: {
      html: string
      fileName: string
      docNo: string
      kind: 'pi' | 'pl' | 'ci' | 'quotation'
      orderId?: number | null
      quotationId?: number | null
      amount?: number
      expectedVersion?: number
    }) => call<{ path: string; filePath: string; version: number }>('docs:save', payload),
    list: (orderId: number) => call<any[]>('docs:list', orderId),
    listQuotation: (quotationId: number) => call<any[]>('docs:listQuotation', quotationId),
    nextVersion: (docNo: string, kind: string) => call<number>('docs:nextVersion', docNo, kind),
    reveal: (filePath?: string) => call<string>('docs:reveal', filePath),
    openFile: (filePath: string) => call<string>('docs:openFile', filePath)
  },
  /** 用系统浏览器打开外链 */
  shell: {
    openExternal: (url: string) => call<boolean>('shell:openExternal', url)
  },
  /** 数据目录完整路径 */
  app: {
    dataDir: () => call<string>('app:dataDir'),
    imagesDir: () => call<string>('app:imagesDir'),
    backupsDir: () => call<string>('app:backupsDir')
  },
  pl: {
    list: (orderId: number) => call<any[]>('pl:list', orderId),
    create: (input: any) => call<any[]>('pl:create', input),
    remove: (orderId: number, plId: number) => call<any[]>('pl:delete', orderId, plId),
    updateInfo: (orderId: number, plId: number, patch: any) =>
      call<any[]>('pl:updateInfo', orderId, plId, patch),
    updateLine: (orderId: number, plId: number, lineId: number, patch: any) =>
      call<any[]>('pl:updateLine', orderId, plId, lineId, patch),
    addLine: (orderId: number, plId: number, line: any) => call<any[]>('pl:addLine', orderId, plId, line),
    deleteLine: (orderId: number, plId: number, lineId: number) =>
      call<any[]>('pl:deleteLine', orderId, plId, lineId),
    /** 作废留档：订舱取消、整批发错时不删记录，只是不再参与汇总 */
    void: (orderId: number, plId: number, reason?: string) => call<any[]>('pl:void', orderId, plId, reason),
    unvoid: (orderId: number, plId: number) => call<any[]>('pl:unvoid', orderId, plId),
    /** 每批的纸面金额（本批货值 + 分摊费用），箱单存档与批次列表都用它 */
    amounts: (orderId: number) => call<PackingAmount[]>('pl:amounts', orderId)
  },
  dashboard: {
    stats: () => call<any>('dashboard:stats'),
    reminders: () => call<any[]>('dashboard:reminders')
  },
  report: {
    monthly: () => call<MonthlyReportRow[]>('report:monthly'),
    receivables: () => call<CustomerReceivable[]>('report:receivables')
  },
  settings: {
    get: () => call<any>('settings:get'),
    save: (s: any) => call<any>('settings:save', s)
  },
  images: {
    pick: () => call<string[]>('images:pick'),
    importLogo: () => call<string>('images:importLogo'),
    url: (fileName: string) => call<string>('images:url', fileName),
    readDataUrl: (fileName: string) => call<string>('images:readDataUrl', fileName),
    baseDir: () => ipcRenderer.sendSync('images:baseDir') as string
  },
  backup: {
    create: () => call<string>('backup:create'),
    reveal: () => call<string>('backup:reveal')
  },
  exporter: {
    csv: (kind: ExportKind) => call<string>('export:csv', kind)
  },
  window: {
    hide: () => call<boolean>('window:hide'),
    printPdf: (payload: { html: string; fileName: string; silent?: boolean }) =>
      call<string>('window:printPdf', payload),
    print: () => call<boolean>('window:print')
  },
  updater: {
    /** 检查更新 */
    check: () => call<any>('updater:check'),
    /** 当前版本号 */
    version: () => call<string>('updater:version'),
    /** 下载更新 */
    download: () => call<any>('updater:download'),
    /** 重启并安装已下载的更新 */
    install: () => call<boolean>('updater:install'),
    /** 订阅更新事件（进度/状态） */
    on: (cb: (info: any) => void) => {
      const listener = (_e: unknown, info: any) => cb(info)
      ipcRenderer.on('updater:event', listener)
      return () => ipcRenderer.removeListener('updater:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type { IKanApi }
