/**
 * 单据存档：每次出单据都在系统里留一版（文件名 + 版本号 + 金额 + 时间），
 * 这样改单前后两版 PI 能分清楚，事后查得到「发出去的是哪一版」。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { dataDir, docsDir, getDb } from '../db'
import { logEvent } from './events'
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

const DOC_KINDS: DocKind[] = ['pi', 'pl', 'ci', 'quotation']
/** 单号会直接当目录名用：只允许安全字符，杜绝 ../ 和 Windows 保留字符 */
const SAFE_DOC_NO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function now(): string {
  return new Date().toISOString()
}

export function assertDocNo(docNo: unknown): string {
  const v = String(docNo ?? '').trim()
  if (!SAFE_DOC_NO.test(v)) {
    throw new Error(
      `单据号「${v || '(空)'}」不能用来建存档目录：只能用字母、数字、点、下划线、短横线，且不能以符号开头。请先把单号改成正常编号。`
    )
  }
  return v
}

export function assertDocKind(kind: unknown): DocKind {
  const v = String(kind ?? '')
  if (!DOC_KINDS.includes(v as DocKind)) throw new Error(`不认识这种单据：${v || '(空)'}`)
  return v as DocKind
}

export function nextVersion(docNo: string, kind: string): number {
  const no = assertDocNo(docNo)
  const k = assertDocKind(kind)
  // 取 MAX 而不是 COUNT：删过记录或手工补过档，号也不能倒回去覆盖旧 PDF
  const row = getDb().get('SELECT MAX(version) AS v FROM doc_versions WHERE doc_no = ? AND kind = ?', [
    no,
    k
  ]) as { v?: number | null } | null
  return Number(row?.v ?? 0) + 1
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

/**
 * 把一版 PDF 落盘并记账。
 *
 * - 版本按 MAX+1 取；带 expectedVersion 时先核对纸面版次，避免「纸印第 1 版、库里第 2 版」。
 * - 文件名带 kind，PI 与 CI 同号也不会互相覆盖。
 * - 落盘用 wx（已存在即失败），数据库唯一索引兜底，失败时删掉刚写的文件。
 * - 数据库里存 data 目录相对路径，换电脑/恢复备份后仍能找到。
 */
export function saveDocFile(input: {
  pdf: Buffer
  docNo: string
  kind: string
  orderId?: number | null
  quotationId?: number | null
  amount?: number
  expectedVersion?: number
}): { filePath: string; absolutePath: string; version: number } {
  const docNo = assertDocNo(input.docNo)
  const kind = assertDocKind(input.kind)
  const version = nextVersion(docNo, kind)
  if (input.expectedVersion != null && Number(input.expectedVersion) !== version) {
    throw new Error(
      `这一版已经变了：纸面是第 ${input.expectedVersion} 版，系统现在该存第 ${version} 版。` +
        `请关掉预览重新打开再存，别把两版内容混在一起。`
    )
  }

  const dir = join(docsDir(), docNo)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const fileName = `${kind}_${docNo}_v${version}.pdf`
  const absolutePath = join(dir, fileName)
  const filePath = relative(dataDir(), absolutePath).split(sep).join('/')

  try {
    writeFileSync(absolutePath, input.pdf, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`存档文件 ${fileName} 已经存在，不能覆盖。请刷新后重新生成这一版。`)
    }
    throw e
  }

  try {
    recordDocVersion({
      orderId: input.orderId ?? null,
      quotationId: input.quotationId ?? null,
      docNo,
      kind,
      version,
      amount: input.amount ?? 0,
      filePath
    })
  } catch (e) {
    try {
      unlinkSync(absolutePath)
    } catch {
      /* 文件没写成功或已删，忽略 */
    }
    const msg = (e as Error).message ?? ''
    if (/UNIQUE|unique/i.test(msg)) {
      throw new Error(`这张单据第 ${version} 版已经存过了（可能另一窗口同时点了存档）。请刷新后再看。`)
    }
    throw e
  }
  return { filePath, absolutePath, version }
}

/** 存档里存的是相对路径；老数据是绝对路径，照样能解析（换机后按 docs 段回退） */
export function resolveDocPath(filePath: string): string {
  const raw = String(filePath ?? '').trim()
  if (!raw) throw new Error('没有文件')
  const root = dataDir()
  if (!isAbsolute(raw)) {
    const abs = resolve(root, raw)
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('单据路径不在数据目录里，已拒绝打开')
    return abs
  }
  if (existsSync(raw)) return raw
  // 老数据记的是旧机器的绝对路径：从 .../docs/ 之后接回当前数据目录
  const marker = `${sep}docs${sep}`
  const i = raw.lastIndexOf(marker)
  if (i >= 0) {
    const abs = resolve(root, raw.slice(i + 1))
    if (abs.startsWith(resolve(root, 'docs') + sep)) return abs
  }
  return raw
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
