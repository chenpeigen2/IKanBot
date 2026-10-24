import { getDb } from '../db'
import { mapCustomer, mapCustomerStats } from '../db/mappers'
import { EXCLUDED_STATUSES, listOrderMoney, sampleReceivable } from './money'
import type { Customer, CustomerStats, StylePriceRow } from '../../src/shared/types'

export interface CustomerInput {
  id?: number
  company: string
  contact?: string
  email?: string
  phone?: string
  country?: string
  address?: string
  zipCode?: string
  attn?: string
  paymentPref?: string
  /** 收货地址（货代实际送货的地方） */
  shipAttn?: string
  shipAddress?: string
  shipZipCode?: string
  shipCountry?: string
  defaultPaymentMethod?: string
  defaultDepositRatio?: number | null
  defaultIncoterm?: string
  defaultPortLoading?: string
  defaultPortDestination?: string
  note?: string
  /** 明知重名还要建（同名不同采购办是常态，不能硬拦） */
  allowDuplicate?: boolean
}

function now(): string {
  return new Date().toISOString()
}

export function listCustomers(keyword = '', includeInactive = false): Customer[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number)[] = []
  // 停用的客户默认不出现在建单下拉里，但历史记录一条不动
  if (!includeInactive) where.push('active = 1')
  if (keyword.trim()) {
    const k = `%${keyword.trim()}%`
    where.push('(company LIKE ? OR contact LIKE ? OR email LIKE ? OR country LIKE ? OR attn LIKE ?)')
    params.push(k, k, k, k, k)
  }
  const sql = `SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY company`
  const rows = db.all(sql, params) as Record<string, unknown>[]
  return rows.map(mapCustomer)
}

export function getCustomer(id: number): Customer | null {
  const row = getDb().get('SELECT * FROM customers WHERE id = ?', [id]) as Record<string, unknown> | null
  return row ? mapCustomer(row) : null
}

/** 同名客户（不分大小写、忽略首尾空格）；一个集团开两个采购办很常见，只提醒不硬拦 */
function findSameNameCompany(company: string, selfId?: number): Customer[] {
  const key = company.trim().toLowerCase()
  if (!key) return []
  const rows = getDb().all('SELECT * FROM customers') as Record<string, unknown>[]
  return rows
    .map(mapCustomer)
    .filter((c) => c.id !== selfId && c.company.trim().toLowerCase() === key)
}

export function saveCustomer(input: CustomerInput): Customer {
  const db = getDb()
  const ts = now()
  const company = (input.company ?? '').trim()
  if (!company) throw new Error('客户公司名不能为空')
  const sameName = findSameNameCompany(company, input.id)
  if (sameName.length > 0 && !input.allowDuplicate) {
    const who = sameName
      .map((c) => `${c.company}（${[c.country, c.contact, c.email].filter(Boolean).join(' · ') || '没填国家/联系人'}）`)
      .join('、')
    throw new Error(
      `已经有同名客户：${who}。\n` +
        `同一个客户建两份，订单和欠款会被劈成两半，漏催一笔就是真钱。\n` +
        `确认是两家不同的公司（比如同一集团下的两个采购办），再点一次「就是同名，继续保存」。`
    )
  }
  const ship = {
    shipAttn: (input.shipAttn ?? '').trim(),
    shipAddress: (input.shipAddress ?? '').trim(),
    shipZipCode: (input.shipZipCode ?? '').trim(),
    shipCountry: (input.shipCountry ?? '').trim()
  }
  if (input.id) {
    db.run(
      `UPDATE customers SET company=?, contact=?, email=?, phone=?, country=?, address=?,
       zip_code=?, attn=?, payment_pref=?, ship_attn=?, ship_address=?, ship_zip_code=?, ship_country=?,
       default_payment_method=?, default_deposit_ratio=?,
       default_incoterm=?, default_port_loading=?, default_port_destination=?, note=?, updated_at=? WHERE id=?`,
      [
        company,
        input.contact ?? '',
        input.email ?? '',
        input.phone ?? '',
        input.country ?? '',
        input.address ?? '',
        input.zipCode ?? '',
        input.attn ?? '',
        input.paymentPref ?? '',
        ship.shipAttn,
        ship.shipAddress,
        ship.shipZipCode,
        ship.shipCountry,
        input.defaultPaymentMethod ?? '',
        input.defaultDepositRatio ?? null,
        input.defaultIncoterm ?? '',
        input.defaultPortLoading ?? '',
        input.defaultPortDestination ?? '',
        input.note ?? '',
        ts,
        input.id
      ]
    )
    return getCustomer(input.id)!
  }
  const res = db.run(
    `INSERT INTO customers(company, contact, email, phone, country, address, zip_code, attn, payment_pref,
      ship_attn, ship_address, ship_zip_code, ship_country,
      default_payment_method, default_deposit_ratio, default_incoterm, default_port_loading, default_port_destination,
      note, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      company,
      input.contact ?? '',
      input.email ?? '',
      input.phone ?? '',
      input.country ?? '',
      input.address ?? '',
      input.zipCode ?? '',
      input.attn ?? '',
      input.paymentPref ?? '',
      ship.shipAttn,
      ship.shipAddress,
      ship.shipZipCode,
      ship.shipCountry,
      input.defaultPaymentMethod ?? '',
      input.defaultDepositRatio ?? null,
      input.defaultIncoterm ?? '',
      input.defaultPortLoading ?? '',
      input.defaultPortDestination ?? '',
      input.note ?? '',
      ts,
      ts
    ]
  )
  return getCustomer(Number(res.lastInsertRowid))!
}

/** 停用 / 启用客户：建错了不想留档、又不删得掉历史单的客户，用这个 */
export function setCustomerActive(id: number, active: 0 | 1): Customer {
  const c = getCustomer(id)
  if (!c) throw new Error('客户不存在')
  getDb().run('UPDATE customers SET active = ?, updated_at = ? WHERE id = ?', [active ? 1 : 0, now(), id])
  return getCustomer(id)!
}

export function sameNameCustomers(company: string, selfId?: number): Customer[] {
  return findSameNameCompany(company, selfId)
}

export function deleteCustomer(id: number): void {
  const db = getDb()
  const cust = db.get('SELECT company FROM customers WHERE id = ?', [id]) as
    | { company?: string }
    | null
  if (!cust) return
  // N32：别把 FOREIGN KEY constraint failed 这种英文数据库报错甩给老板看，
  // 用中文说清楚有几条什么记录、为什么删不掉
  const cnt = (sql: string): number => {
    const row = db.get(sql, [id]) as { c?: number } | null
    return Number(row?.c ?? 0)
  }
  const parts: string[] = []
  const orders = cnt('SELECT COUNT(*) c FROM orders WHERE customer_id = ?')
  if (orders > 0) parts.push(`${orders} 个订单`)
  const quotes = cnt('SELECT COUNT(*) c FROM quotations WHERE customer_id = ?')
  if (quotes > 0) parts.push(`${quotes} 个报价单`)
  const samples = cnt('SELECT COUNT(*) c FROM sample_orders WHERE customer_id = ?')
  if (samples > 0) parts.push(`${samples} 个打样单`)
  if (parts.length > 0) {
    throw new Error(
      `${cust.company} 已经有 ${parts.join('、')}，不能删——删了这些记录就没了凭据。\n` +
        `建错了又不想在建单下拉里看见它，请用「停用」：档案和历史单据都留着，只是不再带出来。`
    )
  }
  db.run('DELETE FROM customers WHERE id = ?', [id])
}

/**
 * 客户聚合统计：订单数、总金额、总毛利、未收金额。
 * 口径全部走 services/money.ts（唯一真源）：
 *  - 成交额 = Σ含费用合计
 *  - 未收   = Σ(含费用合计 − 已收)
 *  - 毛利   = Σ(货值 − 成本)，有成本没录全 → null（不可信）
 */
export function customerStats(customerId: number): CustomerStats {
  const rows = listOrderMoney({ customerId })
  const totalAmount = rows.reduce((s, r) => s + r.grandTotalBase, 0)
  // 未收走统一口径（money.ts）：订单待收 + 打样未收（N23：客户页不能比工作台少数一笔打样费）
  const outstandingOrders = rows.reduce((s, r) => s + r.receivableBase, 0)
  const outstandingSamples = sampleReceivable(customerId)
  const outstanding = outstandingOrders + outstandingSamples
  // 坏账不进待收，但客户页要能看见这家客户赖过多少钱
  const badDebt = rows.reduce((s, r) => s + r.badDebtBase, 0)
  const missingCostOrders = rows.filter((r) => r.missingCostItems > 0).length
  const totalProfitRaw = rows.reduce((s, r) => s + r.profitRaw * r.exchangeRate, 0)
  // 下面的历史列表会把草稿/失效/作废也列出来，成交额却不含它们；
  // 不写明条数，老板会以为系统漏单（N-口径一致）
  const excluded = getDb().all(
    `SELECT payment_status FROM orders WHERE customer_id = ? AND payment_status IN (${EXCLUDED_STATUSES.map(
      () => '?'
    ).join(',')})`,
    [customerId, ...EXCLUDED_STATUSES]
  ) as { payment_status?: string }[]
  return mapCustomerStats({
    order_count: rows.length,
    excluded_order_count: excluded.length,
    total_amount: totalAmount,
    // 有成本没录全的订单 → 毛利不可信（null），不许拿 0 成本凑一个漂亮的数
    total_profit: missingCostOrders > 0 ? null : totalProfitRaw,
    outstanding,
    outstanding_orders: outstandingOrders,
    outstanding_samples: outstandingSamples,
    bad_debt: badDebt,
    missing_cost_orders: missingCostOrders
  })
}

/** 客户历史订单简要（金额口径走 services/money.ts） */
export function customerOrderBriefs(customerId: number): {
  id: number
  orderNo: string
  piNo: string
  currency: string
  paymentStatus: string
  shipStatus: string
  /** 货值 */
  total: number
  /** 含费用合计（PI 上的 TOTAL） */
  grandTotal: number
  paid: number
  /** 待收（含费用合计 − 已收） */
  remaining: number
  /** 这条是否计入上面的「订单数 / 成交额」（草稿、失效、作废不计） */
  counted: boolean
  createdAt: string
}[] {
  const rows = listOrderMoney({ customerId, includeVoided: true })
  return rows.map((r) => ({
    id: r.orderId,
    orderNo: r.orderNo,
    piNo: r.piNo,
    currency: r.currency,
    paymentStatus: r.paymentStatus,
    shipStatus: r.shipStatus,
    total: r.goodsValue,
    grandTotal: r.grandTotal,
    paid: r.paidAmount,
    // 草稿 / 已失效 / 已作废的单在历史里保留，但不再向客户催款，待收按 0 显示
    remaining: EXCLUDED_STATUSES.includes(r.paymentStatus) ? 0 : r.receivable,
    counted: !EXCLUDED_STATUSES.includes(r.paymentStatus),
    createdAt: r.createdAt
  }))
}

/**
 * 历史成交价：客户问「上次那款灰卫衣多少一件」要当场答得上。
 * 口径与销售额一致（草稿/失效/作废不算成交），按 款号+颜色 归并，取最近一单单价。
 * 指定 styleNo 时按 款号+颜色+客户 分开——商品页要看的是「卖给过谁、各是什么价」。
 */
export function stylePriceHistory(filter: { customerId?: number; styleNo?: string } = {}): StylePriceRow[] {
  const db = getDb()
  const where = [`o.payment_status NOT IN (${EXCLUDED_STATUSES.map(() => '?').join(',')})`]
  const params: (string | number)[] = [...EXCLUDED_STATUSES]
  if (filter.customerId != null) {
    where.push('o.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.styleNo) {
    where.push('UPPER(TRIM(oi.style_no)) = UPPER(TRIM(?))')
    params.push(filter.styleNo)
  }
  const rows = db.all(
    `SELECT oi.style_no, oi.color, oi.unit_price, oi.quantity, o.currency, o.created_at, o.customer_id,
            c.company AS customer_company
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY o.created_at DESC, o.id DESC`,
    params
  ) as Record<string, unknown>[]

  const byKey = new Map<string, StylePriceRow>()
  for (const r of rows) {
    const styleNo = String(r.style_no ?? '').trim()
    if (!styleNo) continue
    const color = String(r.color ?? '')
    const customerId = Number(r.customer_id)
    // 商品方向要分客户，客户方向不用
    const key = filter.styleNo
      ? `${styleNo.toLowerCase()}|${color.toLowerCase()}|${customerId}`
      : `${styleNo.toLowerCase()}|${color.toLowerCase()}`
    const qty = Number(r.quantity ?? 0)
    const price = Number(r.unit_price ?? 0)
    const date = String(r.created_at ?? '')
    const hit = byKey.get(key)
    if (!hit) {
      byKey.set(key, {
        styleNo,
        color,
        lastUnitPrice: price,
        lastCurrency: String(r.currency ?? ''),
        lastDate: date,
        times: 1,
        totalQuantity: qty,
        customerCompany: String(r.customer_company ?? '')
      })
    } else {
      hit.times += 1
      hit.totalQuantity += qty
    }
  }
  return [...byKey.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
}
