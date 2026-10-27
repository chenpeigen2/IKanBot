/**
 * 打样单（样品单）—— 下单之前的打样环节。
 *
 * 关键约定：
 *  - 打样单不参与销售额 / 毛利 / 待收款统计（它不是订单）
 *  - 但公司垫的钱（快递费、样品费）要记账，所以单独一张表、单独一个页面
 *  - 样品单号、快递单号都能查（客户来问「上次那个样品寄到哪了」）
 */
import { getDb, nextNo, transact } from '../db'
import { mapCustomer, mapPayment } from '../db/mappers'
import { assertLocalDate, localDate } from '../../src/shared/date'
import { isBillingStatus } from '../../src/shared/billing'
import { assertQuantity, assertUnitPrice, assertOptionalMoney } from '../../src/shared/guards'
import { getSettings } from './settings'
import { createOrder, getOrder, assertSkuListUnique, assertPaymentInput, assertBankRefUnused } from './orders'
import { logEvent } from './events'
import { assertCreditSolvent, hasActiveCredit, reverseCreditsForTarget } from './credits'
import { costInOrderCurrency, creditAppliedForSample } from './money'
import { likeAny } from './search'
import type { OrderDetail } from '../../src/shared/types'
import type {
  Customer,
  Payment,
  PaymentStatus,
  SampleFeeStatus,
  SampleOrder,
  SampleOrderDetail,
  SampleOrderItem,
  SampleStatus
} from '../../src/shared/types'
import { PAYMENT_STATUS_LABEL, SAMPLE_FEE_STATUS_LABEL, SAMPLE_FEE_STATUS_ORDER, SAMPLE_STATUS_LABEL } from '../../src/shared/types'

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
  const totalFee = sampleFee + Number(s.expressFee ?? 0)
  const rate = Number(s.exchangeRate ?? 0)
  const hasRate = rate > 0
  // 实收流水（R25）：打样费的钱也要有凭据。抵扣不落流水，所以这里只有真金白银。
  const paidRow = db.get(
    'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS paid FROM payments WHERE sample_order_id = ?',
    [s.id]
  ) as { n?: number; paid?: number } | null
  const flowCount = Number(paidRow?.n ?? 0)
  const collected = Number(paidRow?.paid ?? 0)
  // 旧记录：当年只把旗子改成「已向客户收」，从来没落过流水。
  // 金额照全额认已收（不能凭空造一条猜日期的流水），界面标出来、月报里没有这笔。
  const legacyPaidNoFlow = s.feeStatus === 'paid' && flowCount === 0
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
  // 已收回（N33/R25）：paid = 流水收齐（旧记录无流水按全额认）；unpaid 可能有部分实收；
  // offset = 实际抵进订单的钱（R15 起含快递费；老记录 offset_amount=0 只抵样品费）；
  // waived = 免单，一分没收回
  // 抵扣挂在转出的订单上：订单退回草稿/失效/作废时，抵扣还没生效（与 money.ts 同一口径）
  const offsetSuspended =
    s.feeStatus === 'offset' && !!s.convertedOrderStatus && !isBillingStatus(s.convertedOrderStatus)
  const offsetSettled = offsetSuspended ? 0 : s.offsetAmount > 0 ? s.offsetAmount : sampleFee
  const recoveredFee =
    s.feeStatus === 'paid'
      ? legacyPaidNoFlow
        ? totalFee
        : collected
      : s.feeStatus === 'offset'
        ? // 抵扣单可能先收了部分现金（R25），已收回 = 实收 + 抵扣，别把现金那半漏掉
          collected + offsetSettled
        : s.feeStatus === 'unpaid'
          ? collected
          : 0
  const feeRecoveredBase = hasRate ? recoveredFee * rate : null
  const netAdvanceBase =
    companyCostBase == null || feeRecoveredBase == null ? null : companyCostBase - feeRecoveredBase
  // 待收（N23/R25）：未收才计；取消的单不收钱；已到的实收先抵掉，剩下的才是欠的。
  // 汇率必须有，否则工作台会少算 → 标记 rateMissing 提示补
  const cancelled = s.status === 'cancelled'
  // 预收抵扣（R27）：客户账上的钱先垫了样品费，这部分不再是待收，也不是现金
  const creditApplied = creditAppliedForSample(s.id)
  // 抵扣被挂起时，样品费重新成为待收——和 sampleOpenRows / 对账单 / 催款提醒同一份口径
  const owed =
    !cancelled && (s.feeStatus === 'unpaid' || offsetSuspended)
      ? Math.max(0, totalFee - recoveredFee - creditApplied)
      : 0
  const rateMissing = owed > 0 && !hasRate
  // 预收把这张单抵清了：fee_status 是「由流水推导」的列（抵扣不是现金，不能写成 paid），
  // 但待收已经是 0——界面必须说「已抵清」，不能挂着「未收」假装还有钱没到
  const creditSettled = !cancelled && s.feeStatus === 'unpaid' && creditApplied > 0.001 && owed <= 0.001
  return {
    ...s,
    customer: customerRow ? (mapCustomer(customerRow) as Customer) : null,
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    sampleFee,
    totalFee,
    sampleFeeBase,
    expressFeeBase,
    totalFeeBase,
    companyCostBase,
    feeRecoveredBase,
    netAdvanceBase,
    collected,
    collectedBase: toBase(collected),
    creditApplied,
    flowCount,
    legacyPaidNoFlow,
    offsetSuspended,
    // 待收（N23）：owed 已按 feeStatus / 取消筛过，这里只管折基准币
    receivableBase: rateMissing ? 0 : owed * rate,
    rateMissing,
    creditSettled
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
  const row = getDb().get(
    `SELECT s.*, o.payment_status AS converted_order_status
     FROM sample_orders s LEFT JOIN orders o ON o.id = s.converted_order_id
     WHERE s.id = ?`,
    [id]
  ) as Record<string, unknown> | null
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
  // 款号可能来自 IPC/旧数据而缺字段：先规整成字符串再 trim，别让一行脏数据把整单保存变成 TypeError
  const rawItems = (input.items ?? []).map((i) => ({ ...i, styleNo: String(i?.styleNo ?? '').trim() }))
  // 只填了数量/单价、没写款号的行不能悄悄丢掉：丢掉就是「保存成功、金额少一截」的假平安
  const blankIdx = rawItems.findIndex(
    (i) => !i.styleNo && (Number(i.quantity ?? 0) !== 0 || Number(i.unitPrice ?? 0) !== 0)
  )
  if (blankIdx >= 0) {
    throw new Error(`第 ${blankIdx + 1} 行填了数量或单价，但没写款号：这一行会被当成空行丢掉，样品费也少算。请补上款号，或把数量/单价清零。`)
  }
  const items = rawItems.filter((i) => i.styleNo)
  items.forEach((it) => {
    const who = `样品行 ${it.styleNo}`
    assertQuantity(it.quantity, `${who} 的数量`)
    // 免费样是真实业务，样品行的单价允许 0
    assertUnitPrice(it.unitPrice, `${who} 的单价`, true)
  })
  // 源头拦同款两行：不拦的话转单时脏明细会原样流进订单，把 CI 金额算乱
  if (itemsProvided) assertSkuListUnique(items, '打样单')
  // 三个日期都只记已经发生的事：催款时钟拿寄出日（没寄就退回打样日）当起点，
  // 填成未来 days 变负数，样品费提醒会从此一声不吭，待收却还挂着
  assertLocalDate(input.sampleDate, '打样日期', true)
  assertLocalDate(input.shippedAt, '寄出日期', true)
  assertLocalDate(input.receivedAt, '收到日期', true)
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
  const factoryCost = keepNum('factoryCost', 'factory_cost')
  // 工厂打样费是公司自己的成本：负数会把净垫和年度成本一起算反，乱码会落成 NaN
  assertOptionalMoney(factoryCost, '工厂打样费')
  const rawFeeStatus = keep('feeStatus', 'fee_status') ?? 'unpaid'
  // 状态是枚举列：'Paid'/'已收' 这种脏值会让待收、客户页、对账单三处各按各的理解跳单，
  // 而工作台还在催——入口一次拦死，比事后对口径便宜
  if (!SAMPLE_FEE_STATUS_ORDER.includes(rawFeeStatus as SampleFeeStatus)) {
    throw new Error(
      `打样费收款状态「${String(rawFeeStatus)}」不认识：只能是未收 / 已向客户收 / 已抵扣 / 免收。`
    )
  }
  const feeStatus = rawFeeStatus as SampleFeeStatus
  const exchangeRate = keepNum('exchangeRate', 'exchange_rate')
  // 快递费是公司垫付、向客户收回的钱：负数会把净垫与应收一起算反，
  // 乱码会整列变成 NaN；服务层拦（IPC 任何调用方都能打）
  assertOptionalMoney(expressFee, '快递费')
  // 汇率必须是真的数：0 表示还没填，负数/NaN 会让待收和净垫一起失真
  if (!Number.isFinite(exchangeRate) || exchangeRate < 0) {
    throw new Error(
      `汇率「${String(keep('exchangeRate', 'exchange_rate'))}」不是有效汇率：请填大于 0 的数字（还没定就先留空）`
    )
  }
  // N23：未收的打样费要进工作台待收款，折算必须有汇率——没有就不许存（跟订单一个规矩）
  if (feeStatus === 'unpaid' && sampleFee + expressFee > 0 && exchangeRate <= 0) {
    throw new Error('这张打样单还有应收没结（样品费+快递费），请先按今天钉盘的汇率填上汇率')
  }
  // 已登记过收款流水（R25）：钱到账的凭据已经钉住了当时的费用与汇率，
  // 事后一改，流水折出来的金额和这张单的应收就对不上。
  // 描述性的字眼（颜色/尺码/品名/快递单号）照旧能改。
  const flowAgg = before
    ? (db.get('SELECT COUNT(*) AS n FROM payments WHERE sample_order_id = ?', [Number(before.id)]) as
        | { n?: number }
        | null)
    : null
  const flowCount = Number(flowAgg?.n ?? 0)
  if (before && flowCount > 0) {
    const moneyChanged =
      Math.abs(storedFee - sampleFee) > 0.001 ||
      Math.abs(expressFee - Number(before.express_fee ?? 0)) > 0.001 ||
      Math.abs(exchangeRate - Number(before.exchange_rate ?? 0)) > 0.001 ||
      (input.currency !== undefined && input.currency !== String(before.currency)) ||
      (input.exchangeRateDate !== undefined &&
        input.exchangeRateDate !== String(before.exchange_rate_date ?? ''))
    if (moneyChanged) {
      throw new Error(
        `这张打样单已经登记过 ${flowCount} 笔收款流水：样品费、快递费、汇率是那些流水的折算依据，不能再改。要改请先在「打样费收款」里逐笔撤销，再回来改。`
      )
    }
    if (input.customerId !== undefined && Number(input.customerId) !== Number(before.customer_id)) {
      throw new Error(
        `这张打样单已经登记过收款流水，客户不能再改：流水和应收都记在这个客户名下。要改请先撤销收款。`
      )
    }
    if (feeStatus !== String(before.fee_status)) {
      throw new Error(
        `这张打样单已经登记过收款流水，收款状态由流水自动推导，不能手工改。要更正请撤销对应收款（撤销要写原因），状态会跟着回退。`
      )
    }
  }
  // 「已向客户收」也不能手工勾（R25）：它现在由流水推导。
  // 老记录本来就是 paid 的保持原样（钱当年确实收了，只是没落流水），
  // 但新单想标已收，只能去登记水单——否则待收凭空消失、月报里也没有这笔钱。
  if (
    feeStatus === 'paid' &&
    !before?.converted_order_id &&
    String(before?.fee_status ?? '') !== 'paid' &&
    sampleFee + expressFee > 0.001
  ) {
    throw new Error(
      '「已向客户收」不能手工勾：请用打样费收款里的「登记收款」按水单逐笔记，收齐后系统会自动标成已收。手勾的话这笔钱会从月报里消失。'
    )
  }
  // 「已抵扣」不是能手工勾的状态：它代表样品费真的抵进了某张订单，只有转单那一步才写
  if (feeStatus === 'offset' && (!input.id || String(before?.fee_status ?? '') !== 'offset')) {
    throw new Error(
      '「已抵扣」不能手工标记：这是样品费已经抵进某张订单的凭据，只有转订单时勾「样品费抵货款」才会自动记上。如果是真收到了钱，请选「已向客户收」。'
    )
  }
  // 客户预收已经抵到这张单上：金额/币种/汇率/客户都是那笔抵扣的依据，改了余额就对不上。
  // 只抵过预收、没落过收款流水的单，上面的流水锁不会触发，得单独锁。
  const creditLocked = before ? hasActiveCredit('sample', Number(before.id)) : false
  if (creditLocked && before) {
    const moneyChanged =
      Math.abs(storedFee - sampleFee) > 0.001 ||
      Math.abs(expressFee - Number(before.express_fee ?? 0)) > 0.001 ||
      Math.abs(exchangeRate - Number(before.exchange_rate ?? 0)) > 0.001 ||
      (input.currency !== undefined && input.currency !== String(before.currency))
    if (moneyChanged) {
      throw new Error(
        '这张打样单已经有客户预收抵到了样品费上：样品费、快递费、币种、汇率是那笔抵扣的依据，不能再改。要改请先在客户页撤销抵扣。'
      )
    }
    if (input.customerId !== undefined && Number(input.customerId) !== Number(before.customer_id)) {
      throw new Error('这张打样单已经有客户预收抵扣：换客户会让抵扣的钱串到另一家账上，请先在客户页撤销抵扣。')
    }
  }
  // 取消要留原因：这单从此不再跟，日后客户问起「那批样品呢」，只有备注这句话能交代
  if (input.status === 'cancelled' && String(before?.status ?? '') !== 'cancelled') {
    const reason = String(input.note ?? '').trim()
    if (!reason || reason === String(before?.note ?? '').trim()) {
      throw new Error('取消打样单要写原因：请在备注里补一句为什么取消（例如「客户自己打样了」「改走别的款」），再保存。')
    }
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
      const o = db.get('SELECT order_no, payment_status FROM orders WHERE id = ?', [
        Number(before.converted_order_id)
      ]) as { order_no?: string; payment_status?: string } | null
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
      // 状态同样锁：转完单又标回「已取消」，这张单就从样品台账里消失，订单却还挂着它的抵扣。
      // 订单已作废则不住拦：那单不再靠这张单作凭据，取消留原因后可以照常销档。
      if (
        o?.payment_status !== 'void' &&
        input.status !== undefined &&
        String(input.status) !== String(before.status)
      ) {
        throw new Error(
          `这张打样单已经转成订单 ${o?.order_no ?? ''}，状态不能再改（现在是「${SAMPLE_STATUS_LABEL[before.status as SampleStatus] ?? before.status}」）：转单之后它跟那单绑在一起。样品环节要收尾，请直接改订单。`
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
      ['factory_cost', factoryCost],
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
        factoryCost,
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

  // 取消/免收之后这张单不再有待收：抵在它身上的预收要退回客户余额，
  // 否则这笔钱既不在待收里、也不在余额里，两边都找不到
  const finalStatus = before ? keepText('status', 'status') || String(before.status) : String(input.status ?? 'pending')
  if (finalStatus === 'cancelled' && String(before?.status ?? '') !== 'cancelled') {
    reverseCreditsForTarget('sample', id, '打样单已取消，预收抵扣回退')
  }
  if (feeStatus === 'waived' && String(before?.fee_status ?? '') !== 'waived') {
    reverseCreditsForTarget('sample', id, '打样费改为免收，预收抵扣回退')
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
  // 任何改动都可能让这家客户的预收来源变小——改小总额、换客户、取消后恢复成在途、免单改回待收——
  // 已经抵/退出去的钱就会穿仓，所以不挑方向。assertCreditSolvent 自带「没抵扣/退款就放行」的早退，
  // 所以这里不再挑方向，改完统一复查；报错由外层事务整单回滚。
  if (before) assertCreditSolvent(Number(before.customer_id))
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
  // 预收抵扣记在这张单上：删单会让这笔余额「用到哪儿去了」失去凭据
  if (hasActiveCredit('sample', id)) {
    throw new Error(
      `这张打样单上还有未撤销的客户预收抵扣，不能删：删了这笔余额用到哪儿就查不到了。请先在客户页撤销抵扣，再删单。`
    )
  }
  // 有收款流水就不能删：删了单，银行水单上的钱在系统里就找不到来路了。
  // 撤销流水要写原因，撤销完再删（那才是「钱退了、单也不要了」的完整交代）
  if (s.flowCount > 0) {
    throw new Error(
      `这张打样单已经登记过 ${s.flowCount} 笔收款流水（实收 ${s.collected.toFixed(2)} ${s.currency}），删了钱就找不到来路。请先在「打样费收款」里逐笔撤销（撤销要写原因），再删单。`
    )
  }
  // 还挂着应收的单不能零留痕删掉：钱没收回、单也没了，账上这笔应收就凭空断线。
  // 先取消（取消要写原因），应收归零、原因入档，才允许删
  if (s.feeStatus === 'unpaid' && s.status !== 'cancelled' && s.totalFee > 0.001) {
    throw new Error(
      `这张打样单还有 ${s.totalFee.toFixed(2)} ${s.currency} 没收回（样品费+快递费）。真要销掉，请先把状态改成「已取消」并写明原因——应收会跟着归零、为什么取消也留在档案里；之后再删。`
    )
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
  // 在标记「已抵扣」后凭空消失。已免收的没有可抵的，别再扣一遍。
  // R25：一部分已经按水单收了（fee_status 仍是 unpaid），就只抵「还没收的那部分」——
  // 整笔再抵一次，同一块钱会在订单负费用行和银行流水里各算一遍。
  // 一部分已经被客户预收抵掉了：能收的现金只剩「总额 − 已收 − 已抵扣」，
  // 不扣预收就会出现「现金和预收各付一遍」的双付
  const paidAlready = s.feeStatus === 'paid' ? s.totalFee : s.collected
  const openFee =
    s.feeStatus === 'waived' ? 0 : Math.max(0, s.totalFee - paidAlready - Number(s.creditApplied ?? 0))
  const offsetTotal = opts.offsetSampleFee && openFee > 0.001 ? openFee : 0
  // 抵扣行不能大于本单货值：合计一旦为负，系统会把 −合计 误当成客户多付，
  // 凭空生成一笔可抵扣、可退真钱的预收。宁可拦下让人先处理样品费。
  const goodsValue = s.items.reduce(
    (sum, i) => sum + Number(i.quantity || 0) * Number(i.goodsUnitPrice || 0),
    0
  )
  if (offsetTotal > goodsValue + 0.001) {
    throw new Error(
      `样品费及快递费还有 ${openFee.toFixed(2)} 没收回，超过这张订单的货值 ${goodsValue.toFixed(2)}。` +
        `这样转单会让订单合计变成负数，系统会把差额误认成客户多付（能拿去抵别的单甚至退款）。` +
        `请先按水单登记部分收款、把剩余部分免收，或补足大货明细后再转。`
    )
  }
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
      // 订单备注会原样印到 PI/CI 上：只留「由打样单 X 转成」这句凭据，
      // 打样单里的自由文本（改版说明、内部提醒）进历史，不跟纸走到客户手里
      note: `由打样单 ${s.sampleNo} 转成`,
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
          }${paidAlready > 0.001 ? `；其中已按水单收 ${paidAlready.toFixed(2)}、抵扣 ${offsetTotal.toFixed(2)}` : ''}）`,
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
      }${s.note ? `；打样单备注：${s.note}` : ''}`
    )
    return getOrder(order.id)!
  })
}
/* ---------------- 打样费收款（R25） ---------------- */

export interface SamplePaymentInput {
  paidAt: string
  amount: number
  method?: string
  bankRef?: string
  note?: string
}

/** 流水说明追加进 fee_note：打样单没有操作历史表，这句话就是唯一的账本 */
function appendFeeNote(id: number, line: string): void {
  const db = getDb()
  const row = db.get('SELECT fee_note FROM sample_orders WHERE id = ?', [id]) as { fee_note?: string } | null
  const prev = String(row?.fee_note ?? '').trim()
  db.run('UPDATE sample_orders SET fee_note = ?, updated_at = ? WHERE id = ?', [
    prev ? `${prev}；${line}` : line,
    now(),
    id
  ])
}

/**
 * 收齐与否由流水推导（R25）：登记/撤销后回写 fee_status。
 * 抵扣 / 免收是人工定的终态，流水不能把它改回去。
 */
function syncSampleFeeStatus(id: number): void {
  const db = getDb()
  const row = db.get('SELECT fee_status, express_fee FROM sample_orders WHERE id = ?', [id]) as {
    fee_status?: string
    express_fee?: number
  } | null
  const cur = String(row?.fee_status ?? 'unpaid')
  if (cur === 'offset' || cur === 'waived') return
  const feeRow = db.get(
    'SELECT COALESCE(SUM(quantity * unit_price), 0) AS fee FROM sample_order_items WHERE sample_order_id = ?',
    [id]
  ) as { fee?: number } | null
  const total = Number(feeRow?.fee ?? 0) + Number(row?.express_fee ?? 0)
  const paidRow = db.get('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE sample_order_id = ?', [
    id
  ]) as { paid?: number } | null
  const collected = Number(paidRow?.paid ?? 0)
  const next = total > 0.001 && collected >= total - 0.001 ? 'paid' : 'unpaid'
  if (next !== cur) {
    db.run('UPDATE sample_orders SET fee_status = ?, updated_at = ? WHERE id = ?', [next, now(), id])
  }
}

export function listSamplePayments(sampleId: number): Payment[] {
  const rows = getDb().all(
    'SELECT * FROM payments WHERE sample_order_id = ? ORDER BY paid_at DESC, id DESC',
    [sampleId]
  ) as Record<string, unknown>[]
  return rows.map(mapPayment)
}

/**
 * 登记一笔打样费实收（R25）。只有真金白银进这张表；
 * 「下单抵扣」是订单里的负费用行，绝不在这里再落一笔（同一块钱算两遍）。
 */
export function addSamplePayment(sampleId: number, p: SamplePaymentInput): SampleOrderDetail {
  const s = getSample(sampleId)
  if (!s) throw new Error('打样单不存在')
  if (s.status === 'cancelled') {
    throw new Error(`打样单 ${s.sampleNo} 已取消：取消的单不再收钱。如果客户确实付了，请先把状态改回来（备注写明原因）再登记。`)
  }
  if (s.convertedOrderId) {
    const o = getOrder(s.convertedOrderId)
    if (o && o.paymentStatus !== 'void') {
      throw new Error(
        `这张打样单已经转成订单 ${o.orderNo}：样品费的钱请直接登记在订单上，这里只留转单前的实收。` +
          (isBillingStatus(o.paymentStatus)
            ? ''
            : `现在那张单是「${PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus}」，` +
              `样品费抵扣挂在它身上还没生效，这笔钱又回到了打样账上——先把那张订单恢复成计费状态（确认/续期）再收款，` +
              `在这里另收一笔会和抵扣重复计。`)
      )
    }
  }
  if (s.feeStatus === 'offset') {
    // 这里不开「挂起就能收」的口子：转出的订单一旦恢复计费，抵扣会自动再生效，
    // 那时这张单上又落了一笔现金，同一块钱就收了两次（应收口径也解释不了）。
    const co = s.convertedOrderId ? getOrder(s.convertedOrderId) : null
    const suspended = !!s.convertedOrderStatus && !isBillingStatus(s.convertedOrderStatus)
    throw new Error(
      `打样单 ${s.sampleNo} 的样品费已经抵扣进${co ? `订单 ${co.orderNo}` : '订单'}，这里再落一笔会重复计。` +
        (suspended
          ? `现在那张单是「${
              PAYMENT_STATUS_LABEL[s.convertedOrderStatus as PaymentStatus] ?? s.convertedOrderStatus
            }」，抵扣暂时挂起、这笔样品费又回到了待收——` +
            `要收钱先把那张订单恢复成计费状态（确认报价/延长有效期），抵扣会自动生效，钱登记在那张单上。`
          : `要改成收现金，请先撤销那笔抵扣（作废/退回那张转出订单，或按订单页的抵扣撤销通道处理），再来这里登记。`)
    )
  }
  if (s.feeStatus === 'waived') {
    throw new Error(`打样单 ${s.sampleNo} 的样品费已免收：确实收到钱的话，请先把「打样费收款标记」改回「未收」再登记。`)
  }
  if (s.feeStatus === 'paid' && s.totalFee > 0.001) {
    throw new Error(
      s.flowCount === 0
        ? `打样单 ${s.sampleNo} 是按「已向客户收」记的老账（没有流水）。要补流水，请先在编辑里把收款标记改回「未收」，再按水单登记。`
        : `打样单 ${s.sampleNo} 的样品费已经收齐（${s.collected.toFixed(2)} ${s.currency}），不能再登记：多收的钱不属于这张单。`
    )
  }
  const { paidAt, amount } = assertPaymentInput(p)
  const rate = Number(s.exchangeRate)
  if (!(rate > 0)) {
    throw new Error('这张打样单没有汇率：收款要折进月报，请先编辑打样单填上汇率再登记收款。')
  }
  const remaining = Math.max(0, s.totalFee - s.collected - Number(s.creditApplied ?? 0))
  if (amount > remaining + 0.001) {
    const creditPart =
      Number(s.creditApplied ?? 0) > 0.001 ? ` − 预收抵扣 ${Number(s.creditApplied).toFixed(2)}` : ''
    throw new Error(
      `这笔 ${amount.toFixed(2)} 超过了还没收的 ${remaining.toFixed(2)} ${s.currency}（应收 ${s.totalFee.toFixed(2)} − 已收 ${s.collected.toFixed(2)}${creditPart}）。多出来的钱不属于这张打样单，请核对水单。`
    )
  }
  transact(() => {
    assertBankRefUnused({ sampleOrderId: sampleId }, p.bankRef)
    getDb().run(
      `INSERT INTO payments(sample_order_id, paid_at, amount, method, bank_ref, note, exchange_rate, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [sampleId, paidAt, amount, p.method ?? 'T/T', p.bankRef ?? '', p.note ?? '', rate, now()]
    )
    appendFeeNote(
      sampleId,
      `登记收款 ${amount.toFixed(2)} ${s.currency}（${paidAt}${
        p.bankRef ? `，流水号 ${p.bankRef}` : `，${p.method ?? 'T/T'}`
      }）；汇率按 ${rate} 钉快照`
    )
    syncSampleFeeStatus(sampleId)
  })
  return getSample(sampleId)!
}

/**
 * 撤销一笔打样费实收：真删流水（这是录错/退汇，不是坏账），原因写进 fee_note。
 * 转单前撤销会同时把「已收齐」回退成未收，待收跟着回来。
 */
export function deleteSamplePayment(sampleId: number, paymentId: number, reason: string): SampleOrderDetail {
  const why = String(reason ?? '').trim()
  if (!why) {
    throw new Error('撤销打样收款要写原因（例如“金额录错”“客户退汇”），操作历史里要留痕。')
  }
  const s = getSample(sampleId)
  if (!s) throw new Error('打样单不存在')
  if (s.convertedOrderId) {
    const o = getOrder(s.convertedOrderId)
    if (o && o.paymentStatus !== 'void') {
      throw new Error(
        `这张打样单已经转成订单 ${o.orderNo}：转单前的实收已经参与抵扣计算，不能回头撤销。要更正请到订单里处理。`
      )
    }
  }
  const db = getDb()
  const row = db.get('SELECT paid_at, amount, bank_ref FROM payments WHERE id = ? AND sample_order_id = ?', [
    paymentId,
    sampleId
  ]) as { paid_at?: string; amount?: number; bank_ref?: string } | null
  if (!row) throw new Error('这条收款记录已经不存在了，刷新页面后再试。')
  const usedBy = db.get(
    'SELECT kind, amount, at FROM order_settlements WHERE payment_id = ? ORDER BY id LIMIT 1',
    [paymentId]
  ) as { kind?: string; amount?: number; at?: string } | null
  if (usedBy) {
    throw new Error(
      `这笔收款已经用于订单核销（${String(usedBy.at ?? '')}，${Number(usedBy.amount ?? 0).toFixed(2)}），不能直接删：请先撤销对应的核销记录。`
    )
  }
  const amount = Number(row.amount ?? 0)
  const paidAt = String(row.paid_at ?? '')
  const bankRef = String(row.bank_ref ?? '')
  transact(() => {
    db.run('DELETE FROM payments WHERE id = ? AND sample_order_id = ?', [paymentId, sampleId])
    appendFeeNote(
      sampleId,
      `撤销收款 ${amount.toFixed(2)} ${s.currency}（${paidAt}${bankRef ? `，流水号 ${bankRef}` : ''}）原因：${why}`
    )
    syncSampleFeeStatus(sampleId)
    // 取消/免收单的实收、多收的钱都是客户预收的来源：撤销不能把已抵出去的余额撤成负数
    assertCreditSolvent(s.customerId)
  })
  return getSample(sampleId)!
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
