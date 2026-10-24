/**
 * 打样单（样品单）—— 下单之前的打样环节。
 *
 * 关键约定：
 *  - 打样单不参与销售额 / 毛利 / 待收款统计（它不是订单）
 *  - 但公司垫的钱（快递费、样品费）要记账，所以单独一张表、单独一个页面
 *  - 样品单号、快递单号都能查（客户来问「上次那个样品寄到哪了」）
 */
import { getDb, nextNo } from '../db'
import { mapCustomer } from '../db/mappers'
import { localDate } from '../../src/shared/date'
import { getSettings } from './settings'
import { logEvent, createOrder, getOrder } from './orders'
import { costInOrderCurrency } from './money'
import type { OrderDetail } from '../../src/shared/types'
import type {
  Customer,
  SampleFeeStatus,
  SampleOrder,
  SampleOrderDetail,
  SampleOrderItem,
  SampleStatus
} from '../../src/shared/types'

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
    currency: String(r.currency ?? 'USD'),
    exchangeRate: Number(r.exchange_rate ?? 0),
    exchangeRateDate: String(r.exchange_rate_date ?? ''),
    convertedOrderId: r.converted_order_id == null ? null : Number(r.converted_order_id),
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
  // 公司净垫（N33）：公司总成本 = 工厂打样费 + 快递费；已收回的样品费（已收/下单抵扣）才能抵
  const companyCost = Number(s.factoryCost ?? 0) + Number(s.expressFee ?? 0)
  // 已收 = 样品费 + 快递费（客户一并付了）；下单抵扣只抵样品费，快递费仍是公司成本
  const feeRecovered =
    s.feeStatus === 'paid' ? sampleFee + s.expressFee : s.feeStatus === 'offset' ? sampleFee : 0
  // 待收（N23）：未收才计；取消的单不收钱；汇率必须有，否则工作台会少算 → 标记 rateMissing 提示补
  const cancelled = s.status === 'cancelled'
  const owed = s.feeStatus === 'unpaid' && !cancelled ? sampleFee + s.expressFee : 0
  const rateMissing = owed > 0 && Number(s.exchangeRate ?? 0) <= 0
  return {
    ...s,
    customer: customerRow ? (mapCustomer(customerRow) as Customer) : null,
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    sampleFee,
    totalFee: sampleFee + s.expressFee,
    companyCost,
    feeRecovered,
    netAdvance: companyCost - feeRecovered,
    receivableBase: rateMissing ? 0 : owed * Number(s.exchangeRate ?? 0),
    rateMissing
  }
}

export function listSamples(filter: { keyword?: string; customerId?: number; status?: string } = {}): SampleOrderDetail[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number)[] = []
  const kw = (filter.keyword ?? '').trim()
  if (kw) {
    // 样品单号 / 客户 / 快递单号 / 款号 都能搜
    where.push(
      `(s.sample_no LIKE ? OR s.tracking_no LIKE ? OR c.company LIKE ?
        OR EXISTS (SELECT 1 FROM sample_order_items si WHERE si.sample_order_id = s.id AND si.style_no LIKE ?))`
    )
    const k = `%${kw}%`
    params.push(k, k, k, k)
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
    `SELECT s.* FROM sample_orders s JOIN customers c ON c.id = s.customer_id
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
  const db = getDb()
  const ts = now()
  const items = (input.items ?? []).filter((i) => i.styleNo.trim() && i.quantity > 0)
  const sampleFee = items.reduce((sum, i) => sum + i.quantity * Number(i.unitPrice ?? 0), 0)
  const expressFee = Number(input.expressFee ?? 0)
  const feeStatus = (input.feeStatus ?? 'unpaid') as SampleFeeStatus
  const exchangeRate = Number(input.exchangeRate ?? 0)
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
    const before = db.get('SELECT * FROM sample_orders WHERE id = ?', [id]) as Record<string, unknown> | null
    if (!before) throw new Error('打样单不存在')
    // 已转订单的打样单：钱的部分（样品费合计 / 快递费 / 汇率）是那单的依据，
    // 事后一改订单就对不上。颜色、尺码、品名这些描述性的字眼照旧能改。
    if (before.converted_order_id) {
      const o = db.get('SELECT order_no FROM orders WHERE id = ?', [Number(before.converted_order_id)]) as
        | { order_no?: string }
        | null
      const oldFee = (
        db.all('SELECT quantity, unit_price FROM sample_order_items WHERE sample_order_id = ?', [id]) as Record<
          string,
          unknown
        >[]
      ).reduce((sum, r) => sum + Number(r.quantity) * Number(r.unit_price), 0)
      const moneyChanged =
        Math.abs(oldFee - sampleFee) > 0.001 ||
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
      // 已经抵扣到订单的样品费，不能再改回「未收」——否则同一笔钱收两次
      if (String(before.fee_status) === 'offset' && feeStatus !== 'offset') {
        throw new Error('这张打样单的样品费已经抵扣到订单，不能改回未收（否则同一笔钱会收两次）')
      }
    }
    // 改号时查重（不改号就不管）
    const finalNo = requestedNo || String(before.sample_no)
    if (finalNo !== String(before.sample_no) && noTaken(finalNo, id)) throw noDupErr(finalNo)
    db.run(
      `UPDATE sample_orders SET sample_no=?, customer_id=?, sample_date=?, courier=?, tracking_no=?, express_fee=?,
        status=?, note=?, shipped_at=?, received_at=?, factory_cost=?, fee_status=?, fee_note=?,
        currency=?, exchange_rate=?, exchange_rate_date=?, updated_at=? WHERE id=?`,
      [
        finalNo,
        input.customerId,
        input.sampleDate ?? localDate(),
        input.courier ?? '',
        input.trackingNo ?? '',
        expressFee,
        input.status ?? (before.status as SampleStatus),
        input.note ?? '',
        input.shippedAt ?? '',
        input.receivedAt ?? '',
        Number(input.factoryCost ?? 0),
        feeStatus,
        input.feeNote ?? '',
        input.currency ?? (before.currency as string) ?? 'USD',
        exchangeRate || Number(before.exchange_rate ?? 0),
        input.exchangeRateDate ?? (before.exchange_rate_date as string) ?? '',
        ts,
        id
      ]
    )
    db.run('DELETE FROM sample_order_items WHERE sample_order_id = ?', [id])
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
  return getSample(id)!
}

export function deleteSample(id: number): void {
  const s = getSample(id)
  if (!s) return
  if (s.convertedOrderId) {
    const o = getOrder(s.convertedOrderId)
    if (o) {
      throw new Error(`这张打样单已经转成订单 ${o.orderNo}，删了以后就查不到原始打样记录了。请先作废订单，再删打样单。`)
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
    if (exist) return exist
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

  const customerDefaults = db_customerDefaults(s.customerId)

  // 样品费抵扣：变成订单里一条负数费用行，单据上印出来，客户对账看得懂
  const charges =
    opts.offsetSampleFee && s.sampleFee > 0
      ? [{ label: '样品费抵扣 Sample Fee (offset)', amount: -s.sampleFee }]
      : []

  const db = getDb()
  // 转单要一次做完：订单头 + 明细 + 打样单标记。中途失败就整单回滚，
  // 不留下「有订单头没明细」或「打样单标了已转、订单却是空的」半截数据
  db.exec('BEGIN')
  try {
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
    if (opts.offsetSampleFee && s.sampleFee > 0) {
      db.run('UPDATE sample_orders SET fee_status = ?, fee_note = ?, updated_at = ? WHERE id = ?', [
        'offset',
        `已抵扣到订单 ${order.orderNo}`,
        now(),
        id
      ])
    }
    logEvent(
      order.id,
      'sample_convert',
      null,
      null,
      `由打样单 ${s.sampleNo} 转成订单，${
        opts.offsetSampleFee ? `样品费 ${s.sampleFee.toFixed(2)} 抵扣` : '样品费未抵扣'
      }`
    )
    db.exec('COMMIT')
    return getOrder(order.id)!
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
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
