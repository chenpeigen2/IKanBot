import { getDb } from '../db'
import { mapDashboard, mapMonthlyReport } from '../db/mappers'
import { getSettings } from './settings'
import {
  CASHFLOW_EXCLUDED_STATUSES,
  EXCLUDED_STATUSES,
  listOrderMoney,
  notInStatuses,
  sampleReceivable
} from './money'
import { isLocalDate, localDate, localDateOf } from '../../src/shared/date'
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, SHIP_STATUS_LABEL } from '../../src/shared/types'
import type { DashboardStats, MonthlyReportRow, Reminder } from '../../src/shared/types'

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

  // 两个口径各用一个常量：作废/失效单不进销售与在途，但真收到的钱留在现金流里
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
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
             WHEN EXISTS (SELECT 1 FROM packing_lists pl WHERE pl.order_id = o2.id AND pl.ship_status IS NOT NULL)
               THEN CASE
                 WHEN EXISTS (SELECT 1 FROM packing_lists pl2
                              WHERE pl2.order_id = o2.id AND pl2.ship_status IS NOT NULL AND pl2.ship_status != 'delivered')
                   THEN NULL
                 ELSE (SELECT MAX(pl3.delivered_at) FROM packing_lists pl3
                       WHERE pl3.order_id = o2.id AND pl3.ship_status = 'delivered' AND pl3.delivered_at IS NOT NULL)
               END
             WHEN o2.ship_status = 'delivered'
               THEN (SELECT date(MAX(e.at), 'localtime') FROM order_events e
                     WHERE e.order_id = o2.id AND e.kind = 'ship_status' AND e.to_status = 'delivered')
             ELSE NULL
           END AS done_at
         FROM orders o2
       ) WHERE done_at IS NOT NULL AND date(done_at) >= date(?)) AS completed_this_month,
      (SELECT COALESCE(SUM(p.amount * o.exchange_rate), 0) FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE date(p.paid_at) >= date(?) AND ${cash.sql}) AS month_received,
      (SELECT COUNT(*) FROM orders WHERE date(created_at, 'localtime') >= date(?) AND ${sales.sql}) AS month_new_orders`,
    [...openOrder.params, ...sales.params, mStart, mStart, ...cash.params, mStart, ...sales.params]
  ) as Record<string, unknown>

  return {
    ...mapDashboard({
      ...(row ?? {}),
      pending_amount: pendingAmount,
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
    const depositDue = Math.max(0, Math.min(r.receivable, r.depositAmount - r.paidAmount))
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
     WHERE ${notGone.sql}`,
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
      const deliveredQty = Number(
        (db.get(
          `SELECT COALESCE(SUM(l.quantity),0) AS q FROM packing_list_lines l
           JOIN packing_lists pl ON pl.id = l.packing_list_id
           WHERE pl.order_id = ? AND pl.ship_status IS NOT NULL`,
          [orderId]
        ) as { q?: number })?.q ?? 0
      )
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
    const since = shipClock.get(r.orderId) ?? String(row.updated_at ?? '')
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
    `SELECT q.q_no, q.created_at, q.sent_at, q.valid_until, q.status, c.company AS customer_name
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.status = 'sent' AND q.converted_order_id IS NULL`
  ) as Record<string, unknown>[]) {
    const qNo = String(q.q_no)
    const who = String(q.customer_name)
    const days = daysFrom(String(q.sent_at ?? '') || String(q.created_at ?? ''))
    if (days !== null && days >= s.remindConfirmDays) {
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
                      WHERE si.sample_order_id = s.id), 0) AS sample_fee
     FROM sample_orders s JOIN customers c ON c.id = s.customer_id
     WHERE s.status != 'cancelled'`
  ) as Record<string, unknown>[]
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
    const owed = Number(r.sample_fee ?? 0) + Number(r.express_fee ?? 0)
    if (owed <= 0) continue
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

  // 逾期最前（越久越靠前）→ 按还剩几天升序 → 「待修」垫底：
  // 待修不会到期，错过船期是真金白银；界面右上角另给「待修 N」计数，不会被埋掉
  const rank = (r: Reminder): number => (r.days < 0 ? r.days : r.kind === 'data' ? 100000 : 1000 + r.days)
  out.sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.orderNo.localeCompare(b.orderNo))
  return out
}

/**
 * 按月统计报表（金额统一折算为基准币）。
 * 销售额/成本/毛利按订单创建月份归集；收款按实际收款月份归集。
 *
 * 口径统一走 services/money.ts：货值 / 成本 / 毛利都跟订单详情、客户页、工作台同一套。
 * 成本没录全的月份，毛利一律给 null（不可信），不许拿 0 成本凑一个漂亮的数。
 */
export function monthlyReport(): MonthlyReportRow[] {
  const db = getDb()
  // 销售额 / 成本 / 毛利：按订单创建月份（用 money.ts 的同一套计算）
  // 销售额 = 含费用合计（与 PI 上的 TOTAL 一致，老板对账不用自己加运费）
  const rows = listOrderMoney()
  interface MonthAcc {
    month: string
    orders: number
    sales: number
    cost: number
    profit: number
    received: number
    missingCostOrders: number
  }
  const byMonth = new Map<string, MonthAcc>()
  for (const r of rows) {
    const cur: MonthAcc = byMonth.get(r.month) ?? {
      month: r.month,
      orders: 0,
      sales: 0,
      cost: 0,
      profit: 0,
      received: 0,
      missingCostOrders: 0
    }
    cur.orders += 1
    cur.sales += r.grandTotalBase
    cur.cost += r.totalCost * r.exchangeRate
    cur.profit += r.profitRaw * r.exchangeRate
    if (r.missingCostItems > 0) cur.missingCostOrders += 1
    byMonth.set(r.month, cur)
  }

  // 收款：按实际收款月份归集。现金流口径只排除草稿单——
  // 作废/失效的单钱真到账了就是到账了，这里必须留着（销售和待收那边才排除）
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
  const payRows = db.all(
    `SELECT strftime('%Y-%m', p.paid_at) AS month,
            COALESCE(SUM(p.amount * o.exchange_rate), 0) AS received
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${cash.sql}
     GROUP BY month`,
    cash.params
  ) as Record<string, unknown>[]
  for (const p of payRows) {
    const m = String(p.month)
    const cur: MonthAcc = byMonth.get(m) ?? {
      month: m,
      orders: 0,
      sales: 0,
      cost: 0,
      profit: 0,
      received: 0,
      missingCostOrders: 0
    }
    cur.received += Number(p.received ?? 0)
    byMonth.set(m, cur)
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
        received: r.received,
        missing_cost_orders: r.missingCostOrders
      })
    )
}

/** 导出 Excel（CSV，UTF-8 BOM，Excel 直接可打开） */
export function exportCsv(kind: 'orders' | 'payments' | 'items'): string {
  const db = getDb()
  const base = getSettings().baseCurrency
  if (kind === 'orders') {
    // 金额口径走 services/money.ts（唯一真源）：货值 / 费用 / 含费用合计 / 已收 / 待收
    const rows = listOrderMoney({ includeVoided: true })
    const header = [
      '订单号',
      'PI号',
      '客户',
      '国家',
      '币种',
      '汇率',
      '收款状态',
      '出货状态',
      '贸易术语',
      '装运港',
      '目的港',
      '付款方式',
      '客户PO号',
      '预计出货日',
      '创建日期',
      '货值(原币)',
      '费用合计(原币)',
      '含费用合计(原币)',
      '已收金额(原币)',
      '待收金额(原币)',
      '短款核销(原币)',
      '坏账核销(原币)',
      '坏账未追回(原币)',
      `含费用合计(${base})`,
      `已收金额(${base})`,
      `待收金额(${base})`
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
        PAYMENT_STATUS_LABEL[r.paymentStatus as keyof typeof PAYMENT_STATUS_LABEL] ?? r.paymentStatus,
        SHIP_STATUS_LABEL[r.shipStatus as keyof typeof SHIP_STATUS_LABEL] ?? r.shipStatus,
        r.incoterm,
        r.portOfLoading,
        r.portOfDestination,
        r.paymentMethod,
        r.customerPo,
        r.expectedShipDate ?? '',
        localDateOf(r.createdAt),
        r.goodsValue.toFixed(2),
        r.chargesTotal.toFixed(2),
        r.grandTotal.toFixed(2),
        r.paidAmount.toFixed(2),
        r.receivable.toFixed(2),
        r.shortageAmount.toFixed(2),
        r.badDebtAmount.toFixed(2),
        r.badDebtOutstanding.toFixed(2),
        (r.grandTotal * rate).toFixed(2),
        (r.paidAmount * rate).toFixed(2),
        (r.receivable * rate).toFixed(2)
      ].join(',')
    })
    return toCsv(header, lines)
  }

  if (kind === 'items') {
    // 按款号×颜色×尺码 的明细台账：退税、对账、报关核数用
    const sales = notInStatuses('o.payment_status', EXCLUDED_STATUSES)
    const rows = db.all(
      `SELECT o.order_no, o.pi_no, c.company, c.country, o.currency, o.exchange_rate,
              o.payment_status, o.ship_status, o.created_at,
              oi.style_no, oi.product_name, oi.color, oi.size, oi.quantity, oi.unit_price,
              (oi.quantity * oi.unit_price) AS amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id
       WHERE ${sales.sql}
       ORDER BY o.created_at DESC, oi.style_no, oi.color, oi.size`,
      sales.params
    ) as Record<string, unknown>[]
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
      '币种',
      '汇率',
      `金额(${base})`,
      '收款状态',
      '出货状态',
      '创建日期'
    ]
    const lines = rows.map((r) => {
      const rate = Number(r.exchange_rate)
      const amount = Number(r.amount)
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
        Number(r.unit_price).toFixed(2),
        amount.toFixed(2),
        r.currency,
        rate,
        (amount * rate).toFixed(2),
        r.payment_status,
        r.ship_status,
        localDateOf(String(r.created_at))
      ].join(',')
    })
    return toCsv(header, lines)
  }

  // 收款流水：现金流口径（草稿单的钱不算真收款），并带上订单状态——
  // 作废/失效单的钱确实到账了，但看的人得知道这单已经作废
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
  const rows = db.all(
    `SELECT p.paid_at, o.order_no, o.pi_no, o.payment_status, c.company, o.currency, o.exchange_rate,
            p.amount, p.method, p.bank_ref, p.note
     FROM payments p JOIN orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id
     WHERE ${cash.sql}
     ORDER BY p.paid_at DESC`,
    cash.params
  ) as Record<string, unknown>[]
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
    '备注'
  ]
  const lines = rows.map((r) =>
    [
      r.paid_at,
      r.order_no,
      r.pi_no,
      r.company,
      r.payment_status,
      r.currency,
      Number(r.amount).toFixed(2),
      (Number(r.amount) * Number(r.exchange_rate)).toFixed(2),
      r.method,
      r.bank_ref,
      r.note
    ].join(',')
  )
  return toCsv(header, lines)
}

function toCsv(header: string[], lines: string[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return (
    '﻿' + [header.map(esc).join(','), ...lines.map((l) => l)].join('\r\n') + '\r\n'
  )
}
