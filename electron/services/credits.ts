/**
 * 客户预收抵扣（R27）。
 *
 * 预收余额不是另存的一笔钱：它从 payments 的现状派生（多收、作废/失效余款、
 * 取消/免单实收），见 money.ts 的 customerCreditBalance。这里只负责
 * 「把余额用掉」和「撤销用掉」——抵扣是非现金动作，绝不进 payments/现金流，
 * 也不改单据总额和毛利，只冲目标单的待收。
 */
import { getDb, transact } from '../db'
import { getSettings } from './settings'
import { logEvent } from './events'
import { recomputePaymentStatus } from './orders'
import { isLocalDate, localDate } from '../../src/shared/date'
import { isBillingStatus } from '../../src/shared/billing'
import {
  customerCreditBalance,
  customerCreditAvailable,
  moneyForOrders,
  sampleOpenRows,
  type CustomerCreditCurrency
} from './money'

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

interface Target {
  kind: 'order' | 'sample'
  id: number
  no: string
  customerId: number
  currency: string
  /** 原币待收（已经扣过既有抵扣） */
  open: number
}

function readOrderTarget(id: number): Target {
  const row = getDb().get(
    'SELECT id, order_no, customer_id, currency, payment_status, charges, deposit_ratio FROM orders WHERE id = ?',
    [id]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('订单不存在')
  const customerId = Number(row.customer_id)
  const currency = String(row.currency ?? '').trim()
  const status = String(row.payment_status ?? '')
  if (status === 'draft') {
    throw new Error(`订单 ${String(row.order_no ?? '')} 还是草稿：草稿不进应收，不能拿客户预收去抵。先把状态改成「已发出」或「已确认」。`)
  }
  if (!isBillingStatus(status)) {
    throw new Error(`订单 ${String(row.order_no ?? '')} 已失效/作废：它已经没有待收，预收抵扣无处可落。`)
  }
  const money = moneyForOrders([{ id, charges: row.charges, depositRatio: Number(row.deposit_ratio ?? 0) }]).get(id)
  return {
    kind: 'order',
    id,
    no: String(row.order_no ?? ''),
    customerId,
    currency,
    open: money?.receivable ?? 0
  }
}

function readSampleTarget(id: number): Target {
  const row = getDb().get(
    'SELECT id, sample_no, customer_id, currency, status, fee_status FROM sample_orders WHERE id = ?',
    [id]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('打样单不存在')
  const customerId = Number(row.customer_id)
  const currency = String(row.currency ?? '').trim()
  const hit = sampleOpenRows(customerId).find((r) => r.sampleId === id)
  if (!hit) {
    throw new Error(
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

function readTarget(kind: 'order' | 'sample', id: number): Target {
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
export function applyCredit(input: ApplyCreditInput): CustomerCreditCurrency[] {
  const customerId = Number(input.customerId)
  const currency = String(input.currency ?? '').trim().toUpperCase()
  if (!customerId) throw new Error('没有指定客户，不能抵扣预收。')
  if (!currency) throw new Error('没有指定币种，不能抵扣预收。')
  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  if (!(amount > 0)) throw new Error('抵扣金额必须大于 0。')

  const target = readTarget(input.targetKind, input.targetId)
  if (target.customerId !== customerId) {
    throw new Error('这张单不属于当前客户：预收只能抵同一家客户的单，不能串账。')
  }
  if (target.currency !== currency) {
    throw new Error(
      `这张单是 ${target.currency}，客户可用预收是 ${currency}：跨币种抵扣没有唯一正确的汇率，请线下换汇后按同币种登记。`
    )
  }
  if (amount > target.open + 0.001) {
    throw new Error(
      `${target.no} 当前待收只有 ${target.open.toFixed(2)} ${currency}，不能再抵 ${amount.toFixed(2)}。`
    )
  }
  const available = customerCreditAvailable(customerId, currency)
  if (available < -0.001) {
    throw new Error(
      `客户 ${currency} 预收出现缺口（${available.toFixed(2)}）：来源单据被改动过。请先在客户页撤销部分抵扣，再继续使用。`
    )
  }
  if (amount > available + 0.001) {
    throw new Error(
      `客户 ${currency} 可用预收只有 ${available.toFixed(2)}，不够抵 ${amount.toFixed(2)}。`
    )
  }

  const appliedAt = input.appliedAt && isLocalDate(input.appliedAt) ? input.appliedAt : localDate()
  const note = String(input.note ?? '').trim() || '客户预收抵扣'
  const actor = getSettings().operator
  transact(() => {
    getDb().run(
      `INSERT INTO credit_applications(customer_id, currency, amount, target_kind, target_id, applied_at, note, actor, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [customerId, currency, amount, target.kind, target.id, appliedAt, note, actor, new Date().toISOString()]
    )
    if (target.kind === 'order') {
      logEvent(
        target.id,
        'credit_apply',
        null,
        null,
        `客户预收抵扣 ${amount.toFixed(2)} ${currency}（客户余额另记，不算现金到账，冲减待收）`
      )
      // 抵扣过后这张单可能已经收齐：收款状态要跟着走，不能再在工作台上催
      recomputePaymentStatus(target.id)
    }
  })
  return customerCreditBalance(customerId)
}

/** 撤销一笔抵扣：不删行，写 reversed_at；余额和待收一起回来 */
export function reverseCredit(applicationId: number, reason = ''): CustomerCreditCurrency[] {
  const db = getDb()
  const row = db.get(
    'SELECT id, customer_id, currency, amount, target_kind, target_id, reversed_at FROM credit_applications WHERE id = ?',
    [applicationId]
  ) as Record<string, unknown> | null
  if (!row) throw new Error('这笔预收抵扣已经不存在了，刷新页面后再试。')
  const customerId = Number(row.customer_id)
  if (row.reversed_at) throw new Error('这笔预收抵扣已经撤销过了。')
  const why = String(reason ?? '').trim() || '撤销客户预收抵扣'
  const targetKind = String(row.target_kind ?? '') === 'sample' ? 'sample' : 'order'
  const targetId = Number(row.target_id)
  const amount = Number(row.amount ?? 0)
  const currency = String(row.currency ?? '')
  transact(() => {
    db.run('UPDATE credit_applications SET reversed_at = ?, reversed_reason = ? WHERE id = ?', [
      new Date().toISOString(),
      why,
      applicationId
    ])
    if (targetKind === 'order') {
      logEvent(
        targetId,
        'credit_reverse',
        null,
        null,
        `撤销客户预收抵扣 ${amount.toFixed(2)} ${currency}：${why}`
      )
      // 撤销后这张单又欠钱了：收款状态要退回「部分收款/已发出」
      recomputePaymentStatus(targetId)
    }
  })
  return customerCreditBalance(customerId)
}

/**
 * 目标单作废/取消时自动回退它的全部抵扣。
 * 调用方必须已经在事务里（本函数不另开事务，避免嵌套时错误地提前提交）。
 */
export function reverseCreditsForTarget(
  targetKind: 'order' | 'sample',
  targetId: number,
  reason: string
): number {
  const db = getDb()
  const rows = db.all(
    `SELECT id, customer_id, currency, amount FROM credit_applications
     WHERE target_kind = ? AND target_id = ? AND reversed_at IS NULL`,
    [targetKind, targetId]
  ) as Record<string, unknown>[]
  if (!rows.length) return 0
  const at = new Date().toISOString()
  const why = String(reason ?? '').trim() || '目标单据已作废/取消，预收抵扣回退'
  let total = 0
  for (const r of rows) {
    db.run('UPDATE credit_applications SET reversed_at = ?, reversed_reason = ? WHERE id = ?', [
      at,
      why,
      Number(r.id)
    ])
    total += Number(r.amount ?? 0)
  }
  if (targetKind === 'order') {
    logEvent(targetId, 'credit_reverse', null, null, `目标单据作废/取消，预收抵扣回退 ${total.toFixed(2)}：${why}`)
  }
  return total
}

/** 目标单是否还有未撤销的预收抵扣（删单前的守门用） */
export function hasActiveCredit(targetKind: 'order' | 'sample', targetId: number): boolean {
  return !!getDb().get(
    `SELECT 1 AS hit FROM credit_applications
     WHERE target_kind = ? AND target_id = ? AND reversed_at IS NULL LIMIT 1`,
    [targetKind, targetId]
  )
}

/** 有预收抵扣的单，金额/客户/币种被改动后仍要兜得住那笔抵扣 */
export function assertCreditFitsOrder(orderId: number): void {
  const db = getDb()
  const row = db.get('SELECT customer_id, currency, charges, deposit_ratio FROM orders WHERE id = ?', [orderId]) as
    | Record<string, unknown>
    | null
  if (!row) return
  const applications = db.all(
    `SELECT amount, customer_id, currency FROM credit_applications
     WHERE target_kind = 'order' AND target_id = ? AND reversed_at IS NULL`,
    [orderId]
  ) as Record<string, unknown>[]
  if (!applications.length) return
  if (applications.some((a) => Number(a.customer_id) !== Number(row.customer_id))) {
    throw new Error('这张单上已经有客户预收抵扣：换客户会让抵扣的钱串到另一家账上，请先在客户页撤销抵扣。')
  }
  if (applications.some((a) => String(a.currency ?? '') !== String(row.currency ?? ''))) {
    throw new Error('这张单上已经有客户预收抵扣：币种不能再改，那笔抵扣是按原币记的。请先在客户页撤销抵扣。')
  }
  const money = moneyForOrders([
    { id: orderId, charges: row.charges, depositRatio: Number(row.deposit_ratio ?? 0) }
  ]).get(orderId)
  if (money && money.remaining < -0.001) {
    const applied = applications.reduce((s, a) => s + Number(a.amount ?? 0), 0)
    throw new Error(
      `这张单上有 ${applied.toFixed(2)} ${String(row.currency ?? '')} 客户预收抵扣，改完后金额不够覆盖（待收会变成 ${money.remaining.toFixed(2)}）。请先在客户页撤销抵扣，再改金额。`
    )
  }
}

/**
 * 任何会让预收来源变小的动作（删收款、改状态、改金额）之后调用：
 * 余额不能变负——那意味着已经抵出去的钱比客户实际多付的还多。
 * 报错由外层事务回滚，不留下「账已经改了、预收却穿仓」的半截状态。
 */
export function assertCreditSolvent(customerId: number): void {
  const gaps = customerCreditBalance(customerId).filter((c) => c.available < -0.001)
  if (!gaps.length) return
  const detail = gaps.map((c) => `${c.currency} ${c.available.toFixed(2)}`).join('、')
  throw new Error(
    `这笔改动会让客户预收出现缺口（${detail}）：已经有 ${gaps
      .map((c) => c.applied.toFixed(2) + ' ' + c.currency)
      .join('、')} 抵到了别的单上。请先在客户页撤销对应的预收抵扣，再改这笔钱。`
  )
}
