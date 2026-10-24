import { useEffect, useMemo, useState } from 'react'
import { money, moneyOrDash, num, fmtDate, PaymentTag, ShipTag, Button } from '../ui'
import type { DashboardStats, Reminder } from '../../../shared/types'

/** 待办类型的中文短标签（2 个字，扫一眼就知道该干什么） */
const REMINDER_KIND_LABEL: Record<string, string> = {
  confirm: '确认',
  payment: '收款',
  ship: '出货',
  balance: '尾款',
  sample: '打样',
  expiry: '到期',
  quote: '报价',
  data: '待修'
}

/** 提醒点到哪儿去：打样/报价回各自的列表页并带上单号，其余进订单详情 */
function reminderTarget(r: Reminder): string | null {
  if (r.kind === 'sample') return `/samples?kw=${encodeURIComponent(r.orderNo)}`
  if (r.kind === 'quote') return `/quotations?kw=${encodeURIComponent(r.orderNo)}`
  return r.orderId > 0 ? `/orders/${r.orderId}` : null
}

const REFRESH_MS = 60000

export default function Dashboard({ onNavigate }: { onNavigate: (p: string) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [recent, setRecent] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  /** 展开过的「同一单多条事由」（key 是单号，收起状态不落库，刷新后回到默认） */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [s, r, o] = await Promise.all([
          window.api.dashboard.stats(),
          window.api.dashboard.reminders(),
          window.api.orders.list({})
        ])
        if (!alive) return
        setStats(s)
        setReminders(r)
        setRecent(o.slice(0, 10))
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    // 工作台是「早上打开看一眼」的页面：交期与天数每天都在动，挂着不刷新就成了昨日新闻
    const timer = setInterval(load, REFRESH_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // 同一张单的几条事由挨着放：默认只摊开最要紧的一条，其余点「还有 N 条」再看
  const groups = useMemo(() => {
    const out: { orderNo: string; items: Reminder[] }[] = []
    const index = new Map<string, number>()
    for (const r of reminders) {
      const at = index.get(r.orderNo)
      if (at === undefined) {
        index.set(r.orderNo, out.length)
        out.push({ orderNo: r.orderNo, items: [r] })
      } else {
        out[at].items.push(r)
      }
    }
    return out
  }, [reminders])

  const overdueCount = reminders.filter((r) => r.days < 0).length
  const dataCount = reminders.filter((r) => r.kind === 'data').length

  const cur = stats?.currency ?? 'CNY'

  const toggleGroup = (orderNo: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(orderNo)) next.delete(orderNo)
      else next.add(orderNo)
      return next
    })

  const row = (r: Reminder, nested: boolean) => {
    const target = reminderTarget(r)
    return (
      <div
        key={r.key}
        className={`reminder-item${nested ? ' nested' : ''}`}
        onClick={() => target && onNavigate(target)}
      >
        <span className={`reminder-dot ${r.kind}`} />
        {/* R2-P1：圆点只靠颜色认不出来（红/黄分不清），加一个 2 字文字标签 */}
        <span className={`reminder-tag ${r.kind}`}>{REMINDER_KIND_LABEL[r.kind] ?? '待办'}</span>
        <div className="reminder-main">
          <div className="reminder-title">{nested ? r.customerName : `${r.customerName} · ${r.orderNo}`}</div>
          <div className="reminder-sub">{r.message}</div>
        </div>
        {/* 「待修」没有期限概念，别给它挂个假的「0 天」 */}
        {r.kind === 'data' ? null : (
          <span className="faint nowrap">{r.days < 0 ? `逾期 ${-r.days} 天` : `${r.days} 天`}</span>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>工作台</h1>
        <div className="spacer" />
        <Button  onClick={() => onNavigate('/orders')}>
          查看全部订单
        </Button>
        <Button variant="primary"  onClick={() => onNavigate('/orders?new=1')}>
          + 新建订单
        </Button>
      </div>

      <div className="content">
        <div className="stat-grid">
          {/* R4-S1：统计卡默认全黑；一屏最多 1 张卡上色。
              卡 2「待收款金额」用橙（钱还没到手，要动手），是本屏唯一的彩色卡；
              卡 3「待出货订单」是订单数不是钱，去掉强调色。 */}
          <div className="stat">
            <div className="stat-label">在途订单</div>
            <div className="stat-value">{stats?.activeOrders ?? 0}</div>
            <div className="stat-hint">未结清的订单总数</div>
          </div>
          <div className="stat amber">
            <div className="stat-label">待收款金额</div>
            <div className="stat-value">{money(stats?.pendingAmount, cur)}</div>
            {/* N37：口径含打样费，说明必须跟着数走（money.ts 唯一入口）
                R6：拆成四桶给一眼看清楚该催谁——合计仍等于上面这个数 */}
            <div className="stat-hint">
              未确认 {money(stats?.pendingUnconfirmed, cur)} · 定金 {money(stats?.pendingDeposit, cur)} · 尾款{' '}
              {money(stats?.pendingBalance, cur)} · 打样 {money(stats?.pendingSample, cur)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">待出货订单</div>
            <div className="stat-value">{stats?.pendingShipOrders ?? 0}</div>
            <div className="stat-hint">尚未签收</div>
          </div>
          <div className="stat">
            <div className="stat-label">本月销售额</div>
            <div className="stat-value">{money(stats?.monthSales, cur)}</div>
            <div className="stat-hint">
              新订单 {stats?.monthNewOrders ?? 0} 单 · 毛利{' '}
              {stats?.monthProfitReliable ? money(stats?.monthProfit, cur) : '—'}
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h2>待办提醒</h2>
              <div className="spacer" />
              {overdueCount > 0 ? <span className="tag red">逾期 {overdueCount} 项</span> : null}
              {dataCount > 0 ? <span className="tag grey">待修 {dataCount}</span> : null}
              {reminders.length > 0 ? <span className="tag">{reminders.length} 项</span> : null}
            </div>
            <div className="card-body tight">
              {loading ? (
                <div className="empty loading">加载中…</div>
              ) : reminders.length === 0 ? (
                <div className="empty">没有待办事项，一切顺利</div>
              ) : (
                groups.map((g) => {
                  const open = openGroups.has(g.orderNo)
                  return (
                    <div key={g.orderNo}>
                      {row(g.items[0], false)}
                      {g.items.length > 1 ? (
                        <div className="reminder-more" onClick={() => toggleGroup(g.orderNo)}>
                          {open
                            ? `收起 ${g.orderNo} 的其余待办`
                            : `${g.orderNo} 还有 ${g.items.length - 1} 条待办（点开看）`}
                        </div>
                      ) : null}
                      {open ? g.items.slice(1).map((r) => row(r, true)) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>本月收款</h2>
              <div className="spacer" />
              <span className="faint">到账合计</span>
            </div>
            <div className="card-body">
              <div className="stat-value small" style={{ marginBottom: 6 }}>
                {money(stats?.monthReceived, cur)}
              </div>
              <div className="price-calc">
                <div>
                  <span className="muted">本月销售额</span>
                  <span>{money(stats?.monthSales, cur)}</span>
                </div>
                <div>
                  <span className="muted">本月毛利</span>
                  <span>{stats?.monthProfitReliable ? money(stats?.monthProfit, cur) : '—'}</span>
                </div>
                {!stats?.monthProfitReliable ? (
                  <div>
                    <span className="muted">说明</span>
                    <span>本月有单成本没录全，毛利不可信（宁可给你「—」）</span>
                  </div>
                ) : null}
                <div>
                  <span className="muted">本月完成（已签收）</span>
                  <span>{stats?.completedThisMonth ?? 0} 单</span>
                </div>
                {/* R2：核销掉的坏账不是收进了口袋，是从应收里挪走的窟窿，工作台必须一直摆着 */}
                <div>
                  <span className="muted">坏账未追回</span>
                  <span>{money(stats?.outstandingBadDebt, cur)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>最近订单</h2>
            <div className="spacer" />
            <Button size="sm"  onClick={() => onNavigate('/orders')}>
              全部
            </Button>
          </div>
          <div className="card-body tight">
            {recent.length === 0 ? (
              <div className="empty">还没有订单。点右上角「新建订单」开始录入。</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>订单号</th>
                      <th>客户</th>
                      <th className="num">金额</th>
                      <th className="num">件数</th>
                      <th>收款状态</th>
                      <th>出货状态</th>
                      <th>创建日期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((o) => (
                      <tr key={o.id} className="clickable" onClick={() => onNavigate(`/orders/${o.id}`)}>
                        <td className="mono">{o.orderNo}</td>
                        <td>{o.customer?.company}</td>
                        <td
                          className="num nowrap"
                          title={
                            o.grandTotal === 0 && (o.totalAmount ?? 0) > 0
                              ? '含费用合计为 0：货值被样品费抵扣 / 折让抵掉了'
                              : '含费用合计（货值 + 运费等费用）'
                          }
                        >
                          {/* N38：这一列印「含费用合计」（货值+费用，与 PI/CI/存档/订单详情同一个数，
不能印货值——同一个单在两个页面上两个数，她截图发群里就会张口报错数）
R2-P2：没录数据显示「—」；真的 0 仍然是 0.00（悬浮有说明） */}
                          {moneyOrDash(o.grandTotal ?? o.totalAmount, o.currency)}
                        </td>
                        <td className="num nowrap">{num(o.totalQuantity)} 件</td>
                        <td>
                          <PaymentTag status={o.paymentStatus} />
                        </td>
                        <td>
                          <ShipTag status={o.shipStatus} />
                        </td>
                        <td className="nowrap faint">{fmtDate(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
