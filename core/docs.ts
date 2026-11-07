/**
 * 单据存档：每次出单据都在系统里留一版（文件名 + 版本号 + 金额 + 时间），
 * 这样改单前后两版 PI 能分清楚，事后查得到「发出去的是哪一版」。
 *
 * 桌面（本机 SQLite）与后端服务共用这一份判据（R60 从 electron/services/docs.ts 收编进 core）：
 * 版次只增不减、纸面指纹、CI 重叠闸门、路径守卫——两边一套账，不再各写各的 SQL。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { Db } from './db'
import { ordersCore } from './orders'
import { quotationsCore } from './quotations'
import { settingsCore } from './settings'
import { computeOrderMoney, parseCharges } from './money'
import { logEvent } from './events'
import { assertDocNo } from '../src/shared/guards'
import { bizError, notFound } from '../src/shared/errors'
import { ciNoOf, latestAmountPerDocNo } from '../src/shared/documents'
import { docPageFingerprint, stalePageMessage } from '../src/shared/docFingerprint'
import type { DocKind } from '../src/shared/types'

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

/** 存档根目录的取法：桌面指向数据目录，服务端指向自己的数据目录（库文件旁边） */
export interface DocsDirs {
  dataDir(): string
  docsDir(): string
}

function now(): string {
  return new Date().toISOString()
}

export function assertDocKind(kind: unknown): DocKind {
  const v = String(kind ?? '')
  if (!DOC_KINDS.includes(v as DocKind)) throw bizError(`不认识这种单据：${v || '(空)'}`)
  return v as DocKind
}

/**
 * 同一「单号 + 单据类型」的存档排队走，一笔完了才轮下一笔。
 *
 * 为什么必须串行：版本号是 MAX+1 在事务外算的，文件先落盘、记录后进库。
 * 两个预览并发点同一张 PI 时，两边都算出 v3——后写的一方 wx 撞 EEXIST，
 * 查库看到「还没记账」判成孤儿直接覆盖，然后自己的记账撞唯一索引失败，
 * 回滚时一 unlink，把前一笔已经记进库的那份 PDF 删了。
 * 纸面和库里对不上、且不报错，事后退税查证时手里是空的。
 * 分键排队（而不是全局一把锁）：给 A 单存档不该把 B 单也堵住。
 * 队列挂在模块级：桌面与后端各有一份进程，同一进程内所有 docsCore 实例共用一条线。
 */
const saveQueue = new Map<string, Promise<void>>()

function serializeDocSave<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = saveQueue.get(key) ?? Promise.resolve()
  // 前一笔无论成败都要接上，不能让一次失败把这条线卡死
  const task = prev.then(run, run)
  const tail = task.then(
    () => undefined,
    () => undefined
  )
  saveQueue.set(key, tail)
  void tail.then(() => {
    if (saveQueue.get(key) === tail) saveQueue.delete(key)
  })
  return task
}

export function docsCore(db: Db, dirs: DocsDirs) {
  const orders = ordersCore(db)
  const quotations = quotationsCore(db)

  /** 订单应收口径（货值 + 费用行）：喂给 computeOrderMoney 单一真源，不在这里另写聚合 */
  async function orderGrandTotal(orderId: number): Promise<number> {
    const items = (await db.all('SELECT quantity, unit_price FROM order_items WHERE order_id = ?', [
      orderId
    ])) as Record<string, unknown>[]
    const charges = parseCharges(
      ((await db.get('SELECT charges FROM orders WHERE id = ?', [orderId])) as { charges?: unknown } | undefined)
        ?.charges
    )
    return computeOrderMoney({
      items: items.map((r) => ({ quantity: Number(r.quantity), unitPrice: Number(r.unit_price), unitCost: null })),
      charges,
      payments: [],
      depositRatio: 0
    }).grandTotal
  }

  async function nextVersion(docNo: string, kind: string): Promise<number> {
    const no = assertDocNo(docNo)
    const k = assertDocKind(kind)
    // 取 MAX 而不是 COUNT：删过记录或手工补过档，号也不能倒回去覆盖旧 PDF
    const row = (await db.get('SELECT MAX(version) AS v FROM doc_versions WHERE doc_no = ? AND kind = ?', [
      no,
      k
    ])) as { v?: number | null } | undefined
    return Number(row?.v ?? 0) + 1
  }

  async function recordDocVersion(input: {
    orderId?: number | null
    quotationId?: number | null
    docNo: string
    kind: DocKind
    version: number
    amount?: number
    filePath: string
  }): Promise<DocVersion> {
    // 存档记录和「出单据」留痕在同一个事务里：提交成功但事件没写上，
    // 操作历史就丢了「这一版是什么时候出的」这条凭据
    const id = await db.transact(async () => {
      const res = await db.run(
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
        await logEvent(
          db,
          input.orderId,
          'doc_export',
          null,
          null,
          `出单据 ${input.docNo} 第 ${input.version} 版（金额 ${(input.amount ?? 0).toFixed(2)}）`
        )
      }
      return Number(res.lastInsertRowid)
    })
    const row = (await db.get('SELECT * FROM doc_versions WHERE id = ?', [id])) as Record<string, unknown>
    return mapDocVersion(row)
  }

  /**
   * 作废一版存档（单据修订）：CI 金额敲错、箱数装错时，旧规则里这张存档
   * 会把批次、箱明细、单价全部钉死，唯一出口是作废整单重开。
   * 作废只摘掉「纸面金额依据」的资格：记录和 PDF 留着（纸发出去过就是事实），
   * 批次解锁、金额按当前数据重算，允许重出正确的一版。原因必填。
   */
  async function voidDocVersion(versionId: number, reason = ''): Promise<DocVersion[]> {
    const why = String(reason ?? '').trim()
    if (!why) throw bizError('作废存档要写原因（例如“金额敲错一位”“箱数装错”），操作历史要留痕。')
    const row = (await db.get('SELECT * FROM doc_versions WHERE id = ?', [versionId])) as
      | Record<string, unknown>
      | undefined
    if (!row) throw notFound('这一版存档已经不存在了，刷新页面后再试。')
    const v = mapDocVersion(row)
    if (v.voidedAt) throw bizError(`存档 ${v.docNo} 第 ${v.version} 版已经是作废状态，不用重复作废。`)
    // 作废重出是 CI 专用通道：批次锁定与金额钉住都只认 CI，作废 PI/箱单/报价的存档
    // 改变不了任何计算，只会污染审计口径；这些纸面要更正直接重出一版即可。
    if (v.kind !== 'ci') {
      throw bizError(
        `只有 CI 存档支持作废重出；${v.docNo} 是 ${v.kind.toUpperCase()} 存档，它不参与锁定，` +
          `作废它改变不了任何计算——纸面要更正直接重出一版即可。`
      )
    }
    if (v.orderId != null) {
      const st = String(
        ((await db.get('SELECT payment_status FROM orders WHERE id = ?', [v.orderId])) as
          | { payment_status?: string }
          | undefined)?.payment_status ?? ''
      )
      if (st === 'void') throw bizError('这张订单已作废，存档是留档凭据，不能再作废。')
    }
    await db.transact(async () => {
      await db.run('UPDATE doc_versions SET voided_at = ?, void_reason = ? WHERE id = ?', [now(), why, versionId])
      if (v.orderId != null) {
        await logEvent(
          db,
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
   * 存档前核对纸面指纹：预览开着的那段时间，底下的单可能已经被改过。
   * 版次号只管「存过几版」，管不了内容——旧纸会被当成新版本存进档案。
   * 指纹不吃图片，所以这里也不需要读图。
   * 老调用方（没带指纹）跳过：这条通道还有脚本在用，不能凭空把它们全判死。
   */
  async function assertPageStillCurrent(input: {
    docNo: string
    kind: DocKind
    orderId?: number | null
    quotationId?: number | null
    pageFingerprint?: string
  }): Promise<void> {
    const sent = String(input.pageFingerprint ?? '').trim()
    if (!sent) return
    const settings = await settingsCore(db).get()
    let current = ''
    if (input.kind === 'quotation') {
      if (input.quotationId == null) throw new Error('报价单存档没有带上报价单 id，不能核对纸面。')
      const quotation = await quotations.getQuotation(Number(input.quotationId))
      if (!quotation) throw new Error(`报价单 #${String(input.quotationId)} 已经不在了，这一版不能存。`)
      current = docPageFingerprint({ kind: input.kind, docNo: input.docNo, quotation, settings })
    } else {
      if (input.orderId == null) throw new Error('单据存档没有带上订单 id，不能核对纸面。')
      const order = await orders.getOrder(Number(input.orderId))
      if (!order) throw new Error(`订单 #${String(input.orderId)} 已经不在了，这一版不能存。`)
      current = docPageFingerprint({ kind: input.kind, docNo: input.docNo, order, settings })
    }
    if (current !== sent) throw new Error(stalePageMessage(input.docNo, input.kind))
  }

  async function writeDocVersion(
    docNo: string,
    kind: DocKind,
    input: Parameters<DocsApi['saveDocFile']>[0]
  ): Promise<{ filePath: string; absolutePath: string; version: number }> {
    // 存档金额是事后对账的依据：NaN/负数直接拒收，不能静默落成 0
    // 漏传金额不能按 0 存：存档金额是这张纸的凭据——批次 CI 记的是本批金额，PI/报价记的是整单金额，
    // 钉成 0 以后对账只剩一张 0 元的纸（预览没带金额就存，只能重开预览）。
    // 这道检查从桌面 IPC 收进 core（R60）：HTTP 入口同样要拦，一句话术。
    if (input.amount == null) {
      throw bizError(
        `这张 ${kind.toUpperCase()} 没带金额，不能存档：存档金额是事后对账的依据，不能按 0 记。请关掉预览重新打开再存。`
      )
    }
    if (input.amount != null) {
      const amt = Number(input.amount)
      if (!Number.isFinite(amt) || amt < 0) {
        throw bizError(`存档金额「${String(input.amount)}」不是有效金额，不能存这一版。请关掉预览重新打开再存。`)
      }
    }
    const version = await nextVersion(docNo, kind)
    if (input.expectedVersion != null && Number(input.expectedVersion) !== version) {
      throw bizError(
        `这一版已经变了：纸面是第 ${input.expectedVersion} 版，系统现在该存第 ${version} 版。` +
          `请关掉预览重新打开再存，别把两版内容混在一起。`
      )
    }
    // CI 的号、以及「出过 CI 就锁单价/锁箱明细/批次金额按存档钉」「有存档禁删」这四道闸门，
    // 全都是按 CI{PI 号} 认账的。PI 号空着时 ciNoOf('') 只剩一个光秃秃的 "CI"，
    // 每张空号单都会挤进同一个键：闸门查的是别人的存档，本单看着「没出过 CI」随便改。
    // 所以 PI 号必须先补上——补号是出口，不用改表结构。
    if (kind === 'ci' && input.orderId != null) {
      const piNo = String(
        ((await db.get('SELECT pi_no FROM orders WHERE id = ?', [input.orderId])) as { pi_no?: string } | undefined)
          ?.pi_no ?? ''
      ).trim()
      if (!piNo) {
        throw bizError(
          `这张单还没有 PI 号，CI 存档不能出：CI 的编号、以及「出过 CI 就锁单价、锁箱明细、批次金额按存档钉」` +
            `这几道闸门都按 PI 号认单。PI 号空着，它们会认错别家的单，这张单看着却像「还没出过 CI」，想怎么改就怎么改。` +
            `请先到订单里补上 PI 号，再出这一版。`
        )
      }
    }
    await assertPageStillCurrent({
      docNo,
      kind,
      orderId: input.orderId,
      quotationId: input.quotationId,
      pageFingerprint: input.pageFingerprint
    })

    const dir = join(dirs.docsDir(), docNo)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const fileName = `${kind}_${docNo}_v${version}.pdf`
    const absolutePath = join(dir, fileName)
    const filePath = relative(dirs.dataDir(), absolutePath).split(sep).join('/')
    // 只删自己 wx 新建的那份：孤儿覆盖与并发对手的 PDF，回滚时碰不得
    let createdHere = false

    try {
      writeFileSync(absolutePath, input.pdf, { flag: 'wx' })
      createdHere = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // 文件在、库里没记录 = 上次存档在「落盘成功、记账之前」崩溃留下的孤儿：
        // 不覆盖它，每次存档都会永远撞 EEXIST，凭据链被一个孤儿文件锁死
        const orphan = !(await db.get(
          'SELECT 1 FROM doc_versions WHERE doc_no = ? AND kind = ? AND version = ?',
          [docNo, kind, version]
        ))
        if (orphan) {
          writeFileSync(absolutePath, input.pdf)
        } else {
          throw bizError(`存档文件 ${fileName} 已经存在，不能覆盖。请刷新后重新生成这一版。`)
        }
      } else {
        throw e
      }
    }

    try {
      await db.transact(async () => {
        // 落账前复查重叠：预览阶段的检查隔着秒级的 PDF 生成，两个预览并发存档会双双放行——
        // 检查与记账放进同一事务，落库的一刻不可能夹带未经确认的重叠
        if (kind === 'ci' && input.orderId != null) {
          await assertCiNoOverlap(input.orderId, docNo, input.confirmOverlap === true)
        }
        await recordDocVersion({
          orderId: input.orderId ?? null,
          quotationId: input.quotationId ?? null,
          docNo,
          kind,
          version,
          amount: input.amount ?? 0,
          filePath
        })
        // CI 金额与应收口径的差异留痕：报关调价是设计允许的（理由写在纸面上），
        // 收款仍按订单口径——但差异必须留在账上，事后对账才知道这不是录错。
        // 只比「整单 CI」（单号就是 PI 号）：批次 CI 记的是本批货值，拿它跟整单应收比，
        // 每出一批就凭空写一条「金额不符」，真正的差异反而被噪声埋掉。
        if (kind === 'ci' && input.orderId != null && input.amount != null) {
          const orderRow = (await db.get('SELECT pi_no FROM orders WHERE id = ?', [input.orderId])) as
            | { pi_no?: string }
            | undefined
          const piNo = String(orderRow?.pi_no ?? '').trim()
          if (piNo && docNo === ciNoOf(piNo)) {
            const grand = await orderGrandTotal(input.orderId)
            const diff = Number(input.amount) - grand
            if (Math.abs(diff) > 0.005) {
              await logEvent(
                db,
                input.orderId,
                'doc_amount_diff',
                null,
                null,
                `CI 存档 ${docNo} 第 ${version} 版金额 ${Number(input.amount).toFixed(2)} 与订单应收 ` +
                  `${grand.toFixed(2)} 相差 ${diff.toFixed(2)}；收款仍按订单口径，差异理由应写在纸面上`
              )
            }
          }
        }
      })
    } catch (e) {
      if (createdHere) {
        try {
          unlinkSync(absolutePath)
        } catch {
          /* 文件没写成功或已删，忽略 */
        }
      }
      const msg = (e as Error).message ?? ''
      if (/UNIQUE|unique/i.test(msg)) {
        throw bizError(`单据 ${docNo} 第 ${version} 版已经存过了（可能另一窗口同时点了存档）。请刷新后核对存档列表。`)
      }
      throw e
    }
    return { filePath, absolutePath, version }
  }

  /**
   * 把一版 PDF 落盘并记账。
   *
   * - 版本按 MAX+1 取；带 expectedVersion 时先核对纸面版次，避免「纸印第 1 版、库里第 2 版」。
   * - 文件名带 kind，PI 与 CI 同号也不会互相覆盖。
   * - 落盘用 wx（已存在即失败），数据库唯一索引兜底，失败时删掉刚写的文件。
   * - 数据库里存 data 目录相对路径，换电脑/恢复备份后仍能找到。
   *
   * 同一单号同一类单据的存档在进程内串行（见 serializeDocSave）：版本号算在事务之外、
   * 文件先落盘后进库，两个预览并发点存档会双双算出同一个 v。
   */
  async function saveDocFile(input: {
    pdf: Buffer
    docNo: string
    kind: string
    orderId?: number | null
    quotationId?: number | null
    amount?: number
    expectedVersion?: number
    /** 预览打开时算出的纸面数据指纹；存档前重算一次，纸面过时就不存 */
    pageFingerprint?: string
    /** CI 与已存档批次/整单 CI 重叠时是否已由人确认（预览弹窗勾选后带来） */
    confirmOverlap?: boolean
  }): Promise<{ filePath: string; absolutePath: string; version: number }> {
    const docNo = assertDocNo(input.docNo)
    const kind = assertDocKind(input.kind)
    return serializeDocSave(`${docNo}::${kind}`, () => writeDocVersion(docNo, kind, input))
  }

  /** 存档里存的是相对路径；老数据是绝对路径，照样能解析（换机后按 docs 段回退） */
  function resolveDocPath(filePath: string): string {
    const raw = String(filePath ?? '').trim()
    if (!raw) throw bizError('没有文件')
    const root = dirs.dataDir()
    const docsRoot = resolve(root, 'docs')
    // 渲染层传来的路径一律当敌情：绝对路径只认落在数据目录里的。
    // Windows 老库搬到本机（真事：我们刚搬过）后，D:\old-pc\… 这种盘符路径在 POSIX 上
    // isAbsolute() 是 false，会掉进下面的相对分支被原样拼进数据目录放行——
    // 所以盘符开头或带反斜杠的相对路径一律先按「外来绝对路径」处理。
    if (isAbsolute(raw)) {
      const abs = resolve(raw)
      if (abs.startsWith(root + sep)) return abs
    } else if (raw.includes('\\') || /^[a-zA-Z]:[/\\]/.test(raw)) {
      // 但反斜杠在 POSIX 也是合法文件名字符：数据目录里真有一个叫这个名字的文件时，
      // 它就是本机相对路径，照常打开，不能被「接回 docs」的判断劫走
      const asLocal = resolve(root, raw)
      if (existsSync(asLocal) && asLocal.startsWith(root + sep)) return asLocal
    } else {
      const abs = resolve(root, raw)
      if (abs !== root && abs.startsWith(root + sep)) return abs
    }
    // 外来路径按 docs 段接回当前数据目录：老机器上分隔符可能是反斜杠，先归一成 / 再找；
    // 没有 docs 段（例如 D:\old-pc\elsewhere\r42.pdf）就拒——那不是我们存档的布局，接不回。
    const marker = '/docs/'
    const i = raw.replace(/\\/g, '/').lastIndexOf(marker)
    if (i >= 0) {
      const abs = resolve(docsRoot, raw.replace(/\\/g, '/').slice(i + marker.length))
      if (abs.startsWith(docsRoot + sep)) return abs
    }
    throw bizError('单据路径不在数据目录里，已拒绝打开')
  }

  async function listDocVersions(orderId: number): Promise<DocVersion[]> {
    const rows = (await db.all('SELECT * FROM doc_versions WHERE order_id = ? ORDER BY id DESC', [
      orderId
    ])) as Record<string, unknown>[]
    return rows.map(mapDocVersion)
  }

  async function listQuotationDocVersions(quotationId: number): Promise<DocVersion[]> {
    const rows = (await db.all('SELECT * FROM doc_versions WHERE quotation_id = ? ORDER BY id DESC', [
      quotationId
    ])) as Record<string, unknown>[]
    return rows.map(mapDocVersion)
  }

  /**
   * 整单 CI 与批次 CI 重叠闸门：整单按 PI 合计开一张，批次按本批货值开一张，
   * 两张同时有效时客户手里的发票金额就打架，报关/收汇会重复申报。
   * 先整单后补批次（或反过来）都是合法顺序，所以不硬挡——但必须让人看着
   * 「重叠了多少钱」亲手确认，而不是悄悄出两张对不上的票。
   */
  async function assertCiNoOverlap(orderId: number, docNo: string, confirmedOverlap = false): Promise<number> {
    const piNo = String(
      ((await db.get('SELECT pi_no FROM orders WHERE id = ?', [orderId])) as { pi_no?: string } | undefined)?.pi_no ?? ''
    ).trim()
    if (!piNo) return 0
    const base = ciNoOf(piNo)
    const rows = (await db.all(
      `SELECT doc_no, version, amount FROM doc_versions
     WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL`,
      [orderId]
    )) as { doc_no?: string; version?: number; amount?: number }[]
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

  const api: DocsApi = {
    assertDocKind,
    nextVersion,
    recordDocVersion,
    voidDocVersion,
    saveDocFile,
    resolveDocPath,
    listDocVersions,
    listQuotationDocVersions,
    assertCiNoOverlap
  }
  return api
}

export interface DocsApi {
  assertDocKind(kind: unknown): DocKind
  nextVersion(docNo: string, kind: string): Promise<number>
  recordDocVersion(input: {
    orderId?: number | null
    quotationId?: number | null
    docNo: string
    kind: DocKind
    version: number
    amount?: number
    filePath: string
  }): Promise<DocVersion>
  voidDocVersion(versionId: number, reason?: string): Promise<DocVersion[]>
  saveDocFile(input: {
    pdf: Buffer
    docNo: string
    kind: string
    orderId?: number | null
    quotationId?: number | null
    amount?: number
    expectedVersion?: number
    pageFingerprint?: string
    confirmOverlap?: boolean
  }): Promise<{ filePath: string; absolutePath: string; version: number }>
  resolveDocPath(filePath: string): string
  listDocVersions(orderId: number): Promise<DocVersion[]>
  listQuotationDocVersions(quotationId: number): Promise<DocVersion[]>
  assertCiNoOverlap(orderId: number, docNo: string, confirmedOverlap?: boolean): Promise<number>
}

export type DocsCore = ReturnType<typeof docsCore>
