/**
 * 客户档案：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 以前后端为了跑通样板域另写了一份 repository，口径靠人肉对齐；
 * 现在只有这里一处 SQL 与守门，改了一边不可能忘另一边。
 * 依赖只有异步 Db 接口 + 纯函数 mapper/守门，不碰 electron、不碰文件系统。
 */
import type { Customer, CustomerOrderBrief, CustomerStats, StylePriceRow } from '../src/shared/types'
import { mapCustomer, mapCustomerStats } from '../electron/db/mappers'
import { likeAny } from '../electron/services/search'
import { assertDepositRatio } from '../src/shared/guards'
import { NON_BILLING_STATUSES, isBillingStatus, shownRemaining } from '../src/shared/billing'
import { BizError, notFound } from '../src/shared/errors'
import { moneyCore } from './money'
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
  // 客户页的几个数全部从 money 取（同一份订单/打样口径），这里只做聚合与措辞
  const money = moneyCore(db)

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
    assertDepositRatio(input.defaultDepositRatio)

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
    // 数一遍再删要放在同一个事务里：查完到删之间正好有人登记一笔预收抵扣，
    // 删客户就会撞上外键，弹出来的还是一句英文数据库报错（R49）
    await db.transact(async () => {
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
      // 预收抵扣和退款也是钱的凭据：撤销过的行也留着 customer_id，删客户同样会断链
      const credits = await count('credit_applications')
      if (credits > 0) parts.push(`${credits} 笔预收抵扣`)
      const refunds = await count('customer_refunds')
      if (refunds > 0) parts.push(`${refunds} 笔预收退款`)
      // 别把 FOREIGN KEY constraint failed 这种英文数据库报错甩给老板看
      if (parts.length > 0) {
        throw new BizError(
          `${cust['company']} 已经有 ${parts.join('、')}，不能删——这些是货和钱的凭据，删了就再也对不上账。\n` +
            `建错了又不想在建单下拉里看见它，请用「停用」：档案和历史单据都留着，只是不再带出来。`
        )
      }
      await db.run('DELETE FROM customers WHERE id = ?', [id])
    })
  }

  /**
   * 历史成交价：客户问「上次那款灰卫衣多少一件」要当场答得上。
   * 口径与销售额一致（草稿/失效/作废不算成交），按 款号+颜色 归并，取最近一单单价。
   * 指定 styleNo 时按 款号+颜色+客户 分开——商品页要看的是「卖给过谁、各是什么价」。
   */
  async function stylePriceHistory(
    filter: { customerId?: number; styleNo?: string } = {}
  ): Promise<StylePriceRow[]> {
    // 两个条件都不给就是「全库历史价」：远端大库会扫穿 order_items、一次回几万行，
    // 而页面从来只用「看这家」或「看这款」两种问法
    if (filter.customerId == null && !filter.styleNo?.trim()) {
      throw new BizError('查历史成交价至少要说清看哪个客户、哪一款；整库翻一遍既慢又容易看错人。')
    }
    if (filter.customerId != null) await mustGet(filter.customerId)
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
              o.id AS order_id, c.company AS customer_company
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC, o.id DESC, oi.id ASC`,
      params
    )

    // 同一款同一色在同一张单里常有多行（S/M/L 各一行）：
    // 「成交次数」说的是几张单，不是几行；最近单价取最新那张单的加权均价，
    // 行序靠 oi.id 钉死，SQLite 与 MySQL 才不会各报一个价。
    interface Acc {
      row: StylePriceRow
      orderIds: Set<number>
      lastOrderId: number
      lastQty: number
      lastAmount: number
    }
    const byKey = new Map<string, Acc>()
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
      const orderId = Number(r['order_id'])
      const hit = byKey.get(key)
      if (!hit) {
        byKey.set(key, {
          row: {
            styleNo,
            color,
            lastUnitPrice: price,
            lastCurrency: String(r['currency'] ?? ''),
            lastDate: date,
            times: 1,
            totalQuantity: qty,
            customerCompany: String(r['customer_company'] ?? '')
          },
          orderIds: new Set([orderId]),
          lastOrderId: orderId,
          lastQty: qty,
          lastAmount: qty * price
        })
        continue
      }
      hit.orderIds.add(orderId)
      hit.row.totalQuantity += qty
      if (orderId === hit.lastOrderId) {
        hit.lastQty += qty
        hit.lastAmount += qty * price
        if (hit.lastQty > 0) hit.row.lastUnitPrice = Math.round((hit.lastAmount / hit.lastQty) * 100) / 100
      }
    }
    const out = [...byKey.values()].map((a) => ({ ...a.row, times: a.orderIds.size }))
    // 日期相同也要有确定顺序（款号、颜色兜底），否则同一天的两笔在不同库里会换位
    return out.sort(
      (a, b) =>
        (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
        a.styleNo.localeCompare(b.styleNo) ||
        a.color.localeCompare(b.color)
    )
  }

  /**
   * 客户聚合统计：订单数、总金额、总毛利、未收金额。
   * 口径全部走 core/money.ts（唯一真源）：
   *  - 成交额 = Σ含费用合计（折各单锁汇率）
   *  - 未收   = Σ(含费用合计 − 已收) + 打样未收
   *  - 毛利   = Σ(货值 − 成本)，有成本没录全 / 缺汇率 → null（不可信）
   */
  async function stats(customerId: number): Promise<CustomerStats> {
    // 客户刚被删或 id 传错时不能回一页「没下过单」的空账：那是另一种意义上的错账
    await mustGet(customerId)
    // 一次取全（含草稿/失效/作废）：成交额与待收只认计费单，坏账要认全部——
    // 单子作废了，那笔没收回来的钱不会跟着消失（与工作台、月报同一个口径，R49）。
    const all = await money.listOrderMoney({ customerId, includeVoided: true })
    const rows = all.filter((r) => isBillingStatus(r.paymentStatus))
    const totalAmount = rows.reduce((s, r) => s + r.grandTotalBase, 0)
    // 未收走统一口径（money.ts）：订单待收 + 打样未收（N23：客户页不能比工作台少数一笔打样费）
    const outstandingOrders = rows.reduce((s, r) => s + r.receivableBase, 0)
    const samples = await money.sampleReceivableBreakdown(customerId)
    const outstanding = outstandingOrders + samples.total
    // 名下打样单总数：只打过样的客户也要能导出对账单
    const sampleCount = Number(
      (await db.get('SELECT COUNT(*) AS c FROM sample_orders WHERE customer_id = ?', [customerId]))?.['c'] ?? 0
    )
    // 坏账不进待收，但客户页要能看见这家客户赖过多少钱：作废/失效单上的坏账也算
    const badDebt = all.reduce((s, r) => s + r.badDebtBase, 0)
    const missingCostOrders = rows.filter((r) => r.missingCostItems > 0).length
    // 外币没填汇率的单：成交额/待收/毛利都按 0 折，上面的合计是「少算了这几单」的数。
    // 不亮出来，老板会拿着一个偏小的成交额去对账
    const rateMissingOrders = rows.filter((r) => r.rateMissing).length
    // 坏账也要单独数一遍缺汇率的：作废单本来就不在 rows 里，
    // 只靠 rateMissingOrders 的话，一笔作废单上的 USD 坏账会无声无息地变成 0
    const badDebtRateMissingOrders = all.filter((r) => r.badDebtOutstanding > 0.001 && r.rateMissing).length
    const totalProfitRaw = rows.reduce((s, r) => s + (r.profitBase ?? 0), 0)
    // 下面的历史列表会把草稿/失效/作废也列出来，成交额却不含它们；
    // 不写明条数，老板会以为系统漏单（N-口径一致）
    return mapCustomerStats({
      order_count: rows.length,
      excluded_order_count: all.length - rows.length,
      total_amount: totalAmount,
      // 有成本没录全的订单 → 毛利不可信（null），不许拿 0 成本凑一个漂亮的数；
      // 缺汇率的单同理：那一单的毛利根本没折进合计，算出来的也不是真毛利
      total_profit: missingCostOrders > 0 || rateMissingOrders > 0 ? null : totalProfitRaw,
      outstanding,
      outstanding_orders: outstandingOrders,
      outstanding_samples: samples.total,
      sample_count: sampleCount,
      bad_debt: badDebt,
      missing_cost_orders: missingCostOrders,
      rate_missing_orders: rateMissingOrders,
      rate_missing_samples: samples.rateMissing,
      bad_debt_rate_missing_orders: badDebtRateMissingOrders
    })
  }

  /** 客户历史订单简要（金额口径走 core/money.ts） */
  async function orderBriefs(customerId: number): Promise<CustomerOrderBrief[]> {
    await mustGet(customerId)
    const rows = await money.listOrderMoney({ customerId, includeVoided: true })
    return rows.map((r) => {
      const billing = isBillingStatus(r.paymentStatus)
      return {
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
        // （口径见 src/shared/billing.ts，订单列表和客户页必须是同一个说法）
        remaining: shownRemaining(r.paymentStatus, r.receivable),
        // 待收里已经由客户账上余额覆盖的那一块：不露出来，「待收 500 + 已收 500」看着像
        // 还差 500 现金，实际那 500 早已抵扣掉，再催一遍就是重复收款
        creditApplied: billing ? r.creditApplied : 0,
        counted: billing,
        // 作废/失效单收到的现金全额进了客户预收（追回的欠款冲的是已核销坏账，不是多付）：
        // 订单行里写着「已收」，预收区又有一笔，不说清就成了两笔钱
        prepaid: billing ? 0 : Math.max(0, r.paidAmount - r.badDebtRecovered),
        createdAt: r.createdAt
      }
    })
  }

  return { list, get, mustGet, sameName, save, setActive, remove, stylePriceHistory, stats, orderBriefs }
}

export type CustomersCore = ReturnType<typeof customersCore>
