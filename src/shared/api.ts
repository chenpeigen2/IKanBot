/**
 * 渲染进程与主进程之间的 API 契约。
 * preload 暴露的 window.api 必须满足此接口。
 */
import type { CustomerReceivable, ExportKind, MonthlyReportRow, PackingAmount } from './types'

export interface IKanApi {
  products: {
    list(keyword?: string, includeInactive?: boolean): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    /** 删除或被引用的款：被引用过只停用，不删数据 */
    remove(id: number): Promise<{ deactivated: boolean; message: string }>
    copy(id: number, newStyleNo: string): Promise<any>
    images(productId: number): Promise<any[]>
    addImage(productId: number, fileName: string, isPrimary?: boolean): Promise<any>
    delImage(id: number): Promise<void>
    setPrimary(productId: number, imageId: number): Promise<void>
    setActive(id: number, active: 0 | 1): Promise<any>
    referenceCount(id: number): Promise<{ orders: number; quotations: number; samples: number }>
    csvTemplate(): Promise<string>
    importCsv(text: string, mode?: 'skip' | 'overwrite'): Promise<any>
  }
  customers: {
    list(keyword?: string, includeInactive?: boolean): Promise<any[]>
    get(id: number): Promise<any>
    save(input: any): Promise<any>
    remove(id: number): Promise<void>
    setActive(id: number, active: 0 | 1): Promise<any>
    /** 同名客户（重名提醒，不是硬拦） */
    sameName(company: string, selfId?: number): Promise<any[]>
    stats(id: number): Promise<any>
    orders(id: number): Promise<any[]>
    /** 款号×颜色的历史成交价：报价前先看客户上次付了多少 */
    stylePriceHistory(filter?: { customerId?: number; styleNo?: string }): Promise<any[]>
  }
  orders: {
    list(filter: any): Promise<any[]>
    get(id: number): Promise<any>
    create(input: any): Promise<any>
    update(id: number, input: any): Promise<any>
    /** 单独改单据抬头快照（重印时纠正地址，不动其他字段） */
    setParties(id: number, patch: { billTo?: any; shipTo?: any }): Promise<any>
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
    deletePayment(orderId: number, paymentId: number, reason: string): Promise<any>
    listSettlements(orderId: number): Promise<any[]>
    addSettlement(orderId: number, input: any): Promise<any>
    reverseSettlement(orderId: number, settlementId: number, reason: string): Promise<any>
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
    /** 报价单的历史版本（每次改价改条款都冻结一版） */
    versions(id: number): Promise<any[]>
    /** 报价单一键转订单：按指定版本原样带过去（不传版本号会被后端拒绝） */
    convert(
      id: number,
      opts?: {
        paymentStatus?: 'draft' | 'sent'
        revision?: number
        override?: { approvedBy?: string; reason?: string }
      }
    ): Promise<any>
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
      /** 纸面印的版次；与系统下一版不一致会被拒绝，防止纸面/存档错位 */
      expectedVersion?: number
    }): Promise<{ path: string; filePath: string; version: number }>
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
    updateInfo(orderId: number, plId: number, patch: any): Promise<any[]>
    updateLine(orderId: number, plId: number, lineId: number, patch: any): Promise<any[]>
    addLine(orderId: number, plId: number, line: any): Promise<any[]>
    deleteLine(orderId: number, plId: number, lineId: number): Promise<any[]>
    /** 作废留档 / 撤销作废：作废的批次不参与状态、件数和本批金额 */
    void(orderId: number, plId: number, reason?: string): Promise<any[]>
    unvoid(orderId: number, plId: number): Promise<any[]>
    /** 每个批次的纸面金额（本批货值 + 分摊费用） */
    amounts(orderId: number): Promise<PackingAmount[]>
  }
  dashboard: {
    stats(): Promise<any>
    reminders(): Promise<any[]>
  }
  report: {
    monthly(): Promise<MonthlyReportRow[]>
    receivables(): Promise<CustomerReceivable[]>
  }
  settings: {
    get(): Promise<any>
    save(s: any): Promise<any>
    /** 基准币种是否已锁死（库里已有单据） */
    baseLocked(): Promise<boolean>
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
    /** 备份目录里现成的备份包（新→旧） */
    list(): Promise<BackupFile[]>
    /** 用系统文件选择框挑一个备份包；取消返回空串 */
    pick(): Promise<string>
    /** 恢复前先打开看一眼里面是什么（不落任何盘） */
    inspect(path: string): Promise<BackupPreview>
    /** 用选定的备份包覆盖当前数据，成功后程序会自动重启 */
    restore(path: string): Promise<{ restarted: boolean }>
  }
  exporter: {
    csv(kind: ExportKind): Promise<string>
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
    /** 当前状态（只认主进程那一份，界面刷新也不会丢进度） */
    state(): Promise<UpdateStatus>
    /**
     * 装已下载好的更新。
     * 装之前会先压一份备份，压不成就不装——返回 ok:false 和原因，
     * 免得升级把数据结构改坏了却连个退回去的地方都没有。
     */
    install(): Promise<{ ok: boolean; message?: string }>
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
    /** 一次拿全：主进程用 join 拼好，界面只管显示，不许自己拼斜杠 */
    paths(): Promise<DataPaths>
  }
}

/** 本机各数据目录的绝对路径 */
export interface DataPaths {
  data: string
  db: string
  images: string
  docs: string
  backups: string
}

/** 备份目录里的一个备份包 */
export interface BackupFile {
  path: string
  name: string
  /** 从文件名里的时间戳还原；手工放进来的文件可能没有 */
  takenAt: string | null
  size: number
}

/** 备份包内容摘要（恢复确认框用） */
export interface BackupPreview {
  path: string
  takenAt: string | null
  fileSize: number
  entryCount: number
  hasDb: boolean
  /** 包里的订单数：恢复前必须看得见，不然等于闭眼按 */
  orderCount: number | null
  paymentCount: number | null
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
