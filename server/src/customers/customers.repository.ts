import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { mapCustomer } from '../../../electron/db/mappers'
import { likeAny } from '../../../electron/services/search'
import type { Customer } from '../../../src/shared/types'

/** 建/改客户能传的字段（HTTP 契约）：与 electron/services/customers.ts 的 CustomerInput 同形 */
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
  allowDuplicate?: boolean
}

/**
 * 客户的 SQL 都在这里。
 * 口径与桌面端 electron/services/customers.ts 逐条对齐（同一份 mapCustomer / likeAny / 守门文案）；
 * M1 把服务层异步化搬到 core/ 之后，这份与桌面端合并，只留一处。
 */
@Injectable()
export class CustomersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(keyword: string, includeInactive: boolean): Promise<Customer[]> {
    const where: string[] = []
    let params: (string | number)[] = []
    // 停用的客户默认不出现在建单下拉里，但历史记录一条不动
    if (!includeInactive) where.push('active = 1')
    const kw = keyword.trim()
    if (kw) {
      const hit = likeAny(['company', 'contact', 'email', 'country', 'attn'], kw)
      where.push(`(${hit.sql})`)
      params = params.concat(hit.params)
    }
    const sql = `SELECT * FROM customers ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY company`
    const rows = await this.db.all(sql, params)
    return rows.map(mapCustomer)
  }

  async get(id: number): Promise<Customer | null> {
    const row = await this.db.get('SELECT * FROM customers WHERE id = ?', [id])
    return row ? mapCustomer(row) : null
  }

  /** 同名客户（不分大小写、忽略首尾空格）；一个集团开两个采购办很常见，只提醒不硬拦 */
  async sameName(company: string, selfId?: number): Promise<Customer[]> {
    const key = company.trim().toLowerCase()
    if (!key) return []
    const rows = await this.db.all('SELECT * FROM customers')
    return rows
      .map(mapCustomer)
      .filter((c) => c.id !== selfId && c.company.trim().toLowerCase() === key)
  }

  async insert(input: CustomerInput, ts: string): Promise<number> {
    const res = await this.db.run(
      `INSERT INTO customers(company, contact, email, phone, country, address, zip_code, attn, payment_pref,
        ship_attn, ship_address, ship_zip_code, ship_country,
        default_payment_method, default_deposit_ratio, default_incoterm, default_port_loading, default_port_destination,
        note, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.company,
        input.contact ?? '',
        input.email ?? '',
        input.phone ?? '',
        input.country ?? '',
        input.address ?? '',
        input.zipCode ?? '',
        input.attn ?? '',
        input.paymentPref ?? '',
        (input.shipAttn ?? '').trim(),
        (input.shipAddress ?? '').trim(),
        (input.shipZipCode ?? '').trim(),
        (input.shipCountry ?? '').trim(),
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
    return res.lastInsertRowid
  }

  async update(input: CustomerInput, ts: string): Promise<void> {
    await this.db.run(
      `UPDATE customers SET company=?, contact=?, email=?, phone=?, country=?, address=?,
       zip_code=?, attn=?, payment_pref=?, ship_attn=?, ship_address=?, ship_zip_code=?, ship_country=?,
       default_payment_method=?, default_deposit_ratio=?,
       default_incoterm=?, default_port_loading=?, default_port_destination=?, note=?, updated_at=? WHERE id=?`,
      [
        input.company,
        input.contact ?? '',
        input.email ?? '',
        input.phone ?? '',
        input.country ?? '',
        input.address ?? '',
        input.zipCode ?? '',
        input.attn ?? '',
        input.paymentPref ?? '',
        (input.shipAttn ?? '').trim(),
        (input.shipAddress ?? '').trim(),
        (input.shipZipCode ?? '').trim(),
        (input.shipCountry ?? '').trim(),
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
  }

  async setActive(id: number, active: 0 | 1, ts: string): Promise<void> {
    await this.db.run('UPDATE customers SET active = ?, updated_at = ? WHERE id = ?', [active, ts, id])
  }

  /** 挂着订单/报价/打样单的客户删不掉：计数交给服务层说人话 */
  async refCounts(id: number): Promise<{ orders: number; quotations: number; samples: number }> {
    const count = async (table: string): Promise<number> => {
      const row = await this.db.get(`SELECT COUNT(*) c FROM ${table} WHERE customer_id = ?`, [id])
      return Number(row?.['c'] ?? 0)
    }
    return {
      orders: await count('orders'),
      quotations: await count('quotations'),
      samples: await count('sample_orders')
    }
  }

  async remove(id: number): Promise<void> {
    await this.db.run('DELETE FROM customers WHERE id = ?', [id])
  }
}
