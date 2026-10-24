/**
 * 报价单（Quotation）—— 下单之前的环节。
 *
 * 关键约定：报价单存在自己的表里，完全不参与销售额 / 毛利 / 待收款统计，
 * 也不会出现在订单列表里。它只有一个出口：转成正式订单。
 */
import { getDb, nextNo } from '../db'
import { mapQuotation, mapQuotationItem, mapCustomer } from '../db/mappers'
import { getSettings } from './settings'
import { createOrder, getOrder, logEvent } from './orders'
import { computeOrderMoney } from './money'
import { localDate, addDays } from '../../src/shared/date'
import type {
  Currency,
  Incoterm,
  OrderDetail,
  PaymentMethod,
  Quotation,
  QuotationCharge,
  QuotationDetail,
  QuotationResult,
  QuotationStatus,
  QuotationVersionSummary
} from '../../src/shared/types'

function now(): string {
  return new Date().toISOString()
}

export interface QuotationItemInput {
  productId?: number | null
  styleNo: string
  productName?: string
  composition?: string
  color?: string
  size?: string
  quantity: number
  unitPrice: number
}

export interface QuotationInput {
  id?: number
  customerId: number
  currency?: Currency
  exchangeRate?: number
  /** 汇率锁定日期 YYYY-MM-DD：填汇率时记下哪天的 */
  exchangeRateDate?: string | null
  baseCurrency?: Currency
  incoterm?: Incoterm
  portOfLoading?: string
  portOfDestination?: string
  paymentMethod?: PaymentMethod
  depositRatio?: number
  validUntil?: string | null
  customerPo?: string
  note?: string
  status?: QuotationStatus
  result?: QuotationResult
  charges?: QuotationCharge[]
  items: QuotationItemInput[]
}

function mapCustomerLocal(row: Record<string, unknown> | null) {
  return row ? mapCustomer(row) : null
}

/** 按款号在商品库里找款（大小写不敏感） */
function findProductByStyleNo(styleNo: string): { id: number; cost_price: number | null } | null {
  const key = String(styleNo ?? '').trim()
  if (!key) return null
  const row = getDb().get('SELECT id, cost_price FROM products WHERE UPPER(style_no) = UPPER(?) LIMIT 1', [
    key
  ]) as { id?: number; cost_price?: number | null } | null
  return row?.id ? { id: Number(row.id), cost_price: row.cost_price ?? null } : null
}

function findProductIdByStyleNo(styleNo: string): number | null {
  return findProductByStyleNo(styleNo)?.id ?? null
}

function hydrate(q: Quotation): QuotationDetail {
  const db = getDb()
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [q.customerId]) as Record<string, unknown> | null
  const items = (
    db.all('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id', [q.id]) as Record<string, unknown>[]
  ).map(mapQuotationItem)
  // 金额口径统一走 services/money.ts（唯一真源）
  const m = computeOrderMoney({
    items: items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, unitCost: null })),
    charges: q.charges,
    payments: [],
    depositRatio: q.depositRatio
  })
  return {
    ...q,
    customer: mapCustomerLocal(customerRow),
    items,
    totalAmount: m.goodsValue,
    totalQuantity: m.totalQuantity,
    chargesTotal: m.chargesTotal,
    grandTotal: m.grandTotal
  }
}

/* ---------------- 版本快照 ---------------- */

export interface QuotationSnapshot {
  qNo: string
  customerId: number
  currency: Currency
  exchangeRate: number
  exchangeRateDate: string | null
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
  items: QuotationItemInput[]
}

/** 把报价单当前内容冻结成某一版（同一版只存一次，不覆盖） */
function freezeQuotationVersion(qId: number, revision: number): void {
  const db = getDb()
  const row = db.get('SELECT * FROM quotations WHERE id = ?', [qId]) as Record<string, unknown> | null
  if (!row) return
  const items = (
    db.all(
      `SELECT product_id, style_no, product_name, composition, color, size, quantity, unit_price
       FROM quotation_items WHERE quotation_id = ? ORDER BY id`,
      [qId]
    ) as Record<string, unknown>[]
  ).map((r) => ({
    productId: r.product_id == null ? null : Number(r.product_id),
    styleNo: String(r.style_no ?? ''),
    productName: String(r.product_name ?? ''),
    composition: String(r.composition ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    quantity: Number(r.quantity ?? 0),
    unitPrice: Number(r.unit_price ?? 0)
  }))
  let charges: QuotationCharge[] = []
  try {
    const parsed = JSON.parse(String(row.charges ?? '[]'))
    if (Array.isArray(parsed)) charges = parsed
  } catch {
    charges = []
  }
  const snap: QuotationSnapshot = {
    qNo: String(row.q_no ?? ''),
    customerId: Number(row.customer_id),
    currency: String(row.currency ?? 'USD') as Currency,
    exchangeRate: Number(row.exchange_rate ?? 0),
    exchangeRateDate: row.exchange_rate_date == null ? null : String(row.exchange_rate_date),
    baseCurrency: String(row.base_currency ?? 'CNY') as Currency,
    incoterm: String(row.incoterm ?? 'FOB') as Incoterm,
    portOfLoading: String(row.port_of_loading ?? ''),
    portOfDestination: String(row.port_of_destination ?? ''),
    paymentMethod: String(row.payment_method ?? 'tt_deposit') as PaymentMethod,
    depositRatio: Number(row.deposit_ratio ?? 0),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    customerPo: String(row.customer_po ?? ''),
    note: String(row.note ?? ''),
    charges,
    items
  }
  const goodsTotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
  const grandTotal = goodsTotal + charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  db.run(
    `INSERT OR IGNORE INTO quotation_versions(quotation_id, revision, snapshot_json, goods_total, grand_total, created_at)
     VALUES(?,?,?,?,?,?)`,
    [qId, revision, JSON.stringify(snap), goodsTotal, grandTotal, now()]
  )
}

/** 老报价没有存档时，把当前内容补成「升级前的这一版」，不重算历史 */
function ensureQuotationVersion(qId: number, revision: number): void {
  const db = getDb()
  const has = db.get('SELECT id FROM quotation_versions WHERE quotation_id = ? LIMIT 1', [qId])
  if (!has) freezeQuotationVersion(qId, revision)
}

export function listQuotationVersions(id: number): QuotationVersionSummary[] {
  const db = getDb()
  const q = db.get('SELECT revision FROM quotations WHERE id = ?', [id]) as { revision?: number } | null
  if (!q) throw new Error('报价单不存在')
  ensureQuotationVersion(id, Number(q.revision ?? 1))
  const rows = db.all(
    `SELECT revision, goods_total, grand_total, snapshot_json, created_at
     FROM quotation_versions WHERE quotation_id = ? ORDER BY revision DESC`,
    [id]
  ) as Record<string, unknown>[]
  return rows.map((r) => {
    let itemCount = 0
    let validUntil = ''
    try {
      const snap = JSON.parse(String(r.snapshot_json ?? '{}')) as QuotationSnapshot
      itemCount = Array.isArray(snap.items) ? snap.items.length : 0
      validUntil = snap.validUntil ?? ''
    } catch {
      itemCount = 0
    }
    return {
      revision: Number(r.revision ?? 0),
      goodsTotal: Number(r.goods_total ?? 0),
      grandTotal: Number(r.grand_total ?? 0),
      createdAt: String(r.created_at ?? ''),
      itemCount,
      validUntil
    }
  })
}

export function listQuotations(filter: {
  keyword?: string
  customerId?: number
  status?: string
  result?: string
} = {}): QuotationDetail[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number)[] = []
  const kw = (filter.keyword ?? '').trim()
  if (kw) {
    // 搜索范围：报价号 / 客户PO号 / 客户名 / 款号（客户问「上次那个款报多少」也能翻出来）
    where.push(
      `(q.q_no LIKE ? OR q.customer_po LIKE ? OR c.company LIKE ?
        OR EXISTS (SELECT 1 FROM quotation_items qi WHERE qi.quotation_id = q.id AND qi.style_no LIKE ?))`
    )
    const k = `%${kw}%`
    params.push(k, k, k, k)
  }
  if (filter.customerId) {
    where.push('q.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.status) {
    where.push('q.status = ?')
    params.push(filter.status)
  }
  if (filter.result) {
    where.push('q.result = ?')
    params.push(filter.result)
  }
  const rows = db.all(
    `SELECT q.* FROM quotations q JOIN customers c ON c.id = q.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY q.created_at DESC, q.id DESC`,
    params
  ) as Record<string, unknown>[]
  return rows.map((r) => hydrate(mapQuotation(r)))
}

export function getQuotation(id: number): QuotationDetail | null {
  const row = getDb().get('SELECT * FROM quotations WHERE id = ?', [id]) as Record<string, unknown> | null
  if (!row) return null
  return hydrate(mapQuotation(row))
}

export function saveQuotation(input: QuotationInput): QuotationDetail {
  const db = getDb()
  const ts = now()
  const settings = getSettings()
  const charges = JSON.stringify((input.charges ?? []).filter((c) => c.label.trim()))
  const validUntil = input.validUntil ?? addDays(localDate(), settings.piValidDays)
  // 汇率必须手动填：系统不拿默认值蒙人，也不替人编锁定日期
  const rate = Number(input.exchangeRate ?? 0)
  if (!rate || rate <= 0) throw new Error('请先按今天钉盘的汇率填写汇率')

  let qId = input.id
  let rateDate = input.exchangeRateDate ?? null
  let revision = 1
  let status: QuotationStatus = input.status ?? 'draft'
  let result: QuotationResult = input.result ?? 'pending'
  let changeNote = ''

  if (qId) {
    const before = db.get('SELECT * FROM quotations WHERE id = ?', [qId]) as Record<string, unknown> | null
    if (!before) throw new Error('报价单不存在')
    // 已转订单的报价单是那单的原始报价凭据：价格、明细、费用事后一改，
    // 订单和报价单就对不上了，客户拿两份纸来问谁也说不清
    if (before.converted_order_id) {
      const o = db.get('SELECT order_no FROM orders WHERE id = ?', [Number(before.converted_order_id)]) as
        | { order_no?: string }
        | null
      throw new Error(
        `报价单 ${before.q_no} 已经转成订单 ${o?.order_no ?? ''}，是那单的原始报价凭据，不能再改。要改价格请直接改订单。`
      )
    }
    const oldItems = (
      db.all('SELECT style_no, color, size, quantity, unit_price FROM quotation_items WHERE quotation_id = ? ORDER BY id', [
        qId
      ]) as Record<string, unknown>[]
    ).map((r) => ({
      styleNo: String(r.style_no),
      color: String(r.color),
      size: String(r.size),
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price)
    }))
    const oldCharges = (() => {
      try {
        return JSON.parse(String(before.charges ?? '[]')) as QuotationCharge[]
      } catch {
        return [] as QuotationCharge[]
      }
    })()
    const oldRate = Number(before.exchange_rate)
    const oldDate = (before.exchange_rate_date as string | null) ?? null
    // 汇率没变就沿用原来的日期；变了就记今天（谁改的谁负责）
    if (!rateDate) rateDate = oldRate === rate ? oldDate ?? localDate() : localDate()
    // 状态/结果没传就保持原样（编辑一张已转订单的报价单不能把状态打回草稿）
    status = input.status ?? (before.status as QuotationStatus)
    result = input.result ?? (before.result as QuotationResult)
    revision = Number(before.revision ?? 1) + 1
    changeNote = describeChange(oldItems, input.items, oldCharges, input.charges ?? [])
    // 条款也是报价的一部分：改 FOB/CIF、付款方式、有效期、汇率必须留痕
    const termBits: string[] = []
    const nextIncoterm = input.incoterm ?? (before.incoterm as Incoterm)
    const nextPayment = input.paymentMethod ?? (before.payment_method as PaymentMethod)
    if (nextIncoterm !== before.incoterm) termBits.push(`贸易术语 ${before.incoterm} → ${nextIncoterm}`)
    if (nextPayment !== before.payment_method) termBits.push(`付款方式 ${before.payment_method} → ${nextPayment}`)
    if (validUntil !== before.valid_until) termBits.push(`有效期 ${before.valid_until || '未填'} → ${validUntil || '未填'}`)
    if (Math.abs(oldRate - rate) > 0.0001) termBits.push(`汇率 ${oldRate} → ${rate}`)
    if (termBits.length) changeNote = changeNote ? `${changeNote}；${termBits.join('；')}` : termBits.join('；')

    // 改之前先把当前版冻结：客户手里那张纸必须能原样找回来
    freezeQuotationVersion(qId, Number(before.revision ?? 1))

    db.run(
      `UPDATE quotations SET customer_id=?, currency=?, exchange_rate=?, exchange_rate_date=?, base_currency=?, incoterm=?,
        port_of_loading=?, port_of_destination=?, payment_method=?, deposit_ratio=?, valid_until=?,
        customer_po=?, note=?, charges=?, status=?, result=?, revision=?, updated_at=? WHERE id=?`,
      [
        input.customerId,
        input.currency ?? 'USD',
        rate,
        rateDate,
        input.baseCurrency ?? settings.baseCurrency,
        input.incoterm ?? 'FOB',
        input.portOfLoading ?? '',
        input.portOfDestination ?? '',
        input.paymentMethod ?? 'tt_deposit',
        input.depositRatio ?? settings.defaultDepositRatio,
        validUntil,
        input.customerPo ?? '',
        input.note ?? '',
        charges,
        status,
        result,
        revision,
        ts,
        qId
      ]
    )
    db.run('DELETE FROM quotation_items WHERE quotation_id = ?', [qId])
  } else {
    if (!rateDate) rateDate = localDate()
    const qNo = nextNo('Q')
    const res = db.run(
      `INSERT INTO quotations(q_no, customer_id, status, result, currency, exchange_rate, exchange_rate_date, base_currency, incoterm,
        port_of_loading, port_of_destination, payment_method, deposit_ratio, valid_until, customer_po, note,
        charges, converted_order_id, revision, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)`,
      [
        qNo,
        input.customerId,
        status,
        result,
        input.currency ?? 'USD',
        rate,
        rateDate,
        input.baseCurrency ?? settings.baseCurrency,
        input.incoterm ?? 'FOB',
        input.portOfLoading ?? '',
        input.portOfDestination ?? '',
        input.paymentMethod ?? 'tt_deposit',
        input.depositRatio ?? settings.defaultDepositRatio,
        validUntil,
        input.customerPo ?? '',
        input.note ?? '',
        charges,
        ts,
        ts
      ]
    )
    qId = Number(res.lastInsertRowid)
  }

  for (const it of input.items) {
    // 手工加的行：按款号在商品库里找一下，找到就把 product_id 记上（转订单时能带出成本价）
    const productId = it.productId ?? findProductIdByStyleNo(it.styleNo)
    db.run(
      `INSERT INTO quotation_items(quotation_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        qId,
        productId,
        it.styleNo ?? '',
        it.productName ?? '',
        it.composition ?? '',
        it.color ?? '',
        it.size ?? '',
        it.quantity,
        it.unitPrice
      ]
    )
  }
  freezeQuotationVersion(qId, revision)
  logQuotationEvent(qId, input.id ? 'update' : 'create', changeNote || (input.id ? '修改报价单' : '新建报价单'))
  return getQuotation(qId)!
}

/** 生成「改了什么」的人话记录 */
function describeChange(
  oldItems: { styleNo: string; color: string; size: string; quantity: number; unitPrice: number }[],
  newItems: QuotationItemInput[],
  oldCharges: QuotationCharge[],
  newCharges: QuotationCharge[]
): string {
  const parts: string[] = []
  const key = (i: { styleNo?: string; color?: string; size?: string }) =>
    `${i.styleNo ?? ''}|${i.color ?? ''}|${i.size ?? ''}`
  const oldMap = new Map(oldItems.map((i) => [key(i), i]))
  const newMap = new Map(newItems.map((i) => [key(i), i]))
  // 尺码换了：同一个款号+颜色，旧行没匹配上就配对，报「尺码 M → L」
  const styleColor = (i: { styleNo?: string; color?: string }) => `${i.styleNo ?? ''}|${i.color ?? ''}`
  const usedOld = new Set<string>()
  const usedNew = new Set<string>()
  for (const [k, ni] of newMap) {
    if (!oldMap.has(k)) continue
    usedNew.add(k)
    usedOld.add(k)
    const oi = oldMap.get(k)!
    if (oi.quantity !== ni.quantity) parts.push(`${k.replace(/\|/g, '/')} 数量 ${oi.quantity} → ${ni.quantity}`)
    if (Math.abs(oi.unitPrice - ni.unitPrice) > 0.0001)
      parts.push(`${k.replace(/\|/g, '/')} 单价 ${oi.unitPrice} → ${ni.unitPrice}`)
  }
  for (const [k, ni] of newMap) {
    if (usedNew.has(k)) continue
    const cands = oldItems.filter((o) => !usedOld.has(key(o)) && styleColor(o) === styleColor(ni))
    if (cands.length === 1) {
      const cand = cands[0]
      usedOld.add(key(cand))
      usedNew.add(k)
      const bits: string[] = []
      if (cand.size !== ni.size) bits.push(`尺码 ${cand.size} → ${ni.size}`)
      if (cand.quantity !== ni.quantity) bits.push(`数量 ${cand.quantity} → ${ni.quantity}`)
      if (Math.abs(cand.unitPrice - ni.unitPrice) > 0.0001) bits.push(`单价 ${cand.unitPrice} → ${ni.unitPrice}`)
      if (bits.length) parts.push(`${styleColor(ni).replace(/\|/g, '/')} ${bits.join('，')}`)
    }
  }
  for (const [k, ni] of newMap) {
    if (!usedNew.has(k)) parts.push(`新增 ${k.replace(/\|/g, '/')} ×${ni.quantity}`)
  }
  for (const [k, oi] of oldMap) {
    if (!usedOld.has(k)) parts.push(`删除 ${k.replace(/\|/g, '/')} ×${oi.quantity}`)
  }
  const oldChargeMap = new Map(oldCharges.map((c) => [c.label, c.amount]))
  const newChargeMap = new Map(newCharges.filter((c) => c.label.trim()).map((c) => [c.label, c.amount]))
  for (const [label, amt] of newChargeMap) {
    const old = oldChargeMap.get(label)
    if (old === undefined) parts.push(`新增费用 ${label} ${amt}`)
    else if (Math.abs(old - amt) > 0.0001) parts.push(`费用 ${label} ${old} → ${amt}`)
  }
  for (const [label, amt] of oldChargeMap) {
    if (!newChargeMap.has(label)) parts.push(`删除费用 ${label} ${amt}`)
  }
  if (parts.length === 0) return '修改报价单'
  return `修改报价单：${parts.join('；')}`
}

/** 报价单自己的操作历史（改了什么、什么时候改的） */
export function logQuotationEvent(quotationId: number, kind: string, note: string): void {
  getDb().run('INSERT INTO quotation_events(quotation_id, at, kind, note) VALUES(?,?,?,?)', [
    quotationId,
    now(),
    kind,
    note
  ])
}

export function listQuotationEvents(quotationId: number): { id: number; at: string; kind: string; note: string }[] {
  const rows = getDb().all(
    'SELECT id, at, kind, note FROM quotation_events WHERE quotation_id = ? ORDER BY id DESC',
    [quotationId]
  ) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: Number(r.id),
    at: String(r.at),
    kind: String(r.kind),
    note: String(r.note)
  }))
}

export function deleteQuotation(id: number): void {
  const db = getDb()
  const q = db.get('SELECT q_no, converted_order_id FROM quotations WHERE id = ?', [id]) as
    | { q_no?: string; converted_order_id?: number | null }
    | null
  if (!q) return
  // N31：已转成订单的报价单是那单的原始报价凭据，删了以后订单操作历史里只剩一个查不到的编号
  if (q.converted_order_id) {
    const o = db.get('SELECT order_no FROM orders WHERE id = ?', [Number(q.converted_order_id)]) as
      | { order_no?: string }
      | null
    if (o?.order_no) {
      throw new Error(
        `报价单 ${q.q_no} 已经转成订单 ${o.order_no}，删了以后就查不到原始报价了。\n` +
          `要作废请把「状态」改成「已失效」，报价记录和版本存档都保留。`
      )
    }
  }
  db.run('DELETE FROM quotations WHERE id = ?', [id])
}

/** 改状态 / 改报价结果 */
export function updateQuotationMeta(
  id: number,
  meta: { status?: QuotationStatus; result?: QuotationResult }
): QuotationDetail {
  const db = getDb()
  const cur = db.get('SELECT status, result FROM quotations WHERE id = ?', [id]) as
    | { status: string; result: string }
    | null
  if (!cur) throw new Error('报价单不存在')
  db.run('UPDATE quotations SET status=?, result=?, updated_at=? WHERE id=?', [
    meta.status ?? cur.status,
    meta.result ?? cur.result,
    now(),
    id
  ])
  const parts: string[] = []
  if (meta.status && meta.status !== cur.status) parts.push(`状态 ${cur.status} → ${meta.status}`)
  if (meta.result && meta.result !== cur.result) parts.push(`结果 ${cur.result} → ${meta.result}`)
  if (parts.length) logQuotationEvent(id, 'meta', parts.join('；'))
  return getQuotation(id)!
}

/**
 * 报价单转订单：款号、颜色、尺码、数量、单价一个数字都不用重敲。
 * 转出来的订单是「草稿」状态，由业务员核对后再发 PI。
 */
export function convertToOrder(
  id: number,
  opts: {
    paymentStatus?: 'draft' | 'sent'
    /** 按第几版转；不填 = 当前最新版 */
    revision?: number
    /** 过期报价要沿用：必须写清批准人和原因 */
    override?: { approvedBy?: string; reason?: string }
  } = {}
): OrderDetail {
  const q = getQuotation(id)
  if (!q) throw new Error('报价单不存在')
  if (q.convertedOrderId) {
    const exist = getOrder(q.convertedOrderId)
    if (exist) return exist
  }
  // 汇率日期必须是真的：没有就不许转单，绝不拿转单当天冒充
  if (!q.exchangeRateDate) {
    throw new Error('这张报价单没有汇率日期，请先编辑报价单把汇率日期补上再转订单')
  }

  const db = getDb()
  ensureQuotationVersion(id, Number(q.revision ?? 1))
  const targetRevision = Number(opts.revision ?? q.revision ?? 1)
  const versionRow = db.get('SELECT snapshot_json, grand_total FROM quotation_versions WHERE quotation_id = ? AND revision = ?', [
    id,
    targetRevision
  ]) as { snapshot_json?: string; grand_total?: number } | null
  if (!versionRow) {
    throw new Error(
      `报价单 ${q.qNo} 没有第 ${targetRevision} 版的存档（最早存档从升级后的修改开始）。请选一个已有版本，或重新保存后再转。`
    )
  }
  let snap: QuotationSnapshot
  try {
    snap = JSON.parse(String(versionRow.snapshot_json ?? '')) as QuotationSnapshot
  } catch {
    throw new Error(`报价单 ${q.qNo} 第 ${targetRevision} 版的存档读不出来，不能拿它转单。请在报价页重新保存一版。`)
  }
  const snapGrand = Number(versionRow.grand_total ?? 0)

  // 有效期是锁汇的承诺：过期、失效、丢单都必须有人明确批准才能沿用
  const today = localDate()
  const expired =
    q.status === 'expired' ||
    Boolean(snap.validUntil && snap.validUntil < today)
  const approvedBy = String(opts.override?.approvedBy ?? '').trim()
  const overrideReason = String(opts.override?.reason ?? '').trim()
  if (expired && (!approvedBy || !overrideReason)) {
    throw new Error(
      `报价单 ${q.qNo} 的有效期是 ${snap.validUntil || '未填'}，已经过期。` +
        `要按旧价转单，必须填写批准人和沿用原因；否则请先重报一版。`
    )
  }

  const currentGrand = q.grandTotal
  const diff = snapGrand - currentGrand
  const overrideNote = expired
    ? `报价已过期，经 ${approvedBy} 批准沿用（原因：${overrideReason}）`
    : ''

  db.exec('BEGIN')
  try {
    const order = createOrder({
      customerId: snap.customerId,
      currency: snap.currency,
      exchangeRate: snap.exchangeRate,
      exchangeRateDate: snap.exchangeRateDate,
      baseCurrency: snap.baseCurrency,
      incoterm: snap.incoterm,
      portOfLoading: snap.portOfLoading,
      portOfDestination: snap.portOfDestination,
      paymentMethod: snap.paymentMethod,
      depositRatio: snap.depositRatio,
      validUntil: snap.validUntil,
      customerPo: snap.customerPo,
      charges: snap.charges,
      note: [`由报价单 ${snap.qNo} 第 ${targetRevision} 版转成`, snap.note].filter(Boolean).join('；'),
      // 转订单的落点状态：PI 已发 = 待确认（sent），否则草稿
      paymentStatus: opts.paymentStatus ?? 'sent'
    })

    for (const it of snap.items) {
      // 成本价：先按商品 id 找，找不到就按款号在商品库里找（手工加的行也能带上成本）
      let productId = it.productId ?? null
      let cost: number | null = null
      if (productId) {
        const p = db.get('SELECT id, cost_price FROM products WHERE id = ?', [productId]) as
          | { id?: number; cost_price?: number | null }
          | null
        // 商品被删过：ID 悬空就置空，别让订单明细指着一个不存在的款
        if (!p) productId = null
        else cost = p.cost_price ?? null
      }
      if (cost == null) {
        const byStyle = findProductByStyleNo(it.styleNo)
        if (byStyle) {
          productId = byStyle.id
          cost = byStyle.cost_price
        }
      }
      db.run(
        `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          order.id,
          productId,
          it.styleNo ?? '',
          it.productName ?? '',
          it.composition ?? '',
          it.color ?? '',
          it.size ?? '',
          it.quantity,
          it.unitPrice,
          cost
        ]
      )
    }
    db.run('UPDATE orders SET source_quotation_id = ?, source_revision = ?, updated_at = ? WHERE id = ?', [
      id,
      targetRevision,
      now(),
      order.id
    ])
    if (overrideNote) {
      db.run('UPDATE orders SET note = ? WHERE id = ?', [`${overrideNote}；${snap.note}`.replace(/^；/, ''), order.id])
    }
    const saved = getOrder(order.id)!
    if (Math.abs(saved.grandTotal - snapGrand) > 0.005) {
      throw new Error(
        `按第 ${targetRevision} 版转单后金额对不上：存档合计 ${snapGrand.toFixed(2)}，订单算出来 ${saved.grandTotal.toFixed(2)}。已回滚，请检查报价明细。`
      )
    }
    logEvent(
      order.id,
      'quotation_convert',
      null,
      null,
      `由报价单 ${snap.qNo} 第 ${targetRevision} 版转成订单，商品明细原样带入（汇率 ${snap.exchangeRate}，汇率日期 ${snap.exchangeRateDate}）` +
        (targetRevision !== Number(q.revision ?? 1)
          ? `；当前最新第 ${q.revision} 版合计 ${currentGrand.toFixed(2)}，差额 ${diff.toFixed(2)}`
          : '') +
        (overrideNote ? `；${overrideNote}` : '')
    )
    logQuotationEvent(
      id,
      'convert',
      `按第 ${targetRevision} 版转成订单 ${saved.orderNo}${overrideNote ? `；${overrideNote}` : ''}`
    )

    db.run('UPDATE quotations SET status=?, result=?, converted_order_id=?, updated_at=? WHERE id=?', [
      'converted',
      'won',
      order.id,
      now(),
      id
    ])
    db.exec('COMMIT')
    return saved
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
