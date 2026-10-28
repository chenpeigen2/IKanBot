/**
 * 客户档案：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 以前后端为了跑通样板域另写了一份 repository，口径靠人肉对齐；
 * 现在只有这里一处 SQL 与守门，改了一边不可能忘另一边。
 * 依赖只有异步 Db 接口 + 纯函数 mapper/守门，不碰 electron、不碰文件系统。
 */
import type { Customer, StylePriceRow } from '../src/shared/types'
import { mapCustomer } from '../electron/db/mappers'
import { likeAny } from '../electron/services/search'
import { assertDepositRatio } from '../src/shared/guards'
import { NON_BILLING_STATUSES } from '../src/shared/billing'
import { BizError, notFound } from './errors'
import type { Db } from './db'

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

/** 外部输入按白名单读字段：多传的键不进 SQL，也防止把 id 写成字符串带进 WHERE */
function normalize(raw: Record<string, unknown>): CustomerInput {
  const s = (k: string): string | undefined => {
    const v = raw[k]
    return typeof v === 'string' ? v : undefined
  }
  const id = raw['id']
  const ratio = raw['defaultDepositRatio']
  return {
    id: typeof id === 'number' && Number.isInteger(id) ? id : undefined,
    company: s('company') ?? '',
    contact: s('contact'),
    email: s('email'),
    phone: s('phone'),
    country: s('country'),
    address: s('address'),
    zipCode: s('zipCode'),
    attn: s('attn'),
    paymentPref: s('paymentPref'),
    shipAttn: s('shipAttn'),
    shipAddress: s('shipAddress'),
    shipZipCode: s('shipZipCode'),
    shipCountry: s('shipCountry'),
    defaultPaymentMethod: s('defaultPaymentMethod'),
    defaultDepositRatio: typeof ratio === 'number' ? ratio : ratio === null ? null : undefined,
    defaultIncoterm: s('defaultIncoterm'),
    defaultPortLoading: s('defaultPortLoading'),
    defaultPortDestination: s('defaultPortDestination'),
    note: s('note'),
    allowDuplicate: raw['allowDuplicate'] === true
  }
}

export function customersCore(db: Db) {
  /** 同名客户（不分大小写、忽略首尾空格）；一个集团开两个采购办很常见，只提醒不硬拦 */
  async function sameName(company: string, selfId?: number): Promise<Customer[]> {
    const key = company.trim().toLowerCase()
    if (!key) return []
    const rows = await db.all('SELECT * FROM customers')
    return rows
      .map(mapCustomer)
      .filter((c) => c.id !== selfId && c.company.trim().toLowerCase() === key)
  }

  async function get(id: number): Promise<Customer | null> {
    const row = await db.get('SELECT * FROM customers WHERE id = ?', [id])
    return row ? mapCustomer(row) : null
  }

  /** 取不到就抛「客户不存在」：桌面弹这句话，后端落 404 */
  async function mustGet(id: number): Promise<Customer> {
    const c = await get(id)
    if (!c) throw notFound('客户不存在')
    return c
  }

  async function list(keyword = '', includeInactive = false): Promise<Customer[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    // 停用的客户默认不出现在建单下拉里，但历史记录一条不动
    if (!includeInactive) where.push('active = 1')
    const kw = keyword.trim()
    if (kw) {
      const hit = likeAny(['company', 'contact', 'email', 'country', 'attn'], kw)
      where.push(`(${hit.sql})`)
      params.push(...hit.params)
    }
    const sql = `SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY company`
    return (await db.all(sql, params)).map(mapCustomer)
  }

  async function save(raw: CustomerInput | Record<string, unknown>): Promise<Customer> {
    const input = normalize(raw as Record<string, unknown>)
    const ts = new Date().toISOString()
    const company = input.company.trim()
    if (!company) throw new BizError('客户公司名不能为空')
    input.company = company

    const dup = await sameName(company, input.id)
    if (dup.length > 0 && !input.allowDuplicate) {
      const who = dup
        .map((c) => `${c.company}（${[c.country, c.contact, c.email].filter(Boolean).join(' · ') || '没填国家/联系人'}）`)
        .join('、')
      throw new BizError(
        `已经有同名客户：${who}。\n` +
          `同一个客户建两份，订单和欠款会被劈成两半，漏催一笔就是真钱。\n` +
          `确认是两家不同的公司（比如同一集团下的两个采购办），再点一次「就是同名，继续保存」。`
      )
    }
    // 档案里的默认定金比例是每张新单的起点：这里混进 1.5，以后每张单的 PI 都印负尾款
    try {
      assertDepositRatio(input.defaultDepositRatio)
    } catch (e) {
      throw new BizError((e as Error).message)
    }

    const ship = {
      shipAttn: (input.shipAttn ?? '').trim(),
      shipAddress: (input.shipAddress ?? '').trim(),
      shipZipCode: (input.shipZipCode ?? '').trim(),
      shipCountry: (input.shipCountry ?? '').trim()
    }
    if (input.id != null) {
      await mustGet(input.id)
      await db.run(
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
      return mustGet(input.id)
    }
    const res = await db.run(
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
    return mustGet(res.lastInsertRowid)
  }

  async function setActive(id: number, active: 0 | 1): Promise<Customer> {
    await mustGet(id)
    await db.run('UPDATE customers SET active = ?, updated_at = ? WHERE id = ?', [
      active ? 1 : 0,
      new Date().toISOString(),
      id
    ])
    return mustGet(id)
  }

  async function remove(id: number): Promise<void> {
    const cust = await db.get('SELECT company FROM customers WHERE id = ?', [id])
    if (!cust) return
    const count = async (table: string): Promise<number> => {
      const row = await db.get(`SELECT COUNT(*) c FROM ${table} WHERE customer_id = ?`, [id])
      return Number(row?.['c'] ?? 0)
    }
    const parts: string[] = []
    const orders = await count('orders')
    if (orders > 0) parts.push(`${orders} 个订单`)
    const quotes = await count('quotations')
    if (quotes > 0) parts.push(`${quotes} 个报价单`)
    const samples = await count('sample_orders')
    if (samples > 0) parts.push(`${samples} 个打样单`)
    // 别把 FOREIGN KEY constraint failed 这种英文数据库报错甩给老板看
    if (parts.length > 0) {
      throw new BizError(
        `${cust['company']} 已经有 ${parts.join('、')}，不能删——删了这些记录就没了凭据。\n` +
          `建错了又不想在建单下拉里看见它，请用「停用」：档案和历史单据都留着，只是不再带出来。`
      )
    }
    await db.run('DELETE FROM customers WHERE id = ?', [id])
  }

  /**
   * 历史成交价：客户问「上次那款灰卫衣多少一件」要当场答得上。
   * 口径与销售额一致（草稿/失效/作废不算成交），按 款号+颜色 归并，取最近一单单价。
   * 指定 styleNo 时按 款号+颜色+客户 分开——商品页要看的是「卖给过谁、各是什么价」。
   */
  async function stylePriceHistory(
    filter: { customerId?: number; styleNo?: string } = {}
  ): Promise<StylePriceRow[]> {
    const where = [`o.payment_status NOT IN (${NON_BILLING_STATUSES.map(() => '?').join(',')})`]
    const params: (string | number)[] = [...NON_BILLING_STATUSES]
    if (filter.customerId != null) {
      where.push('o.customer_id = ?')
      params.push(filter.customerId)
    }
    if (filter.styleNo) {
      where.push('UPPER(TRIM(oi.style_no)) = UPPER(TRIM(?))')
      params.push(filter.styleNo)
    }
    const rows = await db.all(
      `SELECT oi.style_no, oi.color, oi.unit_price, oi.quantity, o.currency, o.created_at, o.customer_id,
              c.company AS customer_company
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC, o.id DESC`,
      params
    )

    const byKey = new Map<string, StylePriceRow>()
    for (const r of rows) {
      const styleNo = String(r['style_no'] ?? '').trim()
      if (!styleNo) continue
      const color = String(r['color'] ?? '')
      const customerId = Number(r['customer_id'])
      // 商品方向要分客户，客户方向不用
      const key = filter.styleNo
        ? `${styleNo.toLowerCase()}|${color.toLowerCase()}|${customerId}`
        : `${styleNo.toLowerCase()}|${color.toLowerCase()}`
      const qty = Number(r['quantity'] ?? 0)
      const price = Number(r['unit_price'] ?? 0)
      const date = String(r['created_at'] ?? '')
      const hit = byKey.get(key)
      if (!hit) {
        byKey.set(key, {
          styleNo,
          color,
          lastUnitPrice: price,
          lastCurrency: String(r['currency'] ?? ''),
          lastDate: date,
          times: 1,
          totalQuantity: qty,
          customerCompany: String(r['customer_company'] ?? '')
        })
      } else {
        hit.times += 1
        hit.totalQuantity += qty
      }
    }
    return [...byKey.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
  }

  return { list, get, mustGet, sameName, save, setActive, remove, stylePriceHistory }
}

export type CustomersCore = ReturnType<typeof customersCore>
