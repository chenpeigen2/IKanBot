import { useEffect, useState } from 'react'
import { money, moneyOrDash, num, fmtDate, PaymentTag, ShipTag, Button } from '../ui'
import type { DashboardStats, Reminder } from '../../../shared/types'

/** 待办类型的中文短标签（2 个字，扫一眼就知道该干什么） */
const REMINDER_KIND_LABEL: Record<string, string> = {
  confirm: '确认',
  payment: '收款',
  ship: '出货',
  balance: '尾款',
  sample: '打样'
}

export default function Dashboard({ onNavigate }: { onNavigate: (p: string) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [recent, setRecent] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

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
    return () => {
      alive = false
    }
  }, [])

  const cur = stats?.currency ?? 'CNY'

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
            {/* N37：口径含打样费，说明必须跟着数走（money.ts 唯一入口） */}
            <div className="stat-hint">含未收定金、尾款与打样费</div>
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
              {reminders.length > 0 ? <span className="tag red">{reminders.length} 项</span> : null}
            </div>
            <div className="card-body tight">
              {loading ? (
                <div className="empty loading">加载中…</div>
              ) : reminders.length === 0 ? (
                <div className="empty">没有待办事项，一切顺利</div>
              ) : (
                reminders.map((r) => (
                  <div
                    key={`${r.kind}-${r.orderId}-${r.sampleId ?? 0}`}
                    className="reminder-item"
                    onClick={() =>
                      // 打样提醒（N23）跳打样单页；其余跳订单详情
                      onNavigate(r.kind === 'sample' ? '/samples' : `/orders/${r.orderId}`)
                    }
                  >
                    <span className={`reminder-dot ${r.kind}`} />
                    {/* R2-P1：圆点只靠颜色认不出来（红/黄分不清），加一个 2 字文字标签 */}
                    <span className={`reminder-tag ${r.kind}`}>{REMINDER_KIND_LABEL[r.kind] ?? '待办'}</span>
                    <div className="reminder-main">
                      <div className="reminder-title">
                        {r.customerName} · {r.orderNo}
                      </div>
                      <div className="reminder-sub">{r.message}</div>
                    </div>
                    <span className="faint nowrap">{r.kind === 'ship' ? fmtDate(null) : `${r.days} 天`}</span>
                  </div>
                ))
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
