/**
 * 单据存档：每次出单据都在系统里留一版（文件名 + 版本号 + 金额 + 时间），
 * 这样改单前后两版 PI 能分清楚，事后查得到「发出去的是哪一版」。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { dataDir, docsDir, getDb, transact } from '../db'
import { logEvent } from './events'
import { computeOrderMoney, parseCharges } from './money'
import { ciNoOf, latestAmountPerDocNo } from '../../src/shared/documents'
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
  /** 作废时间：null = 这版仍是有效凭据。作废只摘「纸面依据」资格，记录与 PDF 一条不动 */
  voidedAt: string | null
  voidReason: string | null
}

const DOC_KINDS: DocKind[] = ['pi', 'pl', 'ci', 'quotation']
/** 单号会直接当目录名用：只允许安全字符，杜绝 ../ 和 Windows 保留字符 */
const SAFE_DOC_NO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** 订单应收口径（货值 + 费用行）：喂给 computeOrderMoney 单一真源，不在这里另写聚合 */
function orderGrandTotal(orderId: number): number {
  const db = getDb()
  const items = db.all('SELECT quantity, unit_price FROM order_items WHERE order_id = ?', [orderId]) as Record<
    string,
    unknown
  >[]
  const charges = parseCharges(
    (db.get('SELECT charges FROM orders WHERE id = ?', [orderId]) as { charges?: unknown } | null)?.charges
  )
  return computeOrderMoney({
    items: items.map((r) => ({ quantity: Number(r.quantity), unitPrice: Number(r.unit_price), unitCost: null })),
    charges,
    payments: [],
    depositRatio: 0
  }).grandTotal
}

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
  // 存档记录和「出单据」留痕在同一个事务里：提交成功但事件没写上，
  // 操作历史就丢了「这一版是什么时候出的」这条凭据
  const id = transact(() => {
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
    return Number(res.lastInsertRowid)
  })
  const row = db.get('SELECT * FROM doc_versions WHERE id = ?', [id]) as Record<string, unknown>
  return mapDocVersion(row)
}

/**
 * 作废一版存档（单据修订）：CI 金额敲错、箱数装错时，旧规则里这张存档
 * 会把批次、箱明细、单价全部钉死，唯一出口是作废整单重开。
 * 作废只摘掉「纸面金额依据」的资格：记录和 PDF 留着（纸发出去过就是事实），
 * 批次解锁、金额按当前数据重算，允许重出正确的一版。原因必填。
 */
export function voidDocVersion(versionId: number, reason = ''): DocVersion[] {
  const db = getDb()
  const why = String(reason ?? '').trim()
  if (!why) throw new Error('作废存档要写原因（例如“金额敲错一位”“箱数装错”），操作历史要留痕。')
  const row = db.get('SELECT * FROM doc_versions WHERE id = ?', [versionId]) as Record<string, unknown> | null
  if (!row) throw new Error('这一版存档已经不存在了，刷新页面后再试。')
  const v = mapDocVersion(row)
  if (v.voidedAt) throw new Error(`存档 ${v.docNo} 第 ${v.version} 版已经是作废状态，不用重复作废。`)
  // 作废重出是 CI 专用通道：批次锁定与金额钉住都只认 CI，作废 PI/箱单/报价的存档
  // 改变不了任何计算，只会污染审计口径；这些纸面要更正直接重出一版即可。
  if (v.kind !== 'ci') {
    throw new Error(
      `只有 CI 存档支持作废重出；${v.docNo} 是 ${v.kind.toUpperCase()} 存档，它不参与锁定，` +
        `作废它改变不了任何计算——纸面要更正直接重出一版即可。`
    )
  }
  if (v.orderId != null) {
    const st = String(
      (db.get('SELECT payment_status FROM orders WHERE id = ?', [v.orderId]) as { payment_status?: string } | null)
        ?.payment_status ?? ''
    )
    if (st === 'void') throw new Error('这张订单已作废，存档是留档凭据，不能再作废。')
  }
  transact(() => {
    db.run('UPDATE doc_versions SET voided_at = ?, void_reason = ? WHERE id = ?', [now(), why, versionId])
    if (v.orderId != null) {
      logEvent(
        v.orderId,
        'doc_void',
        null,
        null,
        `作废存档 ${v.docNo} 第 ${v.version} 版（金额 ${v.amount.toFixed(2)}）：${why}。批次与金额恢复按当前数据计算，可重出正确的一版。`
      )
    }
  })
  return v.orderId != null ? listDocVersions(v.orderId) : listQuotationDocVersions(v.quotationId ?? 0)
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
  /** CI 与已存档批次/整单 CI 重叠时是否已由人确认（预览弹窗勾选后带来） */
  confirmOverlap?: boolean
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
      // 文件在、库里没记录 = 上次存档在「落盘成功、记账之前」崩溃留下的孤儿：
      // 不覆盖它，每次存档都会永远撞 EEXIST，凭据链被一个孤儿文件锁死
      const orphan = !getDb().get('SELECT 1 FROM doc_versions WHERE doc_no = ? AND kind = ? AND version = ?', [
        docNo,
        kind,
        version
      ])
      if (orphan) {
        writeFileSync(absolutePath, input.pdf)
      } else {
        throw new Error(`存档文件 ${fileName} 已经存在，不能覆盖。请刷新后重新生成这一版。`)
      }
    } else {
      throw e
    }
  }

  try {
    transact(() => {
      // 落账前复查重叠：预览阶段的检查隔着秒级的 PDF 生成，两个预览并发存档会双双放行——
      // 检查与记账放进同一事务，落库的一刻不可能夹带未经确认的重叠
      if (kind === 'ci' && input.orderId != null) {
        assertCiNoOverlap(input.orderId, docNo, input.confirmOverlap === true)
      }
      recordDocVersion({
        orderId: input.orderId ?? null,
        quotationId: input.quotationId ?? null,
        docNo,
        kind,
        version,
        amount: input.amount ?? 0,
        filePath
      })
      // CI 金额与应收口径的差异留痕：报关调价是设计允许的（理由写在纸面上），
      // 收款仍按订单口径——但差异必须留在账上，事后对账才知道这不是录错
      if (kind === 'ci' && input.orderId != null && input.amount != null) {
        const diff = Number(input.amount) - orderGrandTotal(input.orderId)
        if (Math.abs(diff) > 0.005) {
          logEvent(
            input.orderId,
            'doc_amount_diff',
            null,
            null,
            `CI 存档 ${docNo} 第 ${version} 版金额 ${Number(input.amount).toFixed(2)} 与订单应收 ` +
              `${orderGrandTotal(input.orderId).toFixed(2)} 相差 ${diff.toFixed(2)}；收款仍按订单口径，差异理由应写在纸面上`
          )
        }
      }
    })
  } catch (e) {
    try {
      unlinkSync(absolutePath)
    } catch {
      /* 文件没写成功或已删，忽略 */
    }
    const msg = (e as Error).message ?? ''
    if (/UNIQUE|unique/i.test(msg)) {
      throw new Error(`单据 ${docNo} 第 ${version} 版已经存过了（可能另一窗口同时点了存档）。请刷新后核对存档列表。`)
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
    createdAt: String(r.created_at),
    voidedAt: r.voided_at == null ? null : String(r.voided_at),
    voidReason: r.void_reason == null ? null : String(r.void_reason)
  }
}

/**
 * 整单 CI 与批次 CI 重叠闸门：整单按 PI 合计开一张，批次按本批货值开一张，
 * 两张同时有效时客户手里的发票金额就打架，报关/收汇会重复申报。
 * 先整单后补批次（或反过来）都是合法顺序，所以不硬挡——但必须让人看着
 * 「重叠了多少钱」亲手确认，而不是悄悄出两张对不上的票。
 */
export function assertCiNoOverlap(orderId: number, docNo: string, confirmedOverlap = false): number {
  const db = getDb()
  const piNo = String(
    (db.get('SELECT pi_no FROM orders WHERE id = ?', [orderId]) as { pi_no?: string } | null)?.pi_no ?? ''
  ).trim()
  if (!piNo) return 0
  const base = ciNoOf(piNo)
  const rows = db.all(
    `SELECT doc_no, version, amount FROM doc_versions
     WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL`,
    [orderId]
  ) as { doc_no?: string; version?: number; amount?: number }[]
  const isWhole = docNo === base
  // 按号取最新一版相加：重版过的 CI 老版本还挂在库里，全加会把重叠金额虚报成两倍
  const amounts = latestAmountPerDocNo(
    rows.map((r) => ({ docNo: String(r.doc_no ?? ''), version: Number(r.version ?? 0), amount: Number(r.amount ?? 0) }))
  )
  const overlap = [...amounts].reduce(
    (s, [no, amt]) => s + (isWhole ? (no !== base ? amt : 0) : no === base ? amt : 0),
    0
  )
  if (overlap <= 0.005) return 0
  if (!confirmedOverlap) {
    throw new Error(
      `这张 CI 和已存档的${isWhole ? '批次' : '整单'} CI 重叠 ${overlap.toFixed(2)}：客户手里会有两张金额对不上的发票，报关和收汇可能重复申报。` +
        `确实要出，请在开票弹窗里勾选确认；要改数请先作废旧存档再重出。`
    )
  }
  return overlap
}
