import { getDb } from '../db'
import { mapDashboard, mapMonthlyReport } from '../db/mappers'
import { getSettings } from './settings'
import {
  CASHFLOW_EXCLUDED_STATUSES,
  EXCLUDED_STATUSES,
  listOrderMoney,
  notInStatuses,
  totalReceivable
} from './money'
import { localDate, localDateOf } from '../../src/shared/date'
import { PAYMENT_STATUS_LABEL, SHIP_STATUS_LABEL } from '../../src/shared/types'
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

  // 待收款金额 = Σ(含费用合计 − 已收)，折算成基准币
  const pendingAmount = totalReceivable()

  // 本月毛利：本月的单只要有一单成本没录全，毛利就不可信 → null（界面显示「—」）
  const monthMissingCost = monthRows.some((r) => r.missingCostItems > 0)
  const monthProfitRaw = monthRows.reduce((s, r) => s + (r.profitRaw * r.exchangeRate), 0)
  const monthProfit = monthMissingCost ? null : monthProfitRaw

  // 两个口径各用一个常量：作废/失效单不进销售与在途，但真收到的钱留在现金流里
  const cash = notInStatuses('o.payment_status', CASHFLOW_EXCLUDED_STATUSES)
  const sales = notInStatuses('payment_status', EXCLUDED_STATUSES)
  const row = db.get(
    `SELECT
      (SELECT COUNT(*) FROM orders WHERE payment_status NOT IN ('settled','expired','draft','void')) AS active_orders,
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
             WHEN o2.ship_status = 'delivered' THEN date(o2.updated_at, 'localtime')
             ELSE NULL
           END AS done_at
         FROM orders o2
       ) WHERE done_at IS NOT NULL AND date(done_at) >= date(?)) AS completed_this_month,
      (SELECT COALESCE(SUM(p.amount * o.exchange_rate), 0) FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE date(p.paid_at) >= date(?) AND ${cash.sql}) AS month_received,
      (SELECT COUNT(*) FROM orders WHERE date(created_at, 'localtime') >= date(?) AND ${sales.sql}) AS month_new_orders`,
    [...sales.params, mStart, mStart, ...cash.params, mStart, ...sales.params]
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
    currency: settings.baseCurrency
  }
}

/**
 * 待办提醒规则：
 *  1. PI 已发送超过 N 天未确认 → 催确认
 *  2. 客户已确认超过 N 天仍未收定金 → 催款
 *  3. 距预计出货日 ≤ N 天仍未到"已包装" → 催备货
 *  4. 已收过钱但未收齐，超过 N 天 → 催尾款
 */
export function reminders(): Reminder[] {
  const db = getDb()
  const s = getSettings()
  const today = localDate()
  const out: Reminder[] = []

  const sentRows = db.all(
    `SELECT o.id, o.order_no, o.updated_at, o.created_at, c.company AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.payment_status = 'sent'`
  ) as Record<string, unknown>[]
  for (const r of sentRows) {
    const days = daysSince(String(r.updated_at) || String(r.created_at))
    if (days >= s.remindConfirmDays) {
      out.push({
        orderId: Number(r.id),
        orderNo: String(r.order_no),
        customerName: String(r.customer_name),
        kind: 'confirm',
        message: `PI 已发出 ${days} 天，客户未确认`,
        days
      })
    }
  }

  const payRows = db.all(
    `SELECT o.id, o.order_no, o.updated_at, o.created_at, c.company AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.payment_status = 'confirmed'`
  ) as Record<string, unknown>[]
  for (const r of payRows) {
    const days = daysSince(String(r.updated_at) || String(r.created_at))
    if (days >= s.remindPaymentDays) {
      out.push({
        orderId: Number(r.id),
        orderNo: String(r.order_no),
        customerName: String(r.customer_name),
        kind: 'payment',
        message: `客户已确认 ${days} 天，定金未到账`,
        days
      })
    }
  }

  // 出货提醒按批次走：一张单分两批，就各提醒各的，别拿整单一个状态糊过去。
  // 只提醒「已经有明细、但还没出运」的批次；老批次（ship_status 为 NULL）走下面的老逻辑。
  // 出货提醒只排除已失效/已作废：草稿单也可能已经有船期，不能装看不见
  const sales = notInStatuses('o.payment_status', ['expired', 'void'])
  const openBatch = `pl.ship_status IS NOT NULL AND pl.ship_status NOT IN ('shipped','cleared','delivered')
       AND EXISTS (SELECT 1 FROM packing_list_lines l WHERE l.packing_list_id = pl.id)`

  const batchRows = db.all(
    `SELECT pl.id AS pl_id, pl.pl_no, pl.container_no, pl.etd_date,
            o.id, o.order_no, c.company AS customer_name
     FROM packing_lists pl
     JOIN orders o ON o.id = pl.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE ${openBatch}
       AND pl.etd_date IS NOT NULL AND pl.etd_date != ''
       AND ${sales.sql}`,
    sales.params
  ) as Record<string, unknown>[]
  for (const r of batchRows) {
    const due = String(r.etd_date)
    const diff = daysBetween(today, due)
    if (diff > s.remindShipDays) continue
    const plNo = String(r.pl_no)
    const container = String(r.container_no ?? '')
    out.push({
      orderId: Number(r.id),
      orderNo: String(r.order_no),
      customerName: String(r.customer_name),
      kind: 'ship',
      plId: Number(r.pl_id),
      plNo,
      message: `批次 ${plNo}：${
        diff < 0 ? `ETD ${due} 已逾期 ${-diff} 天` : `ETD ${due} 还有 ${diff} 天`
      }，还没标记出运${container ? `（柜号 ${container}）` : ''}`,
      days: diff
    })
  }

  // 有未出运批次、但批次还没填 ETD：别因为建了装箱单就把整单的交期提醒吞掉
  const pendingRows = db.all(
    `SELECT o.id, o.order_no, o.expected_ship_date, c.company AS customer_name,
            (SELECT COUNT(*) FROM packing_lists pl WHERE pl.order_id = o.id AND ${openBatch}) AS open_batches,
            (SELECT COUNT(*) FROM packing_lists pl WHERE pl.order_id = o.id AND ${openBatch}
               AND (pl.etd_date IS NULL OR pl.etd_date = '')) AS undated_batches
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.expected_ship_date IS NOT NULL AND o.expected_ship_date != ''
       AND ${sales.sql}`,
    [...sales.params]
  ) as Record<string, unknown>[]
  for (const r of pendingRows) {
    if (Number(r.open_batches) === 0 || Number(r.undated_batches) === 0) continue
    const due = String(r.expected_ship_date)
    const diff = daysBetween(today, due)
    if (diff > s.remindShipDays) continue
    out.push({
      orderId: Number(r.id),
      orderNo: String(r.order_no),
      customerName: String(r.customer_name),
      kind: 'ship',
      message: `距预计出货日 ${due} ${diff < 0 ? `已逾期 ${-diff} 天` : `还有 ${diff} 天`}，还有 ${
        Number(r.undated_batches)
      } 个批次没出运（批次还没填 ETD）`,
      days: diff
    })
  }

  // 工厂交期：货还没装够就提醒；装完了工厂交期自然不再催
  const factoryRows = db.all(
    `SELECT o.id, o.order_no, o.factory_due_date, c.company AS customer_name,
            COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id AND oi.quantity > 0), 0) AS ordered,
            COALESCE((SELECT SUM(l.quantity) FROM packing_list_lines l
                      JOIN packing_lists pl ON pl.id = l.packing_list_id WHERE pl.order_id = o.id), 0) AS packed
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.factory_due_date IS NOT NULL AND o.factory_due_date != ''
       AND o.ship_status NOT IN ('shipped','cleared','delivered')
       AND ${sales.sql}`,
    sales.params
  ) as Record<string, unknown>[]
  for (const r of factoryRows) {
    const ordered = Number(r.ordered ?? 0)
    const packed = Number(r.packed ?? 0)
    if (ordered <= 0 || packed + 0.0001 >= ordered) continue
    const due = String(r.factory_due_date)
    const diff = daysBetween(today, due)
    if (diff > s.remindShipDays) continue
    out.push({
      orderId: Number(r.id),
      orderNo: String(r.order_no),
      customerName: String(r.customer_name),
      kind: 'ship',
      message: `工厂交期 ${due} ${diff < 0 ? `已逾期 ${-diff} 天` : `还有 ${diff} 天`}，货还没装完（已装 ${packed} / ${ordered} 件）`,
      days: diff
    })
  }

  // 截关日：还有批次没走就提醒；没有未出运批次的不打扰
  const cutoffRows = db.all(
    `SELECT o.id, o.order_no, o.cut_off_date, c.company AS customer_name,
            (SELECT COUNT(*) FROM packing_lists pl WHERE pl.order_id = o.id AND ${openBatch}) AS open_batches
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.cut_off_date IS NOT NULL AND o.cut_off_date != ''
       AND ${sales.sql}`,
    sales.params
  ) as Record<string, unknown>[]
  for (const r of cutoffRows) {
    const open = Number(r.open_batches ?? 0)
    if (open <= 0) continue
    const due = String(r.cut_off_date)
    const diff = daysBetween(today, due)
    if (diff > s.remindShipDays) continue
    out.push({
      orderId: Number(r.id),
      orderNo: String(r.order_no),
      customerName: String(r.customer_name),
      kind: 'ship',
      message: `截关日 ${due} ${diff < 0 ? `已逾期 ${-diff} 天` : `还有 ${diff} 天`}，还有 ${open} 个批次没出运`,
      days: diff
    })
  }

  // 老单（没有可推导批次）保留原来按预计出货日的提醒
  const shipRows = db.all(
    `SELECT o.id, o.order_no, o.expected_ship_date, c.company AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.expected_ship_date IS NOT NULL AND o.expected_ship_date != ''
       AND o.ship_status NOT IN ('packed','shipped','cleared','delivered','partial_shipped')
       AND NOT EXISTS (
         SELECT 1 FROM packing_lists pl WHERE pl.order_id = o.id AND ${openBatch}
       )
       AND ${sales.sql}`,
    sales.params
  ) as Record<string, unknown>[]
  for (const r of shipRows) {
    const due = String(r.expected_ship_date)
    const diff = daysBetween(today, due)
    if (diff <= s.remindShipDays) {
      out.push({
        orderId: Number(r.id),
        orderNo: String(r.order_no),
        customerName: String(r.customer_name),
        kind: 'ship',
        message: diff < 0 ? `预计出货日 ${due} 已逾期 ${-diff} 天` : `距预计出货日 ${due} 还有 ${diff} 天`,
        days: diff
      })
    }
  }

  // 催尾款：已经收过定金但还没收齐，超过阈值就提醒。
  // 金额口径必须走 money.ts：短款核销/坏账之后的待收在这里也要消失，
  // 否则钱已经平了，工作台还在天天催。
  const lastPaid = new Map<number, string>()
  for (const p of db.all(
    `SELECT order_id, MAX(paid_at) AS last_paid FROM payments GROUP BY order_id`
  ) as Record<string, unknown>[]) {
    lastPaid.set(Number(p.order_id), String(p.last_paid ?? ''))
  }
  for (const r of listOrderMoney({ onlyStatuses: ['partial', 'paid'] })) {
    if (r.paidAmount <= 0 || r.receivable <= 0.001) continue
    const since = lastPaid.get(r.orderId) || r.createdAt
    const days = daysSince(since)
    if (days < s.remindBalanceDays) continue
    out.push({
      orderId: r.orderId,
      orderNo: r.orderNo,
      customerName: r.customerName,
      kind: 'balance',
      message: `已收 ${r.paidAmount.toFixed(2)} / 待收 ${r.receivable.toFixed(2)}，尾款 ${days} 天未到账`,
      days
    })
  }

  // 催打样费（N23）：公司垫的样品费+快递费，超过阈值还没收 → 提醒。
  // 注意：汇率没填的单折不准，不计入待收，但这里必须亮出来——否则就是又一个悄悄少算的数。
  const sampleRows = db.all(
    `SELECT s.id, s.sample_no, s.sample_date, s.created_at, s.currency, s.exchange_rate, s.express_fee, c.company AS customer_name,
            COALESCE((SELECT SUM(si.quantity * si.unit_price) FROM sample_order_items si
                      WHERE si.sample_order_id = s.id), 0) AS sample_fee
     FROM sample_orders s JOIN customers c ON c.id = s.customer_id
     WHERE s.fee_status = 'unpaid' AND s.status != 'cancelled'`
  ) as Record<string, unknown>[]
  for (const r of sampleRows) {
    const owed = Number(r.sample_fee ?? 0) + Number(r.express_fee ?? 0)
    if (owed <= 0) continue
    const since = String(r.sample_date || r.created_at || '')
    const days = daysSince(since)
    const rate = Number(r.exchange_rate ?? 0)
    if (days < s.remindPaymentDays) continue
    out.push({
      orderId: 0,
      orderNo: String(r.sample_no),
      customerName: String(r.customer_name),
      kind: 'sample',
      message:
        rate > 0
          ? `打样费 ${owed.toFixed(2)} ${String(r.currency || 'USD')} 未收（折合 ${(owed * rate).toFixed(2)}），样品寄出 ${days} 天`
          : `打样费 ${owed.toFixed(2)} ${String(r.currency || 'USD')} 未收，且汇率未填（工作台待收里少算了这单，请补汇率）`,
      days,
      sampleId: Number(r.id)
    })
  }

  out.sort((a, b) => a.kind.localeCompare(b.kind) || b.days - a.days)
  return out
}

function daysSince(iso: string): number {  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return Math.floor((Date.now() - t) / 86400000)
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(a + 'T00:00:00').getTime()
  const tb = new Date(b + 'T00:00:00').getTime()
  return Math.round((tb - ta) / 86400000)
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
