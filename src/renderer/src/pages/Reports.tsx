import { useEffect, useState } from 'react'
import { useToast, money, Empty } from '../ui'
import type { MonthlyReportRow } from '../../../shared/types'

export default function Reports() {
  const toast = useToast()
  const [rows, setRows] = useState<MonthlyReportRow[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const [r, s] = await Promise.all([window.api.report.monthly(), window.api.settings.get()])
      setRows(r)
      setSettings(s)
      setLoading(false)
    })()
  }, [])

  const cur = settings?.baseCurrency ?? 'CNY'
  const totals = rows.reduce(
    (a, r) => ({
      sales: a.sales + r.sales,
      cost: a.cost + r.cost,
      profit: a.profit + (r.profit ?? 0),
      received: a.received + r.received,
      orders: a.orders + r.orders,
      missingCostOrders: a.missingCostOrders + r.missingCostOrders
    }),
    { sales: 0, cost: 0, profit: 0, received: 0, orders: 0, missingCostOrders: 0 }
  )
  // 有成本没录的单：毛利是按 0 成本算的，偏大（不能当成真毛利）
  const missingMonths = rows.filter((r) => r.missingCostOrders > 0)
  // 有任何一个月不可信，累计毛利就不可信
  const profitReliable = totals.missingCostOrders === 0

  return (
    <>
      <div className="topbar">
        <h1>报表</h1>
        <div className="spacer" />
        <button className="btn" onClick={async () => {
          const f = await window.api.exporter.csv('orders')
          if (f) toast('已导出订单台账')
        }}>
          导出订单台账
        </button>
        <button className="btn" onClick={async () => {
          const f = await window.api.exporter.csv('payments')
          if (f) toast('已导出收款台账')
        }}>
          导出收款台账
        </button>
        <button className="btn" onClick={async () => {
          const f = await window.api.exporter.csv('items')
          if (f) toast('已导出品号明细台账')
        }}>
          导出品号明细台账
        </button>
      </div>

      <div className="content">
        <div className="stat-grid">
          {/* R4-S1：报表是"读数"的页面，4 张卡全黑 */}
          <div className="stat">
            <div className="stat-label">累计销售额</div>
            <div className="stat-value">{money(totals.sales, cur)}</div>
            <div className="stat-hint">共 {totals.orders} 单</div>
          </div>
          <div className="stat">
            <div className="stat-label">累计毛利</div>
            <div className={`stat-value ${profitReliable ? '' : 'na'}`}>
              {profitReliable ? money(totals.profit, cur) : '—'}
            </div>
            <div className="stat-hint">
              {totals.missingCostOrders
                ? `有 ${totals.missingCostOrders} 单成本没录全，毛利不算`
                : `成本 ${money(totals.cost, cur)}`}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">累计收款</div>
            <div className="stat-value">{money(totals.received, cur)}</div>
            <div className="stat-hint">到账合计</div>
          </div>
          <div className="stat">
            <div className="stat-label">毛利率</div>
            <div className={`stat-value ${profitReliable && totals.sales > 0 ? '' : 'na'}`}>
              {profitReliable
                ? totals.sales > 0
                  ? ((totals.profit / totals.sales) * 100).toFixed(1)
                  : '—'
                : '—'}
              {profitReliable && totals.sales > 0 ? '%' : ''}
            </div>
            <div className="stat-hint">按订单创建月份统计</div>
          </div>
        </div>

        {missingMonths.length ? (
          /* R2-⑤：这里装的是操作指引，不是警告 —— 用 info 蓝底，不要琥珀色吓人 */
          <div className="alert info">
            有成本没录全的单：{missingMonths.map((r) => `${r.month}（${r.missingCostOrders} 单）`).join('、')}。
            这些单的毛利是按 0 成本算出来的，偏大，所以这里显示「—」。
            <br />
            补录入口：到「订单」里打开那一单 → 「商品明细」表 → <b>成本</b> 那一栏直接填数字（空着的格子写着「未录，点这里补」）。
            填完这一页的毛利自动变真。
          </div>
        ) : null}

        <div className="card">
          <div className="card-head">
            <h2>月度汇总</h2>
            <div className="spacer" />
            <span className="faint">按订单创建月份</span>
          </div>
          <div className="card-body tight">
            {loading ? (
              <div className="empty loading">加载中…</div>
            ) : rows.length === 0 ? (
              <Empty text="还没有数据。先生成订单或报价单，这里就会出月度汇总。" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>月份</th>
                      <th className="num">订单数</th>
                      <th className="num">销售额</th>
                      <th className="num">成本</th>
                      <th className="num">毛利</th>
                      <th className="num">毛利率</th>
                      <th className="num">收款</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.month}>
                        <td className="mono">{r.month}</td>
                        <td className="num">{r.orders}</td>
                        <td className="num">{money(r.sales, cur)}</td>
                        <td className="num">{money(r.cost, cur)}</td>
                        {/* R2-⑤：没有毛利只有一种写法 ——「—」。
                            （这个月没订单 / 成本没录全，两种情况都显示「—」，绝不写 0.00 冒充） */}
                        <td className={`num ${r.profit == null || r.orders === 0 ? 'na' : ''}`}>
                          {r.profit == null || r.orders === 0 ? '—' : money(r.profit, cur)}
                        </td>
                        <td className={`num ${r.profit == null || r.orders === 0 || r.sales <= 0 ? 'na' : ''}`}>
                          {r.profit == null || r.orders === 0 || r.sales <= 0
                            ? '—'
                            : `${((r.profit / r.sales) * 100).toFixed(1)}%`}
                        </td>
                        <td className="num">{money(r.received, cur)}</td>
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
