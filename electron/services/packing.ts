import { getDb, nextNo } from '../db'
import { mapPackingList, mapPackingListLine } from '../db/mappers'
import { getSettings } from './settings'
import { logEvent } from './events'
import { applyShipStatus } from './shipping'
import { localDate, isLocalDate } from '../../src/shared/date'
import { SHIP_STATUS_LABEL, SHIP_STATUS_ORDER } from '../../src/shared/types'
import type { BatchShipStatus, PackingList, PackingListLine } from '../../src/shared/types'

const DEPARTED: BatchShipStatus[] = ['shipped', 'cleared', 'delivered']

/** 已经作废的批次：箱明细和状态都不再动，它只是留档 */
function isVoided(cur: Record<string, unknown> | null): boolean {
  return cur != null && cur.voided_at != null && String(cur.voided_at) !== ''
}

/**
 * 装箱件数的入口闸门：必须是有限正整数。
 * 库里一旦进来负数或半件，三件事同时坏：这一款的累计已装量被压低（超装反而放行）、
 * 整单状态和已出运件数跟着错、纸面箱单把负数件印给海关和客户。
 * UI 挡不住所有出口（IPC 是任何调用方都能打的），所以闸门写在这里。
 */
function assertQuantity(qty: unknown, label = '装箱数量'): void {
  const n = Number(qty)
  if (!Number.isFinite(n)) {
    throw new Error(`${label}「${String(qty)}」不是数字，请填 1 以上的整数件数`)
  }
  if (!Number.isInteger(n)) {
    throw new Error(`${label} ${n} 不是整件——服装按件装箱，半件在箱单和报关上都说不清`)
  }
  if (n <= 0) {
    throw new Error(
      `${label}必须是 1 件以上。这一箱不发了请直接删掉那一行（删到只剩一箱时请整张装箱单一起删），填 0 或负数会让这一款的已装量算错，超装也拦不住了`
    )
  }
}

/** 重量：可以空着（纸面印 est./留白），给了就必须是非负的真实数字 */
function assertWeight(v: unknown, label: string): void {
  if (v == null || v === '') return
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label}「${String(v)}」不是一个合理的公斤数（要留空就清空，不要填负数或非数字）`)
  }
}

/** 款号是箱单的锚：空款号的箱子进不了逐款守恒，也归不进任何一款 */
function assertStyleNo(styleNo: unknown): void {
  if (String(styleNo ?? '').trim() === '') {
    throw new Error('装箱明细必须有款号——没有款号的箱子上不了报关单，也算不进任何一款的已装量。请按款号×颜色×尺码分行装')
  }
}

/**
 * 这一行的毛重算「估」还是「实测」。
 * 落库时就把结论钉死，而不是打印时拿「毛重恰好等于净重×系数」去反推——
 * 反推的结果会随着毛重系数改动而翻面：去年已经出运、已经报关的箱单，
 * 今天重印一次 (est.) 标记换了位置，报关行按着复核就成了麻烦。
 * 毛重整个空着（连估算都做不出来）时返回 null：没得判，也不该判。
 */
function estFlag(gross: number | null, measured: boolean): number | null {
  if (gross == null) return null
  return measured ? 0 : 1
}

function now(): string {
  return new Date().toISOString()
}

/**
 * 分批出货的硬底线：同一个款号×颜色×尺码，累计装箱不能超过订单数量。
 * 多装出来的件数在订单里没有依据，报关、对账、收款都会对不上。
 * excludeLineId：改某一行数量时把它自己排除，免得把自己的旧值算进去。
 */
function assertNotOverPacked(
  orderId: number,
  sku: { styleNo?: string; color?: string; size?: string },
  addQty: number,
  excludeLineId?: number
): void {
  const styleNo = sku.styleNo ?? ''
  // 件数的正数/整数由 assertQuantity 在入口把关，这里只管「同款累计不能超订单量」
  if (!styleNo) return
  const db = getDb()
  const color = sku.color ?? ''
  const size = sku.size ?? ''
  const hasItems = Number(
    (db.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND quantity > 0', [orderId]) as
      | { n?: number }
      | null)?.n ?? 0
  )
  const ordered = Number(
    (
      db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS qty FROM order_items
         WHERE order_id = ? AND style_no = ? AND color = ? AND size = ?`,
        [orderId, styleNo, color, size]
      ) as { qty?: number } | null
    )?.qty ?? 0
  )
  if (ordered <= 0) {
    // 订单里有货、这一款却不在其中：多半是款号敲错或拿错了单，放进去对账就串了
    if (hasItems) {
      throw new Error(
        `订单里没有 ${styleNo} ${color}/${size} 这一款，装箱单不能凭空多出一款。请核对款号/颜色/尺码，或先到订单明细里把这一款加上；如果是升级前的老数据填错了，可以直接删掉这一行。`
      )
    }
    return
  }
  const packed = Number(
    (
      db.get(
        `SELECT COALESCE(SUM(l.quantity), 0) AS qty
         FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l.packing_list_id
         WHERE pl.order_id = ? AND pl.voided_at IS NULL
           AND l.style_no = ? AND l.color = ? AND l.size = ? AND l.id != ?`,
        [orderId, styleNo, color, size, excludeLineId ?? -1]
      ) as { qty?: number } | null
    )?.qty ?? 0
  )
  if (packed + addQty > ordered + 0.0001) {
    const room = Math.max(0, ordered - packed)
    throw new Error(
      `款号 ${styleNo} ${color}/${size}：订单 ${ordered} 件，其他箱已装 ${packed} 件，还能装 ${room} 件；这一批填了 ${addQty} 件，超了 ${
        packed + addQty - ordered
      } 件。请先核对数量。`
    )
  }
}

/**
 * 已出运的批次是给客户的凭据：箱明细一律锁住。
 * 否则把明细删空/改个款号，批次还挂着「已签收」，报关和收款就全对不上了。
 */
function assertBatchLinesEditable(orderId: number, plId: number): number {
  const db = getDb()
  const cur = db.get('SELECT pl_no, ship_status, voided_at FROM packing_lists WHERE id = ? AND order_id = ?', [
    plId,
    orderId
  ]) as Record<string, unknown> | null
  if (!cur) throw new Error('装箱单不存在')
  if (isVoided(cur)) {
    throw new Error(
      `装箱单 ${String(cur.pl_no)} 已作废，现在只是留档：箱明细不能改。要接着用这一批，请先「撤销作废」。`
    )
  }
  const status = cur.ship_status == null ? null : (String(cur.ship_status) as BatchShipStatus)
  if (status && DEPARTED.includes(status)) {
    throw new Error(
      `装箱单 ${String(cur.pl_no)} 当前状态是「${SHIP_STATUS_LABEL[status]}」，箱明细不能改——出运记录是对客户的凭据。如果确实填错了，先把批次状态改回「已包装」再改。`
    )
  }
  return Number(
    (db.get('SELECT COUNT(*) AS n FROM packing_list_lines WHERE packing_list_id = ?', [plId]) as { n?: number } | null)
      ?.n ?? 0
  )
}

export interface PackingListInput {
  orderId: number
  containerNo?: string
  note?: string
  lines: {
    boxNo?: string
    styleNo?: string
    productName?: string
    color?: string
    size?: string
    quantity: number
    netWeight?: number | null
    grossWeight?: number | null
    boxLength?: number | null
    boxWidth?: number | null
    boxHeight?: number | null
  }[]
}

export function listPackingLists(orderId: number): PackingList[] {
  const db = getDb()
  const rows = db.all('SELECT * FROM packing_lists WHERE order_id = ? ORDER BY id', [orderId]) as Record<
    string,
    unknown
  >[]
  return rows.map((r) => {
    const lines = (
      db.all('SELECT * FROM packing_list_lines WHERE packing_list_id = ? ORDER BY box_no, id', [Number(r.id)]) as Record<
        string,
        unknown
      >[]
    ).map(mapPackingListLine)
    return mapPackingList(r, lines)
  })
}

export function createPackingList(input: PackingListInput): PackingList[] {
  const db = getDb()
  if (input.lines.length === 0) throw new Error('装箱单至少要有一箱，先生成箱明细再保存')
  // 同一 SKU 可能拆成好几箱，先按 SKU 合计再校验，免得逐行放行、加起来超了
  const bySku = new Map<string, { sku: { styleNo?: string; color?: string; size?: string }; qty: number }>()
  for (const l of input.lines) {
    assertStyleNo(l.styleNo)
    assertQuantity(l.quantity)
    assertWeight(l.netWeight, '净重')
    assertWeight(l.grossWeight, '毛重')
    const key = [l.styleNo ?? '', l.color ?? '', l.size ?? ''].join('|')
    const cur = bySku.get(key) ?? { sku: l, qty: 0 }
    cur.qty += Number(l.quantity) || 0
    bySku.set(key, cur)
  }
  for (const v of bySku.values()) assertNotOverPacked(input.orderId, v.sku, v.qty)

  const plNo = nextNo('PL')
  db.exec('BEGIN')
  try {
    const res = db.run(
      `INSERT INTO packing_lists(order_id, pl_no, container_no, note, created_at, ship_status)
       VALUES(?,?,?,?,?,'packed')`,
      [input.orderId, plNo, input.containerNo ?? '', input.note ?? '', now()]
    )
    const plId = Number(res.lastInsertRowid)
    const factor = getSettings().grossWeightFactor
    for (const l of input.lines) {
      const net = l.netWeight ?? null
      // 毛重：手填优先，否则按 净重 × 系数 估算
      const gross = l.grossWeight ?? (net != null ? Number((net * factor).toFixed(2)) : null)
      db.run(
        `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity,
          net_weight, gross_weight, gross_est, box_length, box_width, box_height)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          plId,
          l.boxNo ?? '',
          l.styleNo ?? '',
          l.productName ?? '',
          l.color ?? '',
          l.size ?? '',
          l.quantity,
          net,
          gross,
          estFlag(gross, l.grossWeight != null),
          l.boxLength ?? null,
          l.boxWidth ?? null,
          l.boxHeight ?? null
        ]
      )
    }
    // 新批次一落地就要回算订单状态（装箱单 = 已包装，或者还没装够 = 备货中）
    applyShipStatus(input.orderId)
    db.exec('COMMIT')
    logEvent(input.orderId, 'pl_create', null, null, `生成装箱单 ${plNo}（${input.lines.length} 箱）`)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return listPackingLists(input.orderId)
}

export function deletePackingList(orderId: number, plId: number): PackingList[] {
  const db = getDb()
  const cur = db.get(
    'SELECT pl_no, ship_status, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
    [plId, orderId]
  ) as Record<string, unknown> | null
  if (!cur) return listPackingLists(orderId)
  if (isVoided(cur)) {
    throw new Error(
      `装箱单 ${String(cur.pl_no)} 已经作废留档了，就让它留着——纸面发过客户的单据，系统里得查得到。`
    )
  }
  const status = cur.ship_status == null ? null : (String(cur.ship_status) as BatchShipStatus)
  if (status && DEPARTED.includes(status)) {
    throw new Error(
      `装箱单 ${String(cur.pl_no)} 当前状态是「${SHIP_STATUS_LABEL[status]}」，不能删除——出运记录是对客户的凭据，必须留档。如果确实填错了，先把批次状态改回「已包装」再删，改动会留在操作历史里。`
    )
  }
  db.exec('BEGIN')
  try {
    db.run('DELETE FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId])
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  logEvent(orderId, 'pl_delete', null, null, `删除装箱单 ${String(cur.pl_no)}`)
  return listPackingLists(orderId)
}

/**
 * 批次作废：订舱被货代取消、整批发错要整体撤下——纸面箱单可能已经发到客户邮箱了，
 * 所以不能让它「消失」。记录、箱明细、PDF 存档一条不动，只是不再参与
 * 状态汇总、件数守恒和本批金额。作废不需要先把状态退回「已包装」：
 * 作废是承认这一批没走成，不是篡改出运凭据。
 */
export function voidPackingList(orderId: number, plId: number, reason = ''): PackingList[] {
  const db = getDb()
  const cur = db.get(
    'SELECT pl_no, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
    [plId, orderId]
  ) as Record<string, unknown> | null
  if (!cur) throw new Error('装箱单不存在')
  if (isVoided(cur)) throw new Error(`装箱单 ${String(cur.pl_no)} 已经是作废状态，不用重复作废`)
  db.run('UPDATE packing_lists SET voided_at = ? WHERE id = ? AND order_id = ?', [now(), plId, orderId])
  applyShipStatus(orderId)
  logEvent(
    orderId,
    'pl_void',
    null,
    null,
    `作废装箱单 ${String(cur.pl_no)}${reason ? `：${reason}` : ''}（记录与存档保留，不再参与汇总）`
  )
  return listPackingLists(orderId)
}

/** 撤销作废：点错了，或者这一批后来照常发了 */
export function unvoidPackingList(orderId: number, plId: number): PackingList[] {
  const db = getDb()
  const cur = db.get(
    'SELECT pl_no, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
    [plId, orderId]
  ) as Record<string, unknown> | null
  if (!cur) throw new Error('装箱单不存在')
  if (!isVoided(cur)) return listPackingLists(orderId)
  db.run('UPDATE packing_lists SET voided_at = NULL WHERE id = ? AND order_id = ?', [plId, orderId])
  applyShipStatus(orderId)
  logEvent(orderId, 'pl_unvoid', null, null, `撤销作废装箱单 ${String(cur.pl_no)}（重新参与状态与件数汇总）`)
  return listPackingLists(orderId)
}

export interface PackingListInfoInput {
  containerNo?: string
  vessel?: string
  etdDate?: string | null
  atdDate?: string | null
  etaDate?: string | null
  sealNo?: string
  blNo?: string
  note?: string
  shipStatus?: BatchShipStatus
  /** 这批客户实收件数：给 null 是清空（没记录 = 视同全收），0 是合法的「一件没收到」 */
  receivedQty?: number | null
  /** 纸面单据日期（可补录）：空 = 用建单当天 */
  docDate?: string | null
  /** 签收日期：客户上周签收、今天才回办公室补录时用这个，别记成「点这一下的今天」 */
  deliveredDate?: string | null
}

/** 日期字段要么留空，要么是 2026-10-05 这种本地日期；脏日期会把归月和催单时钟一起带错 */
function assertDate(v: string | null | undefined, label: string): void {
  if (v === undefined || v === null || v === '') return
  if (!isLocalDate(v)) {
    throw new Error(`${label}「${v}」不是合法日期，请用 2026-10-05 这种写法（或留空）`)
  }
}

/** 编辑批次信息：柜号/船名/船期/封条/提单号 + 出运状态 + 实收数量 + 单据日期 */
export function updatePackingListInfo(
  orderId: number,
  plId: number,
  patch: PackingListInfoInput
): PackingList[] {
  const db = getDb()
  const cur = db.get('SELECT * FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId]) as Record<
    string,
    unknown
  > | null
  if (!cur) throw new Error('装箱单不存在')
  if (isVoided(cur)) {
    throw new Error(`装箱单 ${String(cur.pl_no)} 已作废，不能改批次信息。要接着用请先「撤销作废」。`)
  }
  if (patch.shipStatus !== undefined && !SHIP_STATUS_ORDER.includes(patch.shipStatus)) {
    throw new Error('这个出货状态不能手工选，请选择「未备货 / 备货中 / 已包装 / 已出运 / 已清关 / 已签收」')
  }
  assertDate(patch.etdDate, 'ETD')
  assertDate(patch.atdDate, '实际开船日')
  assertDate(patch.etaDate, 'ETA')
  assertDate(patch.docDate, '单据日期')
  assertDate(patch.deliveredDate, '签收日期')

  const curStatus = cur.ship_status == null ? null : (String(cur.ship_status) as BatchShipStatus)
  const nextStatus = patch.shipStatus !== undefined ? patch.shipStatus : curStatus
  let deliveredAt = cur.delivered_at == null ? null : String(cur.delivered_at)
  if (nextStatus === 'delivered') {
    // 补录签收以手填日期为准；没填才记今天
    if (patch.deliveredDate !== undefined && patch.deliveredDate) deliveredAt = patch.deliveredDate
    else if (curStatus !== 'delivered') deliveredAt = localDate()
  } else if (curStatus === 'delivered') {
    deliveredAt = null
  }
  // 实收数量：NULL = 没记录（视同全收）；给了就必须是 0 以上整数，且不能超过这批装出去的件数
  let receivedQty = cur.received_qty == null ? null : Number(cur.received_qty)
  if (patch.receivedQty !== undefined) {
    if (patch.receivedQty === null || (patch.receivedQty as unknown) === '') receivedQty = null
    else {
      const n = Number(patch.receivedQty)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error(
          `实收数量「${String(patch.receivedQty)}」不是一个合理的件数（要 0 以上的整数；没和客户对上就先留空，留空等于按发数全收）`
        )
      }
      const shippedQty = Number(
        (db.get('SELECT COALESCE(SUM(quantity),0) AS q FROM packing_list_lines WHERE packing_list_id = ?', [plId]) as
          | { q?: number }
          | null)?.q ?? 0
      )
      if (n > shippedQty) {
        throw new Error(
          `这一批只装出去 ${shippedQty} 件，客户实收不可能比发出的还多 ${n - shippedQty} 件。多收是补发或发错货，请另开装箱单登记。`
        )
      }
      receivedQty = n
    }
  }

  const pick = (v: string | null | undefined, old: unknown) => (v === undefined ? String(old ?? '') : (v ?? ''))
  db.exec('BEGIN')
  try {
    db.run(
      `UPDATE packing_lists
       SET container_no = ?, vessel = ?, etd_date = ?, atd_date = ?, eta_date = ?,
           seal_no = ?, bl_no = ?, note = ?, ship_status = ?, delivered_at = ?,
           doc_date = ?, received_qty = ?
       WHERE id = ? AND order_id = ?`,
      [
        pick(patch.containerNo, cur.container_no),
        pick(patch.vessel, cur.vessel),
        pick(patch.etdDate, cur.etd_date) || null,
        pick(patch.atdDate, cur.atd_date) || null,
        pick(patch.etaDate, cur.eta_date) || null,
        pick(patch.sealNo, cur.seal_no),
        pick(patch.blNo, cur.bl_no),
        pick(patch.note, cur.note),
        nextStatus,
        deliveredAt,
        pick(patch.docDate, cur.doc_date) || null,
        receivedQty,
        plId,
        orderId
      ]
    )
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  const parts: string[] = []
  const cmp = (label: string, next: string | number | null | undefined, old: unknown) => {
    if (next === undefined) return
    if (String(next ?? '') !== String(old ?? '')) parts.push(`${label} ${old ? String(old) : '空'} → ${next || '空'}`)
  }
  cmp('柜号', patch.containerNo, cur.container_no)
  cmp('船名航次', patch.vessel, cur.vessel)
  cmp('ETD', patch.etdDate, cur.etd_date)
  cmp('实际开船', patch.atdDate, cur.atd_date)
  cmp('ETA', patch.etaDate, cur.eta_date)
  cmp('封条号', patch.sealNo, cur.seal_no)
  cmp('提单号', patch.blNo, cur.bl_no)
  cmp('单据日期', patch.docDate, cur.doc_date)
  cmp('实收数量', patch.receivedQty, cur.received_qty)
  // 签收日期只在状态是已签收时才谈得上
  if (nextStatus === 'delivered') cmp('签收日期', patch.deliveredDate, cur.delivered_at)
  if (nextStatus !== curStatus) {
    parts.push(`状态 ${curStatus ? SHIP_STATUS_LABEL[curStatus] : '未设置'} → ${nextStatus ? SHIP_STATUS_LABEL[nextStatus] : '未设置'}`)
  }
  logEvent(
    orderId,
    'pl_update',
    curStatus,
    nextStatus,
    parts.length > 0 ? `修改批次 ${String(cur.pl_no)}：${parts.join('；')}` : `修改批次 ${String(cur.pl_no)}`
  )
  return listPackingLists(orderId)
}

export function updatePackingListLine(
  orderId: number,
  plId: number,
  lineId: number,
  patch: Partial<PackingListLine>
): PackingList[] {
  const db = getDb()
  assertBatchLinesEditable(orderId, plId)
  const cur = db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
    | Record<string, unknown>
    | null
  if (!cur) throw new Error('装箱明细不存在')
  if (patch.quantity !== undefined) assertQuantity(patch.quantity, '这一箱的数量')
  if (patch.styleNo !== undefined) assertStyleNo(patch.styleNo)
  assertWeight(patch.netWeight, '净重')
  assertWeight(patch.grossWeight, '毛重')
  // 数量改动（或换了颜色/尺码）时守住订单总量：把自己这一行的旧值排除后再算
  const nextSku = {
    styleNo: patch.styleNo ?? (cur.style_no as string),
    color: patch.color ?? (cur.color as string),
    size: patch.size ?? (cur.size as string)
  }
  const skuChanged =
    nextSku.styleNo !== String(cur.style_no ?? '') ||
    nextSku.color !== String(cur.color ?? '') ||
    nextSku.size !== String(cur.size ?? '')
  if (patch.quantity !== undefined || skuChanged) {
    assertNotOverPacked(
      orderId,
      nextSku,
      Number(patch.quantity ?? cur.quantity),
      skuChanged ? undefined : lineId
    )
  }
  // 件数改了却没手工给重量：这一箱的净重/毛重按件数比例跟着改，
  // 否则单据上「30 件」旁边还挂着 60 件的重量，报关和过磅都对不上
  const oldQty = Number(cur.quantity ?? 0)
  const scale =
    patch.quantity !== undefined && oldQty > 0 && Number(patch.quantity) !== oldQty ? Number(patch.quantity) / oldQty : 1
  const scaled = (v: unknown): number | null => (v == null ? null : Number((Number(v) * scale).toFixed(2)))
  const net = patch.netWeight !== undefined ? patch.netWeight : scaled(cur.net_weight)
  const factor = getSettings().grossWeightFactor
  let gross = patch.grossWeight !== undefined ? patch.grossWeight : scaled(cur.gross_weight)
  if (patch.netWeight !== undefined && patch.grossWeight === undefined) {
    gross = net != null ? Number((net * factor).toFixed(2)) : null
  }
  // 毛重来源跟着写：手填 = 实测；只改净重（或清空毛重）= 估算；两者都没动就沿用原判定。
  // 这个标记一旦落库就不再跟着毛重系数变——老单据上 (est.) 翻面比不标更糟。
  const est =
    patch.grossWeight !== undefined
      ? estFlag(gross, patch.grossWeight != null)
      : patch.netWeight !== undefined
        ? estFlag(gross, false)
        : (cur.gross_est as number | null)
  db.exec('BEGIN')
  try {
    db.run(
      `UPDATE packing_list_lines SET box_no=?, style_no=?, product_name=?, color=?, size=?, quantity=?,
        net_weight=?, gross_weight=?, gross_est=?, box_length=?, box_width=?, box_height=?
       WHERE id=? AND packing_list_id=?`,
      [
        patch.boxNo ?? (cur.box_no as string),
        patch.styleNo ?? (cur.style_no as string),
        patch.productName ?? (cur.product_name as string),
        patch.color ?? (cur.color as string),
        patch.size ?? (cur.size as string),
        patch.quantity ?? (cur.quantity as number),
        net,
        gross,
        est,
        patch.boxLength !== undefined ? patch.boxLength : (cur.box_length as number | null),
        patch.boxWidth !== undefined ? patch.boxWidth : (cur.box_width as number | null),
        patch.boxHeight !== undefined ? patch.boxHeight : (cur.box_height as number | null),
        lineId,
        plId
      ]
    )
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // 箱数/净重被改过也要留痕（报关单跟箱单一对不上的时候要拿凭据）
  const changes = describePlLineChange(cur, scale !== 1 ? { ...patch, netWeight: net, grossWeight: gross } : patch)
  if (changes) {
    logEvent(orderId, 'pl_line_update', null, null, `修改装箱明细 ${cur.style_no} ${cur.color}/${cur.size}：${changes}`)
  }
  return listPackingLists(orderId)
}

/** 装箱明细变更说明（人话） */
function describePlLineChange(cur: Record<string, unknown>, patch: Partial<PackingListLine>): string {
  const parts: string[] = []
  const cmp = (label: string, key: string, val: unknown) => {
    if (val === undefined) return
    const old = cur[key]
    if (String(old ?? '') !== String(val ?? '')) {
      parts.push(`${label} ${old === null || old === undefined ? '空' : old} → ${val === null ? '空' : val}`)
    }
  }
  cmp('箱号', 'box_no', patch.boxNo)
  cmp('数量', 'quantity', patch.quantity)
  cmp('净重', 'net_weight', patch.netWeight)
  cmp('毛重', 'gross_weight', patch.grossWeight)
  return parts.join('；')
}

export function addPackingListLine(
  orderId: number,
  plId: number,
  line: { boxNo?: string; styleNo?: string; productName?: string; color?: string; size?: string; quantity: number }
): PackingList[] {
  const db = getDb()
  assertBatchLinesEditable(orderId, plId)
  assertStyleNo(line.styleNo)
  assertQuantity(line.quantity)
  assertNotOverPacked(orderId, line, Number(line.quantity) || 0)
  // 现场补一箱时按同批里同款的箱子带上箱规和单位净重，别让人再手敲一遍尺寸
  const twin = db.get(
    `SELECT * FROM packing_list_lines
     WHERE packing_list_id = ? AND style_no = ? AND color = ? AND size = ?
     ORDER BY id LIMIT 1`,
    [plId, line.styleNo ?? '', line.color ?? '', line.size ?? '']
  ) as Record<string, unknown> | null
  const twinQty = Number(twin?.quantity ?? 0)
  const unitNet = twin && twinQty > 0 && twin.net_weight != null ? Number(twin.net_weight) / twinQty : null
  const net = unitNet == null ? null : Number((unitNet * Number(line.quantity)).toFixed(2))
  const gross = net == null ? null : Number((net * getSettings().grossWeightFactor).toFixed(2))
  db.exec('BEGIN')
  try {
    db.run(
      `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity,
        net_weight, gross_weight, gross_est, box_length, box_width, box_height)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        plId,
        line.boxNo ?? '',
        line.styleNo ?? '',
        line.productName ?? '',
        line.color ?? '',
        line.size ?? '',
        line.quantity,
        net,
        gross,
        estFlag(gross, false),
        twin?.box_length == null ? null : Number(twin.box_length),
        twin?.box_width == null ? null : Number(twin.box_width),
        twin?.box_height == null ? null : Number(twin.box_height)
      ]
    )
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  logEvent(
    orderId,
    'pl_line_add',
    null,
    null,
    `添加装箱明细 ${line.styleNo ?? ''} ${line.color ?? ''}/${line.size ?? ''} × ${line.quantity}`
  )
  return listPackingLists(orderId)
}

export function deletePackingListLine(orderId: number, plId: number, lineId: number): PackingList[] {
  const db = getDb()
  const lineCount = assertBatchLinesEditable(orderId, plId)
  if (lineCount <= 1) {
    throw new Error('一箱都没有的装箱单留不住。如果整批作废，请直接删除这张装箱单。')
  }
  const cur = db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
    | Record<string, unknown>
    | null
  db.exec('BEGIN')
  try {
    db.run('DELETE FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId])
    applyShipStatus(orderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (cur) {
    logEvent(
      orderId,
      'pl_line_remove',
      null,
      null,
      `删除装箱明细 ${cur.style_no} ${cur.color}/${cur.size} × ${cur.quantity}`
    )
  }
  return listPackingLists(orderId)
}
