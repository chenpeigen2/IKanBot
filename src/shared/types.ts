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

export type Incoterm = 'EXW' | 'FCA' | 'FOB' | 'CFR' | 'CIF' | 'CPT' | 'DAP' | 'DDP'

export const INCOTERMS: Incoterm[] = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'DAP', 'DDP']

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
  /** 名下打样单总数：对账单入口不能把只打样的客户挡在外面 */
  sampleCount: number
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
  /** 用客户预收抵扣的金额（非现金，R27）：只冲待收，不动已收/总额/毛利 */
  creditApplied: number
  /** 待收（含费用合计 − 已收 − 预收抵扣 − 核销，不会出现负数；多收的部分不显示为待收） */
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
  /**
   * billTo 是从客户档案现取的（升级前的老单没有快照），不是这张单钉死的那份。
   * 纸面上「Agreed Terms」是客户当年认过的话：这种回退值不许替客户认。
   */
  billFromProfile: boolean
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
  /** 客户预收抵扣（非现金，已冲减待收） */
  creditApplied: number
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
  /** 第一次/最近一次「发出」的时间（改价重发才刷新；改备注、补结果都不动） */
  sentAt: string | null
  createdAt: string
  updatedAt: string
}

/** 报价单 + 展开 */
export interface QuotationDetail extends Quotation {
  customer: Customer | null
  /** 报价单发出时的买方抬头快照；纸面上的 Agreed Terms 只认这一份，没有就不印 */
  billTo: PartySnapshot | null
  /** billTo 是从客户档案现取的（升级前的老报价没有快照）：档案偏好不是客户认过的条款，纸面不印 */
  billFromProfile: boolean
  items: QuotationItem[]
  totalAmount: number
  totalQuantity: number
  chargesTotal: number
  grandTotal: number
  /** 转出的订单状态（'' = 没转单）；作废的单不再锁住报价，可以改价重转 */
  convertedOrderStatus: string
}

/** 收款流水：要么挂订单，要么挂打样单，绝不同时挂两边 */
export interface Payment {
  id: number
  /** 订单收款才有；打样费收款为 null */
  orderId: number | null
  /** 打样费收款才有；订单收款为 null */
  sampleOrderId: number | null
  paidAt: string
  amount: number
  method: string
  bankRef: string
  note: string
  /** 到账当天的汇率快照；老数据为空，回退订单汇率 */
  exchangeRate: number | null
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

/** 批次里的一个 SKU（同一款拆多箱也合成一行），批次 CI 的明细行 */
export interface PackingAmountLine {
  styleNo: string
  color: string
  size: string
  quantity: number
  /** 订单该 SKU 的加权单价（同一款多行单价不同时按数量加权） */
  unitPrice: number
  /** 本批金额 = quantity × unitPrice（用于纸面显示；合计以 goods 为准） */
  amount: number
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
  /** 本批明细（按 SKU 汇总）：批次 CI 直接用这份，不在渲染层另算 */
  lines: PackingAmountLine[]
  /** 本批费用行（按货值分摊；各行相加正好等于 charges） */
  chargeLines: QuotationCharge[]
  /** 箱明细里有、订单明细里没有的款号（单价无法确定，出 CI 前必须拦） */
  unknownSkus: string[]
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
  /** 本月退给客户的预收笔数：钱是流出，不在 monthReceived 里，只在界面上说破差异 */
  monthRefunded: number
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
export type ExportKind = 'orders' | 'orders_all' | 'payments' | 'items' | 'monthly' | 'statement'

export const EXPORT_FILE_NAME: Record<ExportKind, string> = {
  orders: '订单台账.csv',
  orders_all: '订单底稿_含草稿作废_仅供复盘.csv',
  payments: '收款台账.csv',
  items: '款号明细台账.csv',
  monthly: '月度汇总.csv',
  // 对账单默认名会带客户与截止日（见 dashboard.statementFileName），这里只是兜底
  statement: '客户对账单.csv'
}

/**
 * 导出台账时跟随订单列表的筛选（排序与分页不参与）。
 * 页面上筛出几张，Excel 里就该是几张——否则同一客户的对账单和页面合计对不上。
 */
export interface OrderExportFilter {
  keyword?: string
  paymentStatus?: string
  shipStatus?: string
  /** 客户对账单：只导这一家名下的单（与订单列表同一份 listWhere） */
  customerId?: number
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
  /** 下单抵扣实际抵掉的金额（打样单币种；0 = R15 之前的老记录，只抵过样品费） */
  offsetAmount: number
  /** 币种（应收要进工作台，必须记币种汇率） */
  currency: string
  /** 汇率：1 currency = exchangeRate 基准币 */
  exchangeRate: number
  /** 汇率日期 YYYY-MM-DD */
  exchangeRateDate: string
  /** 转成的订单 id（N24，转过就删不得） */
  convertedOrderId: number | null
  /** 转出的订单当前状态：已作废时允许按新单重转（列表里要给出入口） */
  convertedOrderStatus: PaymentStatus | null
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
  /** 实收流水合计（原币，R25）：未收单也可能是部分收款 */
  collected: number
  /** 待收（原币，R40）：服务层的唯一口径——已按取消/feeStatus/抵扣挂起筛过，界面只许读不许自己再减一遍 */
  owed: number
  /** 实收流水折基准币（无汇率为 null） */
  collectedBase: number | null
  /** 用客户预收抵扣的金额（原币，R27；非现金，只冲待收） */
  creditApplied: number
  /** 实收流水笔数；feeStatus=paid 且为 0 = 旧记录只改了旗子，月报里没有这笔 */
  flowCount: number
  /** 旧记录·无流水：历史「已向客户收」没有落过流水，金额按全额认已收但不可追溯 */
  legacyPaidNoFlow: boolean
  /** 抵扣暂不生效：转出的订单已退回草稿/失效/作废，样品费重新计入待收（R29） */
  offsetSuspended: boolean
  /** 公司净垫 = 公司总成本 − 已收回打样费（N33：真实垫了多少钱），基准币 */
  netAdvanceBase: number | null
  /** 待收（应收客户金额，折算基准币；feeStatus≠unpaid 或汇率缺失时为 0） */
  receivableBase: number
  /** 汇率未填但有应收（危险：工作台会少算，要提示补） */
  rateMissing: boolean
  /** 客户预收已把这单抵清（待收为 0；fee_status 仍是 unpaid——抵扣不是现金） */
  creditSettled: boolean
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
  /** 本月退给客户的预收笔数；钱是流出，没有并进 received，只在话术里说破 */
  refundCount: number
  /** 退款原币合计（按币种分列，如「1,200.00 USD · 800.00 CNY」）——无汇率快照，不折基准币 */
  refundText: string
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
  /** 最老那笔未收货款的下单日（本地日期；只有打样费的客户为 null） */
  oldestUnpaidDate: string | null
  /** 最老未收货款挂账天数（从下单日起算） */
  oldestUnpaidDays: number
}

/* ---------------- 客户预收（R27）：余额由 payments 现状派生，抵扣另记台账 ---------------- */

/** 一笔「已经收到、但不再属于某张单」的钱 */
export interface CustomerCreditSource {
  kind: 'order' | 'sample'
  docId: number
  docNo: string
  piNo: string
  date: string
  statusText: string
  currency: string
  exchangeRate: number
  /** 原币：多收的部分，或作废/取消/免单后留在账上的实收 */
  amount: number
}

/** 一笔预收抵扣（只记非现金的用途，撤销也留行） */
export interface CustomerCreditApplication {
  id: number
  currency: string
  amount: number
  targetKind: 'order' | 'sample'
  targetId: number
  targetNo: string
  appliedAt: string
  note: string
  actor: string
}

/** 客户在某个币种下的预收余额（原币） */
export interface CustomerCreditCurrency {
  currency: string
  /** 来源合计 = 多收 + 作废/取消/免单余款 */
  gross: number
  /** 已抵扣合计 */
  applied: number
  /** 已退还合计（真金白银退给客户，不再算余额） */
  refunded: number
  /** 可用 = gross − applied − refunded；来源单据后来被改小可能变负，界面必须亮红提示 */
  available: number
  sources: CustomerCreditSource[]
  applications: CustomerCreditApplication[]
  refunds: CustomerCreditRefund[]
}

/** 一笔预收退款（钱退还给客户的凭据；登记错了撤销，不删行） */
export interface CustomerCreditRefund {
  id: number
  currency: string
  amount: number
  refundAt: string
  bankRef: string
  note: string
  actor: string
}
