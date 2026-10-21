/**
 * 全局共享类型定义 —— 主进程与渲染进程共用的数据契约。
 */

/** 收款状态线 */
export type PaymentStatus =
  | 'draft' // 草稿
  | 'sent' // 已发送，待客户确认
  | 'confirmed' // 客户已确认
  | 'partial' // 部分收款
  | 'paid' // 已收款（定金收齐）
  | 'settled' // 已结清（全额收齐）
  | 'expired' // 已失效
  | 'void' // 已作废（客户取消 / 建错单）：记录全留，但不进货值/待收/毛利

/** 出货状态线 */
export type ShipStatus =
  | 'not_prepared' // 未备货
  | 'preparing' // 备货中
  | 'packed' // 已包装
  | 'shipped' // 已出运
  | 'cleared' // 已清关
  | 'delivered' // 已签收

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  draft: '草稿',
  sent: '待确认',
  confirmed: '客户已确认',
  partial: '部分收款',
  paid: '已收款',
  settled: '已结清',
  expired: '已失效',
  void: '已作废'
}

export const SHIP_STATUS_LABEL: Record<ShipStatus, string> = {
  not_prepared: '未备货',
  preparing: '备货中',
  packed: '已包装',
  shipped: '已出运',
  cleared: '已清关',
  delivered: '已签收'
}

export const PAYMENT_STATUS_ORDER: PaymentStatus[] = [
  'draft',
  'sent',
  'confirmed',
  'partial',
  'paid',
  'settled',
  'expired',
  'void'
]

export const SHIP_STATUS_ORDER: ShipStatus[] = [
  'not_prepared',
  'preparing',
  'packed',
  'shipped',
  'cleared',
  'delivered'
]

/** 报价单状态 */
export type QuotationStatus = 'draft' | 'sent' | 'confirmed' | 'converted' | 'expired'

/** 报价结果 */
export type QuotationResult = 'pending' | 'won' | 'lost'

export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: '草稿',
  sent: '已发送',
  confirmed: '客户已确认',
  converted: '已转订单',
  expired: '已失效'
}

export const QUOTATION_RESULT_LABEL: Record<QuotationResult, string> = {
  pending: '待回',
  won: '成交',
  lost: '没成交'
}

export type Currency = 'USD' | 'CNY' | 'EUR' | 'GBP' | 'HKD'

export const CURRENCIES: Currency[] = ['USD', 'CNY', 'EUR', 'GBP', 'HKD']

export type Incoterm = 'EXW' | 'FOB' | 'CIF' | 'DDP'

export const INCOTERMS: Incoterm[] = ['EXW', 'FOB', 'CIF', 'DDP']

export type PaymentMethod =
  | 'tt_deposit' // T/T 定金
  | 'tt_full' // T/T 全款
  | 'lc' // 信用证
  | 'oa' // 赊销

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  tt_deposit: 'T/T 定金',
  tt_full: 'T/T 全款',
  lc: 'L/C 即期信用证',
  oa: '赊销 OA'
}

/** 商品 */
export interface Product {
  id: number
  styleNo: string
  name: string
  composition: string
  category: string
  brand: string
  season: string
  /** 成本价（工厂价），空表示不核算利润 */
  costPrice: number | null
  /** 自有尺码表，如 ["S","M","L"] */
  sizes: string[]
  /** 自有颜色表，如 ["Black","White"] */
  colors: string[]
  /** 单件净重 kg，用于装箱单自动算净重 */
  unitNetWeight: number | null
  /** 每箱件数 */
  boxPieces: number | null
  /** 箱规 长×宽×高 cm */
  boxLength: number | null
  boxWidth: number | null
  boxHeight: number | null
  note: string
  active: number
  createdAt: string
  updatedAt: string
}

export interface ProductImage {
  id: number
  productId: number
  /** 相对 data/images 的文件名 */
  fileName: string
  isPrimary: number
  sortOrder: number
}

/** 客户 */
export interface Customer {
  id: number
  company: string
  contact: string
  email: string
  phone: string
  country: string
  address: string
  zipCode: string
  attn: string
  paymentPref: string
  /** 默认付款方式（建单时带出） */
  defaultPaymentMethod: PaymentMethod | ''
  /** 默认定金比例 */
  defaultDepositRatio: number | null
  /** 默认贸易术语 */
  defaultIncoterm: Incoterm | ''
  /** 默认装运港 */
  defaultPortLoading: string
  /** 默认目的港 */
  defaultPortDestination: string
  note: string
  createdAt: string
  updatedAt: string
}

/** 客户聚合统计 */
export interface CustomerStats {
  orderCount: number
  /** 累计成交额（基准币）= Σ含费用合计 */
  totalAmount: number
  /** 累计毛利（基准币）；有成本没录全时为 null（不可信） */
  totalProfit: number | null
  /** 未收金额（基准币）= Σ(含费用合计 − 已收) */
  outstanding: number
  /** 成本没录全的订单数：这些单的毛利是假的，不能当成真毛利看 */
  missingCostOrders: number
}

/** 订单行 = 一个 SKU */
export interface OrderItem {
  id: number
  orderId: number
  productId: number | null
  styleNo: string
  productName: string
  /** 成分快照，用于单据打印 */
  composition: string
  color: string
  size: string
  quantity: number
  unitPrice: number
  /** 行成本单价快照，null 表示不核算 */
  unitCost: number | null
}

/** 订单 */
export interface Order {
  id: number
  orderNo: string
  customerId: number
  piNo: string
  paymentStatus: PaymentStatus
  shipStatus: ShipStatus
  currency: Currency
  /** 1 外币 = exchangeRate 基准币 */
  exchangeRate: number
  baseCurrency: Currency
  incoterm: Incoterm
  portOfLoading: string
  portOfDestination: string
  paymentMethod: PaymentMethod
  /** 定金比例，0.3 = 30% */
  depositRatio: number
  /** PI 有效期，YYYY-MM-DD */
  validUntil: string | null
  expectedShipDate: string | null
  expectedArrivalDate: string | null
  customerPo: string
  note: string
  /** 汇率锁定日期，YYYY-MM-DD */
  exchangeRateDate: string | null
  /** 加工厂 */
  factory: string
  /** 工厂承诺交期 */
  factoryDueDate: string | null
  /** 截关日 */
  cutOffDate: string | null
  /** 实际开船日 */
  etdDate: string | null
  /** 船名航次 */
  vessel: string
  /** 封条号 */
  sealNo: string
  /** 正式费用行（运费/保险等），PI 上单独成行，不进备注 */
  charges: QuotationCharge[]
  createdAt: string
  updatedAt: string
}

/** 订单 + 关联展开 */
export interface OrderDetail extends Order {
  customer: Customer | null
  items: OrderItem[]
  payments: Payment[]
  packingLists: PackingList[]
  /** 汇总计算 —— 全部来自 services/money.ts（金额口径唯一真源） */
  /** 货值（不含费用） */
  totalAmount: number
  /** 费用合计（运费/保险等） */
  chargesTotal: number
  /** 应收总额 = 货值 + 费用（PI / CI / 报价单 / PL 上的合计） */
  grandTotal: number
  totalCost: number
  /** 毛利原始值；missingCostItems > 0 时不可信，界面上要显示「—」 */
  totalProfit: number
  /** 成本没录的行数：>0 时毛利不可信，界面上要显示「—」而不是假数字 */
  missingCostItems: number
  totalQuantity: number
  paidAmount: number
  /** 待收（含费用合计 − 已收，不会出现负数；多收的部分不显示为待收） */
  remaining: number
  /** 待收原始值（可能为负，表示多收了） */
  remainingRaw: number
  depositAmount: number
}

/** 订单照片（验货照 / 柜照等） */
export interface OrderPhoto {
  id: number
  orderId: number
  fileName: string
  /** inspection 验货照 / container 柜照 / other 其他 */
  kind: 'inspection' | 'container' | 'other'
  note: string
  createdAt: string
}

/** 报价单费用行（运费 / 保险费 / 其他） */
export interface QuotationCharge {
  label: string
  amount: number
}

/** 报价单行 = 一个 SKU */
export interface QuotationItem {
  id: number
  quotationId: number
  productId: number | null
  styleNo: string
  productName: string
  composition: string
  color: string
  size: string
  quantity: number
  unitPrice: number
}

/** 报价单 */
export interface Quotation {
  id: number
  qNo: string
  customerId: number
  status: QuotationStatus
  result: QuotationResult
  currency: Currency
  exchangeRate: number
  baseCurrency: Currency
  incoterm: Incoterm
  portOfLoading: string
  portOfDestination: string
  paymentMethod: PaymentMethod
  depositRatio: number
  validUntil: string | null
  customerPo: string
  note: string
  charges: QuotationCharge[]
  /** 转成的订单 id */
  convertedOrderId: number | null
  /** 汇率锁定日期 YYYY-MM-DD */
  exchangeRateDate: string | null
  /** 改过几版（每次编辑 +1） */
  revision: number
  createdAt: string
  updatedAt: string
}

/** 报价单 + 展开 */
export interface QuotationDetail extends Quotation {
  customer: Customer | null
  items: QuotationItem[]
  totalAmount: number
  totalQuantity: number
  chargesTotal: number
  grandTotal: number
}

/** 收款流水 */
export interface Payment {
  id: number
  orderId: number
  paidAt: string
  amount: number
  method: string
  bankRef: string
  note: string
  createdAt: string
}

/** 装箱单 */
export interface PackingList {
  id: number
  orderId: number
  plNo: string
  /** 批次/柜号 */
  containerNo: string
  note: string
  createdAt: string
  lines: PackingListLine[]
}

/** 装箱单明细行（一箱一行） */
export interface PackingListLine {
  id: number
  packingListId: number
  boxNo: string
  styleNo: string
  productName: string
  color: string
  size: string
  quantity: number
  /** 净重 kg */
  netWeight: number | null
  /** 毛重 kg，null 表示按净重 ×1.1 自动算 */
  grossWeight: number | null
  /** 箱规 长×宽×高 cm */
  boxLength: number | null
  boxWidth: number | null
  boxHeight: number | null
}

/** 操作历史 */
export interface OrderEvent {
  id: number
  orderId: number
  at: string
  /** 操作人/来源 */
  actor: string
  kind: string
  fromStatus: string | null
  toStatus: string | null
  note: string
}

/** 公司信息设置 */
export interface CompanyInfo {
  name: string
  logoFile: string
  address: string
  phone: string
  email: string
  website: string
}

/** 银行账户 */
export interface BankAccount {
  currency: Currency
  bankName: string
  accountName: string
  accountNo: string
  swift: string
  address: string
}

/** 应用设置 */
export interface AppSettings {
  company: CompanyInfo
  banks: BankAccount[]
  /** 默认 PI 有效期天数 */
  piValidDays: number
  /** 默认定金比例 */
  defaultDepositRatio: number
  /** 催确认阈值（天） */
  remindConfirmDays: number
  /** 催款阈值（天） */
  remindPaymentDays: number
  /** 催尾款阈值（天）：已收定金但未收齐，超过该天数提醒 */
  remindBalanceDays: number
  /** 出货提醒提前天数 */
  remindShipDays: number
  /** 毛重系数 */
  grossWeightFactor: number
  /** 基准币 */
  baseCurrency: Currency
}

/** 首页统计 */
export interface DashboardStats {
  activeOrders: number
  /** 待收款金额（基准币）= Σ(含费用合计 − 已收)，出自 services/money.ts */
  pendingAmount: number
  pendingShipOrders: number
  completedThisMonth: number
  monthSales: number
  /** 本月毛利；本月的单有成本没录全时为 null（不可信，界面显示「—」） */
  monthProfit: number | null
  /** 本月毛利是否可信 */
  monthProfitReliable: boolean
  monthReceived: number
  monthNewOrders: number
  currency: Currency
}

/** 待办提醒 */
export interface Reminder {
  /** 订单提醒才有 orderId；打样提醒用 sampleId */
  orderId: number
  orderNo: string
  customerName: string
  kind: 'confirm' | 'payment' | 'ship' | 'balance' | 'sample'
  message: string
  days: number
  /** 打样提醒的打样单 id（非打样提醒为 0） */
  sampleId?: number
}

/** 单据种类 */
export type DocKind = 'pi' | 'pl' | 'ci' | 'quotation'

/** 打样单（样品单）状态 */
export type SampleStatus = 'pending' | 'sent' | 'received' | 'cancelled'

export const SAMPLE_STATUS_LABEL: Record<SampleStatus, string> = {
  pending: '待寄出',
  sent: '已寄出',
  received: '已签收',
  cancelled: '已取消'
}

export const SAMPLE_STATUS_ORDER: SampleStatus[] = ['pending', 'sent', 'received', 'cancelled']

/** 打样费收款标记（N23/N33：样品费+快递费到底收没收、怎么收的） */
export type SampleFeeStatus = 'unpaid' | 'paid' | 'offset' | 'waived'

export const SAMPLE_FEE_STATUS_LABEL: Record<SampleFeeStatus, string> = {
  unpaid: '未收',
  paid: '已向客户收',
  offset: '下单抵扣',
  waived: '客户免单'
}

export const SAMPLE_FEE_STATUS_ORDER: SampleFeeStatus[] = ['unpaid', 'paid', 'offset', 'waived']

/** 打样单明细（一个颜色×尺码一行） */
export interface SampleOrderItem {
  id: number
  sampleOrderId: number
  productId: number | null
  styleNo: string
  productName: string
  composition: string
  color: string
  size: string
  quantity: number
  /** 样品单价 */
  unitPrice: number
}

/** 打样单（样品单） */
export interface SampleOrder {
  id: number
  /** 样品单号，如 SMP20261021001 */
  sampleNo: string
  customerId: number
  /** 打样日期 YYYY-MM-DD */
  sampleDate: string
  /** 快递公司 */
  courier: string
  /** 快递单号 */
  trackingNo: string
  /** 快递费（公司垫的钱） */
  expressFee: number
  status: SampleStatus
  note: string
  /** 寄出日期 YYYY-MM-DD（N25） */
  shippedAt: string
  /** 客户签收日期 YYYY-MM-DD（N25） */
  receivedAt: string
  /** 工厂打样费（公司实际成本，N33） */
  factoryCost: number
  /** 打样费收款标记（N23/N33） */
  feeStatus: SampleFeeStatus
  /** 收款说明（如「已下单抵扣 PO-xxx」） */
  feeNote: string
  /** 币种（应收要进工作台，必须记币种汇率） */
  currency: string
  /** 汇率：1 currency = exchangeRate 基准币 */
  exchangeRate: number
  /** 汇率日期 YYYY-MM-DD */
  exchangeRateDate: string
  /** 转成的订单 id（N24，转过就删不得） */
  convertedOrderId: number | null
  createdAt: string
  updatedAt: string
}

/** 打样单 + 展开 */
export interface SampleOrderDetail extends SampleOrder {
  customer: Customer | null
  items: SampleOrderItem[]
  /** 总件数 */
  totalQuantity: number
  /** 样品费合计（应收客户的钱） */
  sampleFee: number
  /** 样品费 + 快递费（客户欠公司的总额） */
  totalFee: number
  /** 公司总成本 = 工厂打样费 + 快递费（N33） */
  companyCost: number
  /** 公司已收回的打样费（paid/offset 才算收回；unpaid/waived 没收回） */
  feeRecovered: number
  /** 公司净垫 = 公司总成本 − 已收回打样费（N33：真实垫了多少钱） */
  netAdvance: number
  /** 待收（应收客户金额，折算基准币；feeStatus≠unpaid 或汇率缺失时为 0） */
  receivableBase: number
  /** 汇率未填但有应收（危险：工作台会少算，要提示补） */
  rateMissing: boolean
}

/** 按 SKU 汇总 */
export interface SkuSummary {
  styleNo: string
  productName: string
  color: string
  size: string
  quantity: number
}

/** 报表 */
export interface MonthlyReportRow {
  month: string
  orders: number
  sales: number
  cost: number
  /** 毛利；该月有成本没录全的订单时为 null（不可信，界面显示「—」） */
  profit: number | null
  received: number
  /** 该月里成本没录全的订单数：这些单的毛利是假的 */
  missingCostOrders: number
}
