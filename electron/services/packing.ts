import { getDb, nextNo } from '../db'
import { mapPackingList, mapPackingListLine } from '../db/mappers'
import { getSettings } from './settings'
import { logEvent } from './orders'
import { applyShipStatus } from './shipping'
import { localDate } from '../../src/shared/date'
import { SHIP_STATUS_LABEL } from '../../src/shared/types'
import type { PackingList, PackingListLine, ShipStatus } from '../../src/shared/types'

const DEPARTED: ShipStatus[] = ['shipped', 'cleared', 'delivered']
const MANUAL_SHIP_STATUSES: ShipStatus[] = ['not_prepared', 'preparing', 'packed', 'shipped', 'cleared', 'delivered']

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
  if (!styleNo || !(addQty > 0)) return
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
         WHERE pl.order_id = ? AND l.style_no = ? AND l.color = ? AND l.size = ? AND l.id != ?`,
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
  const cur = db.get('SELECT pl_no, ship_status FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId]) as
    | Record<string, unknown>
    | null
  if (!cur) throw new Error('装箱单不存在')
  const status = cur.ship_status == null ? null : (String(cur.ship_status) as ShipStatus)
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

export interface PackingListInput {  id?: number
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
          net_weight, gross_weight, box_length, box_width, box_height)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  const cur = db.get('SELECT pl_no, ship_status FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId]) as
    | Record<string, unknown>
    | null
  if (!cur) return listPackingLists(orderId)
  const status = cur.ship_status == null ? null : (String(cur.ship_status) as ShipStatus)
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

export interface PackingListInfoInput {
  containerNo?: string
  vessel?: string
  etdDate?: string | null
  atdDate?: string | null
  etaDate?: string | null
  sealNo?: string
  blNo?: string
  note?: string
  shipStatus?: ShipStatus
}

/** 编辑批次信息：柜号/船名/船期/封条/提单号 + 出运状态 */
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
  if (patch.shipStatus !== undefined && !MANUAL_SHIP_STATUSES.includes(patch.shipStatus)) {
    throw new Error('这个出货状态不能手工选，请选择「未备货 / 备货中 / 已包装 / 已出运 / 已清关 / 已签收」')
  }

  const curStatus = cur.ship_status == null ? null : (String(cur.ship_status) as ShipStatus)
  const nextStatus = patch.shipStatus !== undefined ? patch.shipStatus : curStatus
  let deliveredAt = cur.delivered_at == null ? null : String(cur.delivered_at)
  if (nextStatus === 'delivered' && curStatus !== 'delivered') deliveredAt = localDate()
  if (nextStatus !== 'delivered' && curStatus === 'delivered') deliveredAt = null

  const pick = (v: string | null | undefined, old: unknown) => (v === undefined ? String(old ?? '') : (v ?? ''))
  db.exec('BEGIN')
  try {
    db.run(
      `UPDATE packing_lists
       SET container_no = ?, vessel = ?, etd_date = ?, atd_date = ?, eta_date = ?,
           seal_no = ?, bl_no = ?, note = ?, ship_status = ?, delivered_at = ?
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
  const cmp = (label: string, next: string | null | undefined, old: unknown) => {
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
  db.exec('BEGIN')
  try {
    db.run(
      `UPDATE packing_list_lines SET box_no=?, style_no=?, product_name=?, color=?, size=?, quantity=?,
        net_weight=?, gross_weight=?, box_length=?, box_width=?, box_height=?
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
  assertNotOverPacked(orderId, line, Number(line.quantity) || 0)
  db.exec('BEGIN')
  try {
    db.run(
      `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity,
        net_weight, gross_weight, box_length, box_width, box_height)
       VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)`,
      [plId, line.boxNo ?? '', line.styleNo ?? '', line.productName ?? '', line.color ?? '', line.size ?? '', line.quantity]
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
