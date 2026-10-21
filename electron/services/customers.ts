import { getDb } from '../db'
import { mapCustomer, mapCustomerStats } from '../db/mappers'
import { listOrderMoney, totalReceivable } from './money'
import type { Customer, CustomerStats } from '../../src/shared/types'

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
  defaultPaymentMethod?: string
  defaultDepositRatio?: number | null
  defaultIncoterm?: string
  defaultPortLoading?: string
  defaultPortDestination?: string
  note?: string
}

function now(): string {
  return new Date().toISOString()
}

export function listCustomers(keyword = ''): Customer[] {
  const db = getDb()
  if (keyword.trim()) {
    const k = `%${keyword.trim()}%`
    const rows = db.all(
      `SELECT * FROM customers
       WHERE company LIKE ? OR contact LIKE ? OR email LIKE ? OR country LIKE ? OR attn LIKE ?
       ORDER BY company`,
      [k, k, k, k, k]
    ) as Record<string, unknown>[]
    return rows.map(mapCustomer)
  }
  const rows = db.all('SELECT * FROM customers ORDER BY company') as Record<string, unknown>[]
  return rows.map(mapCustomer)
}

export function getCustomer(id: number): Customer | null {
  const row = getDb().get('SELECT * FROM customers WHERE id = ?', [id]) as Record<string, unknown> | null
  return row ? mapCustomer(row) : null
}

export function saveCustomer(input: CustomerInput): Customer {
  const db = getDb()
  const ts = now()
  if (input.id) {
    db.run(
      `UPDATE customers SET company=?, contact=?, email=?, phone=?, country=?, address=?,
       zip_code=?, attn=?, payment_pref=?, default_payment_method=?, default_deposit_ratio=?,
       default_incoterm=?, default_port_loading=?, default_port_destination=?, note=?, updated_at=? WHERE id=?`,
      [
        input.company.trim(),
        input.contact ?? '',
        input.email ?? '',
        input.phone ?? '',
        input.country ?? '',
        input.address ?? '',
        input.zipCode ?? '',
        input.attn ?? '',
        input.paymentPref ?? '',
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
      default_payment_method, default_deposit_ratio, default_incoterm, default_port_loading, default_port_destination,
      note, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.company.trim(),
      input.contact ?? '',
      input.email ?? '',
      input.phone ?? '',
      input.country ?? '',
      input.address ?? '',
      input.zipCode ?? '',
      input.attn ?? '',
      input.paymentPref ?? '',
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
        `建错了的客户请直接删；有记录的客户建单时不去选它就行，历史留着对账。`
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
  const outstanding = totalReceivable({ customerId })
  const missingCostOrders = rows.filter((r) => r.missingCostItems > 0).length
  const totalProfitRaw = rows.reduce((s, r) => s + r.profitRaw * r.exchangeRate, 0)
  return mapCustomerStats({
    order_count: rows.length,
    total_amount: totalAmount,
    // 有成本没录全的订单 → 毛利不可信（null），不许拿 0 成本凑一个漂亮的数
    total_profit: missingCostOrders > 0 ? null : totalProfitRaw,
    outstanding,
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
    remaining: r.receivable,
    createdAt: r.createdAt
  }))
}
