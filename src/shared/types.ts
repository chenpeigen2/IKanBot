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
  | 'partial_shipped' // 部分出运（只由批次汇总得出，不能手选）

/** 批次上能出现的出货状态：部分出运是整单汇总出来的，永远不会落在某一批上 */
export type BatchShipStatus = Exclude<ShipStatus, 'partial_shipped'>

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
  delivered: '已签收',
  partial_shipped: '部分出运'
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

/** 手工能选的状态（部分出运是批次汇总出来的，不出现在下拉里）——服务层校验也只用这一份，别处不再抄一个数组 */
export const SHIP_STATUS_ORDER: BatchShipStatus[] = [
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
  /** 成本价（工厂价，按基准币 CNY 记），空表示不核算利润 */
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
  /** 做这个款的工厂 */
  factory: string
  /** 工厂自己的货号（1688 / 打样单上的号） */
  factoryNo: string
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

/**
 * 单据抬头快照。
 * 客户档案会改（搬家、改名、换付款条件），但已经发出去的 PI / PL / CI 不能跟着改——
 * 那是凭据。所以建单时把抬头钉死在单子上，重印永远印当时那一版。
 */
export interface PartySnapshot {
  company: string
  attn: string
  contact: string
  address: string
  zipCode: string
  country: string
  email: string
  phone: string
  /** 档案里的付款条款（印在 PI 的 Agreed Terms） */
  paymentPref: string
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
  /** 收货地址（货代实际送的地方），空则沿用账单地址 */
  shipAttn: string
  shipAddress: string
  shipZipCode: string
  shipCountry: string
  /** 0 = 停用：建单下拉里不再出现，历史单据一条不动 */
  active: number
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
  /** 成交额口径之外还有几单（草稿 / 已失效 / 已作废），客户页要写明，别让人以为漏单 */
  excludedOrderCount: number
  /** 累计成交额（基准币）= Σ含费用合计 */
  totalAmount: number
  /** 累计毛利（基准币）；有成本没录全时为 null（不可信） */
  totalProfit: number | null
  /** 未收金额（基准币）= Σ(含费用合计 − 已收) */
  outstanding: number
  /** 未收金额里的订单部分（基准币），客户页用来拆开显示 */
  outstandingOrders: number
  /** 未收金额里的打样费部分（基准币），客户页用来拆开显示 */
  outstandingSamples: number
  /** 尚未追回的坏账（基准币），不进待收，但客户页要能看见 */
  badDebt: number
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
  /** 由哪张报价单转来（null = 手工建单或打样转单） */
  sourceQuotationId: number | null
  /** 转单用的是报价单第几版 */
  sourceRevision: number | null
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
  /** 待收（含费用合计 − 已收 − 核销，不会出现负数；多收的部分不显示为待收） */
  remaining: number
  /** 待收原始值（可能为负，表示多收了） */
  remainingRaw: number
  depositAmount: number
  /** 短款核销合计（原币，让利，已从待收与毛利里扣） */
  writeOffShortage: number
  /** 坏账核销合计（原币，信用损失，只从待收扣，不改进货毛利） */
  writeOffBadDebt: number
  /** 坏账尚未追回的余额（原币） */
  badDebtOutstanding: number
  /** 核销合计 = 短款 + 坏账（原币） */
  writtenOff: number
  /** 核销 / 坏账 / 追回台账（只追加，撤销也留一条负数） */
  settlements: Settlement[]
  /** 来源报价单号（客户拿 PI 对报价时能查） */
  sourceQuotationNo: string
  /** 出货汇总（批次件数与推导状态） */
  shipSummary: ShipSummary
  /**
   * 买方抬头快照（PI / CI 印这个）。
   * 建单时钉死；改客户档案不影响这张单。老数据没快照时回退客户档案当前值。
   */
  billTo: PartySnapshot
  /** 收货抬头快照（PL 印这个；客户没填收货地址时等于买方抬头） */
  shipTo: PartySnapshot
}

/**
 * 订单列表上的一行（瘦身版）。
 *
 * 列表不再逐单展开明细/收款/装箱/抬头：每张单 9 条查询、几百张单点一下要等两秒，
 * 而且列表根本不显示那些字段。金额仍然由 services/money.ts 批量算，
 * 与订单详情、单据、报表同一个口径。
 */
export interface OrderListRow {
  id: number
  orderNo: string
  piNo: string
  customerPo: string
  currency: Currency
  /** 1 外币 = exchangeRate 基准币 */
  exchangeRate: number
  baseCurrency: Currency
  paymentStatus: PaymentStatus
  shipStatus: ShipStatus
  /** 客户（列表只显示公司名 + 国家） */
  customer: { id: number; company: string; country: string } | null
  portOfLoading: string
  portOfDestination: string
  factory: string
  vessel: string
  sealNo: string
  /** 实际开船日 */
  etdDate: string | null
  /** 截关日 */
  cutOffDate: string | null
  expectedShipDate: string | null
  validUntil: string | null
  createdAt: string
  /** 货值（原币） */
  totalAmount: number
  chargesTotal: number
  /** 含费用合计（PI 上的 TOTAL，原币） */
  grandTotal: number
  paidAmount: number
  /** 待收（原币，多收为 0） */
  remaining: number
  /** 待收折基准币：跨币种排序和「合计待收」用这个 */
  remainingBase: number
  totalQuantity: number
  /** 已装箱件数（作废批次不计） */
  packedQuantity: number
  /** 有效批次数 */
  batchCount: number
  /** 各批柜号（逗号拼接，作废批次不算）；没填为空串 */
  containerNos: string
  /** 费用行数（列表只用来提示「含运费保险」，不展开明细） */
  chargesCount: number
  /** 款号数 */
  styleCount: number
  /** 首个款号（列表上的款号摘要） */
  firstStyleNo: string
  /** 成本没录的行数：>0 时毛利不可信 */
  missingCostItems: number
  /**
   * 交期逾期天数（今天 − 预计出货日，正数 = 已经过了）；
   * 没填预计出货日、或已经出运/清关/签收的单为 null。
   */
  daysLate: number | null
}

/** 一页订单列表 + 筛选后的总数与合计（合计按筛选集算，不能拿本页行数充数） */
export interface OrderListPage {
  rows: OrderListRow[]
  total: number
  /** 筛选集里还在催款的单的待收合计（基准币） */
  owedBaseTotal: number
  /** 筛选集里还在催款的单的含费用合计（基准币） */
  grandBaseTotal: number
}

/** 历史成交价：客户问「上次那款多少钱」时立刻答得上 */
export interface StylePriceRow {
  styleNo: string
  color: string
  /** 最近一次成交价（原币） */
  lastUnitPrice: number
  lastCurrency: string
  /** 最近一次成交日期（ISO） */
  lastDate: string
  /** 成交过几次（按订单数） */
  times: number
  /** 累计件数 */
  totalQuantity: number
  /** 对方是谁（客户方向为空；商品方向带公司名） */
  customerCompany: string
}

export type SettlementKind = 'shortage' | 'bad_debt' | 'recovery'

/** 订单核销台账：只追加，撤销也记一条负数，凭据不丢 */
export interface Settlement {
  id: number
  orderId: number
  kind: SettlementKind
  /** 正数 = 核销/追回；负数 = 撤销 */
  amount: number
  reason: string
  /** 文字证据说明（邮件、律师函、破产公告等），附件在后续版本补 */
  evidence: string
  /** 被撤销的原记录 id */
  reversesId: number | null
  /** 追回款对应的收款记录 id（钱实际到账才有） */
  paymentId: number | null
  /** 业务发生日 YYYY-MM-DD */
  at: string
  createdAt: string
}

/** 报价单某一版的存档摘要 */
export interface QuotationVersionSummary {
  revision: number
  goodsTotal: number
  grandTotal: number
  createdAt: string
  /** 这一版有几行明细 */
  itemCount: number
  /** 这一版的有效期（YYYY-MM-DD） */
  validUntil: string
}

export const SETTLEMENT_KIND_LABEL: Record<SettlementKind, string> = {
  shortage: '短款核销',
  bad_debt: '坏账',
  recovery: '坏账追回'
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
  /** 报价单发出时的买方抬头快照；老数据没有快照时回退客户档案 */
  billTo: PartySnapshot | null
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
  /** null = 迁移前的老批次：不参与订单状态推导，沿用订单级手工状态 */
  shipStatus: BatchShipStatus | null
  vessel: string
  /** 计划开船日 */
  etdDate: string | null
  /** 实际开船日 */
  atdDate: string | null
  /** 预计到港日 */
  etaDate: string | null
  sealNo: string
  /** 提单号（只登记，不上纸） */
  blNo: string
  /** 全部批次签收的日期（本月完成按它归集，不跟 updated_at 走） */
  deliveredAt: string | null
  /**
   * 这批客户实际收到多少件：null = 没记录（视同全收，别拿 0 当「一件没收到」）。
   * 短卸、破损扣款在数量层面留痕，不用只靠金额核销抹平。
   */
  receivedQty: number | null
  /** 纸面单据日期（可补录）：空则用建单当天，海关/银行要求日期不得晚于提单日 */
  docDate: string | null
  /** 作废留档：订舱取消、整批发错时不删记录，纸面和存档都还在，只是不再参与汇总 */
  voidedAt: string | null
  note: string
  createdAt: string
  lines: PackingListLine[]
}

/** 一个装箱批次的纸面金额（原币）：本批货值 + 按货值分摊的费用 */
export interface PackingAmount {
  plId: number
  plNo: string
  /** 本批件数 */
  quantity: number
  /** 本批货值 = Σ(箱内件数 × 订单该行单价) */
  goods: number
  /** 分摊到本批的运费/保险等费用（负数折让也按比例跟着走） */
  charges: number
  /** 本批含费用合计：分批出运的几张单据金额相加 = PI 含费用合计 */
  total: number
}

/** 一张订单的出货汇总：状态由批次 + 件数推导 */
export interface ShipSummary {
  orderedQuantity: number
  packedQuantity: number
  shippedQuantity: number
  batchCount: number
  unshippedBatches: number
  /** null = 当前没有可推导的批次，订单仍用手工状态 */
  derivedStatus: ShipStatus | null
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
  /**
   * 毛重是不是估的：true=按净重×系数推算，false=过磅实测，null=老数据没记过。
   * 落库时就定死，改毛重系数也不会让已出运单据上的 (est.) 标记翻面。
   */
  grossEst: boolean | null
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
  /**
   * 操作者名字（这台机器谁在用）。
   * 每一条操作历史都盖上它——「这笔款昨天还在，今天谁删的」得有答案。
   */
  operator: string
  /**
   * 最近一次成功备份的时间（ISO 串）。空 = 从来没备份成功过。
   * 这一项和下面那项由备份服务写，设置页改了不算（不然一保存就把备份凭据抹了）。
   */
  lastBackupAt: string | null
  /** 最近一次备份失败的原因（人话）。空 = 没失败过 */
  lastBackupError: string | null
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
  /** 待收款拆分：客户还没确认（草稿 / PI 已发）的单（基准币） */
  pendingUnconfirmed: number
  /** 待收款拆分：客户已确认但定金没到账（基准币） */
  pendingDeposit: number
  /** 待收款拆分：收过钱但没收齐的尾款（基准币） */
  pendingBalance: number
  /** 待收款拆分：未收的打样费 + 快递费（基准币）；前四项相加 = pendingAmount */
  pendingSample: number
  /** 已核销但还没追回来的坏账（基准币） */
  outstandingBadDebt: number
  currency: Currency
}

/** 待办提醒 */
export interface Reminder {
  /** 订单提醒才有 orderId；打样/报价提醒用 sampleId 或留 0 */
  orderId: number
  orderNo: string
  customerName: string
  kind: 'confirm' | 'payment' | 'ship' | 'balance' | 'sample' | 'expiry' | 'quote' | 'data'
  message: string
  /** 距到期还有几天（负数 = 已逾期）；「待修」类没有期限，固定 0 */
  days: number
  /** 稳定的折叠键：同一单同一事由刷新后仍是同一条，收起一条不会误伤另一条 */
  key: string
  /** 打样提醒的打样单 id（非打样提醒为 0） */
  sampleId?: number
  /** 出货提醒的批次 id / 装箱单号（同单多批各提醒各的） */
  plId?: number
  plNo?: string
}

/** 单据种类 */
export type DocKind = 'pi' | 'pl' | 'ci' | 'quotation'

/**
 * 导出台账的种类。
 * 四层（渲染页 → preload → IPC → services）共用这一个类型，
 * 谁加了新表，编译器会在每一层都催一遍，不会出现「点得动、类型里不许传」的谎。
 *
 * orders 和报表同一个口径（草稿/失效/作废都不算正式订单），列直接 SUM 就是对的；
 * orders_all 才是全量底稿（含草稿与作废），文件名写死了「仅供复盘」，
 * 免得两套数据在 Excel 里长成一个样子。
 */
export type ExportKind = 'orders' | 'orders_all' | 'payments' | 'items' | 'monthly'

export const EXPORT_FILE_NAME: Record<ExportKind, string> = {
  orders: '订单台账.csv',
  orders_all: '订单底稿_含草稿作废_仅供复盘.csv',
  payments: '收款台账.csv',
  items: '款号明细台账.csv',
  monthly: '月度汇总.csv'
}

/**
 * 导出台账时跟随订单列表的筛选（排序与分页不参与）。
 * 页面上筛出几张，Excel 里就该是几张——否则同一客户的对账单和页面合计对不上。
 */
export interface OrderExportFilter {
  keyword?: string
  paymentStatus?: string
  shipStatus?: string
  from?: string
  to?: string
}

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
  /** 样品单价（打样费，不是大货价） */
  unitPrice: number
  /** 转单用的大货单价；null = 还没填，转单必须拦住 */
  goodsUnitPrice: number | null
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
  /** 样品费 + 快递费（客户欠公司的总额，原币） */
  totalFee: number
  /*
   * 下面五个都是基准币（列表就印这一套，一屏一个币种才看得懂）。
   * 工厂打样费本来就按基准币记账；样品费/快递费跟单据币种走，按本单汇率折算。
   * 汇率没填 → null，界面显示「—」，不许拿 1 凑一个好看的数。
   */
  /** 样品费折基准币（无汇率为 null） */
  sampleFeeBase: number | null
  /** 快递费折基准币（跟单据币种，无汇率为 null） */
  expressFeeBase: number | null
  /** 应收客户总额折基准币 = 样品费 + 快递费 */
  totalFeeBase: number | null
  /** 公司总成本 = 工厂打样费（基准币）+ 快递费（折基准币）（N33） */
  companyCostBase: number | null
  /** 公司已收回的打样费（paid/offset 才算收回；unpaid/waived 没收回），基准币 */
  feeRecoveredBase: number | null
  /** 公司净垫 = 公司总成本 − 已收回打样费（N33：真实垫了多少钱），基准币 */
  netAdvanceBase: number | null
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
  /** 已经装进装箱单的数量（分批出货时，后面几批只装剩下的） */
  packedQuantity: number
  /** 还没装箱的数量 = quantity − packedQuantity */
  remainingQuantity: number
}

/** 报表 */
export interface MonthlyReportRow {
  month: string
  orders: number
  /** 销售额（含费用合计，基准币）—— 按订单创建月份 */
  sales: number
  cost: number
  /** 毛利；该月有成本没录全的订单时为 null（不可信，界面显示「—」） */
  profit: number | null
  /** 折让（负向费用：抵扣/让利，正数表示让出去多少）—— 按订单创建月份 */
  discount: number
  /** 短款核销：当场让掉的尾款，已扣进毛利 —— 按订单创建月份 */
  shortage: number
  /** 还没追回的坏账：信用损失，不进进货毛利，报表单列 —— 按订单创建月份 */
  badDebt: number
  /** 收款：按实际到账月份，不能与上面几列纵向相减 */
  received: number
  /** 该月里成本没录全的订单数：这些单的毛利是假的 */
  missingCostOrders: number
}

/** 客户维度欠款榜（基准币） */
export interface CustomerReceivable {
  customerId: number
  customerName: string
  /** 未结订单数（已排除草稿/失效/作废） */
  orders: number
  /** 货款待收 */
  goodsBase: number
  /** 打样费+快递费待收 */
  sampleBase: number
  /** 合计敞口 */
  totalBase: number
}
