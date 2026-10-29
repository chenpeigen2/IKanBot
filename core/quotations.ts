/**
 * 报价单（Quotation）—— 下单之前的环节：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 关键约定：报价单存在自己的表里，完全不参与销售额 / 毛利 / 待收款统计，
 * 也不会出现在订单列表里。它只有一个出口：转成正式订单。
 *
 * 转单要建订单、要按历史版本钉价格，所以回头调订单域；按需懒建工厂，共用同一个连接。
 */
import { bizError, notFound } from '../src/shared/errors'
import type { Db } from './db'
import { nextNo } from './next-no'
import { logEvent } from './events'
import { settingsCore } from './settings'
import { ordersCore } from './orders'
import { baseRateOf, computeOrderMoney, costInOrderCurrency, describeChargeChange } from './money'
import { mapQuotation, mapQuotationItem, mapCustomer } from '../electron/db/mappers'
import { likeAny } from '../electron/services/search'
import { billPartyOf, emptyParty, parseParty, patchParty, stringifyParty } from '../src/shared/party'
import { localDate, addDays } from '../src/shared/date'
import { assertQuantity, assertUnitPrice } from '../src/shared/guards'
import type {
  Currency,
  Incoterm,
  OrderDetail,
  PartySnapshot,
  PaymentMethod,
  Quotation,
  QuotationCharge,
  QuotationDetail,
  QuotationResult,
  QuotationStatus,
  QuotationVersionSummary
} from '../src/shared/types'
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
  /** 单据抬头快照：不传就取客户档案当时的值 */
  billTo?: Partial<PartySnapshot>
  items: QuotationItemInput[]
}

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
  /** 抬头快照：转单时连抬头一起带走，事后改客户档案不影响已出的纸 */
  billTo?: PartySnapshot
  items: QuotationItemInput[]
}

export function quotationsCore(db: Db) {
  let ordersApi: ReturnType<typeof ordersCore> | null = null
  const ordersOf = () => (ordersApi ??= ordersCore(db))

  function now(): string {
    return new Date().toISOString()
  }





  function mapCustomerLocal(row: Record<string, unknown> | null) {
    return row ? mapCustomer(row) : null
  }

  /** 按款号在商品库里找款（大小写不敏感） */
  async function findProductByStyleNo(
    styleNo: string
  ): Promise<{ id: number; cost_price: number | null } | null> {
    const key = String(styleNo ?? '').trim()
    if (!key) return null
    const row = await db.get('SELECT id, cost_price FROM products WHERE UPPER(style_no) = UPPER(?) LIMIT 1', [
      key
    ]) as { id?: number; cost_price?: number | null } | null
    return row?.id ? { id: Number(row.id), cost_price: row.cost_price ?? null } : null
  }

  async function findProductIdByStyleNo(styleNo: string): Promise<number | null> {
    return (await findProductByStyleNo(styleNo))?.id ?? null
  }

  async function hydrate(q: Quotation, row?: Record<string, unknown>): Promise<QuotationDetail> {
    const customerRow = await db.get('SELECT * FROM customers WHERE id = ?', [q.customerId]) as Record<string, unknown> | null
    const items = (
      await db.all('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id', [q.id]) as Record<string, unknown>[]
    ).map(mapQuotationItem)
    // 金额口径统一走 services/money.ts（唯一真源）
    const m = computeOrderMoney({
      items: items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, unitCost: null })),
      charges: q.charges,
      payments: [],
      depositRatio: q.depositRatio
    })
    const liveCustomer = mapCustomerLocal(customerRow)
    // 转出的订单作废了没有：作废的单不再是活凭据，报价可以改价重转（与转单口径一致）
    const convertedOrderStatus = q.convertedOrderId
      ? String(
          (
            await db.get('SELECT payment_status FROM orders WHERE id = ?', [q.convertedOrderId]) as {
              payment_status?: string
            } | null
          )?.payment_status ?? ''
        )
      : ''
    // 抬头：有快照用快照，老报价单（升级前存的）沿用客户档案当前值
    const fromDoc = parseParty(row?.bill_to_json)
    const billTo = fromDoc ?? (liveCustomer ? billPartyOf(liveCustomer) : null)
    // 本币单的汇率对外只有一个真值：1（升级前的老单可能存着 7.15 这类数，
    // 原样显示会让人以为这是笔外币单，也会被报表再折一次）
    const isHome = q.currency === q.baseCurrency
    return {
      ...q,
      exchangeRate: isHome ? 1 : q.exchangeRate,
      exchangeRateDate: isHome ? null : q.exchangeRateDate,
      customer: liveCustomer,
      billTo,
      billFromProfile: !fromDoc,
      items,
      totalAmount: m.goodsValue,
      totalQuantity: m.totalQuantity,
      chargesTotal: m.chargesTotal,
      grandTotal: m.grandTotal,
      convertedOrderStatus
    }
  }

  /* ---------------- 版本快照 ---------------- */



  /** 把报价单当前内容冻结成某一版（同一版只存一次，不覆盖） */
  async function freezeQuotationVersion(qId: number, revision: number, at?: string): Promise<void> {
    const row = await db.get('SELECT * FROM quotations WHERE id = ?', [qId]) as Record<string, unknown> | null
    if (!row) return
    const items = (
      await db.all(
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
    // 存档是转单取数的唯一来源：本币单在这里就得归一成 1，
    // 否则一张升级前的老报价转出订单，成本会按 7.15 再折一遍
    const currency = String(row.currency ?? 'USD') as Currency
    const baseCurrency = String(row.base_currency ?? 'CNY') as Currency
    const isHome = currency === baseCurrency
    const snap: QuotationSnapshot = {
      qNo: String(row.q_no ?? ''),
      customerId: Number(row.customer_id),
      currency,
      exchangeRate: isHome ? 1 : Number(row.exchange_rate ?? 0),
      exchangeRateDate: isHome ? null : row.exchange_rate_date == null ? null : String(row.exchange_rate_date),
      baseCurrency,
      incoterm: String(row.incoterm ?? 'FOB') as Incoterm,
      portOfLoading: String(row.port_of_loading ?? ''),
      portOfDestination: String(row.port_of_destination ?? ''),
      paymentMethod: String(row.payment_method ?? 'tt_deposit') as PaymentMethod,
      depositRatio: Number(row.deposit_ratio ?? 0),
      validUntil: row.valid_until == null ? null : String(row.valid_until),
      customerPo: String(row.customer_po ?? ''),
      note: String(row.note ?? ''),
      charges,
      billTo: await billPartyForFreeze(row),
      items
    }
    const goodsTotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
    const grandTotal = goodsTotal + charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
    await db.run(
      `INSERT OR IGNORE INTO quotation_versions(quotation_id, revision, snapshot_json, goods_total, grand_total, created_at)
       VALUES(?,?,?,?,?,?)`,
      [qId, revision, JSON.stringify(snap), goodsTotal, grandTotal, at ?? now()]
    )
  }

  /** 老报价没有存档时，把当前内容补成「升级前的这一版」，不重算历史 */
  async function ensureQuotationVersion(qId: number, revision: number): Promise<void> {
    const has = await db.get('SELECT id FROM quotation_versions WHERE quotation_id = ? LIMIT 1', [qId])
    if (has) return
    // 补档发生在只读路径（打开版本历史、转单前核对）：拿 now() 会把「升级前的那一版」
    // 标成浏览的那一天，几个月前发出去的报价在历史里变成「第 1 版 · 今天」。用单子自己的时间
    const own = await db.get('SELECT created_at, updated_at FROM quotations WHERE id = ?', [qId]) as
      | { created_at?: string; updated_at?: string }
      | null
    await freezeQuotationVersion(qId, revision, String(own?.updated_at ?? own?.created_at ?? '') || now())
  }

  async function listQuotationVersions(id: number): Promise<QuotationVersionSummary[]> {
    const q = await db.get('SELECT revision FROM quotations WHERE id = ?', [id]) as { revision?: number } | null
    if (!q) throw notFound('报价单不存在')
    await ensureQuotationVersion(id, Number(q.revision ?? 1))
    const rows = await db.all(
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

  async function listQuotations(filter: {
    keyword?: string
    customerId?: number
    status?: string
    result?: string
  } = {}): Promise<QuotationDetail[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    const kw = (filter.keyword ?? '').trim()
    if (kw) {
      // 搜索范围：报价号 / 客户PO号 / 客户名 / 款号（客户问「上次那个款报多少」也能翻出来）
      const own = likeAny(['q.q_no', 'q.customer_po', 'c.company'], kw)
      const items = likeAny(['qi.style_no', 'qi.product_name'], kw)
      where.push(`(${own.sql} OR EXISTS (SELECT 1 FROM quotation_items qi WHERE qi.quotation_id = q.id AND (${items.sql})))`)
      params.push(...own.params, ...items.params)
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
    const rows = await db.all(
      `SELECT q.* FROM quotations q JOIN customers c ON c.id = q.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY q.created_at DESC, q.id DESC`,
      params
    ) as Record<string, unknown>[]
    return Promise.all(rows.map(async (r) => hydrate(mapQuotation(r), r)))
  }

  async function getQuotation(id: number): Promise<QuotationDetail | null> {
    const row = await db.get('SELECT * FROM quotations WHERE id = ?', [id]) as Record<string, unknown> | null
    if (!row) return null
    return hydrate(mapQuotation(row), row)
  }

  /** 存档用的抬头：优先用单上冻结的快照，老单退回客户档案当前值 */
  async function billPartyForFreeze(qRow: Record<string, unknown>): Promise<PartySnapshot> {
    const fromDoc = parseParty(qRow.bill_to_json)
    if (fromDoc) return fromDoc
    const cRow = await db.get('SELECT * FROM customers WHERE id = ?', [Number(qRow.customer_id)]) as
      | Record<string, unknown>
      | null
    const c = cRow ? mapCustomer(cRow) : null
    return c ? billPartyOf(c) : emptyParty()
  }

  /**
   * 报价单抬头快照：新建时取客户档案当时的值；
   * 编辑时默认沿用原快照（改档案不许重写已经发出去的报价），
   * 只有业务员在本单上手工改过才更新。
   */
  async function billForQuotation(
    customerId: number,
    input: QuotationInput,
    before?: Record<string, unknown> | null
  ): Promise<string> {
    const row = await db.get('SELECT * FROM customers WHERE id = ?', [customerId]) as Record<string, unknown> | null
    const c = row ? mapCustomer(row) : null
    if (!c) throw bizError(`客户编号 ${customerId} 不存在，不能建报价单`)
    // 换了客户就重新取新客户的档案抬头；没换则沿用它已经冻结的那份
    const keepExisting = before && Number(before.customer_id) === customerId
    const base = (keepExisting ? parseParty(before?.bill_to_json) : null) ?? billPartyOf(c)
    return stringifyParty(patchParty(base, input.billTo))
  }

  /**
   * 保存报价单。整段写包在一个事务里：主表、明细「删旧插新」、版本冻结、历史是一件事，
   * 中途抛错（比如第 3 行明细没过校验）不能留下「明细被删光、只剩半张单」的现场。
   */
  function saveQuotation(input: QuotationInput): Promise<QuotationDetail> {
    return db.transact(() => saveQuotationInner(input))
  }

  async function saveQuotationInner(input: QuotationInput): Promise<QuotationDetail> {
    const ts = now()
    // 明细闸门先过一遍再动库：删旧插新之前就知道哪一行不合规
    input.items.forEach((it, i) => {
      const who = `第 ${i + 1} 行（款号 ${it.styleNo || '未填'}）`
      assertQuantity(it.quantity, `${who} 的数量`)
      assertUnitPrice(it.unitPrice, `${who} 的单价`)
    })
    // 源头拦同款两行：转单时明细原样带过去，两行不同单价会把 CI 金额算乱
    await ordersOf().assertSkuListUnique(input.items, '报价单')
    const settings = await settingsCore(db).get()
    // 费用行与有效期是「编辑时没传 ≠ 要清空」的列：先按传了的算，
    // 走到更新分支时再用数据库原值兜住漏传（见下面的 keepCharges/keepValidUntil）
    ordersOf().assertChargeAmounts(input.charges ?? [])
    const charges = JSON.stringify((input.charges ?? []).filter((c) => c.label.trim()))
    /**
     * 有效期三态：没传＝这次不动它（只有新建才给「今天+N」默认）；
     * 传了但是空的＝用户明确清空，一律落 NULL。
     * 清空绝不能悄悄写成「今天+N」：那张纸会印出一个客户从没确认过的日期。
     */
    const sentValidUntil = input.validUntil === undefined ? undefined : String(input.validUntil ?? '').trim() || null
    const validUntil = sentValidUntil ?? addDays(localDate(), settings.piValidDays)
    // 货值现算：负合计守门和转单用的是同一份口径（Σ 数量×单价）
    const goodsTotal = input.items.reduce(
      (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
      0
    )
    // 汇率：本币不用填，系统按 1 记——否则按汇率折算的报表会把 ¥ 当 $ 再乘一遍。
    // 外币必须手动填：系统不拿默认值蒙人，也不替人编锁定日期
    let rate = Number(input.exchangeRate ?? 0)
    const isHome = (currency: string, base: string): boolean => currency === base

    let qId = input.id
    let rateDate = input.exchangeRateDate ?? null
    let revision = 1
    let status: QuotationStatus = input.status ?? 'draft'
    let result: QuotationResult = input.result ?? 'pending'
    let changeNote = ''
    let oldStatus: string | null = null

    if (qId) {
      const before = await db.get('SELECT * FROM quotations WHERE id = ?', [qId]) as Record<string, unknown> | null
      if (!before) throw notFound('报价单不存在')
      // 已转订单的报价单是那单的原始报价凭据：价格、明细、费用事后一改，
      // 订单和报价单就对不上了，客户拿两份纸来问谁也说不清。
      // 例外：转出的订单已经作废——那张单不再是活凭据，锁死报价只会逼人另建一张同号单
      if (before.converted_order_id) {
        const o = await db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [
          Number(before.converted_order_id)
        ]) as { order_no?: string; payment_status?: string } | null
        if (o?.payment_status !== 'void') {
          throw bizError(
            `报价单 ${before.q_no} 已经转成订单 ${o?.order_no ?? ''}，是那单的原始报价凭据，不能再改。要改价格请直接改订单；` +
              `那张订单确实作废了之后，这里就能改价重转。`
          )
        }
      }
      const oldItems = (
        await db.all('SELECT style_no, color, size, quantity, unit_price FROM quotation_items WHERE quotation_id = ? ORDER BY id', [
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
      // 「这次没传」不等于「要清空」：漏传费用/有效期时保留数据库原值，
      // 否则编辑一次就把费用表写成空、有效期推到「今天+N」，客户手里那张纸悄悄变了
      const keepCharges = input.charges === undefined ? oldCharges : input.charges
      const keepValidUntil = sentValidUntil === undefined ? ((before.valid_until as string | null) ?? null) : sentValidUntil
      const nextCurrency = String(input.currency ?? before.currency ?? '') || 'USD'
      const nextBase = String(input.baseCurrency ?? before.base_currency ?? '') || settings.baseCurrency
      const homeCurrency = isHome(nextCurrency, nextBase)
      // 本币单的汇率只有一个真值；外币单必须真填过汇率才许存。
      // 编辑时没传汇率＝这次只动了明细/费用，沿用库里原来那份（客户端、脚本都能这么改）；
      // 但换了币种就不能沿用：USD 的 7.15 填到 EUR 上等于凭空改价
      if (homeCurrency) rate = 1
      else if (input.exchangeRate === undefined) {
        if (!(oldRate > 0)) throw bizError('请先按今天钉盘的汇率填写汇率')
        if (nextCurrency !== String(before.currency ?? '')) {
          throw bizError(
            `币种从 ${String(before.currency ?? '')} 换成 ${nextCurrency}，汇率不能沿用原来的 ${oldRate}；请按 ${nextCurrency} 重新填写汇率再保存。`
          )
        }
        rate = oldRate
      } else if (!(rate > 0)) throw bizError('请先按今天钉盘的汇率填写汇率')
      // 负合计不许落库：转单时它会原样变成订单的负合计，被当成客户多付
      ordersOf().assertOrderTotalNonNegative(
        goodsTotal,
        keepCharges.filter((c) => c.label.trim()),
        '让利（负费用行）',
        '报价单，转成订单后'
      )
      // 汇率没变就沿用原来的日期；变了就记今天（谁改的谁负责）。
      // 本币没有「哪天锁的汇」这回事，日期一律留空
      rateDate = homeCurrency
        ? null
        : rateDate || (oldRate === rate ? oldDate ?? localDate() : localDate())
      // 状态/结果没传就保持原样（编辑一张已转订单的报价单不能把状态打回草稿）
      oldStatus = String(before.status ?? '')
      status = input.status ?? (before.status as QuotationStatus)
      result = input.result ?? (before.result as QuotationResult)
      revision = Number(before.revision ?? 1) + 1
      changeNote = describeChange(oldItems, input.items, oldCharges, keepCharges)
      // 条款也是报价的一部分：改 FOB/CIF、付款方式、有效期、汇率必须留痕
      const termBits: string[] = []
      const nextIncoterm = input.incoterm ?? (before.incoterm as Incoterm)
      const nextPayment = input.paymentMethod ?? (before.payment_method as PaymentMethod)
      if (nextIncoterm !== before.incoterm) termBits.push(`贸易术语 ${before.incoterm} → ${nextIncoterm}`)
      if (nextPayment !== before.payment_method) termBits.push(`付款方式 ${before.payment_method} → ${nextPayment}`)
      if (nextCurrency !== String(before.currency ?? 'USD')) termBits.push(`币种 ${before.currency} → ${nextCurrency}`)
      if (keepValidUntil !== before.valid_until)
        termBits.push(`有效期 ${before.valid_until || '未填'} → ${keepValidUntil || '未填'}`)
      // 本币单把老汇率归一到 1 是修数据，不是改了条款，不能记成一次「汇率变更」
      if (!homeCurrency && Math.abs(oldRate - rate) > 0.0001) termBits.push(`汇率 ${oldRate} → ${rate}`)
      if (termBits.length) changeNote = changeNote ? `${changeNote}；${termBits.join('；')}` : termBits.join('；')

      // 改之前先把当前版冻结：客户手里那张纸必须能原样找回来
      // 时间用上一版的落笔时刻（updated_at），不是这次编辑的时刻——否则历史里第 N 版
      // 会显示成「我改它的那一天」，看不出这一版本来挂了多久
      await freezeQuotationVersion(qId, Number(before.revision ?? 1), String(before.updated_at ?? '') || now())

      const nextCustomerId = input.customerId ?? Number(before.customer_id)
      const billJson = await billForQuotation(nextCustomerId, input, before)
      // 发出时间：只在「这次真的发出去了」时刷新，改价重发重新计时
      const sentAt = status === 'sent' && oldStatus !== 'sent' ? ts : (before.sent_at as string | null) ?? null
      // 确认时间：客户点头那一刻记下来。改备注/补结果只动 updated_at，不许把等待天数清零
      const confirmedAt =
        status === 'confirmed'
          ? oldStatus === 'confirmed'
            ? ((before.confirmed_at as string | null) ?? null)
            : ts
          : null

      /** 只写这次传了的列，没传的保留原值——见 keepCharges/keepValidUntil 上面的注释 */
      const keep = (key: keyof QuotationInput, col: string): unknown => (input[key] === undefined ? before[col] : input[key])
      const keepText = (key: keyof QuotationInput, col: string): string => {
        const v = keep(key, col)
        return v == null ? '' : String(v)
      }
      const cells: Array<[string, unknown]> = [
        ['customer_id', nextCustomerId],
        ['currency', nextCurrency],
        ['exchange_rate', rate],
        ['exchange_rate_date', rateDate],
        ['base_currency', nextBase],
        ['incoterm', keepText('incoterm', 'incoterm') || 'FOB'],
        ['port_of_loading', keepText('portOfLoading', 'port_of_loading')],
        ['port_of_destination', keepText('portOfDestination', 'port_of_destination')],
        ['payment_method', keepText('paymentMethod', 'payment_method') || 'tt_deposit'],
        ['deposit_ratio', keep('depositRatio', 'deposit_ratio') ?? settings.defaultDepositRatio],
        ['valid_until', keepValidUntil],
        ['customer_po', keepText('customerPo', 'customer_po')],
        ['note', keepText('note', 'note')],
        ['charges', JSON.stringify(keepCharges.filter((c) => c.label.trim()))],
        ['status', status],
        ['result', result],
        ['revision', revision],
        ['bill_to_json', billJson],
        ['sent_at', sentAt],
        ['confirmed_at', confirmedAt]
      ]
      await db.run(
        `UPDATE quotations SET ${cells.map(([col]) => `${col}=?`).join(', ')}, updated_at=? WHERE id=?`,
        [...cells.map(([, v]) => v as string | number | null), ts, qId]
      )
      await db.run('DELETE FROM quotation_items WHERE quotation_id = ?', [qId])
    } else {
      const createCurrency = String(input.currency ?? '') || 'USD'
      const createBase = String(input.baseCurrency ?? '') || settings.baseCurrency
      if (isHome(createCurrency, createBase)) {
        rate = 1
        rateDate = null
      } else {
        if (!(rate > 0)) throw bizError('请先按今天钉盘的汇率填写汇率')
        if (!rateDate) rateDate = localDate()
      }
      // 负合计不许落库：转单时它会原样变成订单的负合计，被当成客户多付
      ordersOf().assertOrderTotalNonNegative(
        goodsTotal,
        (input.charges ?? []).filter((c) => c.label.trim()),
        '让利（负费用行）',
        '报价单，转成订单后'
      )
      const qNo = await nextNo(db, 'Q')
      const billJson = await billForQuotation(input.customerId, input, null)
      const res = await db.run(
        `INSERT INTO quotations(q_no, customer_id, status, result, currency, exchange_rate, exchange_rate_date, base_currency, incoterm,
          port_of_loading, port_of_destination, payment_method, deposit_ratio, valid_until, customer_po, note,
          charges, bill_to_json, converted_order_id, revision, sent_at, confirmed_at, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?,?)`,
        [
          qNo,
          input.customerId,
          status,
          result,
          createCurrency,
          rate,
          rateDate,
          createBase,
          input.incoterm ?? 'FOB',
          input.portOfLoading ?? '',
          input.portOfDestination ?? '',
          input.paymentMethod ?? 'tt_deposit',
          input.depositRatio ?? settings.defaultDepositRatio,
          validUntil,
          input.customerPo ?? '',
          input.note ?? '',
          charges,
          billJson,
          status === 'sent' ? ts : null,
          status === 'confirmed' ? ts : null,
          ts,
          ts
        ]
      )
      qId = Number(res.lastInsertRowid)
    }

    for (const it of input.items) {
      // 手工加的行：按款号在商品库里找一下，找到就把 product_id 记上（转订单时能带出成本价）
      const productId = it.productId ?? (await findProductIdByStyleNo(it.styleNo))
      await db.run(
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
    // 这一版的落笔时间与单子本身的 updated_at 对齐，版本历史与「最后修改」不打架
    await freezeQuotationVersion(qId, revision, ts)
    await logQuotationEvent(qId, input.id ? 'update' : 'create', changeNote || (input.id ? '修改报价单' : '新建报价单'))
    // 状态单独记一条：谁把这张报价发出去的、什么时候，历史里都要查得到
    if (input.id && status !== oldStatus) {
      await logQuotationEvent(qId, 'status', `状态 ${oldStatus || '无'} → ${status}`)
    }
    return (await getQuotation(qId))!
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
    // 和订单同一份多重集比对：两张「运费」行改一张，Map 会把它们叠成一条，
    // 历史里看不出到底动了哪一张
    parts.push(...describeChargeChange(oldCharges, newCharges.filter((c) => c.label.trim()), '费用'))
    if (parts.length === 0) return '修改报价单'
    return `修改报价单：${parts.join('；')}`
  }

  /** 报价单自己的操作历史（改了什么、什么时候改的） */
  async function logQuotationEvent(quotationId: number, kind: string, note: string): Promise<void> {
    await db.run('INSERT INTO quotation_events(quotation_id, at, kind, note) VALUES(?,?,?,?)', [
      quotationId,
      now(),
      kind,
      note
    ])
  }

  async function listQuotationEvents(
    quotationId: number
  ): Promise<{ id: number; at: string; kind: string; note: string }[]> {
    const rows = await db.all(
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

  async function deleteQuotation(id: number): Promise<void> {
    const q = await db.get('SELECT q_no, converted_order_id FROM quotations WHERE id = ?', [id]) as
      | { q_no?: string; converted_order_id?: number | null }
      | null
    if (!q) return
    // 存档的报价 PDF 挂在报价单下（外键 CASCADE）：删报价会把发过客户的纸面索引一起删掉
    const docCount = Number(
      (
        await db.get('SELECT COUNT(*) AS n FROM doc_versions WHERE quotation_id = ?', [id]) as { n?: number } | null
      )?.n ?? 0
    )
    if (docCount > 0) {
      throw bizError(
        `报价单 ${q.q_no} 已经有 ${docCount} 份单据存档，删了就连同发过客户的报价 PDF 一起查不到了。不要这张报价，请把「状态」改成「已失效」——记录和存档都留着。`
      )
    }
    // N31：已转成订单的报价单是那单的原始报价凭据，删了以后订单操作历史里只剩一个查不到的编号。
    // 转出的订单已作废时不拦：那张单已经不在账上，留着这张报价反而挡住重开一单。
    if (q.converted_order_id) {
      const o = await db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [Number(q.converted_order_id)]) as
        | { order_no?: string; payment_status?: string }
        | null
      if (o?.order_no && o.payment_status !== 'void') {
        throw bizError(
          `报价单 ${q.q_no} 已经转成订单 ${o.order_no}，删了以后就查不到原始报价了。\n` +
            `要作废请把「状态」改成「已失效」，报价记录和版本存档都保留。`
        )
      }
    }
    await db.run('DELETE FROM quotations WHERE id = ?', [id])
  }

  /** 改状态 / 改报价结果 */
  async function updateQuotationMeta(
    id: number,
    meta: { status?: QuotationStatus; result?: QuotationResult }
  ): Promise<QuotationDetail> {
    const cur = await db.get(
      'SELECT status, result, sent_at, confirmed_at, converted_order_id FROM quotations WHERE id = ?',
      [id]
    ) as
      | {
          status: string
          result: string
          sent_at: string | null
          confirmed_at: string | null
          converted_order_id: number | null
        }
      | null
    if (!cur) throw notFound('报价单不存在')
    // 已转单的报价，成交与否已经由订单定案：再改成「已失效/失败」，同一个客户同一票货
    // 会在报表里既算成交又算流失，订单的原始报价也成了无主凭据。
    // 转出的订单已作废则不再有「定案」可言，放开让人改（对齐转单/编辑的口径）
    if (cur.converted_order_id) {
      const changed =
        (meta.status !== undefined && meta.status !== cur.status) ||
        (meta.result !== undefined && meta.result !== cur.result)
      if (changed) {
        const o = await db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [Number(cur.converted_order_id)]) as
          | { order_no?: string; payment_status?: string }
          | null
        if (o?.payment_status !== 'void') {
          throw bizError(
            `报价单已经转成订单 ${o?.order_no ?? ''}，状态和结果不能再改：这票货的成交与否已经由订单决定。要调整请直接改订单。`
          )
        }
      }
    }
    const ts = now()
    const status = meta.status ?? (cur.status as QuotationStatus)
    const statusChanged = status !== cur.status
    // 只在这里改状态时，也要把「发出/确认」的时间钉下来：
    // 工作台的等待天数按这两列起算，否则改一次状态还得靠 updated_at 猜
    const sentAt = status === 'sent' && statusChanged ? ts : cur.sent_at ?? null
    const confirmedAt =
      status === 'confirmed' ? (cur.status === 'confirmed' ? cur.confirmed_at ?? null : ts) : null
    // 只改结果不动「最后修改」：纸面一个字都没变。列表上的「发后改过」是从
    // updated_at > sent_at 派生的，勾一下成交/失败就跟着喊「待重发」，等于教人别信这个标记
    // 状态、时间和留痕必须一起落：中间断掉就是「状态改了、历史里没有」，
    // 工作台按 sent_at/confirmed_at 起算的等待天数也会跟历史对不上
    await db.transact(async () => {
      await db.run('UPDATE quotations SET status=?, result=?, sent_at=?, confirmed_at=?, updated_at=COALESCE(?, updated_at) WHERE id=?', [
        status,
        meta.result ?? cur.result,
        sentAt,
        confirmedAt,
        statusChanged ? ts : null,
        id
      ])
      const parts: string[] = []
      if (meta.status && meta.status !== cur.status) parts.push(`状态 ${cur.status} → ${meta.status}`)
      if (meta.result && meta.result !== cur.result) parts.push(`结果 ${cur.result} → ${meta.result}`)
      if (parts.length) await logQuotationEvent(id, 'meta', parts.join('；'))
    })
    return (await getQuotation(id))!
  }

  /**
   * 报价单转订单：款号、颜色、尺码、数量、单价一个数字都不用重敲。
   * 转出来的订单是「草稿」状态，由业务员核对后再发 PI。
   */
  async function convertToOrder(
    id: number,
    opts: {
      paymentStatus?: 'draft' | 'sent'
      /** 按第几版转；不填 = 当前最新版 */
      revision?: number
      /** 过期报价要沿用：必须写清批准人和原因 */
      override?: { approvedBy?: string; reason?: string }
    } = {}
  ): Promise<OrderDetail> {
    const q = await getQuotation(id)
    if (!q) throw notFound('报价单不存在')
    if (q.convertedOrderId) {
      const exist = await ordersOf().getOrder(q.convertedOrderId)
      // 上次转出的单还活着就复用；已经作废了要继续做生意，按新单重转（对齐打样转单口径）
      if (exist && exist.paymentStatus !== 'void') return exist
    }
    // 汇率日期必须是真的：外币没有就不许转单，绝不拿转单当天冒充。
    // 本币单不涉汇率，自然也没有「哪天的汇率」
    if (q.currency !== q.baseCurrency && !q.exchangeRateDate) {
      throw bizError('这张报价单没有汇率日期，请先编辑报价单把汇率日期补上再转订单')
    }

    await ensureQuotationVersion(id, Number(q.revision ?? 1))
    const targetRevision = Number(opts.revision ?? q.revision ?? 1)
    const versionRow = await db.get('SELECT snapshot_json, grand_total FROM quotation_versions WHERE quotation_id = ? AND revision = ?', [
      id,
      targetRevision
    ]) as { snapshot_json?: string; grand_total?: number } | null
    if (!versionRow) {
      throw bizError(
        `报价单 ${q.qNo} 没有第 ${targetRevision} 版的存档（最早存档从升级后的修改开始）。请选一个已有版本，或重新保存后再转。`
      )
    }
    let snap: QuotationSnapshot
    try {
      snap = JSON.parse(String(versionRow.snapshot_json ?? '')) as QuotationSnapshot
    } catch {
      throw bizError(`报价单 ${q.qNo} 第 ${targetRevision} 版的存档读不出来，不能拿它转单。请在报价页重新保存一版。`)
    }
    const snapGrand = Number(versionRow.grand_total ?? 0)
    // 存档里的汇率也归一：升级前冻结的本币单可能存着 7.15，
    // 直接拿去建单会把成本再折一遍，毛利全错
    const snapIsHome = snap.currency === snap.baseCurrency
    const snapRate = baseRateOf(snap.currency, snap.baseCurrency, snap.exchangeRate)

    // 有效期是锁汇的承诺：过期、失效、丢单都必须有人明确批准才能沿用
    const today = localDate()
    const expired =
      q.status === 'expired' ||
      Boolean(snap.validUntil && snap.validUntil < today)
    const approvedBy = String(opts.override?.approvedBy ?? '').trim()
    const overrideReason = String(opts.override?.reason ?? '').trim()
    if (expired && (!approvedBy || !overrideReason)) {
      throw bizError(
        `报价单 ${q.qNo} 的有效期是 ${snap.validUntil || '未填'}，已经过期。` +
          `要按旧价转单，必须填写批准人和沿用原因；否则请先重报一版。`
      )
    }

    const currentGrand = q.grandTotal
    const diff = snapGrand - currentGrand
    let overrideNote = expired
      ? `报价已过期，经 ${approvedBy} 批准沿用（原因：${overrideReason}）`
      : ''
    // 批准沿用的是「价格」：有效期是当时报盘的时间承诺，跟着旧日期转单，
    // 新 PI 当天就挂「有效期已逾期」的催办。重置为新 PI 的标准有效期并留痕。
    const freshValidUntil = expired ? addDays(today, (await settingsCore(db).get()).piValidDays) : snap.validUntil
    if (expired) overrideNote += `；有效期已从 ${snap.validUntil || '未填'} 重置为 ${freshValidUntil}`

    // 转单挡：存档里的同款两行不能原样带进订单（老数据；新存的报价单在源头已拦）
    await ordersOf().assertSkuListUnique(snap.items, `报价单 ${q.qNo} 第 ${targetRevision} 版存档`)
    // 老存档可能是在负合计守门之前冻结的：转出去就是一张被当成客户多付的订单
    ordersOf().assertOrderTotalNonNegative(
      snap.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0),
      (snap.charges ?? []).filter((c) => c.label.trim()),
      '让利（负费用行）',
      '报价单存档，转成订单后'
    )

    return db.transact(async () => {
      const order = await ordersOf().createOrder({
        customerId: snap.customerId,
        currency: snap.currency,
        exchangeRate: snapRate,
        exchangeRateDate: snapIsHome ? null : snap.exchangeRateDate,
        baseCurrency: snap.baseCurrency,
        incoterm: snap.incoterm,
        portOfLoading: snap.portOfLoading,
        portOfDestination: snap.portOfDestination,
        paymentMethod: snap.paymentMethod,
        depositRatio: snap.depositRatio,
        validUntil: freshValidUntil,
        customerPo: snap.customerPo,
        charges: snap.charges,
        // 抬头按报价那一版带走（老存档没有就沿用客户档案）
        billTo: snap.billTo,
        // 订单备注原样印在 PI/CI 的 Remarks 框里：只留「由报价单 X 第 N 版转成」这句凭据，
        // 报价单上的自由文本进订单历史，不跟着纸走到客户手里
        note: `由报价单 ${snap.qNo} 第 ${targetRevision} 版转成`,
        // 转订单的落点状态：PI 已发 = 待确认（sent），否则草稿
        paymentStatus: opts.paymentStatus ?? 'sent'
      })

      for (const it of snap.items) {
        // 成本价：先按商品 id 找，找不到就按款号在商品库里找（手工加的行也能带上成本）
        let productId = it.productId ?? null
        let costBase: number | null = null
        if (productId) {
          const p = await db.get('SELECT id, cost_price FROM products WHERE id = ?', [productId]) as
            | { id?: number; cost_price?: number | null }
            | null
          // 商品被删过：ID 悬空就置空，别让订单明细指着一个不存在的款
          if (!p) productId = null
          else costBase = p.cost_price ?? null
        }
        if (costBase == null) {
          const byStyle = await findProductByStyleNo(it.styleNo)
          if (byStyle) {
            productId = byStyle.id
            costBase = byStyle.cost_price
          }
        }
        // 商品成本是工厂价（基准币），订单明细的成本要落在本单币种上，
        // 直接抄进 unit_cost 会把 ¥30 当成 $30，毛利全错
        const cost = costInOrderCurrency(costBase, snapRate)
        await db.run(
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
      await db.run('UPDATE orders SET source_quotation_id = ?, source_revision = ?, updated_at = ? WHERE id = ?', [
        id,
        targetRevision,
        now(),
        order.id
      ])
      // 过期报价的审批话术**只进操作历史**（下面那条 quotation_convert 事件），绝不写进订单备注：
      // note 会原样印在 PI/CI 上发给客户，「经谁批准、为什么让步、有效期重置」都是我方内部口径，
      // 客户看见议价底线，下次报价就拿它压人。原来这里还会整句覆盖掉「由报价单…转成」的凭据句。
      // 明细同样是在这个事务里裸插的，不经 addItem 的自动重算：转完补一次，
      // 让「合计已经抵平」的报价单落库时就是它真正的收款状态，
      // 而不是顶着一张「已发出」去挨催（draft 走不到这里——recompute 对草稿早返回）
      await ordersOf().recomputePaymentStatus(order.id)
      const saved = (await ordersOf().getOrder(order.id))!
      if (Math.abs(saved.grandTotal - snapGrand) > 0.005) {
        throw bizError(
          `按第 ${targetRevision} 版转单后金额对不上：存档合计 ${snapGrand.toFixed(2)}，订单算出来 ${saved.grandTotal.toFixed(2)}。已回滚，请检查报价明细。`
        )
      }
      await logEvent(db, 
        order.id,
        'quotation_convert',
        null,
        null,
        `由报价单 ${snap.qNo} 第 ${targetRevision} 版转成订单，商品明细原样带入` +
          (snapIsHome ? '（本币单，不涉汇率）' : `（汇率 ${snapRate}，汇率日期 ${snap.exchangeRateDate}）`) +
          (targetRevision !== Number(q.revision ?? 1)
            ? `；当前最新第 ${q.revision} 版合计 ${currentGrand.toFixed(2)}，差额 ${diff.toFixed(2)}`
            : '') +
          // 报价单上的自由文本不再跟着订单备注印上 PI/CI，改在这里留痕：
          // 业务员翻订单历史仍然查得到那一版写了什么
          (snap.note ? `；报价单备注：${snap.note}` : '') +
          (overrideNote ? `；${overrideNote}` : '')
      )
      await logQuotationEvent(
        id,
        'convert',
        `按第 ${targetRevision} 版转成订单 ${saved.orderNo}${overrideNote ? `；${overrideNote}` : ''}`
      )

      await db.run('UPDATE quotations SET status=?, result=?, converted_order_id=?, updated_at=? WHERE id=?', [
        'converted',
        'won',
        order.id,
        now(),
        id
      ])
      return saved
    })
  }

  return {
    now,
    mapCustomerLocal,
    findProductByStyleNo,
    findProductIdByStyleNo,
    hydrate,
    freezeQuotationVersion,
    ensureQuotationVersion,
    listQuotationVersions,
    listQuotations,
    getQuotation,
    billPartyForFreeze,
    billForQuotation,
    saveQuotation,
    saveQuotationInner,
    describeChange,
    logQuotationEvent,
    listQuotationEvents,
    deleteQuotation,
    updateQuotationMeta,
    convertToOrder
  }
}

/** 报价域门面类型 */
export type QuotationsCore = ReturnType<typeof quotationsCore>
