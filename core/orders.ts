/**
 * 订单域：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 以前桌面服务直接摸本机同步驱动，后端要用只能另写一份；现在只有这里一处 SQL 与守门。
 * 依赖只有异步 Db 接口 + 纯函数 mapper/守门，不碰 electron、不碰文件系统
 * （订单照片的实物文件由桌面那层壳负责删）。
 *
 * 与 credits / samples 互相调用（转单、抵扣、回退），这里按需懒建对方的工厂，
 * 避免模块初始化时互相等——两边拿到的永远是同一个连接。
 */
import { bizError, notFound } from '../src/shared/errors'
import type { Db } from './db'
import { nextNo } from './next-no'
import { logEvent } from './events'
import { settingsCore } from './settings'
import { applyShipStatus, isShipStatusDerived, shipmentSummary } from './shipping'
import { creditsCore } from './credits'
import { samplesCore } from './samples'
import { baseRateOf, computeOrderMoney, costInOrderCurrency, depositDueOf, describeChargeChange, moneyCore, notInStatuses, parseCharges } from './money'
import { mapCustomer, mapEvent, mapOrder, mapOrderItem, mapOrderPhoto, mapPackingList, mapPackingListLine, mapPayment, mapSettlement, mapSkuSummary } from '../electron/db/mappers'
import { likeAny } from '../electron/services/search'
import { addDays, daysBetween, isLocalDate, localDate, localDayAfterUtc, localDayStartUtc } from '../src/shared/date'
import { billPartyOf, emptyParty, parseParty, patchParty, shipPartyOf, stringifyParty } from '../src/shared/party'
import { isBillingStatus, NON_BILLING_STATUSES, sampleOffsetFromCharges, sampleOpenFeeOf, shownRemaining } from '../src/shared/billing'
import { assertDepositRatio, assertDocNo, assertQuantity, assertUnitPrice } from '../src/shared/guards'
import { PAYMENT_STATUS_LABEL, SETTLEMENT_KIND_LABEL, SHIP_STATUS_LABEL, SHIP_STATUS_ORDER } from '../src/shared/types'
import type {
  Currency,
  Incoterm,
  Order,
  OrderDetail,
  OrderEvent,
  OrderListPage,
  OrderListRow,
  OrderPhoto,
  PackingList,
  PartySnapshot,
  PaymentMethod,
  PaymentStatus,
  QuotationCharge,
  SampleOrderDetail,
  Settlement,
  SettlementKind,
  ShipStatus,
  SkuSummary
} from '../src/shared/types'

/** 新建订单能直接落库的收款状态：刚建的单还没收过钱，不可能是已收/已结清 */
const CREATE_STATUSES: PaymentStatus[] = ['draft', 'sent', 'confirmed']

export interface OrderInput {
  id?: number
  customerId: number
  currency?: Currency
  exchangeRate?: number
  exchangeRateDate?: string | null
  baseCurrency?: Currency
  incoterm?: Incoterm
  portOfLoading?: string
  portOfDestination?: string
  paymentMethod?: PaymentMethod
  depositRatio?: number
  validUntil?: string | null
  expectedShipDate?: string | null
  expectedArrivalDate?: string | null
  customerPo?: string
  note?: string
  piNo?: string
  factory?: string
  factoryDueDate?: string | null
  cutOffDate?: string | null
  etdDate?: string | null
  vessel?: string
  sealNo?: string
  /** 正式费用行（运费/保险等） */
  charges?: QuotationCharge[]
  /** 改了让利（负费用行）时的原因；这句话进订单操作历史，和「只改费用行」那条正门同一个规矩 */
  chargeReason?: string
  /** 建单时的收款状态（报价单转订单时用：PI 已发 = sent） */
  paymentStatus?: PaymentStatus
  /** 买方抬头覆盖（不传就用客户档案当时的值，存进单子里冻结） */
  billTo?: Partial<PartySnapshot>
  /** 收货抬头覆盖（这单要送别的仓就在这里改） */
  shipTo?: Partial<PartySnapshot>
}

export interface OrderItemInput {
  productId?: number | null
  styleNo: string
  productName?: string
  composition?: string
  color?: string
  size?: string
  quantity: number
  unitPrice: number
  /** 行成本单价（订单币种） */
  unitCost?: number | null
  /** 工厂成本（基准币）：由服务端按本单汇率折算，前端不要自己乘除 */
  costBase?: number | null
}

export type OrderSort =
  | 'created_desc'
  | 'created_asc'
  | 'amount_desc'
  | 'amount_asc'
  | 'ship_asc'
  /** 待收（折基准币）高→低：催款先看最大的 */
  | 'owed_desc'
  /** 逾期最久的排前面，没逾期的按创建时间 */
  | 'overdue_first'

export interface OrderListFilter {
  keyword?: string
  paymentStatus?: string
  shipStatus?: string
  customerId?: number
  /** 本地日 YYYY-MM-DD（含这一天） */
  from?: string
  /** 本地日 YYYY-MM-DD（含这一天） */
  to?: string
  sort?: OrderSort
}

export interface PaymentInput {
  paidAt: string
  amount: number
  method?: string
  bankRef?: string
  note?: string
}

export interface BatchPaymentEntry {
  /** 订单和打样单二选一：一笔钱只属于一张单，不会同时挂两边 */
  orderId?: number
  sampleOrderId?: number
  paidAt: string
  amount: number
  method?: string
  bankRef?: string
  note?: string
}

export interface SettlementInput {
  kind: SettlementKind
  /** 金额；不填 = 当前待收全额 */
  amount?: number
  /** 业务发生日，默认今天 */
  at?: string
  reason: string
  evidence?: string
  /** 追回款：这笔钱实际到账的日期与流水号 */
  paidAt?: string
  bankRef?: string
  method?: string
}

export interface OrderTerms {
  currency: Currency
  exchangeRate: number
  incoterm: Incoterm
  portOfLoading: string
  portOfDestination: string
  paymentMethod: PaymentMethod
  depositRatio: number
  customerPo: string
  orderNo: string
  createdAt: string
}

/** 订单域的读写在同一个连接上；流水/抵扣/打样按需取，避免工厂互相初始化 */
export function ordersCore(db: Db) {
  let creditsApi: ReturnType<typeof creditsCore> | null = null
  let samplesApi: ReturnType<typeof samplesCore> | null = null
  let moneyApi: ReturnType<typeof moneyCore> | null = null
  const creditsOf = () => (creditsApi ??= creditsCore(db))
  const samplesOf = () => (samplesApi ??= samplesCore(db))
  const moneyOf = () => (moneyApi ??= moneyCore(db))

  /** sqlite 绑定参数 */
  type Bind = string | number | bigint | boolean | null | Uint8Array

  function now(): string {
    return new Date().toISOString()
  }

  /**
   * 作废 / 失效的单是留档凭据：还能看、还能重印，但不能再往上加明细、装箱或收钱。
   * 以前只有界面把入口藏了，主进程照收不误——一次调用就能把箱单和台账改得对不上。
   */
  async function assertOrderWritable(orderId: number, action: string): Promise<void> {
    const o = await db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [orderId]) as
      | { order_no?: string; payment_status?: string }
      | null
    if (!o) throw notFound('订单不存在')
    const no = String(o.order_no ?? '')
    const status = String(o.payment_status ?? '')
    if (status === 'void') {
      throw bizError(`订单 ${no} 已作废，不能再${action}：作废单只是留档，要接着做生意请按新单重开。`)
    }
    if (status === 'expired') {
      throw bizError(`订单 ${no} 已失效，不能再${action}：先把收款状态改回「客户已确认」，再继续。`)
    }
  }

  /**
   * 出过 CI 的单，单价与费用行就是批次金额的输入：
   * 批次金额 = 箱单件数 × 订单单价 + 费用按货值分摊。改价会让已经发出去的 CI
   * 与系统里重算的批次金额对不上，而存档的 PDF 又不会跟着变。
   * 数量不锁：分批金额按箱单件数算，改整单数量不会改写已出运那批的金额。
   */
  async function assertPricingEditable(orderId: number, action: string): Promise<void> {
    const row = await db.get(
      "SELECT MAX(version) AS v FROM doc_versions WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL",
      [orderId]
    ) as { v?: number | null } | null
    const ver = Number(row?.v ?? 0)
    if (ver > 0) {
      throw bizError(
        `这张单已经出过 CI（第 ${ver} 版存档），不能再${action}：批次金额是按当前单价和费用行算的，改了会和已经发出去的 CI 对不上。确实改错了价，先作废那一版 CI 存档（写明原因），改完重出正确的一版。`
      )
    }
  }

  /** 费用行是否真的变了（只比标签和金额，空标签不算一行） */
  function sameCharges(a: QuotationCharge[], b: QuotationCharge[]): boolean {
    const norm = (list: QuotationCharge[]) =>
      list
        .map((c) => ({ label: String(c.label ?? '').trim(), amount: Number(c.amount) }))
        .filter((c) => c.label)
        .map((c) => `${c.label}|${c.amount.toFixed(4)}`)
        .sort()
    const x = norm(a)
    const y = norm(b)
    return x.length === y.length && x.every((k, i) => k === y[i])
  }







  /** 订单列表的筛选条件 */


  /** 排序要看的几列：订单详情和瘦身列表行都有，比较器只写一遍 */
  interface SortKeys {
    id: number
    createdAt: string
    /** 货值（原币） */
    totalAmount: number
    exchangeRate: number
    /** 待收（原币） */
    remaining: number
    paymentStatus: string
    expectedShipDate: string | null
    shipStatus: ShipStatus
  }

  /** 出运之后的状态：货已经走了，交期不再算逾期 */
  const SHIPPED_STATUSES: ShipStatus[] = ['shipped', 'cleared', 'delivered']

  /**
   * 逾期天数（本地日）。
   * 没填预计出货日、货已经出运/清关/签收、或还没到期 → null（不是 0，0 会被当成「今天到期」）。
   */
  function daysLateOf(row: { expectedShipDate: string | null; shipStatus: ShipStatus }): number | null {
    if (!row.expectedShipDate || SHIPPED_STATUSES.includes(row.shipStatus)) return null
    const late = daysBetween(row.expectedShipDate, localDate())
    return late > 0 ? late : null
  }

  /**
   * 列表排序（订单列表与瘦身列表共用同一个比较器）。
   * 金额跨币种比较一律折成基准币，否则 7.1 的 CNY 单会压过 10 万美元的 USD 单。
   */
  function sortRows<T extends SortKeys>(list: T[], sort: OrderSort): T[] {
    const base = (o: T) => o.totalAmount * o.exchangeRate
    // 待收排序吃的是界面那个数（shownRemaining）：不催款的单算 0，多收的不许倒挂成负数抢前排
    const owedBase = (o: T) => shownRemaining(o.paymentStatus, o.remaining) * o.exchangeRate
    const byCreated = (a: T, b: T) =>
      a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1
    switch (sort) {
      case 'created_asc':
        return [...list].sort((a, b) => -byCreated(a, b))
      case 'amount_desc':
        return [...list].sort((a, b) => base(b) - base(a) || byCreated(a, b))
      case 'amount_asc':
        return [...list].sort((a, b) => base(a) - base(b) || byCreated(a, b))
      case 'ship_asc':
        return [...list].sort((a, b) => {
          const av = a.expectedShipDate ?? '9999-12-31'
          const bv = b.expectedShipDate ?? '9999-12-31'
          return av === bv ? byCreated(a, b) : av < bv ? -1 : 1
        })
      case 'owed_desc':
        // 按「屏幕上那个待收」排：作废/草稿/失效的单不催款，列表上显示「—」，
        // 拿它们的 remaining 参与比较会把一张不催的单顶到第一排
        return [...list].sort(
          (a, b) => owedBase(b) - owedBase(a) || byCreated(a, b)
        )
      case 'overdue_first':
        return [...list].sort(
          (a, b) => (daysLateOf(b) ?? -1) - (daysLateOf(a) ?? -1) || byCreated(a, b)
        )
      case 'created_desc':
      default:
        return [...list].sort(byCreated)
    }
  }

  /** 搜索框的关键词命中范围：单据本身 + 明细款号 + 批次柜号/提单号 + 收款流水号 */
  function keywordClause(kw: string): { sql: string; params: Bind[] } {
    const own = likeAny(
      [
        'o.order_no',
        'o.pi_no',
        'o.customer_po',
        'c.company',
        'o.port_of_loading',
        'o.port_of_destination',
        'o.factory',
        'o.vessel',
        'o.seal_no'
      ],
      kw
    )
    const items = likeAny(['oi.style_no', 'oi.product_name', 'oi.color', 'oi.size'], kw)
    const batches = likeAny(['pl.pl_no', 'pl.container_no', 'pl.bl_no', 'pl.vessel', 'pl.seal_no'], kw)
    const pays = likeAny(['p.bank_ref'], kw)
    return {
      sql:
        `(${own.sql}
          OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND (${items.sql}))
          OR EXISTS (SELECT 1 FROM packing_lists pl WHERE pl.order_id = o.id AND pl.voided_at IS NULL AND (${batches.sql}))
          OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND (${pays.sql})))`,
      params: [...own.params, ...items.params, ...batches.params, ...pays.params]
    }
  }

  /**
   * 列表 WHERE（订单列表与瘦身列表共用，两边筛出来的单必须一模一样）。
   *
   * 日期区间：created_at 存的是 UTC 时间戳，以前用 date(created_at) 比较是按 UTC 日切，
   * UTC+8 晚上 8 点后建的单会被算到前一天，报表和工作台又按本地日归集——
   * 同一段时间，列表和报表数不一样。现在两端都换成本地日的 UTC 边界。
   */
  function listWhere(filter: OrderListFilter): { sql: string; params: Bind[] } {
    const where: string[] = []
    const params: Bind[] = []
    const kw = (filter.keyword ?? '').trim()
    if (kw) {
      const clause = keywordClause(kw)
      where.push(clause.sql)
      params.push(...clause.params)
    }
    if (filter.paymentStatus) {
      where.push('o.payment_status = ?')
      params.push(filter.paymentStatus)
    } else {
      // 已作废的单不进默认列表（但在「已作废」页签里查得到，记录全留）
      where.push("o.payment_status != 'void'")
    }
    if (filter.shipStatus) {
      where.push('o.ship_status = ?')
      params.push(filter.shipStatus)
    }
    if (filter.customerId) {
      where.push('o.customer_id = ?')
      params.push(filter.customerId)
    }
    if (filter.from) {
      const gte = localDayStartUtc(filter.from)
      if (!gte) throw bizError('开始日期要填完整（例如 2026-10-01）。')
      where.push('o.created_at >= ?')
      params.push(gte)
    }
    if (filter.to) {
      const lt = localDayAfterUtc(filter.to)
      if (!lt) throw bizError('结束日期要填完整（例如 2026-10-31）。')
      where.push('o.created_at < ?')
      params.push(lt)
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
  }

  /**
   * 当前筛选命中的订单 id，与订单列表共用同一个 listWhere。
   * 导出台账拿它过滤：页面上筛出几张，Excel 里就是几张，合计才对得上。
   */
  async function listOrderIds(filter: OrderListFilter = {}): Promise<number[]> {
    const w = listWhere(filter)
    const rows = await db.all(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id ${w.sql}`,
      w.params
    ) as { id?: number }[]
    return rows.map((r) => Number(r.id))
  }

  /**
   * 全量展开的订单列表：每张单都要展开明细 / 收款 / 装箱 / 抬头。
   * 页面列表不许用它（用 listOrderRows），这里留给脚本和口径校验当参照。
   */
  async function listOrders(filter: OrderListFilter = {}): Promise<OrderDetail[]> {
    const w = listWhere(filter)
    const rows = await db.all(
      `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id ${w.sql}`,
      w.params
    ) as Record<string, unknown>[]
    const list: OrderDetail[] = []
    for (const r of rows) list.push(await hydrate(mapOrder(r), r))
    return sortRows(list, filter.sort ?? 'created_desc')
  }

  /**
   * 订单列表（瘦身版）：整页固定几条查询，不再逐单展开。
   *
   * 以前 300 张单点一下列表要等 2.7 秒（每张单 9 条查询），
   * 列表上那些字段其实一条明细都不需要。
   * 金额仍走 moneyForOrders → computeOrderMoney，与详情/单据/报表同一口径。
   *
   * 排序要先看全筛选集才能排（金额、待收、逾期都不是数据库里的列），
   * 所以先算完再切页；总数按筛选条件给，分页拿的是它而不是本页行数。
   */
  async function listOrderRows(
    filter: OrderListFilter & { limit?: number; offset?: number } = {}
  ): Promise<OrderListPage> {
    const w = listWhere(filter)
    const rows = await db.all(
      `SELECT o.id, o.order_no, o.pi_no, o.customer_po, o.currency, o.exchange_rate, o.base_currency,
              o.payment_status, o.ship_status, o.port_of_loading, o.port_of_destination,
              o.factory, o.vessel, o.seal_no, o.etd_date, o.cut_off_date, o.expected_ship_date,
              o.valid_until, o.charges, o.deposit_ratio, o.created_at,
              o.customer_id, c.company AS customer_company, c.country AS customer_country
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ${w.sql}`,
      w.params
    ) as Record<string, unknown>[]

    const moneyBy = await moneyOf().moneyForOrders(
      rows.map((r) => ({
        id: Number(r.id),
        charges: r.charges,
        depositRatio: Number(r.deposit_ratio ?? 0)
      }))
    )
    const ids = rows.map((r) => Number(r.id))
    const ph = ids.map(() => '?').join(',')
    const packBy = new Map<number, { qty: number; batches: number; containers: string }>()
    const styleBy = new Map<number, { styles: number; first: string }>()
    if (ids.length > 0) {
      // 已装箱件数、批次数与柜号：作废批次和空批次都不算（和 shipmentSummary 一个口径）
      const packRows = await db.all(
        `SELECT pl.order_id AS order_id, COUNT(*) AS batches,
                COALESCE(SUM(t.qty), 0) AS qty,
                GROUP_CONCAT(DISTINCT NULLIF(t.container_no, '')) AS containers
         FROM (
           SELECT pl2.id, pl2.order_id, pl2.container_no, COALESCE(SUM(l.quantity), 0) AS qty
           FROM packing_lists pl2
           LEFT JOIN packing_list_lines l ON l.packing_list_id = pl2.id
           WHERE pl2.order_id IN (${ph}) AND pl2.voided_at IS NULL
           GROUP BY pl2.id
           HAVING COALESCE(SUM(l.quantity), 0) > 0
         ) t JOIN packing_lists pl ON pl.id = t.id
         GROUP BY pl.order_id`,
        ids
      ) as Record<string, unknown>[]
      for (const r of packRows)
        packBy.set(Number(r.order_id), {
          qty: Number(r.qty ?? 0),
          batches: Number(r.batches ?? 0),
          containers: String(r.containers ?? '')
        })
      const styleRows = await db.all(
        `SELECT order_id, COUNT(DISTINCT TRIM(style_no)) AS styles, MIN(style_no) AS first_style
         FROM order_items WHERE order_id IN (${ph}) GROUP BY order_id`,
        ids
      ) as Record<string, unknown>[]
      for (const r of styleRows)
        styleBy.set(Number(r.order_id), { styles: Number(r.styles ?? 0), first: String(r.first_style ?? '') })
    }

    const list: OrderListRow[] = rows.map((r) => {
      const id = Number(r.id)
      const m = moneyBy.get(id)!
      // 折算率统一走 baseRateOf：本币单恒为 1（库里存着的旧汇率不参与折算），
      // 外币单没填汇率则为 0——折不出来就不许拿 1 装成折得出来，
      // remainingBase / 排序 / 合计要跟着一起归零，否则「待收合计」里混进一个凭空 ×1 的数
      const rate = baseRateOf(
        String(r.currency ?? 'USD'),
        String(r.base_currency ?? 'CNY'),
        Number(r.exchange_rate ?? 0)
      )
      const pack = packBy.get(id) ?? { qty: 0, batches: 0, containers: '' }
      const style = styleBy.get(id) ?? { styles: 0, first: '' }
      const shipStatus = String(r.ship_status ?? 'not_prepared') as ShipStatus
      return {
        id,
        orderNo: String(r.order_no ?? ''),
        piNo: String(r.pi_no ?? ''),
        customerPo: String(r.customer_po ?? ''),
        currency: String(r.currency ?? 'USD') as Currency,
        exchangeRate: rate,
        baseCurrency: String(r.base_currency ?? 'CNY') as Currency,
        paymentStatus: String(r.payment_status ?? '') as PaymentStatus,
        shipStatus,
        customer: { id: Number(r.customer_id), company: String(r.customer_company ?? ''), country: String(r.customer_country ?? '') },
        portOfLoading: String(r.port_of_loading ?? ''),
        portOfDestination: String(r.port_of_destination ?? ''),
        factory: String(r.factory ?? ''),
        vessel: String(r.vessel ?? ''),
        sealNo: String(r.seal_no ?? ''),
        etdDate: r.etd_date == null ? null : String(r.etd_date),
        cutOffDate: r.cut_off_date == null ? null : String(r.cut_off_date),
        expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date),
        validUntil: r.valid_until == null ? null : String(r.valid_until),
        createdAt: String(r.created_at ?? ''),
        totalAmount: m.goodsValue,
        chargesTotal: m.chargesTotal,
        grandTotal: m.grandTotal,
        paidAmount: m.paidAmount,
        creditApplied: m.creditApplied,
        remaining: m.receivable,
        remainingBase: m.receivable * rate,
        totalQuantity: m.totalQuantity,
        packedQuantity: pack.qty,
        batchCount: pack.batches,
        containerNos: pack.containers,
        chargesCount: parseCharges(r.charges).length,
        styleCount: style.styles,
        firstStyleNo: style.first,
        missingCostItems: m.missingCostItems,
        daysLate: daysLateOf({ expectedShipDate: r.expected_ship_date == null ? null : String(r.expected_ship_date), shipStatus })
      }
    })

    const sorted = sortRows(list, filter.sort ?? 'created_desc')
    const offset = Math.max(0, Math.floor(Number(filter.offset ?? 0)) || 0)
    const limit = Number(filter.limit)
    const page = Number.isFinite(limit) && limit > 0 ? sorted.slice(offset, offset + Math.floor(limit)) : sorted
    // 合计按整个筛选集算（不是本页），否则翻一页换一个总数，等于给了个假数
    const billing = sorted.filter((r) => isBillingStatus(r.paymentStatus))
    return {
      rows: page,
      total: sorted.length,
      owedBaseTotal: billing.reduce((s, r) => s + r.remainingBase, 0),
      grandBaseTotal: billing.reduce((s, r) => s + r.grandTotal * r.exchangeRate, 0)
    }
  }

  /** 读取订单并展开关联数据与汇总 */
  async function getOrder(id: number): Promise<OrderDetail | null> {
    const row = await db.get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
    if (!row) return null
    return hydrate(mapOrder(row), row)
  }

  async function hydrate(order: Order, row?: Record<string, unknown>): Promise<OrderDetail> {
    const customerRow = await db.get('SELECT * FROM customers WHERE id = ?', [order.customerId]) as
      | Record<string, unknown>
      | null
    const liveCustomer = customerRow ? mapCustomer(customerRow) : null
    // 抬头优先用单子上钉死的快照；升级前的老单子没有快照，回退客户档案（保持原行为）
    const fromDoc = parseParty(row?.bill_to_json)
    const billTo = fromDoc ?? billPartyOf(liveCustomer)
    const shipTo = parseParty(row?.ship_to_json) ?? shipPartyOf(liveCustomer)
    const items = (
      await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY style_no, color, size, id', [order.id]) as Record<
        string,
        unknown
      >[]
    ).map(mapOrderItem)
    const payments = (
      await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at, id', [order.id]) as Record<string, unknown>[]
    ).map(mapPayment)
    const settlements = (
      await db.all('SELECT * FROM order_settlements WHERE order_id = ? ORDER BY at, id', [order.id]) as Record<
        string,
        unknown
      >[]
    ).map(mapSettlement)
    const sourceQuotationNo = order.sourceQuotationId
      ? String(
          (
            await db.get('SELECT q_no FROM quotations WHERE id = ?', [order.sourceQuotationId]) as
              | { q_no?: string }
              | null
          )?.q_no ?? ''
        )
      : ''
    const plRows = await db.all('SELECT * FROM packing_lists WHERE order_id = ? ORDER BY id', [order.id]) as Record<
      string,
      unknown
    >[]
    const packingLists: PackingList[] = await Promise.all(
      plRows.map(async (r) => {
        const lines = (
          await db.all('SELECT * FROM packing_list_lines WHERE packing_list_id = ? ORDER BY box_no, id', [
            Number(r.id)
          ]) as Record<string, unknown>[]
        ).map(mapPackingListLine)
        return mapPackingList(r, lines)
      })
    )

    // 金额口径统一走 services/money.ts（唯一真源）：
    // 货值 / 费用 / 含费用合计 / 待收 / 毛利（成本缺失 → 不可信）
    const m = computeOrderMoney({
      items: items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, unitCost: i.unitCost })),
      charges: order.charges,
      payments: payments.map((p) => ({ amount: p.amount })),
      settlements: settlements.map((s) => ({ kind: s.kind, amount: s.amount })),
      depositRatio: order.depositRatio,
      creditApplied: await moneyOf().creditAppliedForOrder(order.id)
    })

    return {
      ...order,
      customer: liveCustomer,
      billTo,
      billFromProfile: !fromDoc,
      shipTo,
      items,
      payments,
      packingLists,
      totalAmount: m.goodsValue,
      chargesTotal: m.chargesTotal,
      grandTotal: m.grandTotal,
      totalCost: m.totalCost,
      totalProfit: m.profitRaw,
      missingCostItems: m.missingCostItems,
      totalQuantity: m.totalQuantity,
      paidAmount: m.paidAmount,
      creditApplied: m.creditApplied,
      remaining: m.receivable,
      remainingRaw: m.remaining,
      depositAmount: m.depositAmount,
      writeOffShortage: m.shortageAmount,
      writeOffBadDebt: m.badDebtAmount,
      badDebtOutstanding: m.badDebtOutstanding,
      writtenOff: m.writtenOff,
      settlements,
      sourceQuotationNo,
      shipSummary: await shipmentSummary(db, order.id)
    }
  }

  /** PI 号是否已被别的订单占用（单号是凭据，N-3 查重） */
  async function piNoTaken(no: string, selfId?: number): Promise<boolean> {
    const row = selfId
      ? await db.get('SELECT id FROM orders WHERE pi_no = ? AND id != ?', [no, selfId])
      : await db.get('SELECT id FROM orders WHERE pi_no = ?', [no])
    return !!row
  }

  function piDupErr(no: string): Error {
    return bizError(
      `PI 号 ${no} 已经存在（可能恢复过备份或手工导过数据）。单号是凭据，不能两张单共用一个号——请在「PI号」里换一个号再保存。`
    )
  }

  /** 建单时把客户档案当时的抬头钉在这张单上（改档案不再影响已发出的单据） */
  async function partiesForOrder(
    customerId: number,
    patch: { billTo?: Partial<PartySnapshot>; shipTo?: Partial<PartySnapshot> } = {}
  ): Promise<{ bill: string; ship: string }> {
    const row = await db.get('SELECT * FROM customers WHERE id = ?', [customerId]) as Record<string, unknown> | null
    const c = row ? mapCustomer(row) : null
    if (!c) throw bizError(`客户编号 ${customerId} 不存在，不能建单`)
    return {
      bill: stringifyParty(patchParty(billPartyOf(c), patch.billTo)),
      ship: stringifyParty(patchParty(shipPartyOf(c), patch.shipTo))
    }
  }

  async function createOrder(input: OrderInput): Promise<OrderDetail> {
    const settings = (await settingsCore(db).get())
    const ts = now()
    const currency = input.currency ?? 'USD'
    const baseCurrency = input.baseCurrency ?? settings.baseCurrency
    // 本币单没有折算这回事：汇率固定按 1 记（读取口径 listOrderMoney 也是这么算的）。
    // 以前界面对本币单也逼着填 7.15，存进去的数会在导出台账、成本折算里各乘一遍，
    // 同一张单的金额出现两套说法。汇率日期也不记：纸面本来就不印汇率。
    const isHomeCurrency = currency === baseCurrency
    const exchangeRate = isHomeCurrency ? 1 : (input.exchangeRate ?? 1)
    // 建单与改单同一套汇率闸门：显式传了 0/负数/NaN 一律拦下——这种单会从待收、销售、毛利里静默消失。
    // 没传不拦：草稿单默认 1，正是「汇率待修」提醒认的哨兵值
    if (!isHomeCurrency && input.exchangeRate !== undefined && !(Number(input.exchangeRate) > 0)) {
      throw bizError('汇率必须填大于 0 的数。0 或空值会让这张单从待收和毛利里消失，请按今天钉盘的汇率填。')
    }
    // 费用行同一套闸门：Infinity/NaN 过 JSON.stringify 会变 null，落库后费用按 0 算
    assertChargeAmounts(input.charges ?? [])
    // 定金比例服务层也夹一道：UI 下拉只给 0–1，但 IPC/导入能塞进 1.5 这种数
    assertDepositRatio(input.depositRatio ?? settings.defaultDepositRatio)
    // 负合计守门不放在建单：建单时明细还没加，转单/报价转来的让利行（负费用）
    // 全靠后面的明细把合计顶回正数——那边各有自己的口径守着；
    // 货值和费用行真正同框的 updateOrder / updateOrderCharges 才拦得住、也拦得准
    const validUntil = input.validUntil ?? addDays(localDate(), settings.piValidDays)
    // 汇率锁定日期：默认记今天（本地日期）；本币单不记（根本没有折算这件事）
    const rateDate = isHomeCurrency ? null : (input.exchangeRateDate ?? localDate())
    // 收款状态：报价单/打样单转单时可以指定（PI 已发 = sent、客户已确认 = confirmed），默认草稿。
    // 只放这三个：已经收过钱（partial/paid/settled）或作废/失效的单不可能在「刚建单」这一刻成立，
    // 直接从接口塞进来就等于绕过了收款、核销、作废的全部门槛（R49）
    const status: PaymentStatus = input.paymentStatus ?? 'draft'
    if (!CREATE_STATUSES.includes(status)) {
      throw bizError(
        `新建订单的收款状态只能是 ${CREATE_STATUSES.map((s) => PAYMENT_STATUS_LABEL[s]).join(' / ')}；` +
          `「${PAYMENT_STATUS_LABEL[status] ?? status}」要在单据建好后按实际收款情况再改。`
      )
    }
    // 费用行（运费/保险等）存 JSON
    const chargesJson = JSON.stringify((input.charges ?? []).filter((c) => c.label.trim()))
    const parties = await partiesForOrder(input.customerId, input)

    // 烧号也放进事务：以前在事务外取号，保存失败（撞号、校验不过、转单回滚）时
    // 单没建成、号已烧掉，SO/PI 是客户对账凭据，凭空跳号对不上水单
    const orderId = await db.transact(async () => {
      const orderNo = await nextNo(db, 'SO')
      const typedPiNo = input.piNo?.trim() ?? ''
      // PI 号会当存档目录名和纸面编号用：带 / 或 .. 的号建单时看着正常，
      // 等第一次出 PI 才在存档那一步被拦下——那时单已经发给客户了
      const piNo = typedPiNo ? assertDocNo(typedPiNo, 'PI 号') : await nextNo(db, 'PI')
      // 单号是凭据：手工指定的 PI 号不能跟别的订单撞号（与打样单号同一条规矩，N-3）。
      // 查重放在事务里，查完到写入之间没有别人能插一张同号的单进来。
      if (input.piNo?.trim() && (await piNoTaken(input.piNo.trim()))) throw piDupErr(piNo)
      const res = await db.run(
        `INSERT INTO orders(order_no, customer_id, pi_no, payment_status, ship_status, currency, exchange_rate,
          base_currency, incoterm, port_of_loading, port_of_destination, payment_method, deposit_ratio,
          valid_until, expected_ship_date, expected_arrival_date, customer_po, note,
          exchange_rate_date, factory, factory_due_date, cut_off_date, etd_date, vessel, seal_no, charges,
          bill_to_json, ship_to_json, created_at, updated_at)
         VALUES(?,?,?,?,'not_prepared',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orderNo,
          input.customerId,
          piNo,
          status,
          currency,
          exchangeRate,
          baseCurrency,
          input.incoterm ?? 'FOB',
          input.portOfLoading ?? '',
          input.portOfDestination ?? '',
          input.paymentMethod ?? 'tt_deposit',
          input.depositRatio ?? settings.defaultDepositRatio,
          validUntil,
          input.expectedShipDate ?? null,
          input.expectedArrivalDate ?? null,
          input.customerPo ?? '',
          input.note ?? '',
          rateDate,
          input.factory ?? '',
          input.factoryDueDate ?? null,
          input.cutOffDate ?? null,
          input.etdDate ?? null,
          input.vessel ?? '',
          input.sealNo ?? '',
          chargesJson,
          parties.bill,
          parties.ship,
          ts,
          ts
        ]
      )
      const id = Number(res.lastInsertRowid)
      await logEvent(db, id, 'create', null, status, `创建订单 ${orderNo}`)
      return id
    })
    return (await getOrder(orderId))!
  }

  async function updateOrder(id: number, input: OrderInput): Promise<OrderDetail> {
    const ts = now()
    const before = await db.get('SELECT * FROM orders WHERE id = ?', [id]) as Record<string, unknown> | null
    if (!before) throw notFound('订单不存在')
    await assertOrderWritable(id, '改这张单')
    // 单号是凭据：编辑时把 PI 号改成别人的号要拦住（改成自己的号不算重号）
    const oldPiNo = String(before.pi_no ?? '').trim()
    const newPiNo = input.piNo === undefined ? oldPiNo : String(input.piNo).trim()
    if (newPiNo && newPiNo !== oldPiNo) {
      // 只在真改了号时校验：老单里已经存着的怪号不挡住别的字段保存
      assertDocNo(newPiNo, 'PI 号')
      if (await piNoTaken(newPiNo, id)) throw piDupErr(newPiNo)
    }
    // 已经开出去的 PI 号要被报关、要被对账，清空等于把凭据抹了还不留话
    if (oldPiNo && !newPiNo)
      throw bizError(`PI 号 ${oldPiNo} 已经写在这张单上，不能清空——确实不要这个号请作废这张单后重开。`)

    // 汇率是锁定的凭据：清空或填 0 不许悄悄落成 1——
    // 1 会让整单金额按错汇率折算，四张单据、报表、待收全跟着错
    const settings = (await settingsCore(db).get())
    const newCurrency = (input.currency ?? String(before.currency ?? 'USD')) as Currency
    const oldCurrency = String(before.currency ?? 'USD') as Currency
    // 基准币跟着这张单走（没传就沿用单子上记的，再没有才用全局设置）
    const baseForOrder = String(input.baseCurrency ?? before.base_currency ?? '') || settings.baseCurrency
    // 本币单没有折算这回事：库里那一列（可能是历史垃圾 7.15）一律归一到 1，
    // 和读取口径 listOrderMoney 说同一个数。外币单照旧守「必须大于 0」。
    const isHomeCurrency = newCurrency === baseForOrder
    const newRate = isHomeCurrency ? 1 : Number(input.exchangeRate ?? before.exchange_rate)
    if (!isHomeCurrency && !(newRate > 0)) throw bizError('汇率必须大于 0，清空汇率不能保存')
    const oldRate = Number(before.exchange_rate)
    const payCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
    )
    const settleCount = Number(
      (
        await db.get('SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?', [id]) as
          | { n?: number }
          | null
      )?.n ?? 0
    )
    const itemCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
    )
    const docCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM doc_versions WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
    )
    // PI 号印在已经发出去的单据上，CI 号又是由 PI 号派生的：改了号，重印的纸和客户手里那张对不上
    if (newPiNo !== oldPiNo && docCount > 0) {
      throw bizError(
        `这张单已经有 ${docCount} 份单据存档，PI 号 ${oldPiNo} 印在纸面上、CI 号也由它派生，不能再改。确实要换号，请作废这张单后按新单重开。`
      )
    }
    const plCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM packing_lists WHERE order_id = ?', [id]) as { n?: number } | null)?.n ?? 0
    )
    // 汇率印在纸面上（PI/CI 都有 Exchange Rate 一行），也参与核销的账：
    // 这两样一旦落定，改汇率就会和已发出的纸面、已核定的账对不上。
    // 只登记了收款、还没出单据时不锁——录错汇率要能修正，操作历史里有旧值 → 新值。
    // 本币单不锁：那个数根本不参与折算，归一到 1 不会改动任何一张纸、任何一笔账。
    if (!isHomeCurrency && newRate !== oldRate && (docCount > 0 || settleCount > 0)) {
      const why =
        docCount > 0
          ? `${docCount} 份单据存档（纸面上印着 1 ${oldCurrency} = ${oldRate}）`
          : `${settleCount} 笔核销`
      throw bizError(
        `这张单已经有 ${why}，汇率不能再改：改了会和已经发出去的纸面、已经核定的账对不上。确实要按新汇率重算，请作废这张单后按新单重开。`
      )
    }
    if (newCurrency !== oldCurrency) {
      // 明细单价没有独立币种：已经对外发过（或已出单据/箱单）的单换币种，
      // 等于把 100 USD 的单价当成 100 EUR 用。草稿还没发出去，允许改错字。
      const released =
        String(before.payment_status ?? '') !== 'draft' || docCount > 0 || plCount > 0
      if (itemCount > 0 && released) {
        throw bizError(
          `这张单已经有 ${itemCount} 行明细，而且已经对外发过（不是草稿），不能改币种——单价都是按 ${oldCurrency} 记的，100 ${oldCurrency} 会被当成 100 ${newCurrency}。确实要换币种，请作废这张单后按新单重开。`
        )
      }
      // 收款是按原币登记的凭据：改币种会让历史收款、银行流水和客户对账全部错位
      if (payCount > 0 || settleCount > 0) {
        const what = payCount > 0 ? `${payCount} 笔收款` : `${settleCount} 笔核销`
        throw bizError(
          `这张单已经登记了 ${what}，不能改币种——历史金额都是按 ${oldCurrency} 记的，改了会和银行流水、核销记录对不上。确实要换币种，请作废这张单后按正确币种重开。`
        )
      }
      // 没改汇率就换币种，等于把 USD 的 7.1 套在 EUR 上，报表和毛利全错。
      // 换成基准币不用问汇率（折算口径固定是 1），只有换成外币才要人重新填。
      if (!isHomeCurrency && newRate === oldRate) {
        throw bizError(
          `币种从 ${oldCurrency} 换成 ${newCurrency}，汇率不能沿用原来的 ${oldRate}；请按 ${newCurrency} 重新填写汇率再保存。`
        )
      }
    }
    // 汇率变了就重新记锁定日期（未手动指定时）；本币单不留任何「哪天的汇率」——
    // 那一天不存在，留着只会让税务复核以为这里真折过一次
    let rateDate = isHomeCurrency ? null : ((before.exchange_rate_date as string | null) ?? null)
    if (input.exchangeRateDate !== undefined) rateDate = isHomeCurrency ? null : input.exchangeRateDate
    else if (!isHomeCurrency && newRate !== oldRate) rateDate = localDate()
    // 费用行（运费/保险）：传了就按传的改，没传就保持原样（不能一个字段没传就把费用清空）
    const beforeCharges = parseCharges(before.charges)
    const cleanCharges = input.charges === undefined ? null : input.charges.filter((c) => c.label.trim())
    if (cleanCharges !== null) {
      assertChargeAmounts(input.charges!)
      if (!sameCharges(beforeCharges, cleanCharges)) {
        await assertPricingEditable(id, '改费用行')
      }
      // 合计为负比「没写原因」更要紧：让利让过头的单根本落不了库，先按库内货值把这句话说在前面。
      // 事务里还会按写入那一刻的货值再算一遍（那才是准的），这里只负责报错先后顺序，
      // 免得用户按提示写好原因、保存又被打回一句「合计为负」。与 updateOrderCharges 的喊法保持一致。
      assertOrderTotalNonNegative(await orderGoodsTotal(id), cleanCharges, chargeCause(cleanCharges))
      // 从「只改费用行」那个正门补过来的闸门：让利改一笔就要写原因。
      // 编辑弹窗走的是这里，以前只拦得住正门，跟单员在「编辑订单」里改负数行照样不留话。
      const reasonText = String(input.chargeReason ?? '').trim()
      if (negativeChargesChanged(beforeCharges, cleanCharges) && !reasonText) {
        throw bizError(
          '这次改的是让利（负费用行），它会直接改变客户该付多少。请写明原因（例如「老客户运费对折」「补上次多收的 20」），这句话会记进订单操作历史。'
        )
      }
    }
    const chargesJson = cleanCharges === null ? String(before.charges ?? '[]') : JSON.stringify(cleanCharges)

    // 抬头快照：换了客户就按新客户重新钉一次；没换客户则保住单子上原有的快照，
    // 只把用户这次明确改动的字段写进去（改档案绝不会顺带动到已发出的单据）
    // customerId 也可能整条没传（只改备注的编辑）——那时这张单还挂在原客户名下
    const nextCustomerId = input.customerId === undefined ? Number(before.customer_id) : Number(input.customerId)
    const customerChanged = Number(before.customer_id) !== nextCustomerId
    const fresh = await partiesForOrder(nextCustomerId, {})
    const baseBill = (customerChanged ? null : parseParty(before.bill_to_json)) ?? parseParty(fresh.bill) ?? emptyParty()
    const baseShip = (customerChanged ? null : parseParty(before.ship_to_json)) ?? parseParty(fresh.ship) ?? emptyParty()
    const billJson = stringifyParty(patchParty(baseBill, input.billTo))
    const shipJson = stringifyParty(patchParty(baseShip, input.shipTo))

    // 换客户不是改个抬头：收款流水、核销、预收抵扣、转单打样和存档单据都挂在当前客户名下，
    // 换过去会让两边的对账单、银行流水和客户预收整体错位，而客户手里的纸面抬头不会跟着变。
    // 只有「一张干净的空单」才允许换主（R21 的留痕场景）。
    if (customerChanged) {
      const sampleCount = Number(
        (await db.get('SELECT COUNT(*) AS n FROM sample_orders WHERE converted_order_id = ?', [id]) as
          | { n?: number }
          | null)?.n ?? 0
      )
      const credit = await creditsOf().hasActiveCredit('order', id)
      if (payCount > 0 || settleCount > 0 || credit || sampleCount > 0 || docCount > 0 || plCount > 0) {
        const what = [
          payCount > 0 ? `${payCount} 笔收款流水` : '',
          settleCount > 0 ? `${settleCount} 笔核销` : '',
          credit ? '客户预收抵扣' : '',
          sampleCount > 0 ? `${sampleCount} 张转单打样抵扣` : '',
          docCount > 0 ? `${docCount} 版单据存档` : '',
          plCount > 0 ? `${plCount} 批箱单` : ''
        ]
          .filter(Boolean)
          .join('、')
        throw bizError(
          `这张单已经有 ${what}，不能换客户：这些账和凭据都挂在原客户名下，换过去会让两边的对账单和银行流水对不上。` +
            `确实要换客户，请先撤销这些记录，或作废这张单按新客户重开。`
        )
      }
    }

    /**
     * 只写「这次真的传了」的列：input 里没有的键保留数据库原值。
     * 以前这里是全量替换（input.x ?? null），调用方少传一个日期，
     * 那张单的交期 / ETD / 截关就被静默清空——单据早发出去了，界面上看不出少了东西。
     * 语义：undefined = 这次没提，保留原值；null 或 '' = 用户明确清空。
     */
    const keep = (key: keyof OrderInput, col: string): unknown => (input[key] === undefined ? before[col] : input[key])
    /** 日期列收口：空串一律存 NULL，不让 '' 混进日期比较 */
    const keepDate = (key: keyof OrderInput, col: string): string | null => {
      const v = keep(key, col)
      return v === '' || v == null ? null : String(v)
    }
    const keepText = (key: keyof OrderInput, col: string): string => {
      const v = keep(key, col)
      return v == null ? '' : String(v)
    }
    const cells: Array<[string, unknown]> = [
      ['customer_id', nextCustomerId],
      ['currency', newCurrency],
      ['exchange_rate', newRate],
      ['base_currency', keepText('baseCurrency', 'base_currency') || settings.baseCurrency],
      ['incoterm', keepText('incoterm', 'incoterm') || 'FOB'],
      ['port_of_loading', keepText('portOfLoading', 'port_of_loading')],
      ['port_of_destination', keepText('portOfDestination', 'port_of_destination')],
      ['payment_method', keepText('paymentMethod', 'payment_method') || 'tt_deposit'],
      ['deposit_ratio', (() => {
        // 定金比例服务层也夹一道（B7）：UI 下拉只给 0–1，走 IPC/导入能塞进 1.5
        const v = keep('depositRatio', 'deposit_ratio') ?? settings.defaultDepositRatio
        assertDepositRatio(v)
        return v
      })()],
      ['valid_until', keepDate('validUntil', 'valid_until')],
      ['expected_ship_date', keepDate('expectedShipDate', 'expected_ship_date')],
      ['expected_arrival_date', keepDate('expectedArrivalDate', 'expected_arrival_date')],
      ['customer_po', keepText('customerPo', 'customer_po')],
      ['note', keepText('note', 'note')],
      ['pi_no', newPiNo],
      ['exchange_rate_date', rateDate],
      ['factory', keepText('factory', 'factory')],
      ['factory_due_date', keepDate('factoryDueDate', 'factory_due_date')],
      ['cut_off_date', keepDate('cutOffDate', 'cut_off_date')],
      ['etd_date', keepDate('etdDate', 'etd_date')],
      ['vessel', keepText('vessel', 'vessel')],
      ['seal_no', keepText('sealNo', 'seal_no')],
      ['charges', chargesJson],
      ['bill_to_json', billJson],
      ['ship_to_json', shipJson]
    ]
    await db.transact(async () => {
      await db.run(
        `UPDATE orders SET ${cells.map(([col]) => `${col}=?`).join(', ')}, updated_at=? WHERE id=?`,
        [...cells.map(([, v]) => v as string | number | null), ts, id]
      )
      // 让利让过头（合计为负）的单不许落库。这道门在事务里按库内的货值现算：
      // 事务外读到的货值可能在「守门 → 写入」之间被另一笔改小明细抽走，
      // 两边各自看自己那一改都合法，库里就留下负合计单——负数会被当成客户多付，生出能抵能退的假预收。
      if (cleanCharges !== null) {
        assertOrderTotalNonNegative(await orderGoodsTotal(id), cleanCharges, chargeCause(cleanCharges))
      }
      await logEvent(db, id, 'update', null, null, await describeOrderChange(before, input))
      // 抵扣行改了，打样单那半边必须跟着同一笔保存变脸，否则样品欠款长期对不上
      if (cleanCharges !== null) {
        await syncSampleOffsetFromCharges(id, String(before.order_no ?? ''), beforeCharges, cleanCharges)
      }
      // 收款金额变了，状态可能需要重算
      await recomputePaymentStatus(id)
      // 核销过的单被改小：核销额不能超过实际欠款（多出来的会变成能退真钱的假预收）
      await assertWriteOffFitsOrder(id)
      // 有预收抵扣的单：换客户/币种或金额改小不能让那笔抵扣悬空
      await creditsOf().assertCreditFitsOrder(id)
      // 换客户/换币种：原客户账上的「多收」跟着这单走了，已经抵出去的钱可能穿仓
      if (customerChanged || newCurrency !== oldCurrency) await creditsOf().assertCreditSolvent(Number(before.customer_id))
      await creditsOf().assertCreditSolvent(nextCustomerId)
    })
    return (await getOrder(id))!
  }

  /**
   * 单独改这张单的抬头（客户这单要送别的仓 / 抬头写错了）。
   * 只动快照，不动客户档案——档案改了不能把已经发出去的单据改掉。
   */
  async function setOrderParties(
    orderId: number,
    patch: { billTo?: Partial<PartySnapshot>; shipTo?: Partial<PartySnapshot> }
  ): Promise<OrderDetail> {
    const row = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
    if (!row) throw notFound('订单不存在')
    await assertOrderWritable(orderId, '改抬头')
    const customerRow = await db.get('SELECT * FROM customers WHERE id = ?', [Number(row.customer_id)]) as
      | Record<string, unknown>
      | null
    const live = customerRow ? mapCustomer(customerRow) : null
    const baseBill = parseParty(row.bill_to_json) ?? billPartyOf(live) ?? emptyParty()
    const baseShip = parseParty(row.ship_to_json) ?? shipPartyOf(live) ?? emptyParty()
    const billJson = stringifyParty(patchParty(baseBill, patch.billTo))
    const shipJson = stringifyParty(patchParty(baseShip, patch.shipTo))
    const changed: string[] = []
    const labels: Record<keyof PartySnapshot, string> = {
      company: '公司',
      attn: '收件人',
      contact: '联系人',
      address: '地址',
      zipCode: '邮编',
      country: '国家',
      email: '邮箱',
      phone: '电话',
      paymentPref: '付款条款'
    }
    const diff = (title: string, base: PartySnapshot, p?: Partial<PartySnapshot>) => {
      if (!p) return
      const parts = (Object.keys(p) as (keyof PartySnapshot)[])
        .filter((k) => p[k] !== undefined && String(p[k]) !== String(base[k]))
        .map((k) => `${labels[k]} ${base[k] || '空'} → ${String(p[k]) || '空'}`)
      if (parts.length) changed.push(`${title}：${parts.join('；')}`)
    }
    diff('买方抬头', baseBill, patch.billTo)
    diff('收货抬头', baseShip, patch.shipTo)
    const note = changed.join('；') || '抬头没改动'
    // 抬头和留痕一起落：分开写会留下「纸面已经改了、历史却说没改」的对不上
    await db.transact(async () => {
      await db.run('UPDATE orders SET bill_to_json=?, ship_to_json=?, updated_at=? WHERE id=?', [
        billJson,
        shipJson,
        now(),
        orderId
      ])
      await logEvent(db, orderId, 'party_update', null, null, note)
    })
    return (await getOrder(orderId))!
  }

  /** 生成一条人话版的「改了什么」记录 */
  async function describeOrderChange(before: Record<string, unknown>, input: OrderInput): Promise<string> {
    const parts: string[] = []
    const shown = (v: unknown): string => (v === null || v === undefined || v === '' ? '空' : String(v))
    /**
     * 只比「这次真的传了」的字段。漏传一个日期不等于把它清空，
     * 否则一次只改备注的保存会在历史里留下一串「交期 xxx → 空」，反而把真改动淹了。
     */
    const cmp = (label: string, key: keyof OrderInput, col: string) => {
      if (input[key] === undefined) return
      const old = before[col]
      const next = input[key]
      if (shown(old) !== shown(next)) parts.push(`${label} ${shown(old)} → ${shown(next)}`)
    }
    cmp('币种', 'currency', 'currency')
    cmp('汇率', 'exchangeRate', 'exchange_rate')
    cmp('贸易术语', 'incoterm', 'incoterm')
    cmp('装运港', 'portOfLoading', 'port_of_loading')
    cmp('目的港', 'portOfDestination', 'port_of_destination')
    cmp('付款方式', 'paymentMethod', 'payment_method')
    cmp('定金比例', 'depositRatio', 'deposit_ratio')
    cmp('PI号', 'piNo', 'pi_no')
    cmp('客户PO', 'customerPo', 'customer_po')
    cmp('工厂', 'factory', 'factory')
    // 「这单是谁的」是凭据级字段：换客户会重钉 PI 上的买方/收货抬头，
    // 客户手里两张不同抬头的 PI 说不清的时候，历史里要答得出什么时候换的、从谁换给谁
    if (input.customerId !== undefined && Number(before.customer_id) !== Number(input.customerId)) {
      const nameOf = async (cid: unknown): Promise<string> => {
        if (cid == null) return '空'
        const row = await db.get('SELECT company FROM customers WHERE id = ?', [Number(cid)]) as
          | { company?: string }
          | null
        return row?.company ?? `客户#${String(cid)}`
      }
      parts.push(`客户 ${await nameOf(before.customer_id)} → ${await nameOf(input.customerId)}`)
    }
    cmp('船名航次', 'vessel', 'vessel')
    cmp('封条号', 'sealNo', 'seal_no')
    cmp('备注', 'note', 'note')
    // 日期改动最容易扯皮：客户说交期改过没、报关卡的是哪一版——逐条记 before → after
    cmp('有效期', 'validUntil', 'valid_until')
    cmp('预计开船', 'expectedShipDate', 'expected_ship_date')
    cmp('预计到港', 'expectedArrivalDate', 'expected_arrival_date')
    cmp('工厂交期', 'factoryDueDate', 'factory_due_date')
    cmp('截关日', 'cutOffDate', 'cut_off_date')
    cmp('ETD', 'etdDate', 'etd_date')
    // 费用行也要留痕（运费改了多少）。两张同名行必须按多重集配对，
    // 建 Map 会互相覆盖，历史里就说不清动的是哪一张、另一张去哪了
    if (input.charges !== undefined) {
      const chargeParts = describeChargeChange(parseCharges(before.charges), input.charges.filter((c) => c.label.trim()), '费用')
      parts.push(...chargeParts)
      // 让利的「为什么」必须跟在这串数字后面：历史里只写「费用 折让 0 → -50」，
      // 半年后没人答得出这 50 块是谁答应的
      const why = String(input.chargeReason ?? '').trim()
      if (why && chargeParts.length) parts.push(`让利原因：${why}`)
    }
    if (parts.length === 0) return '修改订单信息'
    return `修改订单：${parts.join('；')}`
  }

  /**
   * 作废订单（客户取消 / 建错单）：
   * 记录全部保留（收款流水、操作历史、单据存档），但不再进货值 / 待收 / 毛利。
   * 老板的规矩：所有订单必须留痕，真删除只留给「建错字」的空单。
   */
  async function voidOrder(id: number, reason = '', opts: { confirmDocs?: boolean } = {}): Promise<OrderDetail> {
    const cur = await db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [id]) as
      | { order_no: string; payment_status: string }
      | null
    if (!cur) throw notFound('订单不存在')
    if (cur.payment_status === 'void') return (await getOrder(id))!
    // 凭据核对闸门：PI/CI 已发到客户手里、批次已出运的单不能一键作废——
    // 作废后系统退出应收口径，但客户手里的纸面凭据不会消失，报关/收汇在途的钱会和系统脱节。
    // 不拦死（真要作废是合法终态），但要人先核对再勾确认，操作历史里留下核对痕迹。
    const docCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM doc_versions WHERE order_id = ? AND voided_at IS NULL', [id]) as { n?: number } | null)
        ?.n ?? 0
    )
    const plCount = Number(
      (await db.get('SELECT COUNT(*) AS n FROM packing_lists WHERE order_id = ? AND voided_at IS NULL', [id]) as { n?: number } | null)
        ?.n ?? 0
    )
    if ((docCount > 0 || plCount > 0) && !opts.confirmDocs) {
      const parts: string[] = []
      if (docCount > 0) parts.push(`${docCount} 版单据存档（PI/CI 可能已发到客户手里）`)
      if (plCount > 0) parts.push(`${plCount} 批箱单`)
      throw bizError(
        `这张订单还有 ${parts.join(' 和 ')}。作废后系统不再认账，但这些纸面凭据不会消失，` +
          `报关/收汇在途的钱会和系统脱节。请先核对这些凭据的处理，在作废确认框里勾选「凭据已核对」再作废。`
      )
    }
    await db.transact(async () => {
      // 单子作废就退出应收口径：已经抵在它身上的客户预收要退回客户余额，
      // 否则这笔钱既不在待收里、也不在余额里，从账上凭空消失
      await creditsOf().reverseCreditsForTarget('order', id, `订单 ${cur.order_no} 作废，预收抵扣回退`)
      await db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', ['void', now(), id])
      // 下单抵扣的样品费不能跟着凭空消失：订单作废退出应收口径，
      // 打样单还挂着「已抵扣」的话，客户实际欠的样品费会从欠款榜、工作台同时蒸发。
      // 回退成未收（抵扣历史留在备注里），打样费回到该在的地方
      const offsetSamples = await db.all(
        `SELECT id, sample_no, fee_note FROM sample_orders
         WHERE converted_order_id = ? AND fee_status = 'offset'`,
        [id]
      ) as Record<string, unknown>[]
      for (const s of offsetSamples) {
        await db.run(
          `UPDATE sample_orders SET fee_status = 'unpaid',
            fee_note = ?, updated_at = ? WHERE id = ?`,
          [
            `${String(s.fee_note ?? '')}；订单 ${cur.order_no} 已作废，抵扣回退为未收`,
            now(),
            Number(s.id)
          ]
        )
        await logEvent(db, 
          id,
          'sample_offset_back',
          null,
          null,
          `打样单 ${String(s.sample_no ?? '')} 的样品费抵扣随订单作废回退为未收`
        )
      }
      await logEvent(db, 
        id,
        'void',
        cur.payment_status,
        'void',
        `作废订单 ${cur.order_no}${reason ? '：' + reason : ''}${
          docCount > 0 || plCount > 0 ? `（凭据已核对：${docCount} 版单据存档、${plCount} 批箱单）` : ''
        }`
      )
    })
    return (await getOrder(id))!
  }

  /**
   * 物理删除：只允许删「从没收过钱、也没有明细和任何凭据」的空单。
   * 有钱、有箱单、有单据存档、有照片的订单必须走「作废」——
   * 这些记录都是外发过或对过账的凭据，跟着订单一起删掉就再也查不回来了。
   */
  async function deleteOrder(id: number): Promise<void> {
    const snapshotSql = `SELECT o.order_no, o.payment_status,
              (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS pay_cnt,
              (SELECT COUNT(*) FROM order_settlements s WHERE s.order_id = o.id) AS settle_cnt,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_cnt,
              (SELECT COUNT(*) FROM packing_lists pl WHERE pl.order_id = o.id) AS pl_cnt,
              (SELECT COUNT(*) FROM doc_versions d WHERE d.order_id = o.id) AS doc_cnt,
              (SELECT COUNT(*) FROM order_photos ph WHERE ph.order_id = o.id) AS photo_cnt,
              (SELECT COUNT(*) FROM sample_orders so WHERE so.converted_order_id = o.id) AS sample_cnt
       FROM orders o WHERE o.id = ?`
    const blockersOf = (row: Record<string, unknown>): string[] => {
      const cnt = (k: string): number => Number(row[k] ?? 0)
      const bits: string[] = []
      if (cnt('item_cnt')) bits.push(`${cnt('item_cnt')} 行明细`)
      if (cnt('pay_cnt')) bits.push(`${cnt('pay_cnt')} 笔收款`)
      if (cnt('settle_cnt')) bits.push(`${cnt('settle_cnt')} 笔核销`)
      if (cnt('pl_cnt')) bits.push(`${cnt('pl_cnt')} 张装箱单`)
      if (cnt('doc_cnt')) bits.push(`${cnt('doc_cnt')} 份单据存档`)
      if (cnt('photo_cnt')) bits.push(`${cnt('photo_cnt')} 张照片`)
      if (cnt('sample_cnt')) bits.push(`由它转出的 ${cnt('sample_cnt')} 张打样单`)
      return bits
    }
    const notEmptyError = (orderNo: string, bits: string[]): Error =>
      bizError(
        `订单 ${orderNo} 已经有 ${bits.join('、')}，不能直接删（删了这些凭据和操作历史会一起没有）。请用「作废」：记录全留，只是不再计入销售额和待收款。`
      )
    const row = (await db.get(snapshotSql, [id])) as Record<string, unknown> | null
    if (!row) throw notFound('订单不存在')
    const orderNo = String(row.order_no ?? '')
    if (String(row.payment_status ?? '') === 'void') {
      throw bizError(`订单 ${orderNo} 已经作废，作废单是留档凭据，不能删除；要重新做生意请按新单重开。`)
    }
    // 预收抵扣记在这张单上：删单会让这笔余额「用到哪儿去了」失去凭据
    if (await creditsOf().hasActiveCredit('order', id)) {
      throw bizError(
        `订单 ${orderNo} 上还有未撤销的客户预收抵扣，不能删：删了这笔余额用到哪儿就查不到了。请先在客户页撤销抵扣，再删单。`
      )
    }
    const bits = blockersOf(row)
    if (bits.length > 0) throw notEmptyError(orderNo, bits)
    // 上一条 SELECT 到这行 DELETE 之间，另一处可能刚落了收款/箱单/存档：
    // 所以「还是空单」的确认要和删除在同一条语句里做完，
    // 分两步走就会出现「查的时候是空单、删的时候不是」——新凭据跟着单一起蒸发
    const res = await db.run(
      `DELETE FROM orders
        WHERE id = ?
          AND payment_status != 'void'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM order_settlements s WHERE s.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM packing_lists pl WHERE pl.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM doc_versions d WHERE d.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM order_photos ph WHERE ph.order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM sample_orders so WHERE so.converted_order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM credit_applications ca
                          WHERE ca.target_kind = 'order' AND ca.target_id = orders.id AND ca.reversed_at IS NULL)`,
      [id]
    )
    if (res.changes === 1) return
    // 已经被人删掉了：结果一样，不报错
    const again = (await db.get(snapshotSql, [id])) as Record<string, unknown> | null
    if (!again) return
    // 按最新的凭据说人话：通常是刚好落了新记录
    if (String(again.payment_status ?? '') === 'void') {
      throw bizError(`订单 ${orderNo} 刚刚被作废了：作废单是留档凭据，不能删除。`)
    }
    const fresh = blockersOf(again)
    if (fresh.length > 0) throw notEmptyError(orderNo, fresh)
    throw bizError(
      `订单 ${orderNo} 上刚刚落了新的记录（可能是另一处的收款、箱单或存档），这次删除没有执行。请刷新页面看一眼，再用「作废」处理。`
    )
  }

  /**
   * 费用金额必须是有限数：输入框里删空会给出 NaN，JSON 一序列化就成了 null，
   * 落库后费用行看着在、金额却按 0 算，CI/PI 合计和应收会静默少掉一笔。
   */
  function assertChargeAmounts(charges: QuotationCharge[]): void {
    charges.forEach((c, idx) => {
      const amount = Number(c.amount)
      if (!Number.isFinite(amount)) {
        const who = String(c.label ?? '').trim() || '未命名费用'
        throw bizError(`费用「${who}」的金额不是有效数字（${String(c.amount)}），请填一个金额再保存。`)
      }
      // 名称为空的行保存时会被 filter 掉：金额都填了还让它整行消失，
      // 用户看到「已保存」、纸面和待收里却少了这笔钱——宁可在保存时拦住
      if (!String(c.label ?? '').trim() && Math.abs(amount) > 0.001) {
        throw bizError(
          `第 ${idx + 1} 行费用填了 ${amount.toFixed(2)} 却没有名称——保存时这一行会被当成空行丢掉，这笔钱不会进 PI/CI，也不算进待收。请补个名称（例如“运费”）再保存。`
        )
      }
    })
  }

  /** 订单货值 = 明细行 Σ(数量×单价)；orders 表不存总金额，费用行守门要用时现算 */
  async function orderGoodsTotal(orderId: number): Promise<number> {
    const row = await db.get(
      'SELECT COALESCE(SUM(quantity * unit_price), 0) AS g FROM order_items WHERE order_id = ?',
      [orderId]
    ) as { g?: number } | null
    return Number(row?.g ?? 0)
  }

  /**
   * 合计（货值 + 费用行）不许为负：负合计会被误当成客户多付，凭空生成一笔能抵别的单、能退真钱的预收。
   * cause 说清这回钱是从哪里让出去的（让利行 / 样品费抵扣 / 调小明细），报错才指得对地方；
   * docLabel 说明这是哪张纸——报价单转单时会把负合计原样带成订单的负合计，所以它也得在源头拦住。
   */
  function assertOrderTotalNonNegative(
    goodsTotal: number,
    charges: QuotationCharge[],
    cause = '让利（负费用行）',
    docLabel = '订单'
  ): void {
    const total = goodsTotal + charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
    if (total < -0.001) {
      throw bizError(
        `货值 ${goodsTotal.toFixed(2)} 加上费用行后合计是 ${total.toFixed(2)}。` +
          `合计为负的${docLabel}会被系统当成客户多付，凭空生成一笔能抵别的单、甚至退真钱的预收。` +
          `请把${cause}控制在货值以内，或先补足明细货值再保存。`
      )
    }
  }

  /**
   * 核销过的单不能再改小到「核销比欠款还多」。
   *
   * 短款/坏账是「这笔我们认了收不回来」，不是客户多付的钱。金额一缩到实收 + 抵扣 + 核销以下，
   * 多出来的核销额就会在客户账上变成一笔从没收到的预收：能抵别的单，还能退真钱出去。
   * 改费用行、改明细、删行、整批换货都得过这一道（加行/加收款只会让缺口变松，不必查）。
   */
  async function assertWriteOffFitsOrder(orderId: number): Promise<void> {
    const row = (await db.get('SELECT charges, deposit_ratio, currency FROM orders WHERE id = ?', [orderId])) as
      | Record<string, unknown>
      | null
    if (!row) return
    const money = (
      await moneyOf().moneyForOrders([
        { id: orderId, charges: row.charges, depositRatio: Number(row.deposit_ratio ?? 0) }
      ])
    ).get(orderId)
    if (!money) return
    const writtenOff = money.netWrittenOff
    if (writtenOff <= 0.001) return
    const debt = money.grandTotal - money.paidAmount - money.creditApplied
    const excess = writtenOff - Math.max(0, debt)
    if (excess <= 0.001) return
    const used = money.creditApplied > 0.001 ? `、预收抵扣 ${money.creditApplied.toFixed(2)}` : ''
    throw bizError(
      `这张单已经核销过 ${writtenOff.toFixed(2)} ${String(row.currency ?? '')}（短款 + 坏账）。` +
        `改完后，客户付过的 ${money.paidAmount.toFixed(2)}${used} 加上这笔核销，` +
        `比单据总额 ${money.grandTotal.toFixed(2)} 还多出 ${excess.toFixed(2)}——` +
        `核销是「我们认了收不回来」，不是客户多付的钱，多出来的部分不能变成客户的预收。` +
        `请先到这张单的「核销与坏账」里撤销那笔核销，再改金额。`
    )
  }

  /** 打样单「还该收多少」的三个原始数：总额（样品费+快递费）、已按水单收、已用预收抵 */
  async function sampleFeePieces(sampleId: number): Promise<{ totalFee: number; collected: number; creditApplied: number }> {
    const row = (await db.get(
      `SELECT (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM sample_order_items WHERE sample_order_id = ?)
                 + COALESCE(express_fee, 0) AS total,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE sample_order_id = ?) AS collected
        FROM sample_orders WHERE id = ?`,
      [sampleId, sampleId, sampleId]
    )) as { total?: number; collected?: number } | null
    return {
      totalFee: Number(row?.total ?? 0),
      collected: Number(row?.collected ?? 0),
      creditApplied: await moneyOf().creditAppliedForSample(sampleId)
    }
  }

  /**
   * 抵扣行和打样单的 offset_amount 是同一块钱的两张脸：订单纸面上那条负数费用，
   * 对应打样单上「已经抵掉多少样品费」。以前只改一边——跟单员在费用行里把抵扣改成
   * 一半，打样单还挂着全额「已抵扣」，样品欠款榜和 PI 就长期对不上；整行删掉时
   * 打样单更是顶着「已抵扣」永远不再出现在催款里。这里让两张脸跟着同一笔保存一起变。
   */
  async function syncSampleOffsetFromCharges(
    orderId: number,
    orderNo: string,
    beforeCharges: QuotationCharge[],
    afterCharges: QuotationCharge[]
  ): Promise<void> {
    const before = sampleOffsetFromCharges(beforeCharges)
    const after = sampleOffsetFromCharges(afterCharges)
    if (Math.abs(before - after) <= 0.001) return
    const linked = (await db.all(
      `SELECT id, sample_no, fee_note FROM sample_orders
       WHERE converted_order_id = ? AND fee_status = 'offset'`,
      [orderId]
    )) as Record<string, unknown>[]
    if (linked.length === 0) return
    // 抵扣行没了（删行或改名）：打样单退回未收，这笔样品费重新回到欠款榜。
    // offset_amount 留着不动，和 voidOrder 那条回退一个口径——它只是历史额。
    if (after <= 0.001) {
      for (const s of linked) {
        await db.run('UPDATE sample_orders SET fee_status = ?, fee_note = ?, updated_at = ? WHERE id = ?', [
          'unpaid',
          `${String(s.fee_note ?? '')}；订单 ${orderNo} 的抵扣行已取消，回退为未收`,
          now(),
          Number(s.id)
        ])
        await logEvent(
          db,
          orderId,
          'sample_offset_back',
          null,
          null,
          `打样单 ${String(s.sample_no ?? '')} 的样品费抵扣随订单费用行取消回退为未收`
        )
      }
      return
    }
    // 一个数写不进两张打样单：说不清抵在哪张上，宁可拦下来让人去打样单那边改
    if (linked.length > 1) {
      const list = linked.map((s) => String(s.sample_no ?? '')).join('、')
      throw bizError(
        `这张订单关联了 ${linked.length} 张已抵扣的打样单（${list}），而订单上只有一条抵扣金额 ${after.toFixed(2)}。` +
          `系统不知道该把这笔钱记在哪张打样单上，请一次只留一张转单，或先作废这张单再分别重转。`
      )
    }
    const s = linked[0]
    const sampleId = Number(s.id)
    // 抵扣行的上限是「这张打样单还没收回来的钱」，跟转单同一个算式。
    // 不封顶的话，费用行里写个样品费三倍的数也能存：打样单从此顶着一笔收不回来的
    // 巨额「已抵扣」，样品欠款榜少算、对账单多算，而订单这边还照旧少收客户钱。
    const sampleTotal = await sampleFeePieces(sampleId)
    const cap = sampleOpenFeeOf(sampleTotal.totalFee, 'offset', sampleTotal.collected, sampleTotal.creditApplied)
    if (after > cap + 0.001) {
      throw bizError(
        `抵扣行写了 ${after.toFixed(2)}，可打样单 ${String(s.sample_no ?? '')} 还没收回来的只有 ${cap.toFixed(2)}` +
          `（样品费+快递费 − 已按水单收 − 已用预收抵）。多出来的部分没有任何一笔样品费可抵，` +
          `抵的其实是从客户身上多收的钱。请把这条抵扣改回 ${cap.toFixed(2)} 以内，` +
          `确实要少收客户这么多，请用正费用行之外的让利并写明原因。`
      )
    }
    await db.run('UPDATE sample_orders SET offset_amount = ?, fee_note = ?, updated_at = ? WHERE id = ?', [
      after,
      `${String(s.fee_note ?? '')}；订单 ${orderNo} 费用行调整后抵扣 ${after.toFixed(2)}`,
      now(),
      sampleId
    ])
    await logEvent(
      db,
      orderId,
      'update',
      null,
      null,
      `打样单 ${String(s.sample_no ?? '')} 的抵扣额随订单费用行调整为 ${after.toFixed(2)}`
    )
  }

  /** 合计为负时报错该指哪儿：这笔钱是从样品费抵扣让的，还是从让利行让的 */
  function chargeCause(charges: QuotationCharge[]): string {
    return sampleOffsetFromCharges(charges) > 0.001 ? '样品费抵扣（含快递费）' : '让利（负费用行）'
  }

  /**
   * 明细变动（改小、删行、整批替换）后的合计守门。
   * 费用行里那条样品费抵扣是本单唯一合法的负数：货值一被抽走，它就变成负合计，
   * 而负合计会被当成客户多付——抵扣凭空蒸发，还铸出一笔能抵别的单、能退真钱的预收。
   */
  async function assertTotalNonNegativeAfter(orderId: number, goodsTotal: number): Promise<void> {
    const row = (await db.get('SELECT charges FROM orders WHERE id = ?', [orderId])) as { charges?: unknown } | null
    assertOrderTotalNonNegative(goodsTotal, parseCharges(row?.charges), '费用行里的抵扣与让利')
  }

  /** 只改费用行（运费/保险），其他字段一个都不动 */
  async function updateOrderCharges(
    orderId: number,
    charges: QuotationCharge[],
    reason = ''
  ): Promise<OrderDetail> {
    const before = await db.get('SELECT charges, customer_id, order_no FROM orders WHERE id = ?', [orderId]) as Record<
      string,
      unknown
    > | null
    if (!before) throw notFound('订单不存在')
    await assertOrderWritable(orderId, '改费用行')
    assertChargeAmounts(charges)
    const clean = charges.filter((c) => c.label.trim())
    // 让利让过头（合计为负）的单不许落库：负合计会被当成客户多付、凭空生成预收
    assertOrderTotalNonNegative(await orderGoodsTotal(orderId), clean, chargeCause(clean))
    const beforeCharges = parseCharges(before.charges)
    if (!sameCharges(beforeCharges, clean)) await assertPricingEditable(orderId, '改费用行')
    // 让利（负费用行）改一笔，客户该付的钱就变了：这是对外的价格让步，
    // 不写原因的话日后只看到应收少了一块，没人说得清是谁答应的、为什么
    const reasonText = String(reason ?? '').trim()
    if (negativeChargesChanged(beforeCharges, clean) && !reasonText) {
      throw bizError(
        '这次改的是让利（负费用行），它会直接改变客户该付多少。请写明原因（例如「老客户运费对折」「补上次多收的 20」），这句话会记进订单操作历史。'
      )
    }
    // 改费用、抵扣联动、留痕、重算状态必须同生同死：中途失败留着「费用改了、应收没重算」的单
    await db.transact(async () => {
      await db.run('UPDATE orders SET charges=?, updated_at=? WHERE id=?', [JSON.stringify(clean), now(), orderId])
      await syncSampleOffsetFromCharges(orderId, String(before.order_no ?? ''), beforeCharges, clean)
      const parts = describeChargeChange(beforeCharges, clean)
      const detail = parts.length ? `修改费用：${parts.join('；')}` : '修改费用行'
      await logEvent(db, orderId, 'update', null, null, reasonText ? `${detail}；原因：${reasonText}` : detail)
      await recomputePaymentStatus(orderId)
      // 改小费用行同样可能让核销额超过实际欠款（多出来的会变成假预收）
      await assertWriteOffFitsOrder(orderId)
      await creditsOf().assertCreditFitsOrder(orderId)
      // 让利/加费都会改变这单的「多收」残差：客户账上已抵/已退的钱不能被架空
      await creditsOf().assertCreditSolvent(Number(before.customer_id))
    })
    return (await getOrder(orderId))!
  }

  /** 负费用行（让利）有没有被增删/改额；正费用行的变化不在此列 */
  function negativeChargesChanged(oldCharges: QuotationCharge[], newCharges: QuotationCharge[]): boolean {
    const snap = (list: QuotationCharge[]): string =>
      list
        .filter((c) => Number(c.amount) < 0)
        .map((c) => `${c.label.trim()}\u0000${Number(c.amount)}`)
        .sort()
        .join('\u0001')
    return snap(oldCharges) !== snap(newCharges)
  }

  /* ---------------- 订单行 ---------------- */

  /**
   * 行成本一律按订单币种存。
   * 前端传 costBase（工厂报的人民币价）时，这里按本单汇率折算——
   * 以前把 ¥30 直接当 $30 写进 unit_cost，毛利差一整个汇率。
   * 本币单没有折算可言：汇率按 1 用，库里那一列存着历史垃圾也不能拿它去除
   * （7.15 的垃圾值会把 ¥30 的成本写成 ¥4.2，毛利凭空翻七倍）。
   */
  async function resolveItemCost(orderId: number, item: { unitCost?: number | null; costBase?: number | null }): Promise<number | null> {
    if (item.costBase !== undefined && item.costBase !== null) {
      const row = await db.get('SELECT currency, exchange_rate FROM orders WHERE id = ?', [orderId]) as
        | { currency?: string; exchange_rate?: number }
        | null
      const base = (await settingsCore(db).get()).baseCurrency
      const currency = String(row?.currency ?? '')
      const rate = currency && currency === base ? 1 : Number(row?.exchange_rate ?? 1)
      return costInOrderCurrency(item.costBase, rate)
    }
    return item.unitCost ?? null
  }

  /**
   * 同一个 款号×颜色×尺码 只许有一行明细。
   * 两行不同单价会按数量加权出一个中间价，已经出过 CI 的批次货值跟着变，
   * 纸面金额却被存档钉住——费用倒推出来就可能是负数。
   */
  async function assertSkuUnique(
    orderId: number,
    sku: { styleNo: string; color: string; size: string },
    exceptItemId?: number
  ): Promise<void> {
    const row = await db.get(
      `SELECT id FROM order_items
       WHERE order_id = ? AND style_no = ? AND color = ? AND size = ?${exceptItemId ? ' AND id != ?' : ''}
       LIMIT 1`,
      exceptItemId
        ? [orderId, sku.styleNo, sku.color, sku.size, exceptItemId]
        : [orderId, sku.styleNo, sku.color, sku.size]
    )
    if (!row) return
    const label = [sku.styleNo || '未填款号', sku.color, sku.size].filter(Boolean).join(' / ')
    throw bizError(
      `款号 ${label} 已经有明细了。同一款只能有一行：两行不同单价会按数量加权，把已经发出去的 CI 金额算乱。请直接改那一行的数量或单价。`
    )
  }

  /**
   * 一批明细里同款同色同码只许出现一次：订单侧 insertOrderItem 逐行拦，
   * 这里给打样/报价/转单这些「整批带入」的路径共用——源头不拦，脏明细就会从旁门流进订单。
   */
  function assertSkuListUnique(
    items: { styleNo?: string | null; color?: string | null; size?: string | null }[],
    where: string
  ): void {
    const seen = new Set<string>()
    for (const it of items) {
      const styleNo = String(it.styleNo ?? '').trim()
      if (!styleNo) continue
      const color = String(it.color ?? '').trim()
      const size = String(it.size ?? '').trim()
      const sku = `${styleNo}\u0000${color}\u0000${size}`
      if (seen.has(sku)) {
        const label = [styleNo, color, size].filter(Boolean).join(' / ')
        throw bizError(
          `${where}里款号 ${label} 出现了两行。同一款只能有一行：转成订单后两行不同单价会按数量加权，把 CI 金额算乱。请在${where}里把同款合并成一行（数量相加、单价用客户确认的那一个）。`
        )
      }
      seen.add(sku)
    }
  }

  /** 已经装进未作废批次的款号不许再加一行：那批的 CI 金额按当时明细算，补一行会把纸面金额改掉 */
  async function assertSkuNotPacked(
    orderId: number,
    sku: { styleNo: string; color: string; size: string }
  ): Promise<void> {
    const packed = await packedQty(orderId, sku)
    if (packed <= 0) return
    const label = [sku.styleNo || '未填款号', sku.color, sku.size].filter(Boolean).join(' / ')
    throw bizError(
      `款号 ${label} 已经装了 ${packed} 件箱，不能再新加一行：这一批的 CI 金额是按当时明细的单价算的，补一行同款会让纸面金额对不上。要补货请改对应箱明细，或按新批次装。`
    )
  }

  /** 插一行的底层动作：数量/单价闸门 + 插入 + 逐行留痕（批量入口共用一个事务） */
  async function insertOrderItem(orderId: number, item: OrderItemInput): Promise<void> {
    const who = `款号 ${item.styleNo || '未填'}`
    assertQuantity(item.quantity, `${who} 的数量`)
    assertUnitPrice(item.unitPrice, `${who} 的单价`)
    const sku = { styleNo: item.styleNo, color: item.color ?? '', size: item.size ?? '' }
    await assertSkuUnique(orderId, sku)
    await assertSkuNotPacked(orderId, sku)
    await db.run(
      `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        orderId,
        item.productId ?? null,
        item.styleNo,
        item.productName ?? '',
        item.composition ?? '',
        item.color ?? '',
        item.size ?? '',
        item.quantity,
        item.unitPrice,
        await resolveItemCost(orderId, item)
      ]
    )
    await logEvent(db, orderId, 'item_add', null, null, `添加 SKU ${item.styleNo} ${item.color}/${item.size} × ${item.quantity}`)
  }

  function addOrderItem(orderId: number, item: OrderItemInput): Promise<OrderDetail> {
    return addOrderItems(orderId, [item])
  }

  /**
   * 批量加行：整批一个事务。
   * 以前是前端循环调 addItem——第 3 行没过校验时前两行已经躺在库里，
   * 订单明细半截，用户只看到一条报错，不知道单子已经多了两行来路不明的 SKU。
   */
  async function addOrderItems(orderId: number, items: OrderItemInput[]): Promise<OrderDetail> {
    await assertOrderWritable(orderId, '加明细')
    const customerId = Number(
      (await db.get('SELECT customer_id FROM orders WHERE id = ?', [orderId]) as { customer_id?: number } | null)
        ?.customer_id ?? 0
    )
    await db.transact(async () => {
      for (const item of items) await insertOrderItem(orderId, item)
      await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
      // 件数变了，订单的「装够没有 / 走了没有」跟着变
      await applyShipStatus(db, orderId)
      // 金额变了，应收总额 / 定金 / 待收都变了，收款状态要重算（可以往上也可以往下）
      await recomputePaymentStatus(orderId)
      // 加行会把客户原来的「多收」吃掉：已经抵/退出去的钱不能因此穿仓
      if (customerId) await creditsOf().assertCreditSolvent(customerId)
    })
    return (await getOrder(orderId))!
  }

  /** 这一款（款号×颜色×尺码）在所有装箱单里已经装了多少件 */
  async function packedQty(orderId: number, sku: { styleNo: string; color: string; size: string }): Promise<number> {
    return Number(
      (
        await db.get(
          `SELECT COALESCE(SUM(l.quantity), 0) AS qty
           FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
           WHERE pl.order_id = ? AND pl.voided_at IS NULL
             AND l.style_no = ? AND l.color = ? AND l.size = ?`,
          [orderId, sku.styleNo, sku.color, sku.size]
        ) as { qty?: number } | null
      )?.qty ?? 0
    )
  }

  /** 订单减量不能减到已装箱数以下：箱子里实物已经在了，订单数字必须兜得住 */
  async function assertNotBelowPacked(
    orderId: number,
    sku: { styleNo: string; color: string; size: string }
  ): Promise<void> {
    const packed = await packedQty(orderId, sku)
    if (packed > 0) {
      throw bizError(
        `款号 ${sku.styleNo} ${sku.color}/${sku.size} 已经装了 ${packed} 件箱，订单数量不能改到 ${packed} 件以下；请先到「装箱单」里改小或删掉对应箱明细（已出运的批次要先把状态改回「已包装」）。`
      )
    }
  }

  async function updateOrderItem(
    orderId: number,
    itemId: number,
    patch: Partial<OrderItemInput>
  ): Promise<OrderDetail> {
    await assertOrderWritable(orderId, '改明细')
    const customerId = Number(
      (await db.get('SELECT customer_id FROM orders WHERE id = ?', [orderId]) as { customer_id?: number } | null)
        ?.customer_id ?? 0
    )
    const cur = await db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]) as
      | Record<string, unknown>
      | null
    if (!cur) throw notFound('订单行不存在')
    const curSku = {
      styleNo: String(cur.style_no ?? ''),
      color: String(cur.color ?? ''),
      size: String(cur.size ?? '')
    }
    const nextSku = {
      styleNo: patch.styleNo ?? curSku.styleNo,
      color: patch.color ?? curSku.color,
      size: patch.size ?? curSku.size
    }
    const skuChanged = nextSku.styleNo !== curSku.styleNo || nextSku.color !== curSku.color || nextSku.size !== curSku.size
    const packed = await packedQty(orderId, curSku)
    if (skuChanged && packed > 0) {
      throw bizError(
        `款号 ${curSku.styleNo} ${curSku.color}/${curSku.size} 已经装了 ${packed} 件箱，不能直接换款号/颜色/尺码；请先到「装箱单」里处理这一款的箱明细（已出运的批次要先把状态改回「已包装」）。`
      )
    }
    if (skuChanged) {
      // 换过去的款也必须守两条：明细不重复、不能撞上已经装箱的款
      await assertSkuUnique(orderId, nextSku, itemId)
      await assertSkuNotPacked(orderId, nextSku)
    }
    if (!skuChanged && patch.quantity !== undefined && Number(patch.quantity) < packed) {
      await assertNotBelowPacked(orderId, curSku)
    }
    // 数量/单价闸门：只校验这次真的传了的键（没传是「不改」，不是「填 0」）
    const lineWho = `款号 ${nextSku.styleNo || '未填'} ${nextSku.color}/${nextSku.size}`
    if (patch.quantity !== undefined) assertQuantity(patch.quantity, `${lineWho} 的数量`)
    if (patch.unitPrice !== undefined) assertUnitPrice(patch.unitPrice, `${lineWho} 的单价`)
    if (patch.unitPrice !== undefined && Number(patch.unitPrice) !== Number(cur.unit_price)) {
      await assertPricingEditable(orderId, '改明细单价')
    }
    // costBase：没传 = 不动；传了数字 = 按本单汇率折算；传 null = 主动清空（不能当成「没传」）
    const nextCost =
      patch.costBase !== undefined
        ? await resolveItemCost(orderId, { costBase: patch.costBase })
        : patch.unitCost !== undefined
          ? patch.unitCost
          : (cur.unit_cost as number | null)
    const baseChanges = describeItemChange(cur, patch)
    const costNote =
      patch.costBase === undefined
        ? ''
        : `${baseChanges ? '；' : ''}成本按工厂价 ${patch.costBase ?? '清空'} 折算（本单汇率下 ${
            nextCost == null ? '—' : nextCost
          }）`
    const changes = baseChanges + costNote
    // 改行、留痕、重算状态必须一起成一起败：以前中途抛错会留下「行改了、状态没改」的单
    await db.transact(async () => {
      await db.run(
        `UPDATE order_items SET product_id=?, style_no=?, product_name=?, composition=?, color=?, size=?, quantity=?, unit_price=?, unit_cost=?
         WHERE id=? AND order_id=?`,
        [
          patch.productId !== undefined ? patch.productId : (cur.product_id as number | null),
          patch.styleNo ?? (cur.style_no as string),
          patch.productName ?? (cur.product_name as string),
          patch.composition ?? (cur.composition as string),
          patch.color ?? (cur.color as string),
          patch.size ?? (cur.size as string),
          patch.quantity ?? (cur.quantity as number),
          patch.unitPrice ?? (cur.unit_price as number),
          nextCost,
          itemId,
          orderId
        ]
      )
      await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
      // 改小数量/单价会把费用行里的抵扣顶出去：合计一旦为负，抵扣静默蒸发、还生出假预收。
      // 这道门在事务里按改完的库内货值现算：事务外那一次读挡不住并发的第二笔改行——
      // 两个人各把一行砍半，彼此都只看见自己的改动，双双放行，库里留下的是一张负合计单
      if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
        await assertTotalNonNegativeAfter(orderId, await orderGoodsTotal(orderId))
      }
      if (changes) await logEvent(db, orderId, 'item_update', null, null, `修改明细 ${patch.styleNo ?? cur.style_no}：${changes}`)
      // 件数变了，订单的「装够没有 / 走了没有」跟着变
      await applyShipStatus(db, orderId)
      // 金额变了，收款状态要重算（加单加到收不够要从「已收款」退回「部分收款」）
      await recomputePaymentStatus(orderId)
      // 改小数量/单价：核销额不能超过实际欠款（多出来的会变成假预收）
      await assertWriteOffFitsOrder(orderId)
      await creditsOf().assertCreditFitsOrder(orderId)
      // 调大数量/单价会吃掉这家客户的「多收」残差，已抵/已退的钱不能被架空
      if (customerId) await creditsOf().assertCreditSolvent(customerId)
    })
    return (await getOrder(orderId))!
  }

  /** 生成明细行变更说明 */
  function describeItemChange(cur: Record<string, unknown>, patch: Partial<OrderItemInput>): string {
    const parts: string[] = []
    const cmp = (label: string, key: string, val: unknown) => {
      if (val === undefined) return
      const old = cur[key]
      if (String(old ?? '') !== String(val ?? '')) {
        parts.push(
          `${label} ${old === null || old === undefined || old === '' ? '空' : old} → ${val === '' ? '空' : val}`
        )
      }
    }
    cmp('款号', 'style_no', patch.styleNo)
    cmp('颜色', 'color', patch.color)
    cmp('尺码', 'size', patch.size)
    cmp('数量', 'quantity', patch.quantity)
    cmp('单价', 'unit_price', patch.unitPrice)
    cmp('成本', 'unit_cost', patch.unitCost)
    return parts.join('；')
  }

  async function removeOrderItem(orderId: number, itemId: number): Promise<OrderDetail> {
    await assertOrderWritable(orderId, '删明细')
    // 删行也要留痕：客户要过 50 件后来取消了，这件事系统必须记得
    const cur = await db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]) as
      | Record<string, unknown>
      | null
    if (!cur) throw notFound('订单行不存在')
    const packed = await packedQty(orderId, {
      styleNo: String(cur.style_no ?? ''),
      color: String(cur.color ?? ''),
      size: String(cur.size ?? '')
    })
    if (packed > 0) {
      throw bizError(
        `款号 ${String(cur.style_no)} ${String(cur.color)}/${String(cur.size)} 已经装了 ${packed} 件箱，不能直接删这一行；请先到「装箱单」里删掉对应箱明细（已出运的批次要先把状态改回「已包装」）。`
      )
    }
    await db.transact(async () => {
      await db.run('DELETE FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId])
      await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
      // 删掉这一行等于抽走一截货值：剩下的货撑不住费用行里的抵扣就成了负合计。
      // 同改行那道门一样，守门读的是事务内已经删完的货值，不给并发插队留缝
      await assertTotalNonNegativeAfter(orderId, await orderGoodsTotal(orderId))
      await logEvent(db, 
        orderId,
        'item_remove',
        null,
        null,
        `删除明细 ${cur.style_no} ${cur.color}/${cur.size} × ${cur.quantity}（单价 ${Number(
          cur.unit_price ?? 0
        ).toFixed(2)}）`
      )
      // 件数变了，订单的「装够没有 / 走了没有」跟着变
      await applyShipStatus(db, orderId)
      // 金额变了，收款状态要重算
      await recomputePaymentStatus(orderId)
      // 删行抽走货值：核销额不能超过实际欠款（多出来的会变成假预收）
      await assertWriteOffFitsOrder(orderId)
      await creditsOf().assertCreditFitsOrder(orderId)
    })
    return (await getOrder(orderId))!
  }

  /** 批量替换订单行（从商品库选款生成 SKU 矩阵时用） */
  async function replaceOrderItems(orderId: number, items: OrderItemInput[]): Promise<OrderDetail> {
    await assertOrderWritable(orderId, '整体替换明细')
    const customerId = Number(
      (await db.get('SELECT customer_id FROM orders WHERE id = ?', [orderId]) as { customer_id?: number } | null)
        ?.customer_id ?? 0
    )
    const packed = Number(
      (
        await db.get(
          `SELECT COALESCE(SUM(l.quantity), 0) AS qty
           FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
           WHERE pl.order_id = ? AND pl.voided_at IS NULL`,
          [orderId]
        ) as { qty?: number } | null
      )?.qty ?? 0
    )
    if (packed > 0) {
      throw bizError(
        `这张单已经装了 ${packed} 件箱，不能整体替换明细；请逐行调整，或先到「装箱单」里处理箱明细（已出运的批次要先把状态改回「已包装」）。`
      )
    }
    // 整批先过闸门再动库：不能删完旧明细才发现第 3 行数量是负数
    const seenSku = new Map<string, number>()
    items.forEach((it, i) => {
      const who = `第 ${i + 1} 行（款号 ${it.styleNo || '未填'}）`
      assertQuantity(it.quantity, `${who} 的数量`)
      assertUnitPrice(it.unitPrice, `${who} 的单价`)
      const key = [it.styleNo, it.color ?? '', it.size ?? ''].join('|')
      const first = seenSku.get(key)
      if (first !== undefined) {
        throw bizError(
          `${who} 和第 ${first} 行是同一个 款号/颜色/尺码。同一款只能有一行：两行不同单价会按数量加权，把批次货值算乱。请合并数量后重试。`
        )
      }
      seenSku.set(key, i + 1)
    })
    // 整批替换连同留痕、状态重算放进同一个事务：只删干净一半就失败，是最难查的那种单
    await db.transact(async () => {
      await db.run('DELETE FROM order_items WHERE order_id = ?', [orderId])
      for (const item of items) {
        await db.run(
          `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            orderId,
            item.productId ?? null,
            item.styleNo,
            item.productName ?? '',
            item.composition ?? '',
            item.color ?? '',
            item.size ?? '',
            item.quantity,
            item.unitPrice,
            await resolveItemCost(orderId, item)
          ]
        )
      }
      await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), orderId])
      // 换成一批更小的货，费用行里的抵扣可能顶不住新货值：守门读事务内已经换完的货值
      await assertTotalNonNegativeAfter(orderId, await orderGoodsTotal(orderId))
      await applyShipStatus(db, orderId)
      await logEvent(db, orderId, 'item_replace', null, null, `批量生成 ${items.length} 个 SKU 行`)
      // 金额变了，收款状态要重算
      await recomputePaymentStatus(orderId)
      // 换成一批更小的货：核销额不能超过实际欠款（多出来的会变成假预收）
      await assertWriteOffFitsOrder(orderId)
      await creditsOf().assertCreditFitsOrder(orderId)
      // 替换后的总额变大 = 原来客户多付的那截变小，已抵/已退的钱不能被架空
      if (customerId) await creditsOf().assertCreditSolvent(customerId)
    })
    return (await getOrder(orderId))!
  }

  /**
   * 按 SKU 汇总（用于 PL 装箱单自动生成）。
   * 同时算出「已经装箱的数量」：分批出货时，新的一箱只装还没装的部分。
   * SKU 按 款号×颜色×尺码 认（品名取其中一行，不参与归组）。
   */
  async function summarizeSkus(orderId: number): Promise<SkuSummary[]> {
    const rows = await db.all(
      `SELECT oi.style_no, MAX(oi.product_name) AS product_name, oi.color, oi.size,
              SUM(oi.quantity) AS quantity,
              COALESCE((
                SELECT SUM(pll.quantity) FROM packing_list_lines pll
                JOIN packing_lists pl ON pl.id = pll.packing_list_id
                WHERE pl.order_id = oi.order_id AND pl.voided_at IS NULL
                  AND pll.style_no = oi.style_no
                  AND pll.color = oi.color AND pll.size = oi.size
              ), 0) AS packed_quantity
       FROM order_items oi
       WHERE oi.order_id = ? AND oi.quantity > 0
       GROUP BY oi.style_no, oi.color, oi.size
       ORDER BY oi.style_no, oi.color, oi.size`,
      [orderId]
    ) as Record<string, unknown>[]
    return rows.map(mapSkuSummary)
  }

  /* ---------------- 收款 ---------------- */



  /**
   * 收款日期与金额的唯一守门：订单收款、打样费收款、水单拆分共用这一份。
   * 分成几处各写一遍，迟早有一处忘掉「不能填未来日期」，那笔钱就从本月到账里漂走。
   */
  function assertPaymentInput(p: { paidAt: string; amount: number }): { paidAt: string; amount: number } {
    const paidAt = String(p.paidAt ?? '').trim()
    // 空日期会让这笔钱从「本月收款」和月报里消失，只剩订单上的已收能看见
    if (!isLocalDate(paidAt)) {
      throw bizError('收款日期要填完整（例如 2026-10-24）。空日期的收款不会进本月收款和月报。')
    }
    // 钱不可能在未来到账：填成明年会把「本月到账」和账期催款一起带偏
    if (paidAt > localDate()) {
      throw bizError(`收款日期 ${paidAt} 还没到。请填银行水单上的实际到账日，最晚是今天（${localDate()}）。`)
    }
    const amount = Number(p.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw bizError('收款金额必须是大于 0 的数。')
    }
    return { paidAt, amount }
  }

  /**
   * 同一张单不许把同一张水单记两次。
   * 拆一张水单到几张单是正常业务（整批共用流水号），所以只在「同一张单」上拦；
   * 空流水号不拦（很多老账、小额汇款根本没有流水号）。
   * 比对前去掉首尾空格并忽略大小写：手抄流水号的大小写不一致，还是同一张水单。
   */
  async function assertBankRefUnused(
    target: { orderId?: number; sampleOrderId?: number },
    bankRef: unknown
  ): Promise<void> {
    const ref = String(bankRef ?? '').trim()
    if (!ref) return
    const bySample = target.sampleOrderId != null
    const docId = bySample ? target.sampleOrderId! : target.orderId
    if (docId == null) return
    const dup = await db.get(
      `SELECT paid_at, amount FROM payments
        WHERE ${bySample ? 'sample_order_id' : 'order_id'} = ?
          AND UPPER(TRIM(bank_ref)) = UPPER(?)
        ORDER BY id LIMIT 1`,
      [docId, ref]
    ) as { paid_at?: string; amount?: number } | null
    if (!dup) return
    throw bizError(
      `这张单上已经登记过流水号「${ref}」的收款（${String(dup.paid_at ?? '')}，${Number(dup.amount ?? 0).toFixed(2)}）：` +
        `同一张水单不能记两次，再记一次会让已收翻倍、凭空多出可退的预收。` +
        `如果这笔钱要拆到别的单，请用「水单拆分收款」；如果上次录错了，请先撤销原记录再重录；确实没有流水号就留空。`
    )
  }

  async function addPayment(orderId: number, p: PaymentInput): Promise<OrderDetail> {
    // 作废单不再有「待收」，但钱真的到账时要能落账：
    // 现金流口径（只排除草稿）本来就把作废单的到账算进月报——闸门拦死只会让银行流水与系统账脱节。
    // 这里开正门：必须写明来路；这笔钱只进收款流水与月报，不复活订单、不动待收（recompute 对终态直接返回）。
    // 失效单不走这条门：它还有「改回客户已确认」的活路，走正常收款流程。
    const cur = await db.get('SELECT order_no, payment_status, currency FROM orders WHERE id = ?', [orderId]) as
      | { order_no?: string; payment_status?: string; currency?: string }
      | null
    if (!cur) throw notFound('订单不存在')
    const curStatus = String(cur.payment_status ?? '')
    const isVoided = curStatus === 'void'
    if (curStatus === 'void') {
      if (!String(p.note ?? '').trim()) {
        throw bizError(`订单 ${String(cur.order_no ?? '')} 已作废：作废单的回款必须写明来路（备注里写清楚，例如“取消单客户退回的定金”），操作历史要能对上银行流水。`)
      }
    } else {
      await assertOrderWritable(orderId, '登记收款')
    }
    // 草稿不进现金流（month_received / 月报 / 月度汇总都排除草稿），
    // 在草稿上登记收款，这笔钱会从所有到账报表里消失——先把状态推到「已发出」再收钱
    if (curStatus === 'draft') {
      throw bizError(
        `订单 ${String(cur.order_no ?? '')} 还是草稿：草稿不进现金流，登记了也不会出现在「本月到账」和月报里。请先把收款状态改成「已发出」或「已确认」，再登记收款。`
      )
    }
    const { paidAt, amount } = assertPaymentInput(p)
    // 有预收抵扣的单：现金只能收「预收之外还欠的那部分」，
    // 否则同一块钱会被收两遍（预收抵一次、现金又收满全额）
    if (!isVoided) {
      const detail = (await getOrder(orderId))!
      // 坏账已经从待收里拿掉过一次：再按普通收款记，同一笔钱会同时被算成
      // 「坏账损失」和「客户多付」，凭空铸出可退的预收。钱到账请走「坏账追回」。
      if (detail.badDebtOutstanding > 0.001) {
        throw bizError(
          `这张单还有 ${detail.badDebtOutstanding.toFixed(2)} ${String(cur.currency ?? '')} 坏账没追回：` +
            `钱到账请走「坏账追回」登记，不能按普通收款记——否则同一笔欠款会同时算坏账损失和客户多付。`
        )
      }
      if (detail.creditApplied > 0.001 && amount > detail.remaining + 0.001) {
        throw bizError(
          `这张单已经有 ${detail.creditApplied.toFixed(2)} ${String(cur.currency ?? '')} 是客户预收抵掉的，现金待收只剩 ${detail.remaining.toFixed(2)}：再收 ${amount.toFixed(2)} 就重复收了。多出来的钱请登记到别的单上。`
        )
      }
    }
    // 汇率快照：这笔到账按「落款那天订单上的汇率」折算进月报，
    // 以后订单汇率再改（出单据前的窗口期是允许的），历史到账不许跟着漂
    const rate = Number(
      (await db.get('SELECT exchange_rate FROM orders WHERE id = ?', [orderId]) as { exchange_rate?: number } | null)
        ?.exchange_rate ?? 1
    )
    await db.transact(async () => {
      // 查重放在事务里：拆分收款整批落账时，同一张单被填两次会在这里当场拦下
      await assertBankRefUnused({ orderId }, p.bankRef)
      await db.run(
        `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, exchange_rate, created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [orderId, paidAt, amount, p.method ?? 'T/T', p.bankRef ?? '', p.note ?? '', rate, now()]
      )
      await logEvent(db, 
        orderId,
        'payment',
        null,
        null,
        `${isVoided ? '作废单回款' : '收款'} ${amount.toFixed(2)}（${paidAt}${p.bankRef ? `，流水号 ${p.bankRef}` : `，${p.method ?? 'T/T'}`}）` +
          // 补录过去日期的到账也是按「录入时刻」的订单汇率钉快照：口径写进历史，月报对不上时查得到原因
          `；汇率按 ${rate} 钉快照`
      )
      await recomputePaymentStatus(orderId)
    })
    return (await getOrder(orderId))!
  }

  /** 一笔水单拆到多张单：每笔的落账参数（流水号必须整批一致，对账靠它归组） */


  /**
   * 拆分收款：一个事务循环落 N 笔。任何一笔被守门拦下（草稿、日期、金额…）
   * 整批回滚——银行水单是一笔钱，账上要么整笔都在、要么一笔没有，
   * 落一半会让「水单总额」和「系统里的收款」对不上。
   * R25：打样单的样品费也接进同一笔水单（客户一笔钱同时付订单和打样费是常事）。
   */
  async function batchAddPayments(entries: BatchPaymentEntry[]): Promise<(OrderDetail | SampleOrderDetail)[]> {
    if (!entries.length) throw bizError('没有要登记的收款：至少选一张单填金额。')
    const bankRef = String(entries[0].bankRef ?? '').trim()
    if (!bankRef) {
      throw bizError('拆分收款必须填银行流水号：这是同一笔水单拆到多张单的凭据，对账时靠它把几笔收款归成一组。')
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (String(e.bankRef ?? '').trim() !== bankRef) {
        throw bizError(`第 ${i + 1} 笔的流水号和第一笔不一致。拆分收款整批共用同一个流水号，不同的水单请分开登记。`)
      }
      if ((e.orderId == null) === (e.sampleOrderId == null)) {
        throw bizError(`第 ${i + 1} 笔没有指定单据：订单和打样单必须二选一。`)
      }
      if (!Number.isFinite(Number(e.amount)) || Number(e.amount) <= 0) {
        throw bizError(`第 ${i + 1} 笔收款金额必须是大于 0 的数。`)
      }
    }
    const results: (OrderDetail | SampleOrderDetail)[] = []
    await db.transact(async () => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const isSample = e.sampleOrderId != null
        try {
          results.push(
            isSample
              ? await samplesOf().addSamplePayment(Number(e.sampleOrderId), {
                  paidAt: e.paidAt,
                  amount: Number(e.amount),
                  method: e.method,
                  bankRef,
                  note: [String(e.note ?? '').trim() || null, `水单拆分 ${i + 1}/${entries.length}`]
                    .filter(Boolean)
                    .join('；')
                })
              : await addPayment(Number(e.orderId), {
                  paidAt: e.paidAt,
                  amount: Number(e.amount),
                  method: e.method,
                  bankRef,
                  note: [String(e.note ?? '').trim() || null, `水单拆分 ${i + 1}/${entries.length}`]
                    .filter(Boolean)
                    .join('；')
                })
          )
        } catch (err) {
          const no = isSample
            ? String(
                (await db.get('SELECT sample_no FROM sample_orders WHERE id = ?', [Number(e.sampleOrderId)]) as
                  | { sample_no?: string }
                  | null)?.sample_no ?? `#${e.sampleOrderId}`
              )
            : String(
                (await db.get('SELECT order_no FROM orders WHERE id = ?', [Number(e.orderId)]) as
                  | { order_no?: string }
                  | null)?.order_no ?? `#${e.orderId}`
              )
          throw bizError(`第 ${i + 1} 笔（${isSample ? '打样单' : '订单'} ${no}）没登进去，整批已回滚：${(err as Error).message}`)
        }
      }
    })
    return results
  }

  async function deletePayment(orderId: number, paymentId: number, reason = ''): Promise<OrderDetail> {
    // 打样单的流水也在这张表里：走错门删不掉，但得说清楚该去哪儿
    const sampleRow = await db.get(
      'SELECT s.sample_no FROM payments p JOIN sample_orders s ON s.id = p.sample_order_id WHERE p.id = ?',
      [paymentId]
    ) as { sample_no?: string } | null
    if (sampleRow) {
      throw bizError(
        `这笔收款是打样单 ${String(sampleRow.sample_no ?? '')} 的样品费流水，要在打样单的「打样费收款」里撤销（撤销要写原因）。`
      )
    }
    const row = await db.get(
      `SELECT p.paid_at, p.amount, p.bank_ref, p.created_at, o.currency, o.customer_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.id = ? AND p.order_id = ?`,
      [paymentId, orderId]
    ) as Record<string, unknown> | null
    if (!row) throw bizError('这条收款记录已经不存在了，刷新页面后再试。')
    // 作废单只许更正「作废之后」登记的回款（录错了不删就成死账）；
    // 作废前的流水是留档凭据，跟客户手里的 PI/CI 对着账，不许改写。原因必填（下方统一校验）。
    const delStatus = String(
      (await db.get('SELECT payment_status FROM orders WHERE id = ?', [orderId]) as { payment_status?: string } | null)
        ?.payment_status ?? ''
    )
    if (delStatus === 'void') {
      const voidedAt = String(
        (await db.get(
          "SELECT at FROM order_events WHERE order_id = ? AND kind = 'void' ORDER BY id DESC LIMIT 1",
          [orderId]
        ) as { at?: string } | null)?.at ?? ''
      )
      const created = String(row.created_at ?? '')
      if (!voidedAt || !created || created <= voidedAt) {
        throw bizError(
          '订单已作废：作废前的收款是留档凭据（和客户手里的 PI/CI 对着账），不能再改写。只有作废后登记的回款才允许更正。'
        )
      }
    } else {
      await assertOrderWritable(orderId, '删收款')
    }
    // 这笔钱可能已经用于短款核销/坏账追回：直接删掉，核销台账里就留着一个指向不存在流水的 payment_id
    const usedBy = await db.get(
      'SELECT kind, amount, at FROM order_settlements WHERE order_id = ? AND payment_id = ? ORDER BY id LIMIT 1',
      [orderId, paymentId]
    ) as { kind?: string; amount?: number; at?: string } | null
    if (usedBy) {
      const kind = String(usedBy.kind ?? '')
      throw bizError(
        kind === 'recovery'
          ? `这笔收款是坏账追回时自动登记的（${String(usedBy.at ?? '')}，${Number(usedBy.amount ?? 0).toFixed(2)}），和核销台账绑在一起，不能单独删除。记错了请到下面的核销记录里撤销这次追回——那会把自动登记的收款一起退掉。`
          : `这笔收款已经用于核销（${String(usedBy.at ?? '')}，${Number(usedBy.amount ?? 0).toFixed(2)}），不能直接删除：删了核销台账会指向一条不存在的流水。请先撤销对应的核销记录，再删收款。`
      )
    }
    const why = String(reason ?? '').trim()
    // 删掉的是钱到账的凭据，操作历史必须能回答「删了多少钱、哪一天、哪笔流水、为什么」
    if (!why) {
      throw bizError('删除收款要写原因（例如“金额录错”“客户退汇”），操作历史里要留痕。')
    }
    const amount = Number(row.amount ?? 0)
    const currency = String(row.currency ?? '')
    const bankRef = String(row.bank_ref ?? '')
    const paidAt = String(row.paid_at ?? '')
    const customerId = Number(row.customer_id ?? 0)
    await db.transact(async () => {
      await db.run('DELETE FROM payments WHERE id = ? AND order_id = ?', [paymentId, orderId])
      await logEvent(db, 
        orderId,
        'payment_delete',
        null,
        null,
        `删除收款 ${currency} ${amount.toFixed(2)}（${paidAt}${bankRef ? `，流水号 ${bankRef}` : ''}）原因：${why}`
      )
      await recomputePaymentStatus(orderId)
      // 作废单的钱、多收的钱都是客户预收的来源：删掉这笔流水不能把已经抵到别的单上的余额删成负数
      if (customerId) await creditsOf().assertCreditSolvent(customerId)
    })
    return (await getOrder(orderId))!
  }

  /* ---------------- 核销 / 坏账 ---------------- */



  async function listSettlements(orderId: number): Promise<Settlement[]> {
    return (
      await db.all('SELECT * FROM order_settlements WHERE order_id = ? ORDER BY at, id', [orderId]) as Record<
        string,
        unknown
      >[]
    ).map(mapSettlement)
  }

  async function settlementSums(orderId: number): Promise<{ shortage: number; badDebt: number; recovered: number }> {
    const rows = await db.all(
      `SELECT kind, COALESCE(SUM(amount), 0) AS total
       FROM order_settlements WHERE order_id = ? GROUP BY kind`,
      [orderId]
    ) as { kind?: string; total?: number }[]
    let shortage = 0
    let badDebt = 0
    let recovered = 0
    for (const r of rows) {
      const total = Number(r.total ?? 0)
      if (r.kind === 'shortage') shortage = total
      else if (r.kind === 'bad_debt') badDebt = total
      else if (r.kind === 'recovery') recovered = total
    }
    return { shortage, badDebt, recovered }
  }

  /**
   * 登记一笔核销：
   *  - shortage 短款让利：从待收里扣，也进毛利；
   *  - bad_debt 坏账：从待收里扣，报表单列，不改进货毛利；
   *  - recovery 坏账追回：钱真的到账，先落一条收款，再冲减坏账余额。
   * 都只追加；要改就撤销后重登，历史里每一步都在。
   */
  async function addSettlement(orderId: number, input: SettlementInput): Promise<OrderDetail> {
    const order = await getOrder(orderId)
    if (!order) throw notFound('订单不存在')
    const kind = input.kind
    if (kind !== 'shortage' && kind !== 'bad_debt' && kind !== 'recovery') {
      throw bizError('核销类型不对，只能是短款核销、坏账或坏账追回。')
    }
    // 核销准入就是「要不要向客户收钱」这条口径：以后加免催状态只改 billing.ts 一处。
    // 但坏账追回是例外：单作废了，欠的钱照样可能到账，不给这个门，这笔钱只能记成
    // 一张没有单据的来历不明的收款（或者根本记不进来）。短款/坏账仍按原口径挡住。
    if (!isBillingStatus(order.paymentStatus)) {
      if (kind !== 'recovery') {
        throw bizError('草稿、已失效、已作废的订单不能做核销或坏账。先把订单状态改成正式单，再处理欠款。')
      }
    }
    const reason = String(input.reason ?? '').trim()
    if (!reason) throw bizError('核销 / 坏账要写原因（例如“银行扣费”“客户破产”），操作历史要留痕。')
    const at = String(input.at ?? '').trim() || localDate()
    if (!isLocalDate(at)) throw bizError('核销日期要填完整（例如 2026-10-24）。')
    // 核销/追回和收款同一口径：钱不会在未来发生，填成未来会把月报和状态一起带偏
    if (at > localDate()) {
      throw bizError(`核销日期 ${at} 还没到。请填实际发生的日期，最晚是今天（${localDate()}）。`)
    }
    const evidence = String(input.evidence ?? '').trim()

    const sums = await settlementSums(orderId)
    const badDebtOutstanding = Math.max(0, sums.badDebt - sums.recovered)
    const currency = order.currency

    if (kind === 'recovery') {
      if (badDebtOutstanding <= 0.001) {
        throw bizError('这张单没有尚未追回的坏账，不能登记追回款；钱到账请走「记录收款」。')
      }
      const amount = Number(input.amount)
      if (!Number.isFinite(amount) || amount <= 0) throw bizError('追回金额必须是大于 0 的数。')
      if (amount > badDebtOutstanding + 0.001) {
        throw bizError(
          `追回金额 ${amount.toFixed(2)} 超过了尚未追回的坏账 ${badDebtOutstanding.toFixed(2)}；超出的部分请按普通收款登记。`
        )
      }
      const paidAt = String(input.paidAt ?? '').trim() || at
      if (!isLocalDate(paidAt)) throw bizError('追回款的到账日期要填完整（例如 2026-10-24）。')
      if (paidAt > localDate()) {
        throw bizError(
          `追回款的到账日期 ${paidAt} 还没到。请填银行水单上的实际到账日，最晚是今天（${localDate()}）。`
        )
      }
      const rate = Number(order.exchangeRate ?? 1)
      await db.transact(async () => {
        // 追回来的钱和普通收款住在同一张表里，查重就得走同一道门。
        // 少查这一次，同一张水单可以既当「追回」又当「收款」记两遍：已收翻倍、坏账冲两遍、
        // 多出来的部分还变成能退给客户的预收——R38 在前门拦掉的，别从后门放进来。
        try {
          await assertBankRefUnused({ orderId }, input.bankRef)
        } catch (err) {
          throw bizError(
            `${(err as Error).message}\n如果是这笔追回登记重了，请到下面的核销记录里撤销——撤销会把自动登记的收款一起退掉。`
          )
        }
        await db.run(
          `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, exchange_rate, created_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          [orderId, paidAt, amount, input.method ?? 'T/T', input.bankRef ?? '', `坏账追回：${reason}`, rate, now()]
        )
        const payId = Number(
          (await db.get('SELECT last_insert_rowid() AS id') as { id?: number } | null)?.id ?? 0
        )
        await db.run(
          `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          [orderId, kind, amount, reason, evidence, null, payId, at, now()]
        )
        await logEvent(db, 
          orderId,
          'settlement',
          null,
          null,
          `坏账追回 ${currency} ${amount.toFixed(2)}（${paidAt}${input.bankRef ? `，流水号 ${input.bankRef}` : ''}）原因：${reason}`
        )
        await recomputePaymentStatus(orderId)
      })
      return (await getOrder(orderId))!
    }

    const outstanding = order.remaining
    if (outstanding <= 0.001) {
      throw bizError('这张单已经没有待收了，不能核销。多收的钱请核对收款记录，不要用核销来平账。')
    }
    // 只有完全不填才按当前待收全额；填 0 或负数必须拦住，不能悄悄变成全额核销
    const amount = input.amount == null ? outstanding : Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw bizError('核销金额必须是大于 0 的数。')
    if (amount > outstanding + 0.001) {
      throw bizError(
        `核销金额 ${amount.toFixed(2)} 超过了当前待收 ${outstanding.toFixed(2)}；核销不能把单子做成多收。`
      )
    }
    const label = kind === 'shortage' ? '短款核销' : '坏账'
    await db.transact(async () => {
      await db.run(
        `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [orderId, kind, amount, reason, evidence, null, null, at, now()]
      )
      // 待收够不够这一笔，在事务里按落完账的库内余额复查一遍：
      // 事务外读到的那个待收，可能在守门和插入之间被另一笔核销/改小金额抽走。
      // 两个人各核 60%，两边都只看见自己那一笔，库里就留下一张「核销核多了」的多收单
      const after = await getOrder(orderId)
      const left = after?.remaining ?? 0
      if (left < -0.001) {
        throw bizError(
          `${label} ${amount.toFixed(2)} 落下去之后，这张单反而多出 ${(-left).toFixed(2)} ${currency}：` +
            `待收在这一瞬间被别的操作改小了（另核了一笔、或明细调小了）。请刷新后按当前待收重新核。`
        )
      }
      await logEvent(db, 
        orderId,
        'settlement',
        null,
        null,
        `${label} ${currency} ${amount.toFixed(2)}（${at}）原因：${reason}${evidence ? `；证据：${evidence}` : ''}`
      )
      await recomputePaymentStatus(orderId)
    })
    return (await getOrder(orderId))!
  }

  /** 撤销一笔核销：记一条负数并指向原记录，原记录不动 */
  async function reverseSettlement(
    orderId: number,
    settlementId: number,
    reason = ''
  ): Promise<OrderDetail> {
    const row = await db.get('SELECT * FROM order_settlements WHERE id = ? AND order_id = ?', [
      settlementId,
      orderId
    ]) as Record<string, unknown> | null
    if (!row) throw bizError('这条核销记录已经不存在了，刷新页面后再试。')
    // 作废/失效单不再拦撤销：核销是「我们把这笔钱认成收不回来」的判断，
    // 判断错了必须能退回，否则一条错误坏账跟着档案永久挂在账上。
    // 撤销只追加一条负数记录，原记录与作废档案都不动。
    const owner = await db.get('SELECT order_no FROM orders WHERE id = ?', [orderId]) as
      | { order_no?: string }
      | null
    if (!owner) throw notFound('订单不存在')
    const kind = String(row.kind) as SettlementKind
    const amount = Number(row.amount ?? 0)
    if (amount <= 0) throw bizError('这条是撤销记录，不能再撤销一次。')
    const reversed = await db.get('SELECT id FROM order_settlements WHERE reverses_id = ?', [settlementId])
    if (reversed) throw bizError('这笔核销已经撤销过了，刷新页面就能看到。')
    const why = String(reason ?? '').trim()
    if (!why) throw bizError('撤销核销要写原因，操作历史要留痕。')
    const label = SETTLEMENT_KIND_LABEL[kind] ?? kind
    const customerId = Number(
      (await db.get('SELECT customer_id FROM orders WHERE id = ?', [orderId]) as { customer_id?: number } | null)
        ?.customer_id ?? 0
    )
    // 追回登记的是「一笔自动收款 + 一条核销」，两行绑在一起：
    // 只追加负数核销，钱还留在现金流和坏账抵扣里；只删收款，核销就指向一条不存在的流水。
    // 记错客户/金额时这是唯一能退回原状的出口，两条必须同一个事务一起动。
    const payId = Number(row.payment_id ?? 0)
    await db.transact(async () => {
      if (kind === 'recovery' && payId) {
        await db.run('DELETE FROM payments WHERE id = ? AND order_id = ?', [payId, orderId])
      }
      await db.run(
        `INSERT INTO order_settlements(order_id, kind, amount, reason, evidence, reverses_id, payment_id, at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [orderId, kind, -amount, why, '', settlementId, null, localDate(), now()]
      )
      await logEvent(db, 
        orderId,
        'settlement_reverse',
        null,
        null,
        `撤销${label} ${amount.toFixed(2)}${kind === 'recovery' && payId ? '（同时删除自动登记的收款）' : ''} 原因：${why}`
      )
      await recomputePaymentStatus(orderId)
      // 撤销核销会把这单的「多收」残差缩小：客户账上已抵/已退的钱不能被架空
      if (customerId) await creditsOf().assertCreditSolvent(customerId)
    })
    return (await getOrder(orderId))!
  }

  /**
   * 收款状态自动流转（双向）：
   *  - 收款 >= 总额 → 已结清
   *  - 收款 >= 定金（且 > 0）→ 已收款
   *  - 收款 > 0 → 部分收款
   *  - 一分没收 → 客户已确认
   *
   * 金额一律取 moneyForOrders（应收口径的唯一真源），不再在这里另写一份 SUM：
   * 两套公式迟早会因为费用/核销改动而打架，首页待收和状态标签就会各说各话。
   *
   * 关键：加单 / 减单 / 改数量 / 改单价 / 删行都会重算，
   * 所以「已收款」可以退回「部分收款」，「部分收款」也能升到「已结清」。
   * 人工设定的 draft / expired / void 保持不变；sent 只在真收到钱后往上走，
   * 否则客户已付定金，工作台还会天天催「客户还没确认」。
   */
  async function recomputePaymentStatus(orderId: number): Promise<PaymentStatus> {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]) as Record<string, unknown> | null
    if (!order) throw notFound('订单不存在')
    const status = String(order.payment_status) as PaymentStatus
    // 草稿 / 已失效 / 已作废 不参与自动流转
    if (status === 'draft' || status === 'expired' || status === 'void') return status

    const money = (
      await moneyOf().moneyForOrders([{ id: orderId, charges: order.charges, depositRatio: Number(order.deposit_ratio ?? 0) }])
    ).get(orderId)!
    const total = money.grandTotal
    const paid = money.paidAmount
    // 核销过的钱不用再收：短款 + 坏账算「结清」，撤销记负数自然退回
    const writtenOff = money.netWrittenOff
    // 客户预收抵扣也是已经收到的钱（只是先收在别的单上）：它同样把这张单收齐
    const creditApplied = money.creditApplied
    const deposit = money.depositAmount

    // 注意：这里算出来的是「下一个状态」，跟当前状态无关，所以能往上走也能往下退
    let next: PaymentStatus = status
    // 有货值却被费用行抵成 0 的单（转单时抵扣恰等于货值）本来就不欠钱：以前要求 total>0
    // 才认结清，这种单会一直停在「已发出」，在途榜和催款天天追一张没有任何金额的账。
    // 空的 0 单不算——那张 PI 还没填货，客户点头才是它的事，不能被当成「钱收齐了」。
    // 负数也不算：那是费用/折扣把货值抵穿了，方向是「该退客户钱」，
    // 标成结清正好把老板最不能吃的那口假象做出来（待收界面本来就把它收在 0）。
    const offsetToZero = Math.abs(total) <= 0.001 && money.goodsValue > 0.001
    // 定金还差多少只认 depositDueOf 那一份算术（工作台待收四桶、催定金、压制尾款共用它）：
    // 以前这里只算 paid+抵扣、不算核销，短款核销把定金抵平的单会永远停在「已确认」，
    // 而同一个客户在同一屏上看到的定金桶已经是 0——一个数两张嘴。
    const depositLeft = depositDueOf(money)
    if (offsetToZero || (total > 0.001 && paid + writtenOff + creditApplied >= total - 0.001)) next = 'settled'
    else if (deposit > 0 && depositLeft <= 0.001) next = 'paid'
    else if (paid + writtenOff + creditApplied > 0) next = 'partial'
    else next = status === 'sent' ? 'sent' : 'confirmed'

    if (next !== status) {
      await db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
      await logEvent(db, 
        orderId,
        'status_auto',
        status,
        next,
        `收款状态自动流转为 ${PAYMENT_STATUS_LABEL[next as keyof typeof PAYMENT_STATUS_LABEL] ?? next}`
      )
    }
    return next
  }

  /* ---------------- 出货状态 ---------------- */

  async function setShipStatus(orderId: number, next: ShipStatus, note = ''): Promise<OrderDetail> {
    const cur = await db.get('SELECT ship_status FROM orders WHERE id = ?', [orderId]) as
      | { ship_status: string }
      | null
    if (!cur) throw notFound('订单不存在')
    await assertOrderWritable(orderId, '改出货状态')
    // 手工状态只能用这一份枚举：把「部分出运」这种派生值钉在订单上，
    // 没有批次兜底时它就永久挂着，列表和导出会显示一个本不该出现在手工位的状态
    if (!(SHIP_STATUS_ORDER as string[]).includes(next)) {
      throw bizError(
        `出货状态「${next}」不能手工设置——「部分出运」只由装箱单批次汇总得出，要让它变就得到「装箱单」里推进对应批次`
      )
    }
    // 有批次之后，整单状态只能由批次汇总，手改会跟批次打架（比如尾批还在厂里却标已签收）
    if (await isShipStatusDerived(db, orderId)) {
      throw bizError(
        `这张单的出货状态由装箱单批次汇总（当前：${SHIP_STATUS_LABEL[cur.ship_status as ShipStatus] ?? cur.ship_status}）。请到「装箱单」里改对应批次的出运状态，整单状态会自动跟着变。`
      )
    }
    await db.transact(async () => {
      // 状态和留痕必须一起落：中间断掉会变成「状态改了、历史里没有」，
      // 出货提醒的主钟（ship_status 事件）也就失去了那笔兜底时间
      await db.run('UPDATE orders SET ship_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
      await logEvent(db, orderId, 'ship_status', cur.ship_status, next, note)
    })
    return (await getOrder(orderId))!
  }

  /**
   * 这张单身上挂着哪些账和纸：退回草稿要拦、转成失效要先说清它们去哪了。
   * 两处闸门共用一份数，免得一处数了六样、另一处漏数一样。
   */
  async function orderHoldings(orderId: number): Promise<{ any: boolean; parts: string[] }> {
    const n = async (sql: string): Promise<number> =>
      Number((await db.get(sql, [orderId]) as { n?: number } | null)?.n ?? 0)
    const payCount = await n('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?')
    const settleCount = await n('SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?')
    const credit = await creditsOf().hasActiveCredit('order', orderId)
    // 纸面凭据也算账：有存档 PI/CI 或箱单的单退回草稿，系统台账里整单消失，纸却还在客户/货代手里
    const docCount = await n('SELECT COUNT(*) AS n FROM doc_versions WHERE order_id = ? AND voided_at IS NULL')
    const plCount = await n('SELECT COUNT(*) AS n FROM packing_lists WHERE order_id = ? AND voided_at IS NULL')
    const sampleCount = await n('SELECT COUNT(*) AS n FROM sample_orders WHERE converted_order_id = ?')
    const parts = [
      payCount > 0 ? `${payCount} 笔收款流水` : '',
      settleCount > 0 ? `${settleCount} 笔核销` : '',
      credit ? '客户预收抵扣' : '',
      docCount > 0 ? `${docCount} 版单据存档` : '',
      plCount > 0 ? `${plCount} 批箱单` : '',
      sampleCount > 0 ? `${sampleCount} 张转单打样抵扣` : ''
    ].filter(Boolean)
    return { any: parts.length > 0, parts }
  }

  /** 人工设置收款状态（会打断自动流转） */
  async function setPaymentStatus(orderId: number, next: PaymentStatus, note = ''): Promise<OrderDetail> {
    // 与出货状态同一套守门：非法值一旦入库，这单就从待收、月报、催款里静默消失
    if (!(next in PAYMENT_STATUS_LABEL)) {
      const allowed = Object.values(PAYMENT_STATUS_LABEL).join(' / ')
      throw bizError(`「${String(next)}」不是收款状态，请选择：${allowed}`)
    }
    const cur = await db.get('SELECT payment_status, customer_id FROM orders WHERE id = ?', [orderId]) as
      | { payment_status: string; customer_id: number }
      | null
    if (!cur) throw notFound('订单不存在')
    // 作废是留档终态：从这里改回 confirmed 就等于把一张已取消的单偷偷塞回台账和应收
    if (cur.payment_status === 'void' && next !== 'void') {
      throw bizError('这张单已作废，不能改回收款状态：作废是留档终态，要接着做生意请按新单重开。')
    }
    // 手工下拉不许直接改成「已作废」：那会绕过作废弹窗的凭据核对、作废留痕和打样抵扣回退。
    // 作废只能走「⋯ → 作废此单」，在凭据清单前勾了「凭据已核对」再作废。
    if (next === 'void') {
      throw bizError(
        '收款状态下拉不能直接改成「已作废」：作废要先核对客户手里的 PI/CI 凭据。请到「⋯」菜单里走「作废此单」。'
      )
    }
    // 同值就是没发生任何事：不早返回会重写 updated_at（把状态时钟挪后，尾款/催款提醒跟着变）、
    // 多一条「确认 → 确认」的历史事件，还会对非计费状态再跑一遍预收抵扣回退。
    if (cur.payment_status === next) return (await getOrder(orderId))!
    // 草稿不进应收、不进现金流，也不认收款状态：已经有流水/核销/预收抵扣的单退回草稿，
    // 这些账就从系统里静默消失（以前会顺手把抵扣回退掉，等于替客户把决定做了）。
    // 真不要这单请走作废：凭据核对、留痕、抵扣回退都按正门走。
    if (next === 'draft' && cur.payment_status !== 'draft') {
      const holdings = await orderHoldings(orderId)
      if (holdings.any) {
        throw bizError(
          `这张单已经有 ${holdings.parts.join('、')}，不能退回草稿：草稿不进应收和现金流，这些账会从系统里消失，纸面凭据却还在客户手里。确实不要这单，请走「⋯ → 作废此单」。`
        )
      }
    }
    // 失效同样退出应收，但它可逆、现金仍留在流水里，所以不拦，只要求把原因写下来：
    // 单子从销售额与待收里消失、预收抵扣退回客户余额——这些连带动作要有人签字，
    // 将来客户拿着这张纸来问，历史里能说清是谁点的、为什么（R49）
    let expireNote = ''
    if (next === 'expired') {
      const holdings = await orderHoldings(orderId)
      if (holdings.any) {
        if (!note.trim()) {
          throw bizError(
            `这张单上还挂着 ${holdings.parts.join('、')}：转成「已失效」后它不再计入销售额和待收，预收抵扣会退回客户余额，收款流水仍留在账上。请写明原因再转。`
          )
        }
        expireNote = `（转失效时账上还有 ${holdings.parts.join('、')}）`
      }
    }
    // 手工勾「已结清」但按流水算还欠：这单会从应收、月报、催款里整体消失，差额没人再追。
    // 所以原因必填，并把「还差多少」钉进留痕——将来对不上账，这条历史要说清点的是谁、差多少。
    // 用的就是 recomputePaymentStatus 那一份待收（grandTotal − 已收 − 净核销 − 预收抵扣），
    // 不许在这里再写一条公式：两套算术迟早一个说欠一个说不欠。
    let settleGap = ''
    if (next === 'settled') {
      const settleRow = await db.get('SELECT charges, deposit_ratio, currency FROM orders WHERE id = ?', [orderId]) as
        | { charges: string | null; deposit_ratio: number | null; currency: string }
        | null
      const money = (
        await moneyOf().moneyForOrders([
          { id: orderId, charges: settleRow?.charges, depositRatio: Number(settleRow?.deposit_ratio ?? 0) }
        ])
      ).get(orderId)!
      if (money.remaining > 0.001) {
        if (!note.trim()) {
          throw bizError(
            `这张单按流水还欠 ${money.remaining.toFixed(2)} ${settleRow?.currency ?? ''}，不能直接勾「已结清」：请先在收款/核销里把这笔做平；确实不用再收（线下收款未入账、协商免尾款…）请写明原因。`
          )
        }
        settleGap = `（按流水仍欠 ${money.remaining.toFixed(2)} ${settleRow?.currency ?? ''}）`
      }
    }
    await db.transact(async () => {
      // 改成草稿/失效就退出应收口径：抵在这张单上的客户预收无处可落，先退回余额
      if (!isBillingStatus(next)) {
        await creditsOf().reverseCreditsForTarget('order', orderId, `订单转为「${PAYMENT_STATUS_LABEL[next]}」，预收抵扣回退`)
      }
      await db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [next, now(), orderId])
      await logEvent(db, orderId, 'payment_status', cur.payment_status, next, note + settleGap + expireNote)
      // 失效单改回计费状态：预收来源从「全部到账」收回成「只有多收的部分」，
      // 已经抵出去的钱可能就多于客户实际多付的了
      if (isBillingStatus(next)) await creditsOf().assertCreditSolvent(cur.customer_id)
      // 退出应收口径期间（失效/草稿）recompute 直接返回，钱到了状态也不动：
      // 回到计费状态必须按账重算一次，否则一张早已收齐的单恢复后还顶着「已确认」，
      // 工作台继续催款、报表把它算进待收，要等下一笔流水进来才自己纠正
      if (isBillingStatus(next) && !isBillingStatus(cur.payment_status)) await recomputePaymentStatus(orderId)
    })
    return (await getOrder(orderId))!
  }

  async function listEvents(orderId: number): Promise<OrderEvent[]> {
    const rows = await db.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY at, id', [orderId]) as Record<
      string,
      unknown
    >[]
    return rows.map(mapEvent)
  }

  /* ---------------- 历史条款 / 港口 / 照片 ---------------- */

  /** 客户上一次订单用的条款，建单时直接带出来 */


  async function lastOrderTerms(customerId: number): Promise<OrderTerms | null> {
    // 只带「真做过」的单：客户取消过的那张的港口、定金不能变成下一单的默认值
    const bill = notInStatuses('payment_status', NON_BILLING_STATUSES)
    const row = await db.get(
      `SELECT * FROM orders WHERE customer_id = ? AND ${bill.sql}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [customerId, ...bill.params]
    ) as Record<string, unknown> | null
    if (!row) return null
    return {
      currency: String(row.currency) as Currency,
      exchangeRate: Number(row.exchange_rate),
      incoterm: String(row.incoterm) as Incoterm,
      portOfLoading: String(row.port_of_loading),
      portOfDestination: String(row.port_of_destination),
      paymentMethod: String(row.payment_method) as PaymentMethod,
      depositRatio: Number(row.deposit_ratio),
      customerPo: String(row.customer_po),
      orderNo: String(row.order_no),
      createdAt: String(row.created_at)
    }
  }

  /** 最近一次填过的汇率（新建订单/报价单时的参考） */
  async function lastExchangeRate(): Promise<number | null> {
    const row = await db.get(
      `SELECT exchange_rate FROM orders ORDER BY updated_at DESC, id DESC LIMIT 1`
    ) as { exchange_rate?: number } | null
    if (!row || row.exchange_rate == null) return null
    return Number(row.exchange_rate)
  }

  /**
   * 最近一次用的汇率 + 当时的锁定日期（参考值，不自动填）。
   * 按币种过滤：USD 的 7.1 抄到 EUR 单上是事故，参考值必须同币种才算数。
   */
  async function lastExchangeRateInfo(currency?: string): Promise<{ rate: number; date: string } | null> {
    // 只认真钉过汇率的单、且按钉盘日期取最近：补备注/改状态都会刷 updated_at，
    // 按 updated_at 排序会让「上次用的汇率」被一张根本没动汇率的老单带偏（甚至带成 null）
    const row = currency
      ? (await db.get(
          `SELECT exchange_rate, exchange_rate_date FROM orders
           WHERE currency = ? AND exchange_rate IS NOT NULL
           ORDER BY (exchange_rate_date IS NULL), exchange_rate_date DESC, updated_at DESC, id DESC LIMIT 1`,
          [currency]
        ) as { exchange_rate?: number; exchange_rate_date?: string | null } | null)
      : (await db.get(
          `SELECT exchange_rate, exchange_rate_date FROM orders
           WHERE exchange_rate IS NOT NULL
           ORDER BY (exchange_rate_date IS NULL), exchange_rate_date DESC, updated_at DESC, id DESC LIMIT 1`
        ) as { exchange_rate?: number; exchange_rate_date?: string | null } | null)
    if (!row || row.exchange_rate == null) return null
    return {
      rate: Number(row.exchange_rate),
      date: String(row.exchange_rate_date ?? '').slice(0, 10)
    }
  }

  /** 历史用过的港口，供自动补全 */
  async function listPorts(): Promise<{ loading: string[]; destination: string[] }> {
    const loading = (
      await db.all(
        `SELECT DISTINCT port_of_loading AS p FROM orders
         WHERE port_of_loading != '' ORDER BY port_of_loading`
      ) as Record<string, unknown>[]
    ).map((r) => String(r.p))
    const destination = (
      await db.all(
        `SELECT DISTINCT port_of_destination AS p FROM orders
         WHERE port_of_destination != '' ORDER BY port_of_destination`
      ) as Record<string, unknown>[]
    ).map((r) => String(r.p))
    return { loading, destination }
  }

  /* ---------------- 订单照片 ---------------- */

  async function listOrderPhotos(orderId: number): Promise<OrderPhoto[]> {
    const rows = await db.all('SELECT * FROM order_photos WHERE order_id = ? ORDER BY id', [orderId]) as Record<
      string,
      unknown
    >[]
    return rows.map(mapOrderPhoto)
  }

  async function addOrderPhoto(
    orderId: number,
    fileName: string,
    kind: OrderPhoto['kind'] = 'inspection',
    note = ''
  ): Promise<OrderPhoto> {
    // 照片挂在订单名下：作废/失效单已经不进货值和毛利，再往上面挂验货照会让留档看起来「这单还在走」
    await assertOrderWritable(orderId, '上传订单照片')
    const res = await db.transact(async () => {
      const r = await db.run(
        'INSERT INTO order_photos(order_id, file_name, kind, note, created_at) VALUES(?,?,?,?,?)',
        [orderId, fileName, kind, note, now()]
      )
      await logEvent(db, orderId, 'photo', null, null, `上传${kind === 'container' ? '柜照' : '验货照'}`)
      return r
    })
    const row = await db.get('SELECT * FROM order_photos WHERE id = ?', [Number(res.lastInsertRowid)]) as Record<
      string,
      unknown
    >
    return mapOrderPhoto(row)
  }

  /** 删照片记录并留痕；实物文件由桌面那层壳按返回的文件名去删（后端没有本机目录） */
  async function deleteOrderPhoto(orderId: number, photoId: number): Promise<string | null> {
    const row = await db.get('SELECT * FROM order_photos WHERE id = ? AND order_id = ?', [photoId, orderId]) as Record<
      string,
      unknown
    > | null
    if (!row) return null
    const fileName = String(row.file_name ?? '')
    // 删记录和留痕一起成败：以前 DELETE 成功了、logEvent 抛错，纸上这张照存在过、
    // 库里却没有了，日后争议查不到是谁删的
    await db.transact(async () => {
      await db.run('DELETE FROM order_photos WHERE id = ? AND order_id = ?', [photoId, orderId])
      // 验货照是出货争议时的证据，删掉必须留痕：谁、什么时候、删的是哪一张
      await logEvent(db, 
        orderId,
        'photo',
        null,
        null,
        `删除${String(row.kind) === 'container' ? '柜照' : '验货照'}${row.note ? `（${String(row.note)}）` : ''}`
      )
    })
    // 实物文件在事务提交之后由壳来删（回滚时记录还在，不能先把证据毁了）
    return fileName || null
  }

  return {
    now,
    assertOrderWritable,
    assertPricingEditable,
    sameCharges,
    daysLateOf,
    keywordClause,
    listWhere,
    listOrderIds,
    listOrders,
    listOrderRows,
    getOrder,
    hydrate,
    piNoTaken,
    piDupErr,
    partiesForOrder,
    createOrder,
    updateOrder,
    setOrderParties,
    describeOrderChange,
    voidOrder,
    deleteOrder,
    assertChargeAmounts,
    orderGoodsTotal,
    assertOrderTotalNonNegative,
    updateOrderCharges,
    negativeChargesChanged,
    describeChargeChange,
    resolveItemCost,
    assertSkuUnique,
    assertSkuListUnique,
    insertOrderItem,
    addOrderItem,
    addOrderItems,
    packedQty,
    assertNotBelowPacked,
    updateOrderItem,
    describeItemChange,
    removeOrderItem,
    replaceOrderItems,
    summarizeSkus,
    assertPaymentInput,
    assertBankRefUnused,
    addPayment,
    batchAddPayments,
    deletePayment,
    listSettlements,
    settlementSums,
    addSettlement,
    reverseSettlement,
    recomputePaymentStatus,
    setShipStatus,
    setPaymentStatus,
    listEvents,
    lastOrderTerms,
    lastExchangeRate,
    lastExchangeRateInfo,
    listPorts,
    listOrderPhotos,
    addOrderPhoto,
    deleteOrderPhoto
  }
}

/** 订单域的完整门面类型（后端服务注入自己的 Db 后得到同一形状） */
export type OrdersCore = ReturnType<typeof ordersCore>
