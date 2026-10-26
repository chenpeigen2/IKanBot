import { getDb } from '../db'
import { mapDashboard, mapMonthlyReport } from '../db/mappers'
import { getSettings } from './settings'
import {
  EXCLUDED_STATUSES,
  cashFlowRows,
  creditAppliedForSamples,
  customerCreditBalance,
  listOrderMoney,
  notInStatuses,
  receivedByMonth,
  sampleReceivable,
  sampleStatementRows
} from './money'
import { factoryDeliveredQuantity } from './shipping'
import { isLocalDate, localDate, localDateOf, localMonthOf } from '../../src/shared/date'
import { isBillingStatus, shownRemaining } from '../../src/shared/billing'
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  SAMPLE_FEE_STATUS_LABEL,
  SAMPLE_STATUS_LABEL,
  SHIP_STATUS_LABEL
} from '../../src/shared/types'
import type {
  DashboardStats,
  ExportKind,
  MonthlyReportRow,
  OrderExportFilter,
  Reminder
} from '../../src/shared/types'
import { listOrderIds } from './orders'
import type { OrderMoneyRow } from './money'

/** 本地月初 YYYY-MM-DD（toISOString 是 UTC，拿到的是上个月最后一天） */
function monthStart(): string {
  const d = new Date()
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

export function dashboard(): DashboardStats {
  const db = getDb()
  const settings = getSettings()
  const mStart = monthStart()

  // 金额口径统一走 services/money.ts（唯一真源）：
  // 货值 / 费用 / 含费用合计 / 待收 / 毛利 全部用同一套计算
  // 草稿单、已失效、已作废不算正式订单：不进在途、待收、销售额、毛利、订单数
  const all = listOrderMoney()
  const monthRows = all.filter((r) => localDateOf(r.createdAt) >= mStart)

  // 待收款金额 = Σ(含费用合计 − 已收) + 未收打样费，折算成基准币
  // 直接吃已经拿到的 all，不再让 totalReceivable() 把同一批单重算一遍
  const goodsReceivable = all.reduce((s, r) => s + r.receivableBase, 0)
  const samplePending = sampleReceivable()
  const pendingAmount = goodsReceivable + samplePending

  // 待收款拆成四桶给界面用（纯展示，加起来必须等于 pendingAmount）：
  // 客户点头前后是两码事，混在一个数里就不知道该催销售还是催财务
  const bucket = (...statuses: string[]) =>
    all.filter((r) => statuses.includes(r.paymentStatus)).reduce((s, r) => s + r.receivableBase, 0)
  const pendingUnconfirmed = bucket('draft', 'sent')
  const pendingDeposit = bucket('confirmed')
  // 尾款这一桶用减法：以后再加状态，也不会出现「四个桶加起来 ≠ 待收总额」这种尴尬
  const pendingBalance = goodsReceivable - pendingUnconfirmed - pendingDeposit

  // 还没追回来的坏账：老板要看见「这钱实际上收不回来了」
  const outstandingBadDebt = all.reduce((s, r) => s + r.badDebtBase, 0)

  // 本月毛利：本月的单只要有一单成本没录全，毛利就不可信 → null（界面显示「—」）
  const monthMissingCost = monthRows.some((r) => r.missingCostItems > 0)
  const monthProfitRaw = monthRows.reduce((s, r) => s + (r.profitRaw * r.exchangeRate), 0)
  const monthProfit = monthMissingCost ? null : monthProfitRaw

  // 作废/失效单不进销售与在途（真收到的钱留在现金流里，那份口径在 money.receivedByMonth）
  const sales = notInStatuses('payment_status', EXCLUDED_STATUSES)
  // 「在途」= 正式单里还没结清的：结算完/失效/作废/草稿都不算，集合从常量推，别再手写一遍状态
  const openOrder = notInStatuses('payment_status', [...EXCLUDED_STATUSES, 'settled'])
  const row = db.get(
    `SELECT
      (SELECT COUNT(*) FROM orders WHERE ${openOrder.sql}) AS active_orders,
      (SELECT COUNT(*) FROM orders WHERE ship_status NOT IN ('delivered') AND ${sales.sql}) AS pending_ship_orders,
      (SELECT COUNT(*) FROM (
         SELECT o2.id,
           CASE
             /* 批次接管的前提和 shipping.deriveStatus 一模一样：作废的不算，
                还有一张升级前的老批次（状态为空）也不知道走到哪了，就不下结论 */
             WHEN EXISTS (SELECT 1 FROM packing_lists pl
                          WHERE pl.order_id = o2.id AND pl.voided_at IS NULL AND pl.ship_status IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM packing_lists pln
                               WHERE pln.order_id = o2.id AND pln.voided_at IS NULL AND pln.ship_status IS NULL)
               THEN CASE
                 WHEN EXISTS (SELECT 1 FROM packing_lists pl2
                              WHERE pl2.order_id = o2.id AND pl2.voided_at IS NULL
                                AND pl2.ship_status IS NOT NULL AND pl2.ship_status != 'delivered')
                   THEN NULL
                 ELSE (SELECT MAX(pl3.delivered_at) FROM packing_lists pl3
                       WHERE pl3.order_id = o2.id AND pl3.voided_at IS NULL
                         AND pl3.ship_status = 'delivered' AND pl3.delivered_at IS NOT NULL)
               END
             WHEN o2.ship_status = 'delivered'
               THEN (SELECT date(MAX(e.at), 'localtime') FROM order_events e
                     WHERE e.order_id = o2.id AND e.kind = 'ship_status' AND e.to_status = 'delivered')
             ELSE NULL
           END AS done_at
         FROM orders o2
         WHERE ${sales.sql}
       ) WHERE done_at IS NOT NULL AND date(done_at) >= date(?)) AS completed_this_month,
      (SELECT COUNT(*) FROM orders WHERE date(created_at, 'localtime') >= date(?) AND ${sales.sql}) AS month_new_orders`,
    [...openOrder.params, ...sales.params, ...sales.params, mStart, mStart, ...sales.params]
  ) as Record<string, unknown>

  // 本月到账：走 money.ts 里唯一一份「按到账月算收到多少钱」的实现。
  // 以前这里和月度报表各写一遍 SUM，两处会各自漂出两个数。
  const thisMonth = localMonthOf(localDate())
  const monthReceived = receivedByMonth().find((m) => m.month === thisMonth)?.amount ?? 0

  return {
    ...mapDashboard({
      ...(row ?? {}),
      pending_amount: pendingAmount,
      month_received: monthReceived,
      month_sales: monthRows.reduce((s, r) => s + r.grandTotalBase, 0),
      month_profit: monthProfitRaw
    }),
    monthProfit,
    monthProfitReliable: !monthMissingCost,
    pendingUnconfirmed,
    pendingDeposit,
    pendingBalance,
    pendingSample: samplePending,
    outstandingBadDebt,
    currency: settings.baseCurrency
  }
}


/**
 * 待办提醒规则（一张单一条事一条，宁重复催不可漏催）：
 *  1. PI 已发出超过 N 天未确认 → 催确认（按真正转入「待确认」的那天起算）
 *  2. 客户已确认超过 N 天，定金仍未收够 → 催定金
 *  3. 出货类：批次 ETD / 整单 ETD / 截关日 / 工厂交期 / 预计出货日各盯各的（不合并，责任人不同）
 *  4. 尾款类：收过钱但没收齐；以及「货已出运却一分未收」（赊销 / L/C / 全款后付）
 *  5. 到期类：PI 有效期、报价单发出没回音与报价过期
 *  6. 打样类：打样费未收 + 样品压在手里迟迟没寄出
 *  7. 待修类：日期格式不对、汇率看着不像真的、开了船没提单号、批次没标状态、整单没有任何交期
 *  8. 备份类：从没成功备份过、或者太久没备份（数据只躺在这台电脑上）
 *
 * 铁律：天数一律用本地日期算；脏日期不许印成「还有 NaN 天」，改成单独亮一条「日期格式待修」；
 *      金额一律取自 services/money.ts，这里不再自己写 SQL 算钱。
 */
export function reminders(): Reminder[] {
  const db = getDb()
  const s = getSettings()
  const today = localDate()
  const out: Reminder[] = []

  /** suffix 让同一单同类型的两条不同事由各自成一条，不互相顶掉；单号保证不同报价/打样单不撞 key */
  const add = (r: Omit<Reminder, 'key'>, suffix = ''): void => {
    out.push({ ...r, key: `${r.kind}:${r.orderNo}:${r.plId ?? r.sampleId ?? 0}:${suffix}` })
  }

  /** 两个本地日期相差几天（b − a）；任一侧不是合法本地日期就返回 null */
  const dayDiff = (a: string, b: string): number | null => {
    if (!isLocalDate(a) || !isLocalDate(b)) return null
    return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000)
  }
  /** 距今已过几天（纯日期串按本地零点，时刻串换算成本地日）；脏数据返回 null */
  const daysFrom = (v: unknown): number | null => {
    const raw = String(v ?? '').trim()
    if (!raw) return null
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDateOf(raw)
    return dayDiff(d, today)
  }
  /** 距到期还有几天（负数 = 已逾期）；脏数据返回 null */
  const daysTo = (v: unknown): number | null => dayDiff(today, String(v ?? '').trim())
  /** 「还有 N 天 / 已逾期 N 天」的统一说法 */
  const dueWords = (diff: number): string => (diff < 0 ? `已逾期 ${-diff} 天` : `还有 ${diff} 天`)

  // 钱只看一个真源：待收 / 定金 / 已收都取自 listOrderMoney，出运后催款也必须用它
  const moneyRows = listOrderMoney()

  // 催款时钟按「真正进入这个状态的时间」算：改备注、补成本不能把拖了几个星期的单子刷新成 0 天
  const statusClock = new Map<string, string>()
  for (const e of db.all(
    `SELECT order_id, to_status, MAX(at) AS at FROM order_events
     WHERE kind IN ('create','payment_status','status_auto') AND to_status IS NOT NULL
     GROUP BY order_id, to_status`
  ) as Record<string, unknown>[]) {
    statusClock.set(`${String(e.to_status)}|${Number(e.order_id)}`, String(e.at))
  }
  const clockOf = (orderId: number, status: string, fallback: string): string =>
    statusClock.get(`${status}|${orderId}`) ?? fallback

  // 交期字段一次取全，出货类、到期类、待修类都从这张表里读
  // 出货提醒只排除已失效/已作废：草稿单也可能已经有船期，不能装看不见
  const notGone = notInStatuses('o.payment_status', ['expired', 'void'])
  const dated = db.all(
    `SELECT o.id, o.order_no, o.pi_no, o.created_at, o.updated_at, o.customer_id, o.payment_status, o.ship_status,
            o.valid_until, o.expected_ship_date, o.factory_due_date, o.cut_off_date, o.etd_date, o.payment_method,
            c.company AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE ${notGone.sql}`,
    notGone.params
  ) as Record<string, unknown>[]
  const orderById = new Map<number, Record<string, unknown>>()
  for (const r of dated) orderById.set(Number(r.id), r)

  /* 1. 催确认：PI 发出去了客户还没点头 */
  for (const r of dated) {
    if (String(r.payment_status) !== 'sent') continue
    const days = daysFrom(clockOf(Number(r.id), 'sent', String(r.created_at)))
    if (days === null || days < s.remindConfirmDays) continue
    add(
      {
        orderId: Number(r.id),
        orderNo: String(r.order_no),
        customerName: String(r.customer_name),
        kind: 'confirm',
        message: `PI 已发出 ${days} 天，客户未确认`,
        days
      },
      'confirm'
    )
  }

  /* 2. 催定金：客户确认了，定金却没着落 */
  for (const r of moneyRows) {
    if (r.paymentStatus !== 'confirmed' || r.depositAmount <= 0) continue
    // 预收抵扣也是已经收到的钱：抵过一部分，定金就只剩差额要催
    const depositDue = Math.max(
      0,
      Math.min(r.receivable, r.depositAmount - r.paidAmount - r.creditApplied)
    )
    if (depositDue <= 0.001) continue
    const row = orderById.get(r.orderId)
    if (!row) continue
    const days = daysFrom(clockOf(r.orderId, 'confirmed', String(row.created_at)))
    if (days === null || days < s.remindPaymentDays) continue
    add(
      {
        orderId: r.orderId,
        orderNo: r.orderNo,
        customerName: r.customerName,
        kind: 'payment',
        message: `客户已确认 ${days} 天，定金 ${depositDue.toFixed(2)} ${r.currency} 未到账`,
        days
      },
      'deposit'
    )
  }

  /* 3. 出货类：批次 / 工厂 / 报关 / 客户交期各管各的，合并就丢责任人 */
  const batchRows = db.all(
    `SELECT pl.id AS pl_id, pl.pl_no, pl.container_no, pl.etd_date, pl.eta_date, pl.atd_date, pl.bl_no,
            pl.delivered_at, pl.ship_status,
            (SELECT COUNT(*) FROM packing_list_lines l WHERE l.packing_list_id = pl.id) AS line_count,
            o.id, o.order_no, c.company AS customer_name
     FROM packing_lists pl
     JOIN orders o ON o.id = pl.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE pl.voided_at IS NULL AND ${notGone.sql}`,
    notGone.params
  ) as Record<string, unknown>[]

  /** 空装箱单（还没塞货）不算「在飞的批次」，否则刚点新建就到处喊 */
  const loaded = (b: Record<string, unknown>): boolean => Number(b.line_count ?? 0) > 0
  const notGoneStatus = (b: Record<string, unknown>): boolean =>
    b.ship_status != null && !['shipped', 'cleared', 'delivered'].includes(String(b.ship_status))

  const batchesOf = new Map<number, Record<string, unknown>[]>()
  for (const b of batchRows) {
    const arr = batchesOf.get(Number(b.id)) ?? []
    arr.push(b)
    batchesOf.set(Number(b.id), arr)
  }

  for (const b of batchRows) {
    const status = b.ship_status == null ? null : String(b.ship_status)
    if (!status) continue
    if (['shipped', 'cleared', 'delivered'].includes(status)) {
      // 船开了却查不到提单号：客户见提单副本付款时拿不出凭据
      if (status === 'shipped' && String(b.bl_no ?? '').trim() === '') {
        add(
          {
            orderId: Number(b.id),
            orderNo: String(b.order_no),
            customerName: String(b.customer_name),
            kind: 'data',
            plId: Number(b.pl_id),
            plNo: String(b.pl_no),
            message: `批次 ${String(b.pl_no)} 已标「已出运」但没填提单号，客户凭提单副本付款时拿不出凭据`,
            days: 0
          },
          'bl-' + String(b.pl_id)
        )
      }
      continue
    }
    if (!String(b.etd_date ?? '').trim()) continue
    const diff = daysTo(b.etd_date)
    if (diff === null) {
      add(
        {
          orderId: Number(b.id),
          orderNo: String(b.order_no),
          customerName: String(b.customer_name),
          kind: 'data',
          plId: Number(b.pl_id),
          plNo: String(b.pl_no),
          message: `批次 ${String(b.pl_no)} 的 ETD「${String(b.etd_date)}」不是合法日期（应为 2026-10-05 这种写法），这条交期没能算进提醒`,
          days: 0
        },
        'bad-etd-' + String(b.pl_id)
      )
      continue
    }
    if (diff > s.remindShipDays) continue
    const container = String(b.container_no ?? '')
    add(
      {
        orderId: Number(b.id),
        orderNo: String(b.order_no),
        customerName: String(b.customer_name),
        kind: 'ship',
        plId: Number(b.pl_id),
        plNo: String(b.pl_no),
        message: `批次 ${String(b.pl_no)}：ETD ${String(b.etd_date)} ${dueWords(diff)}，还没标记出运${
          container ? `（柜号 ${container}）` : ''
        }`,
        days: diff
      },
      'etd-' + String(b.pl_id)
    )
  }

  for (const r of dated) {
    const orderId = Number(r.id)
    const batches = batchesOf.get(orderId) ?? []
    const open = batches.filter((b) => loaded(b) && notGoneStatus(b) && String(b.etd_date ?? '').trim() !== '')
    const undated = batches.filter((b) => loaded(b) && notGoneStatus(b) && String(b.etd_date ?? '').trim() === '')

    // 整单 ETD：没有带日期的批次时才用它盯，别跟单上的船期脱节
    const etdRaw = String(r.etd_date ?? '').trim()
    if (etdRaw && open.length === 0) {
      const diff = daysTo(etdRaw)
      if (diff === null) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'data',
            message: `开船日「${etdRaw}」不是合法日期（应为 2026-10-05 这种写法），这条交期没能算进提醒`,
            days: 0
          },
          'bad-order-etd'
        )
      } else if (diff <= s.remindShipDays) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'ship',
            message: `开船日 ${etdRaw} ${dueWords(diff)}，还没有批次标出运`,
            days: diff
          },
          'order-etd'
        )
      }
    }

    // 截关日：错过就是退关改港的实损，最优先级；有未出运批次才喊
    const cutoffRaw = String(r.cut_off_date ?? '').trim()
    if (cutoffRaw) {
      const diff = daysTo(cutoffRaw)
      const openAny = batches.some((b) => loaded(b) && notGoneStatus(b))
      const gone = ['shipped', 'cleared', 'delivered'].includes(String(r.ship_status))
      if (diff === null) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'data',
            message: `截关日「${cutoffRaw}」不是合法日期（应为 2026-10-05 这种写法），这条交期没能算进提醒`,
            days: 0
          },
          'bad-cutoff'
        )
      } else if (openAny && !gone && diff <= s.remindShipDays) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'ship',
            message: `截关日 ${cutoffRaw} ${dueWords(diff)}，还有货没出运`,
            days: diff
          },
          'cutoff'
        )
      }
    }

    // 工厂交期：只认批次状态已推进（已包装及以上）的件数，光建装箱单不算工厂交了货
    const factoryRaw = String(r.factory_due_date ?? '').trim()
    if (factoryRaw) {
      const ordered = Number(
        (db.get('SELECT COALESCE(SUM(quantity),0) AS q FROM order_items WHERE order_id = ? AND quantity > 0', [
          orderId
        ]) as { q?: number })?.q ?? 0
      )
      // 口径只认 shipping 里那一份「工厂已交货件数」：以前这里自己写 SQL 用
      // 「状态非空」判定，结果被改回备货中的批次还算工厂已交，催单直接不响
      const deliveredQty = factoryDeliveredQuantity(orderId)
      const diff = daysTo(factoryRaw)
      const gone = ['shipped', 'cleared', 'delivered'].includes(String(r.ship_status))
      if (diff === null) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'data',
            message: `工厂交期「${factoryRaw}」不是合法日期（应为 2026-10-05 这种写法），这条交期没能算进提醒`,
            days: 0
          },
          'bad-factory'
        )
      } else if (!gone && ordered > 0 && deliveredQty + 0.0001 < ordered && diff <= s.remindShipDays) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'ship',
            message: `工厂交期 ${factoryRaw} ${dueWords(diff)}，货还没交够（工厂已交 ${deliveredQty} / ${ordered} 件）`,
            days: diff
          },
          'factory'
        )
      }
    }

    // 老批次（迁移前建的）没有出货状态：整单进度推不出来，得有人去补一下
    const legacy = batches.filter((b) => loaded(b) && b.ship_status == null)
    if (legacy.length > 0 && !['shipped', 'cleared', 'delivered'].includes(String(r.ship_status))) {
      add(
        {
          orderId,
          orderNo: String(r.order_no),
          customerName: String(r.customer_name),
          kind: 'data',
          message: `这张单有 ${legacy.length} 个批次没标出运状态（老数据），整单出货进度推不出来，请去装箱单里补一下`,
          days: 0
        },
        'legacy-batch'
      )
    }

    // 预计出货日：客户那边盯的是这个；有带 ETD 的批次时由批次自己喊，不重复
    const shipRaw = String(r.expected_ship_date ?? '').trim()
    if (shipRaw && open.length === 0) {
      const diff = daysTo(shipRaw)
      const gone = ['packed', 'shipped', 'cleared', 'delivered', 'partial_shipped'].includes(String(r.ship_status))
      if (diff === null) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'data',
            message: `预计出货日「${shipRaw}」不是合法日期（应为 2026-10-05 这种写法），这条交期没能算进提醒`,
            days: 0
          },
          'bad-expected'
        )
      } else if (!gone && diff <= s.remindShipDays) {
        add(
          {
            orderId,
            orderNo: String(r.order_no),
            customerName: String(r.customer_name),
            kind: 'ship',
            message: `预计出货日 ${shipRaw} ${dueWords(diff)}${
              undated.length ? `，${undated.length} 个批次还没填 ETD（补上船期才能按批次催出货）` : ''
            }`,
            days: diff
          },
          'expected'
        )
      }
    } else if (!shipRaw && !etdRaw && !cutoffRaw && !factoryRaw && batches.length > 0 && undated.length > 0) {
      // 建了装箱单却一个交期都没有：这单永远不会有人喊，比提醒晚了更危险
      add(
        {
          orderId,
          orderNo: String(r.order_no),
          customerName: String(r.customer_name),
          kind: 'data',
          message: `这张单已建 ${batches.length} 个批次但没有任何交期（预计出货日 / 开船日 / 截关日 / 工厂交期都是空的），到点没人喊得到`,
          days: 0
        },
        'no-date'
      )
    }

    // 到港后清款：见提单副本付款的钱不能只凭记忆
    for (const b of batches) {
      if (!['shipped', 'cleared'].includes(String(b.ship_status ?? ''))) continue
      const diff = daysTo(b.eta_date)
      if (diff === null || diff > 0) continue
      const m = moneyRows.find((x) => x.orderId === orderId)
      if (!m || m.receivable <= 0.001) continue
      if (-diff < s.remindBalanceDays) continue
      add(
        {
          orderId,
          orderNo: String(r.order_no),
          customerName: String(r.customer_name),
          kind: 'balance',
          plId: Number(b.pl_id),
          plNo: String(b.pl_no),
          message: `批次 ${String(b.pl_no)} 预计到港 ${String(b.eta_date)} 已过 ${-diff} 天，仍有 ${m.receivable.toFixed(
            2
          )} ${m.currency} 未收`,
          days: diff
        },
        'eta-' + String(b.pl_id)
      )
    }
  }

  /* 4. 尾款类：收过钱没收齐 + 已出运却一分没收（赊销 / L/C / 全款后付） */
  const lastPaid = new Map<number, string>()
  for (const p of db.all(`SELECT order_id, MAX(paid_at) AS last_paid FROM payments GROUP BY order_id`) as Record<
    string,
    unknown
  >[]) {
    lastPaid.set(Number(p.order_id), String(p.last_paid ?? ''))
  }
  // 出运时间：批次实际开船/签收时间优先，没有就用整单状态事件，再兜底最后修改日
  const shipClock = new Map<number, string>()
  for (const b of batchRows) {
    if (!['shipped', 'cleared', 'delivered'].includes(String(b.ship_status ?? ''))) continue
    const at = String(b.atd_date ?? '').trim() || String(b.delivered_at ?? '').trim()
    if (!at) continue
    const id = Number(b.id)
    const cur = shipClock.get(id) ?? ''
    if (at > cur) shipClock.set(id, at)
  }
  // 批次没填实际开船/签收日时，退回整单出货事件的时间：
  // 手工把老单改成已出运也会留一条 ship_status 事件，不能拿 updated_at 兜底（改备注就清零）
  const shipEventClock = new Map<number, string>()
  for (const e of db.all(
    `SELECT order_id, MAX(at) AS at FROM order_events
     WHERE kind = 'ship_status' AND to_status IN ('shipped', 'cleared', 'delivered', 'partial_shipped')
     GROUP BY order_id`
  ) as Record<string, unknown>[]) {
    shipEventClock.set(Number(e.order_id), String(e.at))
  }

  for (const r of moneyRows) {
    if (r.receivable <= 0.001) continue
    const row = orderById.get(r.orderId)
    if (!row) continue
    if (r.paidAmount > 0) {
      const since = lastPaid.get(r.orderId) || r.createdAt
      const days = daysFrom(since)
      if (days === null || days < s.remindBalanceDays) continue
      add(
        {
          orderId: r.orderId,
          orderNo: r.orderNo,
          customerName: r.customerName,
          kind: 'balance',
          message: `已收 ${r.paidAmount.toFixed(2)} / 待收 ${r.receivable.toFixed(2)}，尾款 ${days} 天未到账`,
          days
        },
        'balance'
      )
      continue
    }
    // 一分未收：货走了就必须催，不能因为没收过定金就当没事
    const shipped = ['shipped', 'cleared', 'delivered', 'partial_shipped'].includes(String(row.ship_status))
    if (!shipped) continue
    const since = shipClock.get(r.orderId) ?? shipEventClock.get(r.orderId) ?? String(row.updated_at ?? '')
    const days = daysFrom(since)
    if (days === null || days < s.remindBalanceDays) continue
    const method = PAYMENT_METHOD_LABEL[r.paymentMethod as keyof typeof PAYMENT_METHOD_LABEL] ?? r.paymentMethod
    add(
      {
        orderId: r.orderId,
        orderNo: r.orderNo,
        customerName: r.customerName,
        kind: 'balance',
        message: `货已出运 ${days} 天，一分未收（待收 ${r.receivable.toFixed(2)} ${r.currency}，付款方式 ${method}）`,
        days
      },
      'unpaid-shipped'
    )
  }

  /* 5. 到期类：PI 有效期与报价单跟进 */
  for (const r of dated) {
    const raw = String(r.valid_until ?? '').trim()
    if (!raw) continue
    const st = String(r.payment_status)
    if (st !== 'draft' && st !== 'sent') continue
    const diff = daysTo(raw)
    if (diff === null) {
      add(
        {
          orderId: Number(r.id),
          orderNo: String(r.order_no),
          customerName: String(r.customer_name),
          kind: 'data',
          message: `PI 有效期「${raw}」不是合法日期（应为 2026-10-05 这种写法）`,
          days: 0
        },
        'bad-valid'
      )
      continue
    }
    if (diff > s.remindShipDays) continue
    add(
      {
        orderId: Number(r.id),
        orderNo: String(r.order_no),
        customerName: String(r.customer_name),
        kind: 'expiry',
        message: `PI 有效期 ${raw} ${dueWords(diff)}，客户还没确认（过期就要重新盘汇率、重出单）`,
        days: diff
      },
      'pi-valid'
    )
  }

  for (const q of db.all(
    `SELECT q.q_no, q.created_at, q.sent_at, q.confirmed_at, q.valid_until, q.status, c.company AS customer_name
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.status IN ('sent', 'confirmed') AND q.converted_order_id IS NULL`
  ) as Record<string, unknown>[]) {
    const qNo = String(q.q_no)
    const who = String(q.customer_name)
    if (String(q.status) === 'confirmed') {
      // 客户已经点头却没人转订单，是最容易被忘掉的一笔生意：报价会过期，汇率也天天在动。
      // 起算点只认确认日：改备注/补结果会把 updated_at 刷新，但生意并没有往前挪
      const days = daysFrom(
        String(q.confirmed_at ?? '') || String(q.sent_at ?? '') || String(q.created_at ?? '')
      )
      if (days !== null && days >= s.remindConfirmDays) {
        add(
          {
            orderId: 0,
            orderNo: qNo,
            customerName: who,
            kind: 'quote',
            message: `报价 ${qNo} 客户 ${days} 天前已确认，还没转订单——拖下去汇率和交期都会变`,
            days
          },
          'quote-confirmed'
        )
      }
    }
    const days = daysFrom(String(q.sent_at ?? '') || String(q.created_at ?? ''))
    if (String(q.status) === 'sent' && days !== null && days >= s.remindConfirmDays) {
      add(
        {
          orderId: 0,
          orderNo: qNo,
          customerName: who,
          kind: 'quote',
          message: `报价 ${qNo} 发出 ${days} 天没回音，客户可能被同行抢走`,
          days
        },
        'quote-silent'
      )
    }
    const diff = daysTo(q.valid_until)
    if (diff !== null && diff <= s.remindShipDays) {
      add(
        {
          orderId: 0,
          orderNo: qNo,
          customerName: who,
          kind: 'quote',
          message: `报价 ${qNo} ${dueWords(diff)}到期（${String(q.valid_until)}），到期要重新盘汇率`,
          days: diff
        },
        'quote-valid'
      )
    }
  }

  /* 6. 打样类：钱要催，压在手里的样品更要催 */
  const sampleRows = db.all(
    `SELECT s.id, s.sample_no, s.sample_date, s.created_at, s.shipped_at, s.status, s.fee_status,
            s.currency, s.exchange_rate, s.express_fee, c.company AS customer_name,
            COALESCE((SELECT SUM(si.quantity * si.unit_price) FROM sample_order_items si
                      WHERE si.sample_order_id = s.id), 0) AS sample_fee,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                      WHERE p.sample_order_id = s.id), 0) AS collected
     FROM sample_orders s JOIN customers c ON c.id = s.customer_id
     WHERE s.status != 'cancelled'`
  ) as Record<string, unknown>[]
  // 预收抵扣过的打样费已经由客户余额覆盖：催款只催净额（与 sampleOpenRows 同一个口径）
  const creditBySample = creditAppliedForSamples(sampleRows.map((r) => Number(r.id)))
  for (const r of sampleRows) {
    const sampleNo = String(r.sample_no)
    const who = String(r.customer_name)
    // 样品还压在手里：客户等的是样，不是发票
    if (String(r.status) === 'pending' && !String(r.shipped_at ?? '').trim()) {
      const days = daysFrom(String(r.sample_date ?? '') || String(r.created_at ?? ''))
      if (days !== null && days >= s.remindPaymentDays) {
        add(
          {
            orderId: 0,
            orderNo: sampleNo,
            customerName: who,
            kind: 'sample',
            sampleId: Number(r.id),
            message: `打样单 ${sampleNo} 建了 ${days} 天还没寄出样品，客户在等`,
            days
          },
          'not-shipped'
        )
      }
    }
    if (String(r.fee_status ?? 'unpaid') !== 'unpaid') continue
    // 催的是还欠的那部分：已经收了一半就只催另一半，预收抵掉的部分也不算欠
    const owed =
      Number(r.sample_fee ?? 0) +
      Number(r.express_fee ?? 0) -
      Number(r.collected ?? 0) -
      (creditBySample.get(Number(r.id)) ?? 0)
    if (owed <= 0.001) continue
    const shippedAt = String(r.shipped_at ?? '').trim()
    const days = daysFrom(shippedAt || String(r.sample_date ?? '') || String(r.created_at ?? ''))
    if (days === null || days < s.remindPaymentDays) continue
    const rate = Number(r.exchange_rate ?? 0)
    add(
      {
        orderId: 0,
        orderNo: sampleNo,
        customerName: who,
        kind: 'sample',
        sampleId: Number(r.id),
        message:
          `打样费 ${owed.toFixed(2)} ${String(r.currency || 'USD')} 未收` +
          (rate > 0
            ? `（折合 ${(owed * rate).toFixed(2)}），${shippedAt ? `样品寄出 ${days} 天` : `挂单 ${days} 天还没寄出`}`
            : '，且汇率未填（工作台待收里少算了这单，请补汇率）'),
        days
      },
      'fee'
    )
  }

  /* 7. 待修类：外币单汇率看着不像真的 */
  for (const r of moneyRows) {
    // 外币单汇率正好等于 1 = 当初建单时没人填，被兜底成了 1:1（不阻断建单，但必须亮出来）
    if (r.currency === s.baseCurrency || r.exchangeRate !== 1) continue
    add(
      {
        orderId: r.orderId,
        orderNo: r.orderNo,
        customerName: r.customerName,
        kind: 'data',
        message: `${r.currency} 的单按 1:${s.baseCurrency} 折算，汇率看着没填过——待收、销售额、毛利都被它带偏，请补真实汇率`,
        days: 0
      },
      'rate'
    )
  }

  /* 8. 备份类：软件一直能用，不代表数据一直安全 */
  {
    // 超过这个天数没备份就催：程序每天启动会自动备一次，正常用着的人永远不会看到这条
    const BACKUP_STALE_DAYS = 7
    const docCount = Number(
      (
        db.get(
          `SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM quotations) + (SELECT COUNT(*) FROM sample_orders) AS n`
        ) as { n: number } | null
      )?.n ?? 0
    )
    // 空库不催：刚装好还没有业务，天天喊备份只会让人学会无视它
    if (docCount > 0) {
      if (s.lastBackupError) {
        add(
          {
            orderId: 0,
            orderNo: '数据备份',
            customerName: '备份',
            kind: 'data',
            message: `最近一次备份没成功：${s.lastBackupError}。请到「设置 → 数据备份」手动点一次「立即备份」，成功了这条提示才会消掉`,
            days: 0
          },
          'backup-failed'
        )
      }
      const since = daysFrom(s.lastBackupAt ?? '')
      if (since === null) {
        add(
          {
            orderId: 0,
            orderNo: '数据备份',
            customerName: '备份',
            kind: 'data',
            message: `已经有 ${docCount} 张单据，这台电脑上却还没有一份成功备份。电脑一坏就全没了——请到「设置 → 数据备份」点一次「立即备份」`,
            days: 0
          },
          'backup-never'
        )
      } else if (since > BACKUP_STALE_DAYS) {
        add(
          {
            orderId: 0,
            orderNo: '数据备份',
            customerName: '备份',
            kind: 'data',
            message: `距离上一次成功备份已经 ${since} 天（超过 ${BACKUP_STALE_DAYS} 天），中间的单据都还没有凭据。请到「设置 → 数据备份」再备一次`,
            days: 0
          },
          'backup-stale'
        )
      }
    }
  }

  // 逾期最前（越久越靠前）→ 按还剩几天升序 → 「待修」垫底：
  // 待修不会到期，错过船期是真金白银；界面右上角另给「待修 N」计数，不会被埋掉
  const rank = (r: Reminder): number => (r.days < 0 ? r.days : r.kind === 'data' ? 100000 : 1000 + r.days)
  out.sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.orderNo.localeCompare(b.orderNo))
  return out
}

/**
 * 按月统计报表（金额统一折算为基准币）。
 *
 * 两套归月口径同时存在于一张表里，列名必须写清楚，别让人以为能纵向相减：
 *   销售额 / 成本 / 毛利 / 折让 / 短款 / 坏账 —— 按订单创建月份
 *   收款 —— 按实际到账月份（走 money.receivedByMonth，与工作台同一个数）
 *
 * 口径统一走 services/money.ts：货值 / 成本 / 毛利 / 核销都跟订单详情、客户页、工作台同一套。
 * 成本没录全的月份，毛利一律给 null（不可信），不许拿 0 成本凑一个漂亮的数，
 * 也不许再加一列「已录成本单的毛利」——半可信的毛利列比空白更容易被当成真数。
 */
export function monthlyReport(): MonthlyReportRow[] {
  interface MonthAcc {
    month: string
    orders: number
    sales: number
    cost: number
    profit: number
    discount: number
    shortage: number
    badDebt: number
    received: number
    missingCostOrders: number
  }
  const empty = (month: string): MonthAcc => ({
    month,
    orders: 0,
    sales: 0,
    cost: 0,
    profit: 0,
    discount: 0,
    shortage: 0,
    badDebt: 0,
    received: 0,
    missingCostOrders: 0
  })
  const byMonth = new Map<string, MonthAcc>()
  for (const r of listOrderMoney()) {
    const cur = byMonth.get(r.month) ?? empty(r.month)
    const rate = r.exchangeRate
    cur.orders += 1
    cur.sales += r.grandTotalBase
    cur.cost += r.costBase
    cur.profit += r.profitBase
    // negativeCharges 本身是负数，报表里折让按「让出去多少」写正数
    cur.discount += -r.negativeCharges * rate
    cur.shortage += r.shortageAmount * rate
    cur.badDebt += r.badDebtOutstanding * rate
    if (r.missingCostItems > 0) cur.missingCostOrders += 1
    byMonth.set(r.month, cur)
  }

  // 收款：按实际到账月份归集（现金流口径的实现在 money.ts，这里只搬运不加总）
  for (const p of receivedByMonth()) {
    const cur = byMonth.get(p.month) ?? empty(p.month)
    cur.received += p.amount
    byMonth.set(p.month, cur)
  }

  return [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((r) =>
      mapMonthlyReport({
        month: r.month,
        orders: r.orders,
        sales: r.sales,
        cost: r.cost,
        // 成本没录全的月份：毛利不可信 → null（界面上显示「—」）
        profit: r.missingCostOrders > 0 ? null : r.profit,
        discount: r.discount,
        shortage: r.shortage,
        bad_debt: r.badDebt,
        received: r.received,
        missing_cost_orders: r.missingCostOrders
      })
    )
}

/**
 * 导出台账（CSV，UTF-8 BOM，Excel 直接可打开）。
 *
 * 三张台账的口径都写在列名和文件名里，Excel 里 SUM 出来的数必须能对上系统：
 *   orders      —— 与销售额/毛利/待收同一口径（草稿、失效、作废都不在表里）
 *   orders_all  —— 全量底稿，含草稿与作废，只对历史复盘用，别拿去 SUM
 *   payments    —— 现金流口径（只排草稿）：作废单到账的钱是真钱，行要在，状态列要写清
 *   items       —— 款号×颜色×尺码明细，走销售额口径
 *   monthly     —— 月度汇总，与报表页同一份数
 * 状态一律中文标签，别再出现一张表写「void」、另一张写「已作废」。
 */
export function exportCsv(kind: ExportKind, filter?: OrderExportFilter): string {
  const db = getDb()
  const base = getSettings().baseCurrency
  switch (kind) {
    case 'orders':
    case 'orders_all':
      // 有筛选时「所见即所得」：停在「已作废 / 草稿 / 已失效」页签导出的必须是屏幕上的行，
      // 不能因为台账口径把行集先剔光、最后只导出一个表头。
      // 但日期/关键词/正常状态筛选仍走台账口径——把草稿、失效单混进「订单台账」，
      // Excel 里 SUM 出来的数就不等于销售额了。只有筛的本身就是非计费状态才放开全量行集。
      return ordersCsv(
        kind === 'orders_all' || (filter?.paymentStatus && !isBillingStatus(filter.paymentStatus))
          ? listOrderMoney({ includeVoided: true })
          : listOrderMoney(),
        base,
        kind === 'orders' ? filter : undefined
      )
    case 'items':
      return itemsCsv(db, base)
    case 'monthly':
      return monthlyCsv(base)
    case 'payments':
      return paymentsCsv(base)
    case 'statement': {
      const customerId = Number(filter?.customerId ?? 0)
      if (!customerId) throw new Error('导出对账单必须指定客户。')
      return statementCsv(customerId, base)
    }
    default: {
      // 加了新 kind 却忘了在这里分支：让编译器在这里叫，别让它静默掉进收款分支
      const never: never = kind
      throw new Error(`不支持的导出类型：${String(never)}`)
    }
  }
}

/** 订单台账：orders 与 orders_all 共用列，只差在传进来的行集 */
function ordersCsv(rows: OrderMoneyRow[], base: string, filter?: OrderExportFilter): string {
  if (filter) {
    // 不另写一份筛选 SQL：拿列表同一个 listWhere 算出的 id 再过滤，口径只此一处
    const keep = new Set(listOrderIds(filter))
    rows = rows.filter((r) => keep.has(r.orderId))
  }
  const header = [
    '订单号',
    'PI号',
    '客户',
    '国家',
    '币种',
    '汇率',
    '锁汇日期',
    '收款状态',
    '出货状态',
    '贸易术语',
    '装运港',
    '目的港',
    '付款方式',
    '客户PO号',
    '预计出货日',
    '创建日期',
    '归属月份',
    '货值(原币)',
    '费用合计(原币)',
    '含费用合计(原币)',
    '成本(原币)',
    '成本未录全款数',
    '毛利(原币)',
    '已收金额(原币)',
    '待收金额(原币)',
    '预收抵扣(原币)',
    '短款核销(原币)',
    '坏账核销(原币)',
    '坏账未追回(原币)',
    `含费用合计(${base})`,
    `成本(${base})`,
    `已收金额(${base})`,
    `待收金额(${base})`,
    `预收抵扣(${base})`
  ]
  const lines = rows.map((r) => {
    const rate = r.exchangeRate
    return [
      r.orderNo,
      r.piNo,
      r.customerName,
      r.country,
      r.currency,
      rate,
      r.exchangeRateDate ?? '',
      PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus,
      SHIP_STATUS_LABEL[r.shipStatus as keyof typeof SHIP_STATUS_LABEL] ?? r.shipStatus,
      r.incoterm,
      r.portOfLoading,
      r.portOfDestination,
      r.paymentMethod,
      r.customerPo,
      r.expectedShipDate ?? '',
      localDateOf(r.createdAt),
      r.month,
      money2(r.goodsValue),
      money2(r.chargesTotal),
      money2(r.grandTotal),
      money2(r.totalCost),
      r.missingCostItems || '',
      // 成本没录全 → 毛利不可信，宁可空着，不许拿 0 成本凑一个好看的数
      r.missingCostItems > 0 ? '' : money2(r.profitRaw),
      money2(r.paidAmount),
      money2(r.receivable),
      money2(r.creditApplied),
      money2(r.shortageAmount),
      money2(r.badDebtAmount),
      money2(r.badDebtOutstanding),
      money2(r.grandTotalBase),
      money2(r.costBase),
      money2(r.paidAmount * rate),
      money2(r.receivable * rate),
      money2(r.creditAppliedBase)
    ]
  })
  return toCsv(header, lines)
}

/** 款号明细台账：款号×颜色×尺码，退税、对账、报关核数用 */
function itemsCsv(db: ReturnType<typeof getDb>, base: string): string {
  const sales = notInStatuses('o.payment_status', EXCLUDED_STATUSES)
  const rows = db.all(
    `SELECT o.id AS order_id, o.order_no, o.pi_no, c.company, c.country, o.currency, o.exchange_rate,
            o.payment_status, o.ship_status, o.created_at,
            oi.style_no, oi.product_name, oi.color, oi.size, oi.quantity, oi.unit_price, oi.unit_cost,
            (oi.quantity * oi.unit_price) AS amount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE ${sales.sql}
     ORDER BY o.created_at DESC, oi.style_no, oi.color, oi.size`,
    sales.params
  ) as Record<string, unknown>[]
  // 明细行加起来只等于「货值」，PI 上的 TOTAL 还含运费/折让等费用行。
  // 报关核数时那截差额最容易被当成漏单，所以把整单的货值/费用一起带上。
  const orderMoney = new Map(listOrderMoney().map((r) => [r.orderId, r]))
  const header = [
    '订单号',
    'PI号',
    '客户',
    '国家',
    '款号',
    '品名',
    '颜色',
    '尺码',
    '数量',
    '单价',
    '金额(原币)',
    '单位成本(原币)',
    '成本(原币)',
    '币种',
    '汇率',
    `金额(${base})`,
    '收款状态',
    '出货状态',
    '创建日期',
    '该单货值(原币)',
    '该单费用合计(原币)',
    '该单含费用合计(原币)'
  ]
  const lines = rows.map((r) => {
    const rate = Number(r.exchange_rate)
    const amount = Number(r.amount)
    const o = orderMoney.get(Number(r.order_id))
    const unitCost = r.unit_cost == null ? null : Number(r.unit_cost)
    return [
      r.order_no,
      r.pi_no,
      r.company,
      r.country,
      r.style_no,
      r.product_name,
      r.color,
      r.size,
      Number(r.quantity),
      money2(Number(r.unit_price)),
      money2(amount),
      unitCost == null ? '' : money2(unitCost),
      unitCost == null ? '' : money2(unitCost * Number(r.quantity)),
      r.currency,
      rate,
      money2(amount * rate),
      PAYMENT_STATUS_LABEL[String(r.payment_status) as keyof typeof PAYMENT_STATUS_LABEL] ?? r.payment_status,
      SHIP_STATUS_LABEL[String(r.ship_status) as keyof typeof SHIP_STATUS_LABEL] ?? r.ship_status,
      localDateOf(String(r.created_at)),
      money2(o?.goodsValue ?? 0),
      money2(o?.chargesTotal ?? 0),
      money2(o?.grandTotal ?? 0)
    ]
  })
  return toCsv(header, lines)
}

/** 月度汇总：与报表页同一份数（销售额按下单月、收款按到账月，列名里写清楚） */
function monthlyCsv(base: string): string {
  const header = [
    '月份',
    '订单数',
    `销售额(${base})`,
    `成本(${base})`,
    `毛利(${base})`,
    `折让(${base})`,
    `短款核销(${base})`,
    `坏账未追回(${base})`,
    '成本未录全单数',
    `收款(${base}·按到账月)`
  ]
  const lines = monthlyReport().map((r) => [
    r.month,
    r.orders,
    money2(r.sales),
    money2(r.cost),
    r.profit == null ? '' : money2(r.profit),
    money2(r.discount),
    money2(r.shortage),
    money2(r.badDebt),
    r.missingCostOrders,
    money2(r.received)
  ])
  return toCsv(header, lines)
}

/** 收款流水：现金流口径（草稿单的钱不算真收款），并带上订单状态——
 *  作废/失效单的钱确实到账了，但看的人得知道这单已经作废 */
function paymentsCsv(base: string): string {
  // 取数与月报到账同一份（cashFlowRows）：订单收款 + 打样实收。
  // 打样抵扣不落流水，这里也不会出现——同一笔钱只能有一条来路。
  const rows = cashFlowRows()
  // 「单据类型」加在最后一列：前面的列序是别人报表的下游约定，插在中间会错位
  const header = [
    '收款日期',
    '订单号',
    'PI号',
    '客户',
    '订单状态',
    '币种',
    '金额(原币)',
    `金额(${base})`,
    '方式',
    '银行流水号',
    '备注',
    '单据类型'
  ]
  const lines = rows.map((r) => [
    r.paidAt,
    r.docNo,
    r.piNo,
    r.customerName,
    r.statusText,
    r.currency,
    money2(r.amount),
    money2(r.amountBase),
    r.method,
    r.bankRef,
    r.note,
    r.docType === 'sample' ? '打样单' : '订单'
  ])
  return toCsv(header, lines)
}

/** 报表里用到的金额：四舍五入到分，但保持数字类型（负数不能被当成 Excel 公式加前缀） */
function money2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

/**
 * 客户对账单（R26）：发给客户看的那一份，和内部订单台账是两张表。
 *
 * 三件事必须成立：
 *   1. 不含成本、毛利、坏账未追回这类内部数字——这张表客户会拿去跟自己的水单核；
 *   2. 订单行取 listOrderMoney（含作废/失效，好让客户认得出已经付过钱的那张单），
 *      打样行取 sampleStatementRows，收款行取 cashFlowRows——全是现成口径，不另写 SQL；
 *   3. 表尾「未收」合计（折基准币）必须等于客户页的未收（customerReceivable）。
 *
 * 已收一律按单据汇率折算，与待收同一套数；每笔收款行只列原币到账额——
 * 拿逐笔快照去合计会和待收差一个汇兑差，对账单是应收账，不是现金流量表。
 */
function statementCsv(customerId: number, base: string): string {
  const today = localDate()
  const orders = listOrderMoney({ customerId, includeVoided: true }).filter(
    // 草稿还没发出去，客户手里没有这张单，别放上对账单
    (r) => r.paymentStatus !== 'draft'
  )
  const samples = sampleStatementRows(customerId)
  const flows = cashFlowRows({ customerId })
  if (orders.length === 0 && samples.length === 0 && flows.length === 0) {
    throw new Error('这家客户还没有订单或打样单，没有可对账的内容。')
  }

  type StatementRow = {
    kind: '订单' | '打样单' | '收款' | '合计' | '预收结余' | '预收退款'
    docNo: string
    piNo: string
    date: string
    status: string
    currency: string
    amount: number
    paid: number
    writtenOff: number
    open: number
    rate: number
    openBase: number
    method: string
    bankRef: string
    note: string
    /** 这张单里用客户预收抵掉的原币金额（非现金） */
    credit: number
  }
  const blank = {
    docNo: '',
    piNo: '',
    date: '',
    status: '',
    currency: '',
    amount: 0,
    paid: 0,
    writtenOff: 0,
    open: 0,
    rate: 0,
    openBase: 0,
    method: '',
    bankRef: '',
    note: '',
    credit: 0
  }

  const docs: StatementRow[] = []
  for (const r of orders) {
    const rate = Number(r.exchangeRate) || 0
    const open = shownRemaining(r.paymentStatus, r.receivable)
    const prepaid = r.remaining < -0.001 ? -r.remaining : 0
    const creditUsed = Number(r.creditApplied ?? 0)
    const notes: string[] = []
    if (!isBillingStatus(r.paymentStatus)) {
      notes.push(`此单${PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus}，不计应收；已到的钱仍是实收`)
      if (r.paidAmount > 0.001) notes.push(`实收 ${money2(r.paidAmount)} 已计入客户预收结余`)
    }
    if (r.negativeCharges < -0.001) notes.push(`含折让/抵扣 ${money2(r.negativeCharges)}（已计入单据金额）`)
    if (r.netWrittenOff > 0.001) notes.push(`其中已让利（短款/坏账核销）${money2(r.netWrittenOff)}`)
    if (creditUsed > 0.001) notes.push(`其中预收抵扣 ${money2(creditUsed)}（非现金，从客户预收余额冲减）`)
    if (open > 0.001 && rate <= 0) notes.push('汇率未填，未折算')
    if (prepaid > 0.001) notes.push(`实收比单据多 ${money2(prepaid)}（预收结余）`)
    docs.push({
      ...blank,
      kind: '订单',
      docNo: r.orderNo,
      piNo: r.piNo,
      date: localDateOf(r.createdAt),
      status: PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus,
      currency: r.currency,
      amount: money2(r.grandTotal),
      paid: money2(r.paidAmount),
      writtenOff: money2(r.netWrittenOff),
      open: money2(open),
      rate,
      openBase: rate > 0 ? money2(open * rate) : 0,
      note: notes.join('；'),
      credit: money2(creditUsed)
    })
  }
  for (const s of samples) {
    const rate = s.exchangeRate > 0 ? s.exchangeRate : 0
    const statusText = SAMPLE_STATUS_LABEL[s.status as keyof typeof SAMPLE_STATUS_LABEL] ?? s.status
    const feeText = SAMPLE_FEE_STATUS_LABEL[s.feeStatus as keyof typeof SAMPLE_FEE_STATUS_LABEL] ?? s.feeStatus
    const notes: string[] = []
    if (s.status === 'cancelled') {
      notes.push(`已取消，实收 ${money2(s.recovered)} 留在账上`)
      if (s.recovered > 0.001) notes.push('这笔实收已计入客户预收结余')
    } else if (s.feeStatus === 'waived') notes.push('客户免单，未收 0')
    else if (s.feeStatus === 'offset') {
      notes.push(`已抵扣入订单${s.convertedOrderNo ? ` ${s.convertedOrderNo}` : ''}（不是现金，但账上已收回）`)
    }
    if (s.feeStatus === 'unpaid' && s.recovered > 0.001) notes.push(`已收 ${money2(s.recovered)}`)
    if (s.creditApplied > 0.001) notes.push(`其中预收抵扣 ${money2(s.creditApplied)}（非现金，从客户预收余额冲减）`)
    if (s.open > 0.001 && rate <= 0) notes.push('汇率未填，未折算')
    if (s.prepaid > 0.001) notes.push(`实收比单据多 ${money2(s.prepaid)}（预收结余）`)
    docs.push({
      ...blank,
      kind: '打样单',
      docNo: s.sampleNo,
      date: s.sampleDate,
      status: `${statusText} · ${feeText}`,
      currency: s.currency,
      amount: money2(s.totalFee),
      paid: money2(s.recovered),
      open: money2(s.open),
      rate,
      openBase: rate > 0 ? money2(s.open * rate) : 0,
      note: notes.join('；'),
      credit: money2(s.creditApplied)
    })
  }
  docs.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.docNo.localeCompare(b.docNo))

  const payments: StatementRow[] = flows
    .map((f) => ({
      ...blank,
      kind: '收款' as const,
      docNo: f.docNo,
      piNo: f.piNo,
      date: f.paidAt,
      status: f.statusText,
      currency: f.currency,
      amount: money2(f.amount),
      rate: f.exchangeRate,
      method: f.method,
      bankRef: f.bankRef,
      note: f.note
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.docNo.localeCompare(b.docNo))

  // 多币种混在一列里没有意义：先按币种给原币小计，再给一行基准币的「未收」总数
  const totals: StatementRow[] = []
  const currencies = [...new Set(docs.map((d) => d.currency))].sort()
  for (const cur of currencies) {
    const rs = docs.filter((d) => d.currency === cur)
    totals.push({
      ...blank,
      kind: '合计',
      date: today,
      status: `${cur} 共 ${rs.length} 张单据`,
      currency: cur,
      amount: money2(rs.reduce((s, d) => s + d.amount, 0)),
      paid: money2(rs.reduce((s, d) => s + d.paid, 0)),
      writtenOff: money2(rs.reduce((s, d) => s + d.writtenOff, 0)),
      open: money2(rs.reduce((s, d) => s + d.open, 0))
    })
  }
  const openBaseTotal = money2(docs.reduce((s, d) => s + d.openBase, 0))
  totals.push({
    ...blank,
    kind: '合计',
    date: today,
    status: `截至 ${today}`,
    currency: base,
    openBase: openBaseTotal,
    note: '与客户页「未收」同一口径'
  })

  // 预收结余：多收的钱、作废/取消单留在账上的实收，都从 money.ts 的同一份余额派生，
  // 减去已经抵到别的单上的部分、也减去已经退还给客户的部分。
  // 压进待收会变负数，客户会以为我们算错了
  const credit = customerCreditBalance(customerId)
  const prepaidRows: StatementRow[] = credit.map((c) => {
    const parts = `来源 ${money2(c.gross)} − 已抵扣 ${money2(c.applied)}${c.refunded > 0.001 ? ` − 已退还 ${money2(c.refunded)}` : ''}`
    return {
      ...blank,
      kind: '预收结余',
      date: today,
      currency: c.currency,
      amount: money2(c.available),
      note:
        c.available < -0.001
          ? `预收出现缺口 ${money2(-c.available)}：${parts}。来源单据被改动过，请先在客户页核对抵扣/退还`
          : `可用 ${money2(c.available)}（${parts}）；可抵下张单或在客户页登记退还；不计入应收`
    }
  })
  // 已退还的钱是真实出口：单列一行负数，客户拿对账单能和我们汇出去的水单对上
  const refundRows: StatementRow[] = credit.flatMap((c) =>
    c.refunds.map((f) => ({
      ...blank,
      kind: '预收退款' as const,
      date: f.refundAt,
      currency: c.currency,
      amount: money2(-f.amount),
      bankRef: f.bankRef,
      note: `${f.note || '退还客户预收'}${f.actor ? `（${f.actor}）` : ''}`
    }))
  )

  const header = [
    '类型',
    '单据号',
    'PI号',
    '日期',
    '状态',
    '币种',
    '金额(原币)',
    '已收(原币)',
    '已让利(原币)',
    '未收(原币)',
    '汇率',
    `未收(${base})`,
    '方式',
    '银行流水号',
    '备注',
    '预收抵扣(原币)'
  ]
  const lines = [...docs, ...payments, ...refundRows, ...prepaidRows, ...totals].map((r) => {
    // 基准币合计行只有「未收(基准币)」这一列有意义：别的列写 0 会被当成「已收 0」
    const isBaseTotal = r.kind === '合计' && r.status.startsWith('截至')
    return [
      r.kind,
      r.docNo,
      r.piNo,
      r.date,
      r.status,
      r.currency,
      isBaseTotal ? '' : r.amount,
      isBaseTotal ? '' : r.paid,
      isBaseTotal ? '' : r.writtenOff,
      isBaseTotal ? '' : r.open,
      isBaseTotal ? '' : r.rate,
      r.openBase,
      r.method ? PAYMENT_METHOD_LABEL[r.method as keyof typeof PAYMENT_METHOD_LABEL] ?? r.method : '',
      r.bankRef,
      r.note,
      isBaseTotal ? '' : r.credit
    ]
  })
  return toCsv(header, lines)
}

/** 对账单默认文件名：客户名 + 截止日（同日导两家不能都叫「客户对账单_2026-10-26.csv」） */
export function statementFileName(customerId: number): string {
  const row = getDb().get('SELECT company FROM customers WHERE id = ?', [customerId]) as
    | { company?: string }
    | null
  const name = String(row?.company ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '客户'
  return `对账单_${name}_${localDate()}.csv`
}

/**
 * CSV 单元格。
 * 文本必须转义：客户名、品名、备注里带逗号或引号是常态，
 * 不转义整行会往后错位，Excel 里看就是一堆对不上的数。
 * 以 = + - @ 开头的文本要前置单引号，否则 Excel 会当公式执行（CSV 注入）。
 * 数字原样输出，不加引号也不加前缀，保证 Excel 里能直接求和。
 */
function csvCell(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = String(v ?? '')
  const guarded = /^[=+\-@\t]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** 拼 CSV：调用方只负责给每行的原始值，转义和 BOM 一律在这里做 */
function toCsv(header: string[], rows: unknown[][]): string {
  return (
    '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  )
}
