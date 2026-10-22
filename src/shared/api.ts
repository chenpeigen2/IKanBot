/**
 * 渲染进程与主进程之间的 API 契约。
 * preload 暴露的 window.api 必须满足此接口。
 */
export interface IKanApi {
  products: {
    list(keyword?: string, includeInactive?: boolean): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    remove(id: number): Promise<void>
    copy(id: number, newStyleNo: string): Promise<any>
    images(productId: number): Promise<any[]>
    addImage(productId: number, fileName: string, isPrimary?: boolean): Promise<any>
    delImage(id: number): Promise<void>
    setPrimary(productId: number, imageId: number): Promise<void>
  }
  customers: {
    list(keyword?: string): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    remove(id: number): Promise<void>
    stats(id: number): Promise<any>
    orders(id: number): Promise<any[]>
  }
  orders: {
    list(filter: any): Promise<any[]>
    get(id: number): Promise<any>
    create(input: any): Promise<any>
    update(id: number, input: any): Promise<any>
    /** 只改费用行（运费/保险），其他字段不动 */
    updateCharges(id: number, charges: any[]): Promise<any>
    remove(id: number): Promise<void>
    /** 作废订单（客户取消 / 建错单）：记录全留，不进货值/待收/毛利 */
    void(id: number, reason?: string): Promise<any>
    addItem(orderId: number, item: any): Promise<any>
    updateItem(orderId: number, itemId: number, patch: any): Promise<any>
    removeItem(orderId: number, itemId: number): Promise<any>
    replaceItems(orderId: number, items: any[]): Promise<any>
    summarizeSkus(orderId: number): Promise<any[]>
    addPayment(orderId: number, p: any): Promise<any>
    deletePayment(orderId: number, paymentId: number): Promise<any>
    setShipStatus(orderId: number, status: string, note?: string): Promise<any>
    setPaymentStatus(orderId: number, status: string, note?: string): Promise<any>
    events(orderId: number): Promise<any[]>
    /** 历史用过的港口，供自动补全 */
    ports(): Promise<{ loading: string[]; destination: string[] }>
    /** 客户上一次订单用的条款 */
    lastTerms(customerId: number): Promise<any>
    /** 最近一次填过的汇率 */
    lastExchangeRate(): Promise<number | null>
    /** 最近一次用的汇率 + 当时的锁定日期（只作参考，不自动填） */
    lastExchangeRateInfo(): Promise<{ rate: number; date: string } | null>
    /** 订单照片（验货照 / 柜照） */
    photos(orderId: number): Promise<any[]>
    addPhoto(orderId: number, fileName: string, kind?: string, note?: string): Promise<any>
    delPhoto(orderId: number, photoId: number): Promise<void>
  }
  quotations: {
    list(filter?: any): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    remove(id: number): Promise<void>
    updateMeta(id: number, meta: any): Promise<any>
    /** 报价单操作历史（改了什么） */
    events(id: number): Promise<any[]>
    /** 报价单一键转订单 */
    convert(id: number, opts?: { paymentStatus?: 'draft' | 'sent' }): Promise<any>
  }
  samples: {
    list(filter?: any): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    remove(id: number): Promise<void>
    /** 打样转订单（N24） */
    convert(id: number, opts?: { offsetSampleFee?: boolean; paymentStatus?: 'draft' | 'sent' }): Promise<any>
  }
  docs: {
    /** 把单据 PDF 存进系统存档目录，并记一版 */
    save(payload: {
      html: string
      fileName: string
      docNo: string
      kind: 'pi' | 'pl' | 'ci' | 'quotation'
      orderId?: number | null
      quotationId?: number | null
      amount?: number
    }): Promise<{ path: string; version: number }>
    /** 订单的单据存档列表 */
    list(orderId: number): Promise<any[]>
    /** 报价单的单据存档列表 */
    listQuotation(quotationId: number): Promise<any[]>
    /** 下一版是第几版（打印前先问一句，纸面上要印版本号） */
    nextVersion(docNo: string, kind: 'pi' | 'pl' | 'ci' | 'quotation'): Promise<number>
    /** 打开这一版文件所在的文件夹（N34）；不传路径则打开存档根目录 */
    reveal(filePath?: string): Promise<string>
    /** 直接打开某一版文件（N34） */
    openFile(filePath: string): Promise<string>
  }
  pl: {
    list(orderId: number): Promise<any[]>
    create(input: any): Promise<any[]>
    remove(orderId: number, plId: number): Promise<any[]>
    updateLine(orderId: number, plId: number, lineId: number, patch: any): Promise<any[]>
    addLine(orderId: number, plId: number, line: any): Promise<any[]>
    deleteLine(orderId: number, plId: number, lineId: number): Promise<any[]>
  }
  dashboard: {
    stats(): Promise<any>
    reminders(): Promise<any[]>
  }
  report: {
    monthly(): Promise<any[]>
  }
  settings: {
    get(): Promise<any>
    save(s: any): Promise<any>
  }
  images: {
    pick(): Promise<string[]>
    importLogo(): Promise<string>
    url(fileName: string): Promise<string>
    readDataUrl(fileName: string): Promise<string>
    /** 图片目录绝对路径（同步），渲染进程直接拼 file:// URL */
    baseDir(): string
  }
  backup: {
    create(): Promise<string>
    reveal(): Promise<string>
  }
  exporter: {
    csv(kind: 'orders' | 'payments' | 'items'): Promise<string>
  }
  window: {
    hide(): Promise<boolean>
    printPdf(payload: { html: string; fileName: string; silent?: boolean }): Promise<string>
    print(): Promise<boolean>
  }
  /** 应用内自动更新 */
  updater: {
    check(): Promise<UpdateStatus>
    /** 当前版本号 */
    version(): Promise<string>
    download(): Promise<UpdateStatus>
    install(): Promise<boolean>
    on(cb: (info: UpdateStatus) => void): () => void
  }
  /** 用系统浏览器打开外链 */
  shell: {
    openExternal(url: string): Promise<boolean>
  }
  /** 数据目录完整路径 */
  app: {
    dataDir(): Promise<string>
    imagesDir(): Promise<string>
    backupsDir(): Promise<string>
  }
}

/** 自动更新状态 */
export interface UpdateStatus {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  version?: string
  releaseNotes?: string
  releaseDate?: string
  percent?: number
  transferred?: number
  total?: number
  speed?: number
  message?: string
  currentVersion: string
}
