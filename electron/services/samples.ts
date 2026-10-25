/**
 * 打样单（样品单）—— 下单之前的打样环节。
 *
 * 关键约定：
 *  - 打样单不参与销售额 / 毛利 / 待收款统计（它不是订单）
 *  - 但公司垫的钱（快递费、样品费）要记账，所以单独一张表、单独一个页面
 *  - 样品单号、快递单号都能查（客户来问「上次那个样品寄到哪了」）
 */
import { getDb, nextNo, transact } from '../db'
import { mapCustomer } from '../db/mappers'
import { localDate } from '../../src/shared/date'
import { assertQuantity, assertUnitPrice } from '../../src/shared/guards'
import { getSettings } from './settings'
import { createOrder, getOrder, assertSkuListUnique } from './orders'
import { logEvent } from './events'
import { costInOrderCurrency } from './money'
import { likeAny } from './search'
import type { OrderDetail } from '../../src/shared/types'
import type {
  Customer,
  SampleFeeStatus,
  SampleOrder,
  SampleOrderDetail,
  SampleOrderItem,
  SampleStatus
} from '../../src/shared/types'
import { SAMPLE_FEE_STATUS_LABEL } from '../../src/shared/types'

function now(): string {
  return new Date().toISOString()
}

/** 号尾数字 +1（手工插过数据/恢复备份导致计数器落后时，自动跳到没用过的号） */
function bumpNo(no: string): string {
  const m = no.match(/^(.*?)(\d+)$/)
  if (!m) return no + '2'
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0')
}

export interface SampleItemInput {
  productId?: number | null
  styleNo: string
  productName?: string
  composition?: string
  color?: string
  size?: string
  quantity: number
  unitPrice?: number
  /** 转单用的大货单价；不填就不能转单，绝不拿打样单价冒充 */
  goodsUnitPrice?: number | null
}

export interface SampleInput {
  id?: number
  /** N-3：样品单号可在保存时指定/修改；不填（新建）则自动编号。撞号会被拦住 */
  sampleNo?: string
  customerId: number
  sampleDate?: string
  courier?: string
  trackingNo?: string
  expressFee?: number
  status?: SampleStatus
  note?: string
  shippedAt?: string
  receivedAt?: string
  factoryCost?: number
  feeStatus?: SampleFeeStatus
  feeNote?: string
  currency?: string
  exchangeRate?: number
  exchangeRateDate?: string
  items: SampleItemInput[]
}

function mapSample(r: Record<string, unknown>): SampleOrder {
  return {
    id: Number(r.id),
    sampleNo: String(r.sample_no),
    customerId: Number(r.customer_id),
    sampleDate: String(r.sample_date ?? ''),
    courier: String(r.courier ?? ''),
    trackingNo: String(r.tracking_no ?? ''),
    expressFee: Number(r.express_fee ?? 0),
    status: String(r.status ?? 'pending') as SampleStatus,
    note: String(r.note ?? ''),
    shippedAt: String(r.shipped_at ?? ''),
    receivedAt: String(r.received_at ?? ''),
    factoryCost: Number(r.factory_cost ?? 0),
    feeStatus: String(r.fee_status ?? 'unpaid') as SampleFeeStatus,
    feeNote: String(r.fee_note ?? ''),
    offsetAmount: Number(r.offset_amount ?? 0),
    currency: String(r.currency ?? 'USD'),
    exchangeRate: Number(r.exchange_rate ?? 0),
    exchangeRateDate: String(r.exchange_rate_date ?? ''),
    convertedOrderId: r.converted_order_id == null ? null : Number(r.converted_order_id),
    convertedOrderStatus:
      r.converted_order_status == null ? null : (String(r.converted_order_status) as SampleOrder['convertedOrderStatus']),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? '')
  }
}

function mapSampleItem(r: Record<string, unknown>): SampleOrderItem {
  return {
    id: Number(r.id),
    sampleOrderId: Number(r.sample_order_id),
    productId: r.product_id == null ? null : Number(r.product_id),
    styleNo: String(r.style_no ?? ''),
    productName: String(r.product_name ?? ''),
    composition: String(r.composition ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    quantity: Number(r.quantity ?? 0),
    unitPrice: Number(r.unit_price ?? 0),
    goodsUnitPrice: r.goods_unit_price == null ? null : Number(r.goods_unit_price)
  }
}

function hydrate(s: SampleOrder): SampleOrderDetail {
  const db = getDb()
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [s.customerId]) as
    | Record<string, unknown>
    | null
  const items = (
    db.all('SELECT * FROM sample_order_items WHERE sample_order_id = ? ORDER BY id', [s.id]) as Record<
      string,
      unknown
    >[]
  ).map(mapSampleItem)
  const sampleFee = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0)
  const rate = Number(s.exchangeRate ?? 0)
  const hasRate = rate > 0
  /**
   * 列表上的金额必须同一币种，否则「净垫 130」这种数没人知道是美元还是人民币。
   * 口径按钱的来路分：
   *   工厂打样费（factoryCost）是公司自家人民币账，不参与换算；
   *   样品费、快递费都跟着打样单币种走（单据上就印在这个币种下），有汇率才 × 汇率；
   *   汇率没填 → 折不出来，一律 null（界面显示「—」，绝不拿 1 凑一个好看的数）。
   * 未收待收必须真有汇率，否则工作台少算 → rateMissing 标出来让人补。
   */
  const toBase = (v: number): number | null => (hasRate ? v * rate : null)
  const sampleFeeBase = toBase(sampleFee)
  const expressFeeBase = toBase(Number(s.expressFee ?? 0))
  const totalFeeBase =
    sampleFeeBase == null || expressFeeBase == null ? null : sampleFeeBase + expressFeeBase
  // 公司总成本（N33）= 工厂打样费（基准币）+ 快递费（折基准币）
  const companyCostBase = expressFeeBase == null ? null : Number(s.factoryCost ?? 0) + expressFeeBase
  // 已收回（N33）：paid = 客户连快递费一起付了；
  // offset = 实际抵进订单的钱（R15 起含快递费；老记录 offset_amount=0，
  // 按当时的「只抵样品费」算，不能拿新口径倒推成多收回一笔钱）
  const recoveredFee =
    s.feeStatus === 'paid'
      ? sampleFee + Number(s.expressFee ?? 0)
      : s.feeStatus === 'offset'
        ? s.offsetAmount > 0
          ? s.offsetAmount
          : sampleFee
        : 0
  const feeRecoveredBase = hasRate ? recoveredFee * rate : null
  const netAdvanceBase =
    companyCostBase == null || feeRecoveredBase == null ? null : companyCostBase - feeRecoveredBase
  // 待收（N23）：未收才计；取消的单不收钱；汇率必须有，否则工作台会少算 → 标记 rateMissing 提示补
  const cancelled = s.status === 'cancelled'
  const owed = s.feeStatus === 'unpaid' && !cancelled ? sampleFee + Number(s.expressFee ?? 0) : 0
  const rateMissing = owed > 0 && !hasRate
  return {
    ...s,
    customer: customerRow ? (mapCustomer(customerRow) as Customer) : null,
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    sampleFee,
    totalFee: sampleFee + Number(s.expressFee ?? 0),
    sampleFeeBase,
    expressFeeBase,
    totalFeeBase,
    companyCostBase,
    feeRecoveredBase,
    netAdvanceBase,
    // 待收（N23）：owed 已按 feeStatus / 取消筛过，这里只管折基准币
    receivableBase: rateMissing ? 0 : owed * rate,
    rateMissing
  }
}

export function listSamples(filter: { keyword?: string; customerId?: number; status?: string } = {}): SampleOrderDetail[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number)[] = []
  const kw = (filter.keyword ?? '').trim()
  if (kw) {
    // 样品单号 / 客户 / 快递公司 / 快递单号 / 款号 / 品名 / 颜色 都能搜
    const own = likeAny(['s.sample_no', 's.tracking_no', 's.courier', 'c.company'], kw)
    const items = likeAny(['si.style_no', 'si.product_name', 'si.color', 'si.size'], kw)
    where.push(`(${own.sql} OR EXISTS (SELECT 1 FROM sample_order_items si WHERE si.sample_order_id = s.id AND (${items.sql})))`)
    params.push(...own.params, ...items.params)
  }
  if (filter.customerId) {
    where.push('s.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.status) {
    where.push('s.status = ?')
    params.push(filter.status)
  }
  const rows = db.all(
    `SELECT s.*, o.payment_status AS converted_order_status
     FROM sample_orders s JOIN customers c ON c.id = s.customer_id
     LEFT JOIN orders o ON o.id = s.converted_order_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.created_at DESC, s.id DESC`,
    params
  ) as Record<string, unknown>[]
  return rows.map((r) => hydrate(mapSample(r)))
}

export function getSample(id: number): SampleOrderDetail | null {
  const row = getDb().get('SELECT * FROM sample_orders WHERE id = ?', [id]) as Record<string, unknown> | null
  return row ? hydrate(mapSample(row)) : null
}

/** 新建 / 修改打样单 */
export function saveSample(input: SampleInput): SampleOrderDetail {
  return transact(() => saveSampleInner(input))
}

function saveSampleInner(input: SampleInput): SampleOrderDetail {
  const db = getDb()
  const ts = now()
  // 编辑时先把旧行取出来：字段「没传」不等于「是 0 / 是空」，
  // 漏传快递费、工厂打样费、收发日期都只能保留原值，不能顺手清零
  const before = input.id
    ? ((db.get('SELECT * FROM sample_orders WHERE id = ?', [input.id]) as Record<string, unknown> | null))
    : null
  if (input.id && !before) throw new Error('打样单不存在')
  // 空白行（款号都没填）忽略；填了款号的行必须过闸门——
  // 以前 filter 直接把数量≤0 的行丢掉，用户打了一半数字保存后那一行凭空消失，
  // 既不知道少了一行，也不知道为什么少
  const itemsProvided = input.items !== undefined
  const items = (input.items ?? []).filter((i) => i.styleNo.trim())
  items.forEach((it) => {
    const who = `样品行 ${it.styleNo}`
    assertQuantity(it.quantity, `${who} 的数量`)
    // 免费样是真实业务，样品行的单价允许 0
    assertUnitPrice(it.unitPrice, `${who} 的单价`, true)
  })
  // 源头拦同款两行：不拦的话转单时脏明细会原样流进订单，把 CI 金额算乱
  if (itemsProvided) assertSkuListUnique(items, '打样单')
  // 漏传 items ≠ 清空：只改快递单号的编辑不能把样品行和样品费一起抹掉
  const storedFee = before
    ? Number(
        (
          db.get('SELECT COALESCE(SUM(quantity * unit_price), 0) AS fee FROM sample_order_items WHERE sample_order_id = ?', [
            Number(before.id)
          ]) as { fee?: number } | null
        )?.fee ?? 0
      )
    : 0
  const sampleFee = itemsProvided ? items.reduce((sum, i) => sum + i.quantity * Number(i.unitPrice ?? 0), 0) : storedFee
  const keep = (key: keyof SampleInput, col: string): unknown =>
    input[key] === undefined ? before?.[col] : input[key]
  const keepNum = (key: keyof SampleInput, col: string): number => Number(keep(key, col) ?? 0)
  const keepText = (key: keyof SampleInput, col: string): string => {
    const v = keep(key, col)
    return v == null ? '' : String(v)
  }
  const expressFee = keepNum('expressFee', 'express_fee')
  const feeStatus = (keep('feeStatus', 'fee_status') ?? 'unpaid') as SampleFeeStatus
  const exchangeRate = keepNum('exchangeRate', 'exchange_rate')
  // N23：未收的打样费要进工作台待收款，折算必须有汇率——没有就不许存（跟订单一个规矩）
  if (feeStatus === 'unpaid' && sampleFee + expressFee > 0 && exchangeRate <= 0) {
    throw new Error('这张打样单还有应收没结（样品费+快递费），请先按今天钉盘的汇率填上汇率')
  }

  let id = input.id
  const requestedNo = (input.sampleNo ?? '').trim()

  // N-3：单号是凭据，两张打样单不能共用一个号
  const noTaken = (no: string, selfId?: number): boolean => {
    const hit = selfId
      ? db.get('SELECT id FROM sample_orders WHERE sample_no = ? AND id != ?', [no, selfId])
      : db.get('SELECT id FROM sample_orders WHERE sample_no = ?', [no])
    return !!hit
  }
  const noDupErr = (no: string): Error =>
    new Error(
      `样品单号 ${no} 已经存在（可能恢复过备份或手工导过数据）。单号是凭据，不能两张单共用一个号——请在「样品单号」里换一个号再保存。`
    )

  if (id) {
    if (!before) throw new Error('打样单不存在')
    // 已转订单的打样单：钱的部分（样品费合计 / 快递费 / 汇率）是那单的依据，
    // 事后一改订单就对不上。颜色、尺码、品名这些描述性的字眼照旧能改。
    if (before.converted_order_id) {
      const o = db.get('SELECT order_no FROM orders WHERE id = ?', [Number(before.converted_order_id)]) as
        | { order_no?: string }
        | null
      const moneyChanged =
        Math.abs(storedFee - sampleFee) > 0.001 ||
        Math.abs(expressFee - Number(before.express_fee ?? 0)) > 0.001 ||
        Math.abs(exchangeRate - Number(before.exchange_rate ?? 0)) > 0.001 ||
        (input.currency !== undefined && input.currency !== String(before.currency)) ||
        (input.exchangeRateDate !== undefined &&
          input.exchangeRateDate !== String(before.exchange_rate_date ?? ''))
      if (moneyChanged) {
        throw new Error(
          `这张打样单已经转成订单 ${o?.order_no ?? ''}，样品费、快递费、汇率都是那单的依据，不能再改。要改请直接改订单。`
        )
      }
      // 客户也锁：换个人，样品费抵扣和应收就串到另一家账上
      if (input.customerId !== undefined && Number(input.customerId) !== Number(before.customer_id)) {
        throw new Error(
          `这张打样单已经转成订单 ${o?.order_no ?? ''}，客户不能再改：样品费抵扣和应收都记在这个客户名下。要改请直接改订单。`
        )
      }
      // 收款状态也锁：已收/已抵扣改成未收，同一笔钱会在待收里再收一次
      if (feeStatus !== String(before.fee_status)) {
        throw new Error(
          `这张打样单已经转成订单 ${o?.order_no ?? ''}，样品费的收款状态不能再改（现在是「${SAMPLE_FEE_STATUS_LABEL[before.fee_status as SampleFeeStatus] ?? before.fee_status}」）：它和那单的抵扣、应收是绑在一起的。`
        )
      }
    }
    // 改号时查重（不改号就不管）
    const finalNo = requestedNo || String(before.sample_no)
    if (finalNo !== String(before.sample_no) && noTaken(finalNo, id)) throw noDupErr(finalNo)
    const cells: Array<[string, unknown]> = [
      ['sample_no', finalNo],
      ['customer_id', keep('customerId', 'customer_id')],
      ['sample_date', keepText('sampleDate', 'sample_date') || localDate()],
      ['courier', keepText('courier', 'courier')],
      ['tracking_no', keepText('trackingNo', 'tracking_no')],
      ['express_fee', expressFee],
      ['status', keepText('status', 'status') || (before.status as SampleStatus)],
      ['note', keepText('note', 'note')],
      ['shipped_at', keepText('shippedAt', 'shipped_at')],
      ['received_at', keepText('receivedAt', 'received_at')],
      ['factory_cost', keepNum('factoryCost', 'factory_cost')],
      ['fee_status', feeStatus],
      ['fee_note', keepText('feeNote', 'fee_note')],
      ['currency', keepText('currency', 'currency') || 'USD'],
      ['exchange_rate', exchangeRate],
      ['exchange_rate_date', keepText('exchangeRateDate', 'exchange_rate_date')]
    ]
    db.run(
      `UPDATE sample_orders SET ${cells.map(([col]) => `${col}=?`).join(', ')}, updated_at=? WHERE id=?`,
      [...cells.map(([, v]) => v as string | number | null), ts, id]
    )
    if (itemsProvided) db.run('DELETE FROM sample_order_items WHERE sample_order_id = ?', [id])
  } else {
    let sampleNo = requestedNo
    if (!sampleNo) {
      // 自动编号：计数器落后时（手工插过数据）自动跳号，绝不生成重号
      sampleNo = nextNo('SMP')
      while (noTaken(sampleNo)) sampleNo = bumpNo(sampleNo)
    } else if (noTaken(sampleNo)) {
      // 手填的号撞了才拦：给中文报错 + 留着单号输入框让她换号
      throw noDupErr(sampleNo)
    }
    const res = db.run(
      `INSERT INTO sample_orders(sample_no, customer_id, sample_date, courier, tracking_no, express_fee, status, note,
        shipped_at, received_at, factory_cost, fee_status, fee_note, currency, exchange_rate, exchange_rate_date, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sampleNo,
        input.customerId,
        input.sampleDate ?? localDate(),
        input.courier ?? '',
        input.trackingNo ?? '',
        expressFee,
        input.status ?? 'pending',
        input.note ?? '',
        input.shippedAt ?? '',
        input.receivedAt ?? '',
        Number(input.factoryCost ?? 0),
        feeStatus,
        input.feeNote ?? '',
        input.currency ?? 'USD',
        exchangeRate,
        input.exchangeRateDate ?? '',
        ts,
        ts
      ]
    )
    id = Number(res.lastInsertRowid)
  }

  if (itemsProvided) {
    for (const it of items) {
      // 手打的款号：商品库里有就记上（以后能跟款号台账对上）
      let productId = it.productId ?? null
      if (!productId) {
        const hit = db.get('SELECT id FROM products WHERE UPPER(style_no) = UPPER(?) LIMIT 1', [
          String(it.styleNo ?? '').trim()
        ]) as { id?: number } | null
        productId = hit?.id ?? null
      }
      db.run(
        `INSERT INTO sample_order_items(sample_order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, goods_unit_price)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          productId,
          it.styleNo,
          it.productName ?? '',
          it.composition ?? '',
          it.color ?? '',
          it.size ?? '',
          it.quantity,
          Number(it.unitPrice ?? 0),
          it.goodsUnitPrice == null || Number(it.goodsUnitPrice) <= 0 ? null : Number(it.goodsUnitPrice)
        ]
      )
    }
  }
  return getSample(id)!
}

export function deleteSample(id: number): void {
  const s = getSample(id)
  if (!s) return
  if (s.convertedOrderId) {
    const o = getOrder(s.convertedOrderId)
    // 活着的订单还靠这张打样单作原始凭据；订单已作废，留档订单本身就能追溯，同意删
    if (o && o.paymentStatus !== 'void') {
      throw new Error(
        `这张打样单已经转成订单 ${o.orderNo}，删了以后就查不到原始打样记录了。确实不要了，请先作废订单，再删打样单。`
      )
    }
  }
  getDb().run('DELETE FROM sample_orders WHERE id = ?', [id])
}

/**
 * 打样转订单（N24）：客户确认样品后，款号/颜色/尺码/数量/样品单价原样带过去，
 * 数量按打样件数带（大货数量客户确认后自己改），样品费可以选择抵扣。
 */
export function convertSampleToOrder(
  id: number,
  opts: {
    /** 15=0：0=不抵扣，原价收；1=样品费从订单里扣掉（标记为下单抵扣） */
    offsetSampleFee?: boolean
    /** 转出来的订单落什么收款状态：sent = PI 现在就发 */
    paymentStatus?: 'draft' | 'sent'
  } = {}
): OrderDetail {
  const s = getSample(id)
  if (!s) throw new Error('打样单不存在')
  if (s.status === 'cancelled') throw new Error('这张打样单已取消，不能再转订单（要转请先把状态改回来）')
  if (s.convertedOrderId) {
    const exist = getOrder(s.convertedOrderId)
    // 上次转出的单还活着就复用；已经作废了要继续做生意，只能按新单重转
    if (exist && exist.paymentStatus !== 'void') return exist
  }
  const settings = getSettings()
  const currency = (s.currency || 'USD') as 'USD'
  const rate = Number(s.exchangeRate || 0)
  if (rate <= 0) {
    throw new Error('这张打样单没有汇率，请先编辑打样单填上汇率再转订单')
  }
  // 锁汇日期必须是真记下来的那一天：打样日期不是订单的锁汇日，拿它或今天顶替
  // 都会在账上留下一个查不出处的汇率
  const rateDate = s.exchangeRateDate
  if (!rateDate) {
    throw new Error('这张打样单没记汇率锁定日期。请先编辑打样单，把汇率锁定日期补上再转订单')
  }

  // 打样单价是打样费，不是大货价。没填大货单价的款号必须拦住，
  // 否则会把 15 美金/件的打样价当成大货价转出一张错三倍的 PI。
  const missingGoodsPrice = s.items.filter(
    (i) => !(Number(i.goodsUnitPrice) > 0)
  )
  if (missingGoodsPrice.length) {
    const list = missingGoodsPrice.map((i) => i.styleNo || '(未填款号)').join('、')
    throw new Error(`这些款号还没填大货单价：${list}。打样单价只是打样费，不能当大货价；请在打样单里补上大货单价再转。`)
  }

  // 转单挡：老数据里同款两行不能原样带进订单（不合并——合并会改客户确认过的价，让人回打样单自己改）
  assertSkuListUnique(s.items, '打样单')

  const customerDefaults = db_customerDefaults(s.customerId)

  // 样品费抵扣：变成订单里一条负数费用行，单据上印出来，客户对账看得懂。
  // 快递费也是公司垫的、也记在这张打样单的待收里：只抵样品费会让快递费
  // 在标记「已抵扣」后凭空消失。已收 / 已免收的没有可抵的，别再扣一遍。
  const offsetTotal =
    opts.offsetSampleFee && s.feeStatus !== 'paid' && s.feeStatus !== 'waived'
      ? s.sampleFee + Number(s.expressFee ?? 0)
      : 0
  const charges =
    offsetTotal > 0
      ? [{ label: '样品费及快递费抵扣 Sample Fee & Courier (offset)', amount: -offsetTotal }]
      : []

  const db = getDb()
  // 转单要一次做完：订单头 + 明细 + 打样单标记。中途失败就整单回滚，
  // 不留下「有订单头没明细」或「打样单标了已转、订单却是空的」半截数据
  // （createOrder 自己也开事务，这里嵌套 SAVEPOINT，回滚时两层一起退）
  return transact(() => {
    const order = createOrder({
      customerId: s.customerId,
      currency,
      exchangeRate: rate,
      exchangeRateDate: rateDate,
      baseCurrency: settings.baseCurrency as 'CNY',
      incoterm: customerDefaults.incoterm as any,
      portOfLoading: customerDefaults.portLoading,
      portOfDestination: customerDefaults.portDestination,
      paymentMethod: (customerDefaults.paymentMethod || 'tt_deposit') as any,
      depositRatio: customerDefaults.depositRatio ?? 0.3,
      note: s.note ? `由打样单 ${s.sampleNo} 转成；${s.note}` : `由打样单 ${s.sampleNo} 转成`,
      charges: charges as any,
      paymentStatus: opts.paymentStatus ?? 'draft'
    })

    for (const it of s.items) {
      let productId = it.productId
      let costBase: number | null = null
      if (productId) {
        const p = db.get('SELECT id, cost_price FROM products WHERE id = ?', [productId]) as
          | { cost_price?: number | null }
          | null
        // 商品被删过：ID 悬空就置空，别让订单明细指着一个不存在的款
        if (!p) productId = null
        else costBase = p.cost_price ?? null
      }
      // 商品成本是工厂价（基准币）：直接抄进 unit_cost 会把 ¥30 记成 $30，毛利全错
      const cost = costInOrderCurrency(costBase, rate)
      db.run(
        `INSERT INTO order_items(order_id, product_id, style_no, product_name, composition, color, size, quantity, unit_price, unit_cost)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          order.id,
          productId,
          it.styleNo,
          it.productName,
          it.composition,
          it.color,
          it.size,
          it.quantity,
          Number(it.goodsUnitPrice),
          cost
        ]
      )
    }
    db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now(), order.id])
    // 打样单标记：转过的不能再转；样品费标记为「下单抵扣」（否则以后收不回来还被忘了）
    db.run('UPDATE sample_orders SET converted_order_id = ?, updated_at = ? WHERE id = ?', [order.id, now(), id])
    if (offsetTotal > 0) {
      db.run(
        'UPDATE sample_orders SET fee_status = ?, fee_note = ?, offset_amount = ?, updated_at = ? WHERE id = ?',
        [
          'offset',
          `已抵扣到订单 ${order.orderNo}（样品费 ${s.sampleFee.toFixed(2)}${
            Number(s.expressFee ?? 0) > 0 ? ` + 快递费 ${Number(s.expressFee).toFixed(2)}` : ''
          }）`,
          offsetTotal,
          now(),
          id
        ]
      )
    }
    logEvent(
      order.id,
      'sample_convert',
      null,
      null,
      `由打样单 ${s.sampleNo} 转成订单，${
        offsetTotal > 0 ? `样品费及快递费 ${offsetTotal.toFixed(2)} 抵扣` : '样品费未抵扣'
      }`
    )
    return getOrder(order.id)!
  })
}
/** 客户档案里的默认条款（打样转订单时用） */
function db_customerDefaults(customerId: number): {
  incoterm: string
  portLoading: string
  portDestination: string
  paymentMethod: string
  depositRatio: number | null
} {
  const row = getDb().get(
    `SELECT default_incoterm, default_port_loading, default_port_destination,
            default_payment_method, default_deposit_ratio
     FROM customers WHERE id = ?`,
    [customerId]
  ) as Record<string, unknown> | null
  return {
    incoterm: String(row?.default_incoterm ?? 'FOB') || 'FOB',
    portLoading: String(row?.default_port_loading ?? ''),
    portDestination: String(row?.default_port_destination ?? ''),
    paymentMethod: String(row?.default_payment_method ?? ''),
    depositRatio: row?.default_deposit_ratio == null ? null : Number(row.default_deposit_ratio)
  }
}
