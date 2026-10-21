import { getDb, nextNo } from '../db'
import { mapPackingList, mapPackingListLine } from '../db/mappers'
import { getSettings } from './settings'
import { logEvent } from './orders'
import type { PackingList, PackingListLine } from '../../src/shared/types'

function now(): string {
  return new Date().toISOString()
}

export interface PackingListInput {
  id?: number
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
  const plNo = nextNo('PL')
  db.exec('BEGIN')
  try {
    const res = db.run(
      'INSERT INTO packing_lists(order_id, pl_no, container_no, note, created_at) VALUES(?,?,?,?,?)',
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
  db.run('DELETE FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId])
  logEvent(orderId, 'pl_delete', null, null, `删除装箱单 #${plId}`)
  return listPackingLists(orderId)
}

export function updatePackingListLine(
  orderId: number,
  plId: number,
  lineId: number,
  patch: Partial<PackingListLine>
): PackingList[] {
  const db = getDb()
  const cur = db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
    | Record<string, unknown>
    | null
  if (!cur) throw new Error('装箱明细不存在')
  const net = patch.netWeight !== undefined ? patch.netWeight : (cur.net_weight as number | null)
  const factor = getSettings().grossWeightFactor
  let gross = patch.grossWeight !== undefined ? patch.grossWeight : (cur.gross_weight as number | null)
  if (patch.netWeight !== undefined && patch.grossWeight === undefined) {
    gross = net != null ? Number((net * factor).toFixed(2)) : null
  }
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
  // 箱数/净重被改过也要留痕（报关单跟箱单一对不上的时候要拿凭据）
  const changes = describePlLineChange(cur, patch)
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
  db.run(
    `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity,
      net_weight, gross_weight, box_length, box_width, box_height)
     VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)`,
    [plId, line.boxNo ?? '', line.styleNo ?? '', line.productName ?? '', line.color ?? '', line.size ?? '', line.quantity]
  )
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
  const cur = db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
    | Record<string, unknown>
    | null
  db.run('DELETE FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId])
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
