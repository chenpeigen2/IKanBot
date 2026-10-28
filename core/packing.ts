/**
 * 装箱单（分批出货）：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 关键约定：
 *  - 箱单是纸面凭据：出了 CI 的批次金额、箱明细都冻结；作废只留档，不改历史
 *  - 同款累计装箱不得超过订单数量（分批出货的硬底线）
 *  - 批次状态只往前推，回退要整批改
 *
 * 作废/装箱会推动订单的出货状态，所以回头调订单域；按需懒建工厂，共用同一个连接。
 */
import { bizError, notFound } from '../src/shared/errors'
import type { Db } from './db'
import { nextNo } from './next-no'
import { logEvent } from './events'
import { settingsCore } from './settings'
import { ordersCore } from './orders'
import { applyShipStatus } from './shipping'
import { mapPackingList, mapPackingListLine } from '../electron/db/mappers'
import { localDate, assertLocalDate } from '../src/shared/date'
import { ciNoOf } from '../src/shared/documents'
import { assertQuantity as assertQtyRule } from '../src/shared/guards'
import { SHIP_STATUS_LABEL, SHIP_STATUS_ORDER } from '../src/shared/types'
import type { BatchShipStatus, PackingList, PackingListLine } from '../src/shared/types'
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

export function packingCore(db: Db) {
  let ordersApi: ReturnType<typeof ordersCore> | null = null
  const ordersOf = () => (ordersApi ??= ordersCore(db))

  const DEPARTED: BatchShipStatus[] = ['shipped', 'cleared', 'delivered']

  /** 已经作废的批次：箱明细和状态都不再动，它只是留档 */
  function isVoided(cur: Record<string, unknown> | null): boolean {
    return cur != null && cur.voided_at != null && String(cur.voided_at) !== ''
  }

  /**
   * 装箱件数的入口闸门：规矩与订单/报价/打样明细共用同一条（实现在 src/shared/guards），
   * 这里只补装箱特有的那句话——这一箱不发了应该删行，而不是填 0 或负数。
   */
  function assertQuantity(qty: unknown, label = '装箱数量'): void {
    assertQtyRule(qty, label, '这一箱不发了请直接删掉那一行（删到只剩一箱时请整张装箱单一起删）')
  }

  /** 重量：可以空着（纸面印 est./留白），给了就必须是非负的真实数字 */
  function assertWeight(v: unknown, label: string): void {
    if (v == null || v === '') return
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) {
      throw bizError(`${label}「${String(v)}」不是一个合理的公斤数（要留空就清空，不要填负数或非数字）`)
    }
  }

  /** 款号是箱单的锚：空款号的箱子进不了逐款守恒，也归不进任何一款 */
  function assertStyleNo(styleNo: unknown): void {
    if (String(styleNo ?? '').trim() === '') {
      throw bizError('装箱明细必须有款号——没有款号的箱子上不了报关单，也算不进任何一款的已装量。请按款号×颜色×尺码分行装')
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
  async function assertNotOverPacked(
    orderId: number,
    sku: { styleNo?: string; color?: string; size?: string },
    addQty: number,
    excludeLineId?: number
  ): Promise<void> {
    const styleNo = sku.styleNo ?? ''
    // 件数的正数/整数由 assertQuantity 在入口把关，这里只管「同款累计不能超订单量」
    if (!styleNo) return
    const color = sku.color ?? ''
    const size = sku.size ?? ''
    const hasItems = Number(
      (await db.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND quantity > 0', [orderId]) as
        | { n?: number }
        | null)?.n ?? 0
    )
    const ordered = Number(
      (
        await db.get(
          `SELECT COALESCE(SUM(quantity), 0) AS qty FROM order_items
           WHERE order_id = ? AND style_no = ? AND color = ? AND size = ?`,
          [orderId, styleNo, color, size]
        ) as { qty?: number } | null
      )?.qty ?? 0
    )
    if (ordered <= 0) {
      // 订单里有货、这一款却不在其中：多半是款号敲错或拿错了单，放进去对账就串了
      if (hasItems) {
        throw bizError(
          `订单里没有 ${styleNo} ${color}/${size} 这一款，装箱单不能凭空多出一款。请核对款号/颜色/尺码，或先到订单明细里把这一款加上；如果是升级前的老数据填错了，可以直接删掉这一行。`
        )
      }
      return
    }
    const packed = Number(
      (
        await db.get(
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
      throw bizError(
        `款号 ${styleNo} ${color}/${size}：订单 ${ordered} 件，其他箱已装 ${packed} 件，还能装 ${room} 件；这一批填了 ${addQty} 件，超了 ${
          packed + addQty - ordered
        } 件。请先核对数量。`
      )
    }
  }

  /**
   * 这一批出过 CI 吗？出了就是客户手里那张纸的依据：
   * 箱明细、批次本身都不能再改，否则系统按新箱数重算批次金额，纸面却不会跟着变。
   * 返回最新一版有效 CI 的版次（0 = 没出过）。作废的存档不算：
   * 作废就是摘掉「纸面依据」资格，批次解锁、金额按当前数据重算，可重出正确的一版。
   */
  async function archivedCiVersion(orderId: number, plNo: string): Promise<number> {
    const piNo = String(
      (await db.get('SELECT pi_no FROM orders WHERE id = ?', [orderId]) as { pi_no?: string } | null)?.pi_no ?? ''
    ).trim()
    if (!piNo) return 0
    const row = await db.get(
      `SELECT MAX(version) AS v FROM doc_versions
       WHERE order_id = ? AND kind = 'ci' AND voided_at IS NULL AND doc_no = ?`,
      [orderId, ciNoOf(piNo, plNo)]
    ) as { v?: number | null } | null
    return Number(row?.v ?? 0)
  }

  /**
   * 已出运的批次是给客户的凭据：箱明细一律锁住。
   * 否则把明细删空/改个款号，批次还挂着「已签收」，报关和收款就全对不上了。
   */
  async function assertBatchLinesEditable(orderId: number, plId: number): Promise<number> {
    const cur = await db.get('SELECT pl_no, ship_status, voided_at FROM packing_lists WHERE id = ? AND order_id = ?', [
      plId,
      orderId
    ]) as Record<string, unknown> | null
    if (!cur) throw notFound('装箱单不存在')
    if (isVoided(cur)) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 已作废，现在只是留档：箱明细不能改。要接着用这一批，请先「撤销作废」。`
      )
    }
    const ciVer = await archivedCiVersion(orderId, String(cur.pl_no))
    if (ciVer > 0) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 已经出过 CI（第 ${ciVer} 版存档），箱明细不能再改：那一批的金额已经按这些箱子印给客户了，改了系统重算的数和纸面就对不上。确实装错了，先把这一版 CI 存档作废（操作历史里写明原因），箱子改对后重出正确的一版。`
      )
    }
    const status = cur.ship_status == null ? null : (String(cur.ship_status) as BatchShipStatus)
    if (status && DEPARTED.includes(status)) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 当前状态是「${SHIP_STATUS_LABEL[status]}」，箱明细不能改——出运记录是对客户的凭据。如果确实填错了，先把批次状态改回「已包装」再改。`
      )
    }
    return Number(
      (await db.get('SELECT COUNT(*) AS n FROM packing_list_lines WHERE packing_list_id = ?', [plId]) as { n?: number } | null)
        ?.n ?? 0
    )
  }

  /** 箱明细收缩后，已登记的客户实收件数不能比剩下的还多（单据上会是负数短装） */
  async function assertReceivedFitsLines(plId: number): Promise<void> {
    const row = await db.get(
      `SELECT p.received_qty AS received,
              COALESCE((SELECT SUM(l.quantity) FROM packing_list_lines l
                        WHERE l.packing_list_id = p.id), 0) AS qty
       FROM packing_lists p WHERE p.id = ?`,
      [plId]
    ) as { received?: number | null; qty?: number } | null
    const received = row?.received
    if (received != null && Number(received) > Number(row?.qty ?? 0)) {
      throw bizError(
        `这一批登记了客户实收 ${Number(received)} 件，改完箱明细只剩 ${Number(row?.qty ?? 0)} 件——实收不可能比装出去的还多。请先把实收数量改对，或者补上少掉的那一箱。`
      )
    }
  }

  /**
   * 箱号在同一张订单里全局唯一，不是「同一批不重」。
   * 箱号是提单和报关单上的箱号（箱号跨批次连续），第二批又从 NO.1 开始，
   * 客户按箱号点货、货代按箱号订舱时两边对不上。作废批次的号也占着——纸已经发出去过。
   */
  async function assertBoxNoFree(plId: number, boxNo: string | undefined, exceptLineId?: number): Promise<void> {
    const no = String(boxNo ?? '').trim()
    if (!no) return
    const pl = await db.get('SELECT order_id FROM packing_lists WHERE id = ?', [plId]) as { order_id?: number } | null
    if (!pl) return
    await assertBoxNoFreeInOrder(Number(pl.order_id), no, exceptLineId)
  }

  async function assertBoxNoFreeInOrder(orderId: number, boxNo: string, exceptLineId?: number): Promise<void> {
    const no = boxNo.trim()
    if (!no) return
    const hit = await db.get(
      `SELECT l.id FROM packing_list_lines l
       JOIN packing_lists p ON p.id = l.packing_list_id
       WHERE p.order_id = ? AND l.box_no = ? AND l.id != ?`,
      [orderId, no, exceptLineId ?? -1]
    )
    if (hit) {
      throw bizError(
        `箱号「${no}」在这张订单里已经用过了：箱号跨批次连续（作废批次也占号），重复会让提单和报关单的箱数对不上。请换一个没发过的箱号。`
      )
    }
  }



  async function listPackingLists(orderId: number): Promise<PackingList[]> {
    const rows = await db.all('SELECT * FROM packing_lists WHERE order_id = ? ORDER BY id', [orderId]) as Record<
      string,
      unknown
    >[]
    return Promise.all(
      rows.map(async (r) => {
        const lines = (
          await db.all('SELECT * FROM packing_list_lines WHERE packing_list_id = ? ORDER BY box_no, id', [
            Number(r.id)
          ]) as Record<string, unknown>[]
        ).map(mapPackingListLine)
        return mapPackingList(r, lines)
      })
    )
  }

  async function createPackingList(input: PackingListInput): Promise<PackingList[]> {
    await ordersOf().assertOrderWritable(input.orderId, '装箱')
    if (input.lines.length === 0) throw bizError('装箱单至少要有一箱，先生成箱明细再保存')
    // 同一 SKU 可能拆成好几箱，先按 SKU 合计再校验，免得逐行放行、加起来超了
    const bySku = new Map<string, { sku: { styleNo?: string; color?: string; size?: string }; qty: number }>()
    const seenBoxNo = new Set<string>()
    for (const l of input.lines) {
      const boxNo = String(l.boxNo ?? '').trim()
      if (boxNo) {
        if (seenBoxNo.has(boxNo)) {
          throw bizError(`箱号「${boxNo}」在这一批里出现了两次：一箱只能占一行，否则箱数和体积对不上`)
        }
        seenBoxNo.add(boxNo)
      }
      assertStyleNo(l.styleNo)
      assertQuantity(l.quantity)
      assertWeight(l.netWeight, '净重')
      assertWeight(l.grossWeight, '毛重')
      const key = [l.styleNo ?? '', l.color ?? '', l.size ?? ''].join('|')
      const cur = bySku.get(key) ?? { sku: l, qty: 0 }
      cur.qty += Number(l.quantity) || 0
      bySku.set(key, cur)
    }
    for (const v of bySku.values()) await assertNotOverPacked(input.orderId, v.sku, v.qty)
    // 跨批次查号放在超装校验之后：用户先看到「数量超了」这个更直接的问题
    for (const no of seenBoxNo) await assertBoxNoFreeInOrder(input.orderId, no)

    await db.transact(async () => {
      // 烧号进事务：插入失败（超装校验漏网、并发撞号）时号跟着回滚，不烧空号
      const plNo = await nextNo(db, 'PL')
      const res = await db.run(
        `INSERT INTO packing_lists(order_id, pl_no, container_no, note, created_at, ship_status)
         VALUES(?,?,?,?,?,'packed')`,
        [input.orderId, plNo, input.containerNo ?? '', input.note ?? '', now()]
      )
      const plId = Number(res.lastInsertRowid)
      const factor = (await settingsCore(db).get()).grossWeightFactor
      for (const l of input.lines) {
        const net = l.netWeight ?? null
        // 毛重：手填优先，否则按 净重 × 系数 估算
        const gross = l.grossWeight ?? (net != null ? Number((net * factor).toFixed(2)) : null)
        await db.run(
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
      await applyShipStatus(db, input.orderId)
      // 留痕和批次在同一个事务里：提交成功但留痕失败，单据和历史就对不上了
      await logEvent(db, input.orderId, 'pl_create', null, null, `生成装箱单 ${plNo}（${input.lines.length} 箱）`)
    })
    return listPackingLists(input.orderId)
  }

  async function deletePackingList(orderId: number, plId: number): Promise<PackingList[]> {
    const cur = await db.get(
      'SELECT pl_no, ship_status, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
      [plId, orderId]
    ) as Record<string, unknown> | null
    if (!cur) return listPackingLists(orderId)
    await ordersOf().assertOrderWritable(orderId, '删装箱单')
    if (isVoided(cur)) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 已经作废留档了，就让它留着——纸面发过客户的单据，系统里得查得到。`
      )
    }
    const ciVer = await archivedCiVersion(orderId, String(cur.pl_no))
    if (ciVer > 0) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 已经出过 CI（第 ${ciVer} 版存档），不能删除：删了这一批，存档的发票就找不到对应的箱单和金额了。先作废那版 CI 存档，这一批才能删。`
      )
    }
    const status = cur.ship_status == null ? null : (String(cur.ship_status) as BatchShipStatus)
    if (status && DEPARTED.includes(status)) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 当前状态是「${SHIP_STATUS_LABEL[status]}」，不能删除——出运记录是对客户的凭据，必须留档。如果确实填错了，先把批次状态改回「已包装」再删，改动会留在操作历史里。`
      )
    }
    await db.transact(async () => {
      await db.run('DELETE FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId])
      await applyShipStatus(db, orderId)
      await logEvent(db, orderId, 'pl_delete', null, null, `删除装箱单 ${String(cur.pl_no)}`)
    })
    return listPackingLists(orderId)
  }

  /**
   * 批次作废：订舱被货代取消、整批发错要整体撤下——纸面箱单可能已经发到客户邮箱了，
   * 所以不能让它「消失」。记录、箱明细、PDF 存档一条不动，只是不再参与
   * 状态汇总、件数守恒和本批金额。作废不需要先把状态退回「已包装」：
   * 作废是承认这一批没走成，不是篡改出运凭据。
   */
  async function voidPackingList(orderId: number, plId: number, reason = ''): Promise<PackingList[]> {
    const cur = await db.get(
      'SELECT pl_no, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
      [plId, orderId]
    ) as Record<string, unknown> | null
    if (!cur) throw notFound('装箱单不存在')
    // 作废/失效单的箱单也是留档的一部分：改它的作废状态会连带改整单出货汇总
    await ordersOf().assertOrderWritable(orderId, '作废装箱单')
    if (isVoided(cur)) throw bizError(`装箱单 ${String(cur.pl_no)} 已经是作废状态，不用重复作废`)
    const ciVer = await archivedCiVersion(orderId, String(cur.pl_no))
    if (ciVer > 0) {
      throw bizError(
        `装箱单 ${String(cur.pl_no)} 已经出过 CI（第 ${ciVer} 版存档），不能作废：发票已经按这一批发给客户了，作废会让箱单、发票和订单三边的金额对不上。先作废那版 CI 存档（写明原因），这一批才能作废。`
      )
    }
    if (!String(reason ?? '').trim()) {
      throw bizError('作废批次必须写明原因（比如「订舱取消」「整批发错」）：这是发给客户的凭据，不留原因以后对不上账。')
    }
    await db.transact(async () => {
      await db.run('UPDATE packing_lists SET voided_at = ? WHERE id = ? AND order_id = ?', [now(), plId, orderId])
      await applyShipStatus(db, orderId)
      await logEvent(db, 
        orderId,
        'pl_void',
        null,
        null,
        `作废装箱单 ${String(cur.pl_no)}${reason ? `：${reason}` : ''}（记录与存档保留，不再参与汇总）`
      )
    })
    return listPackingLists(orderId)
  }

  /** 撤销作废：点错了，或者这一批后来照常发了 */
  async function unvoidPackingList(orderId: number, plId: number, reason = ''): Promise<PackingList[]> {
    const cur = await db.get(
      'SELECT pl_no, voided_at FROM packing_lists WHERE id = ? AND order_id = ?',
      [plId, orderId]
    ) as Record<string, unknown> | null
    if (!cur) throw notFound('装箱单不存在')
    await ordersOf().assertOrderWritable(orderId, '撤销作废装箱单')
    if (!isVoided(cur)) return listPackingLists(orderId)
    if (!String(reason ?? '').trim()) {
      throw bizError('撤销作废也要写明原因：作废记录是留档凭据，为什么翻案得能查到。')
    }
    await db.transact(async () => {
      await db.run('UPDATE packing_lists SET voided_at = NULL WHERE id = ? AND order_id = ?', [plId, orderId])
      await applyShipStatus(db, orderId)
      await logEvent(db, orderId, 'pl_unvoid', null, null, `撤销作废装箱单 ${String(cur.pl_no)}：${reason}（重新参与状态与件数汇总）`)
    })
    return listPackingLists(orderId)
  }



  /** 编辑批次信息：柜号/船名/船期/封条/提单号 + 出运状态 + 实收数量 + 单据日期 */
  async function updatePackingListInfo(
    orderId: number,
    plId: number,
    patch: PackingListInfoInput
  ): Promise<PackingList[]> {
    const cur = await db.get('SELECT * FROM packing_lists WHERE id = ? AND order_id = ?', [plId, orderId]) as Record<
      string,
      unknown
    > | null
    if (!cur) throw notFound('装箱单不存在')
    if (isVoided(cur)) {
      throw bizError(`装箱单 ${String(cur.pl_no)} 已作废，不能改批次信息。要接着用请先「撤销作废」。`)
    }
    await ordersOf().assertOrderWritable(orderId, '改装箱单')
    if (patch.shipStatus !== undefined && !SHIP_STATUS_ORDER.includes(patch.shipStatus)) {
      throw bizError('这个出货状态不能手工选，请选择「未备货 / 备货中 / 已包装 / 已出运 / 已清关 / 已签收」')
    }
    assertLocalDate(patch.etdDate, 'ETD')
    // 预计可以排到未来，实际开船与签收不行：它们是催尾款的主钟
    assertLocalDate(
      patch.atdDate,
      '实际开船日',
      true,
      '这一项记的是已经发生的事，尾款催款也从它起算；填成未来的日子，这张单的尾款提醒会从此不再出现'
    )
    assertLocalDate(patch.etaDate, 'ETA')
    assertLocalDate(patch.docDate, '单据日期')
    assertLocalDate(
      patch.deliveredDate,
      '签收日期',
      true,
      '这一项记的是已经发生的事，尾款催款也从它起算；填成未来的日子，这张单的尾款提醒会从此不再出现'
    )

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
          throw bizError(
            `实收数量「${String(patch.receivedQty)}」不是一个合理的件数（要 0 以上的整数；没和客户对上就先留空，留空等于按发数全收）`
          )
        }
        const shippedQty = Number(
          (await db.get('SELECT COALESCE(SUM(quantity),0) AS q FROM packing_list_lines WHERE packing_list_id = ?', [plId]) as
            | { q?: number }
            | null)?.q ?? 0
        )
        if (n > shippedQty) {
          throw bizError(
            `这一批只装出去 ${shippedQty} 件，客户实收不可能比发出的还多 ${n - shippedQty} 件。多收是补发或发错货，请另开装箱单登记。`
          )
        }
        receivedQty = n
      }
    }

    // 已出 CI 的批次改船期/柜号这类纸面字段：数据可以改（舱位变了是真实发生），
    // 但必须提醒「客户手里那张 CI 不会跟着变」，免得两边悄悄分叉还没人知道
    const ciVer = await archivedCiVersion(orderId, String(cur.pl_no))

    const pick = (v: string | null | undefined, old: unknown) => (v === undefined ? String(old ?? '') : (v ?? ''))
    await db.transact(async () => {
      await db.run(
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
      await applyShipStatus(db, orderId)
      // 留痕入事务：改成功了历史却没记上，等于把「谁改的」这条证据弄丢了
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
      if (ciVer > 0) {
        // CI 印的就是柜号/船名/ETD/封条/提单号这几个字段：改了哪个就提醒哪个
        const paperLabels = ['柜号', '船名航次', 'ETD', '实际开船', '封条号', '提单号', '单据日期']
        if (parts.some((p) => paperLabels.some((k) => p.startsWith(k)))) {
          parts.push(`注意：这一批已出 CI 第 ${ciVer} 版存档，已发出的纸面不会跟着变，请核对后重出正确的一版`)
        }
      }
      await logEvent(db, 
        orderId,
        'pl_update',
        curStatus,
        nextStatus,
        parts.length > 0 ? `修改批次 ${String(cur.pl_no)}：${parts.join('；')}` : `修改批次 ${String(cur.pl_no)}`
      )
    })
    return listPackingLists(orderId)
  }

  async function updatePackingListLine(
    orderId: number,
    plId: number,
    lineId: number,
    patch: Partial<PackingListLine>
  ): Promise<PackingList[]> {
    await assertBatchLinesEditable(orderId, plId)
    await ordersOf().assertOrderWritable(orderId, '改装箱明细')
    const cur = await db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
      | Record<string, unknown>
      | null
    if (!cur) throw notFound('装箱明细不存在')
    if (patch.quantity !== undefined) assertQuantity(patch.quantity, '这一箱的数量')
    if (patch.styleNo !== undefined) assertStyleNo(patch.styleNo)
    assertWeight(patch.netWeight, '净重')
    assertWeight(patch.grossWeight, '毛重')
    if (patch.boxNo !== undefined && String(patch.boxNo ?? '').trim() !== String(cur.box_no ?? '').trim()) {
      await assertBoxNoFree(plId, patch.boxNo, lineId)
    }
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
      await assertNotOverPacked(
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
    const factor = (await settingsCore(db).get()).grossWeightFactor
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
    await db.transact(async () => {
      await db.run(
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
      await assertReceivedFitsLines(plId)
      await applyShipStatus(db, orderId)
      // 箱数/净重被改过也要留痕（报关单跟箱单一对不上的时候要拿凭据）
      const changes = describePlLineChange(cur, scale !== 1 ? { ...patch, netWeight: net, grossWeight: gross } : patch)
      if (changes) {
        await logEvent(db, orderId, 'pl_line_update', null, null, `修改装箱明细 ${cur.style_no} ${cur.color}/${cur.size}：${changes}`)
      }
    })
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

  async function addPackingListLine(
    orderId: number,
    plId: number,
    line: { boxNo?: string; styleNo?: string; productName?: string; color?: string; size?: string; quantity: number }
  ): Promise<PackingList[]> {
    await assertBatchLinesEditable(orderId, plId)
    await ordersOf().assertOrderWritable(orderId, '加装箱明细')
    assertStyleNo(line.styleNo)
    assertQuantity(line.quantity)
    await assertBoxNoFree(plId, line.boxNo)
    await assertNotOverPacked(orderId, line, Number(line.quantity) || 0)
    // 现场补一箱时按同批里同款的箱子带上箱规和单位净重，别让人再手敲一遍尺寸
    const twin = await db.get(
      `SELECT * FROM packing_list_lines
       WHERE packing_list_id = ? AND style_no = ? AND color = ? AND size = ?
       ORDER BY id LIMIT 1`,
      [plId, line.styleNo ?? '', line.color ?? '', line.size ?? '']
    ) as Record<string, unknown> | null
    const twinQty = Number(twin?.quantity ?? 0)
    const unitNet = twin && twinQty > 0 && twin.net_weight != null ? Number(twin.net_weight) / twinQty : null
    const net = unitNet == null ? null : Number((unitNet * Number(line.quantity)).toFixed(2))
    const gross = net == null ? null : Number((net * (await settingsCore(db).get()).grossWeightFactor).toFixed(2))
    await db.transact(async () => {
      await db.run(
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
      await applyShipStatus(db, orderId)
      await logEvent(db, 
        orderId,
        'pl_line_add',
        null,
        null,
        `添加装箱明细 ${line.styleNo ?? ''} ${line.color ?? ''}/${line.size ?? ''} × ${line.quantity}`
      )
    })
    return listPackingLists(orderId)
  }

  async function deletePackingListLine(orderId: number, plId: number, lineId: number): Promise<PackingList[]> {
    const lineCount = await assertBatchLinesEditable(orderId, plId)
    await ordersOf().assertOrderWritable(orderId, '删装箱明细')
    if (lineCount <= 1) {
      throw bizError('一箱都没有的装箱单留不住。如果整批作废，请直接删除这张装箱单。')
    }
    const cur = await db.get('SELECT * FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId]) as
      | Record<string, unknown>
      | null
    await db.transact(async () => {
      await db.run('DELETE FROM packing_list_lines WHERE id = ? AND packing_list_id = ?', [lineId, plId])
      await assertReceivedFitsLines(plId)
      await applyShipStatus(db, orderId)
      if (cur) {
        await logEvent(db, 
          orderId,
          'pl_line_remove',
          null,
          null,
          `删除装箱明细 ${cur.style_no} ${cur.color}/${cur.size} × ${cur.quantity}`
        )
      }
    })
    return listPackingLists(orderId)
  }

  return {
    isVoided,
    assertQuantity,
    assertWeight,
    assertStyleNo,
    estFlag,
    now,
    assertNotOverPacked,
    archivedCiVersion,
    assertBatchLinesEditable,
    assertReceivedFitsLines,
    assertBoxNoFree,
    assertBoxNoFreeInOrder,
    listPackingLists,
    createPackingList,
    deletePackingList,
    voidPackingList,
    unvoidPackingList,
    updatePackingListInfo,
    updatePackingListLine,
    describePlLineChange,
    addPackingListLine,
    deletePackingListLine
  }
}

/** 装箱域门面类型 */
export type PackingCore = ReturnType<typeof packingCore>
