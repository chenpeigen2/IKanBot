import type {
  Customer,
  CustomerStats,
  DashboardStats,
  Incoterm,
  MonthlyReportRow,
  Order,
  OrderEvent,
  OrderItem,
  OrderPhoto,
  PackingList,
  Payment,
  PaymentMethod,
  PackingListLine,
  Product,
  ProductImage,
  Quotation,
  QuotationCharge,
  QuotationItem,
  Settlement,
  SkuSummary
} from '../../src/shared/types'

type Row = Record<string, unknown>

const num = (v: unknown): number => (v == null ? 0 : Number(v))
const str = (v: unknown): string => (v == null ? '' : String(v))
const optNum = (v: unknown): number | null => (v == null ? null : Number(v))
const optStr = (v: unknown): string | null => (v == null ? null : String(v))
/** 0/1 三态列：库里没这一列（升级前的老行）时返回 null，让读的人知道「当年没记」而不是「假的」 */
const optBool = (v: unknown): boolean | null => (v == null ? null : Number(v) === 1)

function parseArray(v: unknown): string[] {
  try {
    const parsed = JSON.parse(str(v) || '[]')
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function parseCharges(v: unknown): QuotationCharge[] {
  try {
    const parsed = JSON.parse(str(v) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((c) => ({ label: String(c?.label ?? ''), amount: Number(c?.amount ?? 0) }))
      .filter((c) => c.label)
  } catch {
    return []
  }
}

export function mapProduct(r: Row): Product {
  return {
    id: num(r.id),
    styleNo: str(r.style_no),
    name: str(r.name),
    composition: str(r.composition),
    category: str(r.category),
    brand: str(r.brand),
    season: str(r.season),
    costPrice: optNum(r.cost_price),
    sizes: parseArray(r.sizes),
    colors: parseArray(r.colors),
    unitNetWeight: optNum(r.unit_net_weight),
    boxPieces: optNum(r.box_pieces),
    boxLength: optNum(r.box_length),
    boxWidth: optNum(r.box_width),
    boxHeight: optNum(r.box_height),
    factory: str(r.factory),
    factoryNo: str(r.factory_no),
    note: str(r.note),
    active: num(r.active),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at)
  }
}

export function mapProductImage(r: Row): ProductImage {
  return {
    id: num(r.id),
    productId: num(r.product_id),
    fileName: str(r.file_name),
    isPrimary: num(r.is_primary),
    sortOrder: num(r.sort_order)
  }
}

export function mapCustomer(r: Row): Customer {
  return {
    id: num(r.id),
    company: str(r.company),
    contact: str(r.contact),
    email: str(r.email),
    phone: str(r.phone),
    country: str(r.country),
    address: str(r.address),
    zipCode: str(r.zip_code),
    attn: str(r.attn),
    paymentPref: str(r.payment_pref),
    shipAttn: str(r.ship_attn),
    shipAddress: str(r.ship_address),
    shipZipCode: str(r.ship_zip_code),
    shipCountry: str(r.ship_country),
    active: num(r.active),
    defaultPaymentMethod: str(r.default_payment_method) as PaymentMethod | '',
    defaultDepositRatio: optNum(r.default_deposit_ratio),
    defaultIncoterm: str(r.default_incoterm) as Incoterm | '',
    defaultPortLoading: str(r.default_port_loading),
    defaultPortDestination: str(r.default_port_destination),
    note: str(r.note),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at)
  }
}

export function mapOrder(r: Row): Order {
  return {
    id: num(r.id),
    orderNo: str(r.order_no),
    customerId: num(r.customer_id),
    piNo: str(r.pi_no),
    paymentStatus: str(r.payment_status) as Order['paymentStatus'],
    shipStatus: str(r.ship_status) as Order['shipStatus'],
    currency: str(r.currency) as Order['currency'],
    exchangeRate: num(r.exchange_rate),
    baseCurrency: str(r.base_currency) as Order['baseCurrency'],
    incoterm: str(r.incoterm) as Order['incoterm'],
    portOfLoading: str(r.port_of_loading),
    portOfDestination: str(r.port_of_destination),
    paymentMethod: str(r.payment_method) as Order['paymentMethod'],
    depositRatio: num(r.deposit_ratio),
    validUntil: optStr(r.valid_until),
    expectedShipDate: optStr(r.expected_ship_date),
    expectedArrivalDate: optStr(r.expected_arrival_date),
    customerPo: str(r.customer_po),
    note: str(r.note),
    exchangeRateDate: optStr(r.exchange_rate_date),
    factory: str(r.factory),
    factoryDueDate: optStr(r.factory_due_date),
    cutOffDate: optStr(r.cut_off_date),
    etdDate: optStr(r.etd_date),
    vessel: str(r.vessel),
    sealNo: str(r.seal_no),
    charges: parseCharges(r.charges),
    sourceQuotationId: optNum(r.source_quotation_id),
    sourceRevision: optNum(r.source_revision),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at)
  }
}

export function mapOrderPhoto(r: Row): OrderPhoto {
  return {
    id: num(r.id),
    orderId: num(r.order_id),
    fileName: str(r.file_name),
    kind: str(r.kind) as OrderPhoto['kind'],
    note: str(r.note),
    createdAt: str(r.created_at)
  }
}

export function mapQuotation(r: Row): Quotation {
  return {
    id: num(r.id),
    qNo: str(r.q_no),
    customerId: num(r.customer_id),
    status: str(r.status) as Quotation['status'],
    result: str(r.result) as Quotation['result'],
    currency: str(r.currency) as Quotation['currency'],
    exchangeRate: num(r.exchange_rate),
    baseCurrency: str(r.base_currency) as Quotation['baseCurrency'],
    incoterm: str(r.incoterm) as Quotation['incoterm'],
    portOfLoading: str(r.port_of_loading),
    portOfDestination: str(r.port_of_destination),
    paymentMethod: str(r.payment_method) as Quotation['paymentMethod'],
    depositRatio: num(r.deposit_ratio),
    validUntil: optStr(r.valid_until),
    customerPo: str(r.customer_po),
    note: str(r.note),
    charges: parseCharges(r.charges),
    convertedOrderId: optNum(r.converted_order_id),
    exchangeRateDate: optStr(r.exchange_rate_date),
    revision: num(r.revision),
    sentAt: optStr(r.sent_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at)
  }
}

export function mapQuotationItem(r: Row): QuotationItem {
  return {
    id: num(r.id),
    quotationId: num(r.quotation_id),
    productId: optNum(r.product_id),
    styleNo: str(r.style_no),
    productName: str(r.product_name),
    composition: str(r.composition),
    color: str(r.color),
    size: str(r.size),
    quantity: num(r.quantity),
    unitPrice: num(r.unit_price)
  }
}

export function mapOrderItem(r: Row): OrderItem {
  return {
    id: num(r.id),
    orderId: num(r.order_id),
    productId: optNum(r.product_id),
    styleNo: str(r.style_no),
    productName: str(r.product_name),
    composition: str(r.composition),
    color: str(r.color),
    size: str(r.size),
    quantity: num(r.quantity),
    unitPrice: num(r.unit_price),
    unitCost: optNum(r.unit_cost)
  }
}

export function mapPayment(r: Row): Payment {
  return {
    id: num(r.id),
    orderId: r.order_id == null ? null : num(r.order_id),
    sampleOrderId: r.sample_order_id == null ? null : num(r.sample_order_id),
    paidAt: str(r.paid_at),
    amount: num(r.amount),
    method: str(r.method),
    bankRef: str(r.bank_ref),
    note: str(r.note),
    exchangeRate: r.exchange_rate == null ? null : num(r.exchange_rate),
    createdAt: str(r.created_at)
  }
}

export function mapSettlement(r: Row): Settlement {
  return {
    id: num(r.id),
    orderId: num(r.order_id),
    kind: str(r.kind) as Settlement['kind'],
    amount: num(r.amount),
    reason: str(r.reason),
    evidence: str(r.evidence),
    reversesId: optNum(r.reverses_id),
    paymentId: optNum(r.payment_id),
    at: str(r.at),
    createdAt: str(r.created_at)
  }
}

export function mapPackingListLine(r: Row): PackingListLine {
  return {
    id: num(r.id),
    packingListId: num(r.packing_list_id),
    boxNo: str(r.box_no),
    styleNo: str(r.style_no),
    productName: str(r.product_name),
    color: str(r.color),
    size: str(r.size),
    quantity: num(r.quantity),
    netWeight: optNum(r.net_weight),
    grossWeight: optNum(r.gross_weight),
    grossEst: optBool(r.gross_est),
    boxLength: optNum(r.box_length),
    boxWidth: optNum(r.box_width),
    boxHeight: optNum(r.box_height)
  }
}

export function mapPackingList(r: Row, lines: PackingListLine[]): PackingList {
  return {
    id: num(r.id),
    orderId: num(r.order_id),
    plNo: str(r.pl_no),
    containerNo: str(r.container_no),
    shipStatus: (optStr(r.ship_status) as PackingList['shipStatus']) ?? null,
    vessel: str(r.vessel),
    etdDate: optStr(r.etd_date),
    atdDate: optStr(r.atd_date),
    etaDate: optStr(r.eta_date),
    sealNo: str(r.seal_no),
    blNo: str(r.bl_no),
    deliveredAt: optStr(r.delivered_at),
    receivedQty: r.received_qty == null ? null : num(r.received_qty),
    docDate: optStr(r.doc_date),
    voidedAt: optStr(r.voided_at),
    note: str(r.note),
    createdAt: str(r.created_at),
    lines
  }
}

export function mapEvent(r: Row): OrderEvent {
  return {
    id: num(r.id),
    orderId: num(r.order_id),
    at: str(r.at),
    actor: str(r.actor),
    kind: str(r.kind),
    fromStatus: optStr(r.from_status),
    toStatus: optStr(r.to_status),
    note: str(r.note)
  }
}

export function mapCustomerStats(r: Row): CustomerStats {
  return {
    orderCount: num(r.order_count),
    excludedOrderCount: num(r.excluded_order_count),
    totalAmount: num(r.total_amount),
    totalProfit: r.total_profit == null ? null : num(r.total_profit),
    outstanding: num(r.outstanding),
    outstandingOrders: num(r.outstanding_orders),
    outstandingSamples: num(r.outstanding_samples),
    sampleCount: num(r.sample_count),
    badDebt: num(r.bad_debt),
    missingCostOrders: num(r.missing_cost_orders)
  }
}

export function mapSkuSummary(r: Row): SkuSummary {
  const quantity = num(r.quantity)
  const packedQuantity = num(r.packed_quantity)
  return {
    styleNo: str(r.style_no),
    productName: str(r.product_name),
    color: str(r.color),
    size: str(r.size),
    quantity,
    packedQuantity,
    remainingQuantity: Math.max(0, quantity - packedQuantity)
  }
}

export function mapDashboard(r: Row): DashboardStats {
  return {
    activeOrders: num(r.active_orders),
    pendingAmount: num(r.pending_amount),
    pendingShipOrders: num(r.pending_ship_orders),
    completedThisMonth: num(r.completed_this_month),
    monthSales: num(r.month_sales),
    monthProfit: r.month_profit == null ? null : num(r.month_profit),
    monthProfitReliable: true,
    monthReceived: num(r.month_received),
    monthUnconverted: num(r.month_unconverted),
    monthRefunded: num(r.month_refunded),
    monthNewOrders: num(r.month_new_orders),
    // 待收拆分与坏账是内存里算出来的，由 services/dashboard.ts 覆盖这几个 0
    pendingUnconfirmed: 0,
    pendingDeposit: 0,
    pendingBalance: 0,
    pendingSample: 0,
    outstandingBadDebt: 0,
    currency: str(r.currency) as DashboardStats['currency']
  }
}

export function mapMonthlyReport(r: Row): MonthlyReportRow {
  return {
    month: str(r.month),
    orders: num(r.orders),
    sales: num(r.sales),
    cost: num(r.cost),
    profit: r.profit == null ? null : num(r.profit),
    discount: num(r.discount),
    shortage: num(r.shortage),
    badDebt: num(r.bad_debt),
    received: num(r.received),
    unconvertedCount: num(r.unconverted_count),
    refundCount: num(r.refund_count),
    refundText: str(r.refund_text),
    missingCostOrders: num(r.missing_cost_orders)
  }
}
