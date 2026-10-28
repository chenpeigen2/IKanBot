/**
 * 客户预收抵扣（R27）：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 预收余额不是另存的一笔钱：它从 payments 的现状派生（多收、作废/失效余款、
 * 取消/免单实收），见 money 的 customerCreditBalance。这里只负责
 * 「把余额用掉」和「撤销用掉」——抵扣是非现金动作，绝不进 payments/现金流，
 * 也不改单据总额和毛利，只冲目标单的待收。
 *
 * 抵扣生效/回退会推动目标单的收款状态，所以要回头调订单域；按需懒建工厂，
 * 避免与 orders 在模块初始化时互相等待。
 */
import { bizError, notFound } from '../src/shared/errors'
import type { Db } from './db'
import { logEvent } from './events'
import { settingsCore } from './settings'
import { ordersCore } from './orders'
import { moneyCore } from './money'
import { isLocalDate, localDate } from '../src/shared/date'
import { isBillingStatus } from '../src/shared/billing'
import type { CustomerCreditCurrency } from '../src/shared/types'
export interface ApplyCreditInput {
  customerId: number
  currency: string
  targetKind: 'order' | 'sample'
  targetId: number
  amount: number
  /** 默认今天；对账单按这一天排序 */
  appliedAt?: string
  note?: string
}

export interface RefundCreditInput {
  customerId: number
  currency: string
  amount: number
  /** 退款到账日；默认今天 */
  refundAt?: string
  /** 银行水单/转账凭据号，必填：退款是真金白银的出口 */
  bankRef: string
  note?: string
}

export interface CreditTarget {
  kind: 'order' | 'sample'
  id: number
  no: string
  customerId: number
  currency: string
  /** 原币待收（已经扣过既有抵扣） */
  open: number
}

export function creditsCore(db: Db) {
  let ordersApi: ReturnType<typeof ordersCore> | null = null
  const ordersOf = () => (ordersApi ??= ordersCore(db))
  let moneyApi: ReturnType<typeof moneyCore> | null = null
  const moneyOf = () => (moneyApi ??= moneyCore(db))



  async function readOrderTarget(id: number): Promise<CreditTarget> {
    const row = await db.get(
      'SELECT id, order_no, customer_id, currency, payment_status, charges, deposit_ratio FROM orders WHERE id = ?',
      [id]
    ) as Record<string, unknown> | null
    if (!row) throw notFound('订单不存在')
    const customerId = Number(row.customer_id)
    const currency = String(row.currency ?? '').trim()
    const status = String(row.payment_status ?? '')
    if (status === 'draft') {
      throw bizError(`订单 ${String(row.order_no ?? '')} 还是草稿：草稿不进应收，不能拿客户预收去抵。先把状态改成「已发出」或「已确认」。`)
    }
    if (!isBillingStatus(status)) {
      throw bizError(`订单 ${String(row.order_no ?? '')} 已失效/作废：它已经没有待收，预收抵扣无处可落。`)
    }
    const detail = await ordersOf().getOrder(id)
    // 坏账已经从待收里拿掉过一次：再拿预收抵，同一笔欠款会同时算「坏账损失」和「预收抵扣」，
    // 待收、坏账余额、客户余额三处对不上。追回款走「坏账追回」，别用预收替客户补。
    if (detail && detail.badDebtOutstanding > 0.001) {
      throw bizError(
        `订单 ${String(row.order_no ?? '')} 还有 ${detail.badDebtOutstanding.toFixed(2)} ${currency} 坏账没追回：` +
          `先走「坏账追回」或撤销那笔坏账，再拿预收抵扣——否则同一笔欠款会同时算坏账损失和预收抵扣。`
      )
    }
    const money = (
      await moneyOf().moneyForOrders([{ id, charges: row.charges, depositRatio: Number(row.deposit_ratio ?? 0) }])
    ).get(id)
    return {
      kind: 'order',
      id,
      no: String(row.order_no ?? ''),
      customerId,
      currency,
      open: money?.receivable ?? 0
    }
  }

  async function readSampleTarget(id: number): Promise<CreditTarget> {
    const row = await db.get(
      `SELECT s.id, s.sample_no, s.customer_id, s.currency, s.status, s.fee_status, o.order_no AS converted_order_no
       FROM sample_orders s LEFT JOIN orders o ON o.id = s.converted_order_id
       WHERE s.id = ?`,
      [id]
    ) as Record<string, unknown> | null
    if (!row) throw notFound('打样单不存在')
    const customerId = Number(row.customer_id)
    const currency = String(row.currency ?? '').trim()
    // 已经走「转单抵扣」的样品费由订单负费用行结清过一次，不能再拿预收抵第二次。
    // R29 起转出订单退回草稿/失效时，这笔样品费会重新出现在待收里——
    // 那只是抵扣暂挂，不是第二笔欠款；等订单恢复会自动再抵。
    if (String(row.fee_status ?? '') === 'offset') {
      const orderNo = String(row.converted_order_no ?? '').trim()
      throw bizError(
        `打样单 ${String(row.sample_no ?? '')} 的样品费已经抵进转出的订单${orderNo ? ` ${orderNo}` : ''}，不能再用客户预收抵一次。` +
          `如果转出的订单退回了草稿/失效，请先把订单恢复成正式单，抵扣会自动生效。`
      )
    }
    const hit = (await moneyOf().sampleOpenRows(customerId)).find((r) => r.sampleId === id)
    if (!hit) {
      throw bizError(
        `打样单 ${String(row.sample_no ?? '')} 没有待收（已收齐/已抵扣/已取消/已免单），不能再用预收抵扣。`
      )
    }
    return {
      kind: 'sample',
      id,
      no: String(row.sample_no ?? ''),
      customerId,
      currency,
      open: hit.receivable
    }
  }

  function readTarget(kind: 'order' | 'sample', id: number): Promise<CreditTarget> {
    return kind === 'sample' ? readSampleTarget(id) : readOrderTarget(id)
  }

  /**
   * 用客户预收抵一张单的待收。
   *
   * 守门（全是业务上会踩的坑）：
   *  - 只能抵同币种：跨币种折算没有唯一正确的汇率，不猜；
   *  - 客户必须对得上：拿 A 客户的钱抵 B 客户的单就是串账；
   *  - 金额不能超过目标单待收，也不能超过客户可用预收；
   *  - 草稿/失效/作废/取消的单不抵（它们没有应收）。
   */
  async function applyCredit(input: ApplyCreditInput): Promise<CustomerCreditCurrency[]> {
    const customerId = Number(input.customerId)
    const currency = String(input.currency ?? '').trim().toUpperCase()
    if (!customerId) throw bizError('没有指定客户，不能抵扣预收。')
    if (!currency) throw bizError('没有指定币种，不能抵扣预收。')
    if (input.targetKind !== 'order' && input.targetKind !== 'sample') {
      throw bizError('抵扣对象只能是订单或打样单。')
    }
    const amount = Math.round((Number(input.amount) || 0) * 100) / 100
    if (!(amount > 0)) throw bizError('抵扣金额必须大于 0。')
    if (input.appliedAt != null && input.appliedAt !== '' && !isLocalDate(input.appliedAt)) {
      throw bizError(`抵扣日期「${input.appliedAt}」不是有效日期。`)
    }
    if (input.appliedAt && input.appliedAt > localDate()) {
      throw bizError('抵扣日期不能填未来：对账单按这一天排序，未来的日期会把余额排到还没发生的月份。')
    }

    // 校验和落库必须在同一个事务里：中间只要让出事件循环，别的写口就能插进来
    // 改待收或花掉同一笔预收，检查时看到的「够」到插入时已经不够了。
    // 余额守门（缺口、超可用）和水单查重同理——它们查的都是将要被改写的那张表。
    const appliedAt = input.appliedAt && isLocalDate(input.appliedAt) ? input.appliedAt : localDate()
    const note = String(input.note ?? '').trim() || '客户预收抵扣'
    return await db.transact(async () => {
      const target = await readTarget(input.targetKind, input.targetId)
      if (target.customerId !== customerId) {
        throw bizError('这张单不属于当前客户：预收只能抵同一家客户的单，不能串账。')
      }
      if (target.currency !== currency) {
        throw bizError(
          `这张单是 ${target.currency}，客户可用预收是 ${currency}：跨币种抵扣没有唯一正确的汇率，请线下换汇后按同币种登记。`
        )
      }
      if (amount > target.open + 0.001) {
        throw bizError(
          `${target.no} 当前待收只有 ${target.open.toFixed(2)} ${currency}，不能再抵 ${amount.toFixed(2)}。`
        )
      }
      const available = await moneyOf().customerCreditAvailable(customerId, currency)
      if (available < -0.001) {
        throw bizError(
          `客户 ${currency} 预收出现缺口（${available.toFixed(2)}）：来源单据被改动过。请先在客户页撤销部分抵扣，再继续使用。`
        )
      }
      if (amount > available + 0.001) {
        throw bizError(
          `客户 ${currency} 可用预收只有 ${available.toFixed(2)}，不够抵 ${amount.toFixed(2)}。`
        )
      }
      const actor = (await settingsCore(db).get()).operator
      await db.run(
        `INSERT INTO credit_applications(customer_id, currency, amount, target_kind, target_id, applied_at, note, actor, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [customerId, currency, amount, target.kind, target.id, appliedAt, note, actor, new Date().toISOString()]
      )
      if (target.kind === 'order') {
        await logEvent(db, 
          target.id,
          'credit_apply',
          null,
          null,
          `客户预收抵扣 ${amount.toFixed(2)} ${currency}（客户余额另记，不算现金到账，冲减待收）`
        )
        // 抵扣过后这张单可能已经收齐：收款状态要跟着走，不能再在工作台上催
        await ordersOf().recomputePaymentStatus(target.id)
      }
      return await moneyOf().customerCreditBalance(customerId)
    })
  }

  /** 撤销一笔抵扣：不删行，写 reversed_at；余额和待收一起回来 */
  async function reverseCredit(applicationId: number, reason = ''): Promise<CustomerCreditCurrency[]> {
    const row = await db.get(
      'SELECT id, customer_id, currency, amount, target_kind, target_id, reversed_at FROM credit_applications WHERE id = ?',
      [applicationId]
    ) as Record<string, unknown> | null
    if (!row) throw bizError('这笔预收抵扣已经不存在了，刷新页面后再试。')
    const customerId = Number(row.customer_id)
    if (row.reversed_at) throw bizError('这笔预收抵扣已经撤销过了。')
    const why = String(reason ?? '').trim()
    // 撤销会把客户的余额和那张单的待收同时改回去：没有原因，历史里就只剩一个「不知道谁撤的」
    if (!why) {
      throw bizError('撤销预收抵扣要写原因（例如「抵错了单」「客户改主意，余额留着抵下一单」），操作历史要留痕。')
    }
    const targetKind = String(row.target_kind ?? '') === 'sample' ? 'sample' : 'order'
    const targetId = Number(row.target_id)
    const amount = Number(row.amount ?? 0)
    const currency = String(row.currency ?? '')
    await db.transact(async () => {
      // CAS 写：从读出 reversed_at 到写回之间，另一次点击可能已经把这笔撤了。
      // 裸 UPDATE 会把对方的原因盖掉，历史里多出两条「撤销」而余额只回来一次
      const done = await db.run(
        'UPDATE credit_applications SET reversed_at = ?, reversed_reason = ? WHERE id = ? AND reversed_at IS NULL',
        [new Date().toISOString(), why, applicationId]
      )
      if (done.changes !== 1) {
        throw bizError('这笔预收抵扣刚刚已经被撤销过了（多半是两个人同时点了撤销），本次操作没有改动任何数据。')
      }
      if (targetKind === 'order') {
        await logEvent(
          db,
          targetId,
          'credit_reverse',
          null,
          null,
          `撤销客户预收抵扣 ${amount.toFixed(2)} ${currency}：${why}`
        )
        // 撤销后这张单又欠钱了：收款状态要退回「部分收款/已发出」
        await ordersOf().recomputePaymentStatus(targetId)
      }
    })
    return await moneyOf().customerCreditBalance(customerId)
  }



  /**
   * 把客户预收退还给客户（R28）。
   *
   * 余额是「钱还在我们账上」，退出去必须当场减掉，否则同一笔钱退了还能再抵下一张单。
   * 这里绝不删来源流水（作废前的收款是留档凭据），只记一笔退还对冲。
   * 日期、水单、原因都是凭据：日期不许填未来，水单必须能对上银行，原因要能回答「为什么退」。
   */
  async function refundCredit(input: RefundCreditInput): Promise<CustomerCreditCurrency[]> {
    const customerId = Number(input.customerId)
    const currency = String(input.currency ?? '').trim().toUpperCase()
    const amount = Math.round((Number(input.amount) || 0) * 100) / 100
    if (!customerId) throw bizError('没有指定客户，不能退还预收。')
    if (!currency) throw bizError('没有指定币种，不能退还预收。')
    if (!(amount > 0)) throw bizError('退还金额必须大于 0。')
    const refundAt = String(input.refundAt ?? '').trim() || localDate()
    if (!isLocalDate(refundAt)) throw bizError(`退款日期「${refundAt}」不是有效日期。`)
    if (refundAt > localDate()) throw bizError('退款日期不能填未来：钱还没退出去。')
    const bankRef = String(input.bankRef ?? '').trim()
    if (!bankRef) {
      throw bizError('退还预收必须填银行水单号：这是钱已经退给客户的凭据，对账时靠它和银行流水对上。')
    }
    const note = String(input.note ?? '').trim()
    if (!note) {
      throw bizError('退还预收要写原因（例如“客户取消尾单，多付退回”）：这笔钱离开公司账上，必须留痕。')
    }
    // 余额够不够、这张水单退没退过，都要和落库同事务查：
    // 水单查重在事务外查过一次，两笔同号退款各自看到「没退过」，余额就会被凭空扣两遍。
    const actor = (await settingsCore(db).get()).operator
    return await db.transact(async () => {
      const available = await moneyOf().customerCreditAvailable(customerId, currency)
      if (available < -0.001) {
        throw bizError(
          `客户 ${currency} 预收已经有缺口（${available.toFixed(2)}）：来源单据被改动过。请先核对来源和抵扣，再办理退款。`
        )
      }
      if (amount > available + 0.001) {
        throw bizError(
          `客户 ${currency} 可用预收只有 ${available.toFixed(2)}，不够退 ${amount.toFixed(2)}。`
        )
      }
      // 一张出水单只退一次钱。水单号是钱已经出门的凭据，同一号记第二笔，
      // 客户余额会被扣两遍，而银行流水那边只找得到一笔支出——对账时两头都说不清。
      const dup = await db.get(
        `SELECT refund_at, amount FROM customer_refunds
          WHERE customer_id = ? AND currency = ? AND reversed_at IS NULL AND UPPER(TRIM(bank_ref)) = UPPER(?)
          ORDER BY id LIMIT 1`,
        [customerId, currency, bankRef]
      ) as { refund_at?: string; amount?: number } | null
      if (dup) {
        throw bizError(
          `这个客户的 ${currency} 已经按水单号「${bankRef}」退过一次（${String(dup.refund_at ?? '')}，${Number(dup.amount ?? 0).toFixed(2)}）：` +
            `同一张出水单不能退两次，再记一笔余额就凭空少一截。` +
            `上次录错了请先在退款台账里撤销那条记录（撤销要写原因）再重录；确实是另一笔支出就填它自己的水单号。`
        )
      }
      await db.run(
        `INSERT INTO customer_refunds(customer_id, currency, amount, refund_at, bank_ref, note, actor, created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [customerId, currency, amount, refundAt, bankRef, note, actor, new Date().toISOString()]
      )
      return await moneyOf().customerCreditBalance(customerId)
    })
  }

  /** 撤销一笔退款（登记错了才用）：写 reversed_at，余额回来，不删行 */
  async function reverseRefund(refundId: number, reason = ''): Promise<CustomerCreditCurrency[]> {
    const row = await db.get('SELECT id, customer_id, reversed_at FROM customer_refunds WHERE id = ?', [refundId]) as
      | Record<string, unknown>
      | null
    if (!row) throw bizError('这笔预收退款已经不存在了，刷新页面后再试。')
    if (row.reversed_at) throw bizError('这笔预收退款已经撤销过了。')
    const why = String(reason ?? '').trim()
    if (!why) throw bizError('撤销退款要写原因（例如“水单录错，钱没退出去”），操作历史要留痕。')
    const customerId = Number(row.customer_id)
    // CAS 写：读出来时还没撤销，写回去这中间可能已经被撤过一次（后端多人同时点）。
    // 裸 UPDATE 会把对方的原因盖掉，台账上多一条撤销、余额只回来一次
    const done = await db.run(
      'UPDATE customer_refunds SET reversed_at = ?, reversed_reason = ? WHERE id = ? AND reversed_at IS NULL',
      [new Date().toISOString(), why, refundId]
    )
    if (done.changes !== 1) {
      throw bizError('这笔退款刚刚已经被撤销过了（多半是两个人同时点了撤销），本次操作没有改动任何数据。')
    }
    return await moneyOf().customerCreditBalance(customerId)
  }

  /**
   * 目标单作废/取消时自动回退它的全部抵扣。
   * 调用方必须已经在事务里（本函数不另开事务，避免嵌套时错误地提前提交）。
   */
  async function reverseCreditsForTarget(
    targetKind: 'order' | 'sample',
    targetId: number,
    reason: string
  ): Promise<number> {
    const rows = await db.all(
      `SELECT id, customer_id, currency, amount FROM credit_applications
       WHERE target_kind = ? AND target_id = ? AND reversed_at IS NULL`,
      [targetKind, targetId]
    ) as Record<string, unknown>[]
    if (!rows.length) return 0
    const at = new Date().toISOString()
    const why = String(reason ?? '').trim() || '目标单据已作废/取消，预收抵扣回退'
    let total = 0
    for (const r of rows) {
      await db.run('UPDATE credit_applications SET reversed_at = ?, reversed_reason = ? WHERE id = ?', [
        at,
        why,
        Number(r.id)
      ])
      total += Number(r.amount ?? 0)
    }
    if (targetKind === 'order') {
      await logEvent(db, targetId, 'credit_reverse', null, null, `目标单据作废/取消，预收抵扣回退 ${total.toFixed(2)}：${why}`)
    }
    return total
  }

  /** 目标单是否还有未撤销的预收抵扣（删单前的守门用） */
  async function hasActiveCredit(targetKind: 'order' | 'sample', targetId: number): Promise<boolean> {
    return !!await db.get(
      `SELECT 1 AS hit FROM credit_applications
       WHERE target_kind = ? AND target_id = ? AND reversed_at IS NULL LIMIT 1`,
      [targetKind, targetId]
    )
  }

  /** 有预收抵扣的单，金额/客户/币种被改动后仍要兜得住那笔抵扣 */
  async function assertCreditFitsOrder(orderId: number): Promise<void> {
    const row = await db.get('SELECT customer_id, currency, charges, deposit_ratio FROM orders WHERE id = ?', [orderId]) as
      | Record<string, unknown>
      | null
    if (!row) return
    const applications = await db.all(
      `SELECT amount, customer_id, currency FROM credit_applications
       WHERE target_kind = 'order' AND target_id = ? AND reversed_at IS NULL`,
      [orderId]
    ) as Record<string, unknown>[]
    if (!applications.length) return
    if (applications.some((a) => Number(a.customer_id) !== Number(row.customer_id))) {
      throw bizError('这张单上已经有客户预收抵扣：换客户会让抵扣的钱串到另一家账上，请先在客户页撤销抵扣。')
    }
    if (applications.some((a) => String(a.currency ?? '') !== String(row.currency ?? ''))) {
      throw bizError('这张单上已经有客户预收抵扣：币种不能再改，那笔抵扣是按原币记的。请先在客户页撤销抵扣。')
    }
    const money = (
      await moneyOf().moneyForOrders([{ id: orderId, charges: row.charges, depositRatio: Number(row.deposit_ratio ?? 0) }])
    ).get(orderId)
    if (money && money.remaining < -0.001) {
      const applied = applications.reduce((s, a) => s + Number(a.amount ?? 0), 0)
      throw bizError(
        `这张单上有 ${applied.toFixed(2)} ${String(row.currency ?? '')} 客户预收抵扣，改完后金额不够覆盖（待收会变成 ${money.remaining.toFixed(2)}）。请先在客户页撤销抵扣，再改金额。`
      )
    }
  }

  /**
   * 任何会让预收来源变小的动作（删收款、改状态、改金额）之后调用：
   * 余额不能变负——那意味着已经抵出去的钱比客户实际多付的还多。
   * 报错由外层事务回滚，不留下「账已经改了、预收却穿仓」的半截状态。
   */
  async function assertCreditSolvent(customerId: number): Promise<void> {
    // 绝大多数客户从没抵扣/退过预收：一次索引查找就放行，
    // 这样把守门挂到每条改金额的路径上也不会拖慢日常编辑。
    // 退款也算「有账」：退了钱再改小来源，同样会穿仓。
    const hit = await db.get(
      `SELECT 1 AS hit FROM credit_applications WHERE customer_id = ? AND reversed_at IS NULL
       UNION ALL
       SELECT 1 FROM customer_refunds WHERE customer_id = ? AND reversed_at IS NULL
       LIMIT 1`,
      [customerId, customerId]
    )
    if (!hit) return
    const gaps = (await moneyOf().customerCreditBalance(customerId)).filter((c) => c.available < -0.001)
    if (!gaps.length) return
    const detail = gaps.map((c) => `${c.currency} ${c.available.toFixed(2)}`).join('、')
    throw bizError(
      `这笔改动会让客户预收出现缺口（${detail}）：这些钱已经抵到了别的单上或退还给了客户。请先在客户页撤销对应的预收抵扣/退款，再改这笔钱。`
    )
  }

  return {
    readOrderTarget,
    readSampleTarget,
    readTarget,
    applyCredit,
    reverseCredit,
    refundCredit,
    reverseRefund,
    reverseCreditsForTarget,
    hasActiveCredit,
    assertCreditFitsOrder,
    assertCreditSolvent
  }
}

/** 预收抵扣域门面类型 */
export type CreditsCore = ReturnType<typeof creditsCore>
