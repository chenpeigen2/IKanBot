/**
 * 单据存档：每次出单据都在系统里留一版（文件名 + 版本号 + 金额 + 时间），
 * 这样改单前后两版 PI 能分清楚，事后查得到「发出去的是哪一版」。
 */
import { getDb } from '../db'
import { logEvent } from './orders'
import type { DocKind } from '../../src/shared/types'

export interface DocVersion {
  id: number
  orderId: number | null
  quotationId: number | null
  docNo: string
  kind: DocKind
  version: number
  amount: number
  filePath: string
  createdAt: string
}

function now(): string {
  return new Date().toISOString()
}

export function nextVersion(docNo: string, kind: string): number {
  const row = getDb().get('SELECT COUNT(*) AS c FROM doc_versions WHERE doc_no = ? AND kind = ?', [
    docNo,
    kind
  ]) as { c?: number } | null
  return Number(row?.c ?? 0) + 1
}

export function recordDocVersion(input: {
  orderId?: number | null
  quotationId?: number | null
  docNo: string
  kind: DocKind
  version: number
  amount?: number
  filePath: string
}): DocVersion {
  const db = getDb()
  const res = db.run(
    `INSERT INTO doc_versions(order_id, quotation_id, doc_no, kind, version, amount, file_path, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [
      input.orderId ?? null,
      input.quotationId ?? null,
      input.docNo,
      input.kind,
      input.version,
      input.amount ?? 0,
      input.filePath,
      now()
    ]
  )
  if (input.orderId) {
    logEvent(
      input.orderId,
      'doc_export',
      null,
      null,
      `出单据 ${input.docNo} 第 ${input.version} 版（金额 ${(input.amount ?? 0).toFixed(2)}）`
    )
  }
  const row = db.get('SELECT * FROM doc_versions WHERE id = ?', [Number(res.lastInsertRowid)]) as Record<
    string,
    unknown
  >
  return mapDocVersion(row)
}

export function listDocVersions(orderId: number): DocVersion[] {
  const rows = getDb().all('SELECT * FROM doc_versions WHERE order_id = ? ORDER BY id DESC', [
    orderId
  ]) as Record<string, unknown>[]
  return rows.map(mapDocVersion)
}

export function listQuotationDocVersions(quotationId: number): DocVersion[] {
  const rows = getDb().all('SELECT * FROM doc_versions WHERE quotation_id = ? ORDER BY id DESC', [
    quotationId
  ]) as Record<string, unknown>[]
  return rows.map(mapDocVersion)
}

function mapDocVersion(r: Record<string, unknown>): DocVersion {
  return {
    id: Number(r.id),
    orderId: r.order_id == null ? null : Number(r.order_id),
    quotationId: r.quotation_id == null ? null : Number(r.quotation_id),
    docNo: String(r.doc_no),
    kind: String(r.kind) as DocKind,
    version: Number(r.version),
    amount: Number(r.amount),
    filePath: String(r.file_path),
    createdAt: String(r.created_at)
  }
}
