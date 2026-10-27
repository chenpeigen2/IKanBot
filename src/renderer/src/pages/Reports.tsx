import { useCallback, useEffect, useState } from 'react'
import { useToast, money, Empty, Button, Card, LoadError } from '../ui'
import type { CustomerReceivable, ExportKind, MonthlyReportRow } from '../../../shared/types'

/** 一行取整到分；合计只吃这些取整后的行值（口径：所见即所算，别让浮点在小数点后打架） */
function r2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

export default function Reports() {
  const toast = useToast()
  const [rows, setRows] = useState<MonthlyReportRow[]>([])
  const [owed, setOwed] = useState<CustomerReceivable[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  /** 报表算不出来时要说出来：一直停在「加载中…」等于让人对着空表做决定 */
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      const [r, o, s] = await Promise.all([
        window.api.report.monthly(),
        window.api.report.receivables(),
        window.api.settings.get()
      ])
      setRows(r)
      setOwed(o)
      setSettings(s)
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '报表没算出来')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const cur = settings?.baseCurrency ?? 'CNY'
  // 合计 = 逐行取整后的和：表里 12 行各差半分钱时，卡片上的数才不会对不上
  const totals = rows.reduce(
    (a, r) => ({
      sales: r2(a.sales + r2(r.sales)),
      cost: r2(a.cost + r2(r.cost)),
      profit: r2(a.profit + r2(r.profit ?? 0)),
      discount: r2(a.discount + r2(r.discount)),
      shortage: r2(a.shortage + r2(r.shortage)),
      badDebt: r2(a.badDebt + r2(r.badDebt)),
      received: r2(a.received + r2(r.received)),
      refundCount: a.refundCount + r.refundCount,
      orders: a.orders + r.orders,
      missingCostOrders: a.missingCostOrders + r.missingCostOrders
    }),
    {
      sales: 0,
      cost: 0,
      profit: 0,
      discount: 0,
      shortage: 0,
      badDebt: 0,
      received: 0,
      refundCount: 0,
      orders: 0,
      missingCostOrders: 0
    }
  )
  // 有成本没录的单：毛利是按 0 成本算的，偏大（不能当成真毛利）
  const missingMonths = rows.filter((r) => r.missingCostOrders > 0)
  // 有任何一个月不可信，累计毛利就不可信
  const profitReliable = totals.missingCostOrders === 0
  const totalOwed = r2(owed.reduce((s, o) => s + r2(o.totalBase), 0))

  const exportBtn = (kind: ExportKind, label: string, toastText: string) => (
    <Button
      onClick={async () => {
        try {
          const f = await window.api.exporter.csv(kind)
          if (f) toast(toastText)
        } catch (e) {
          toast((e as Error).message || '导出没成功', 'error')
        }
      }}
    >
      {label}
    </Button>
  )

  // 数据没算出来就别摆一张全是 0 的表：宁可明说失败，也不让人拿空报表做决定
  if (loadError) {
    return (
      <>
        <div className="topbar">
          <h1>报表</h1>
        </div>
        <div className="content">
          <LoadError what="报表" message={loadError} onRetry={() => void load()} />
        </div>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>报表</h1>
        <div className="spacer" />
        {exportBtn('orders', '导出订单台账', '已导出订单台账')}
        {exportBtn('monthly', '导出月度汇总', '已导出月度汇总')}
        {exportBtn('payments', '导出收款台账', '已导出收款台账')}
        {exportBtn('items', '导出品号明细台账', '已导出品号明细台账')}
        {exportBtn('orders_all', '导出全量底稿', '已导出全量底稿（含草稿与作废）')}
      </div>

      <div className="content">
        <div className="stat-grid">
          {/* R4-S1：报表是"读数"的页面，4 张卡全黑 */}
          <div className="stat">
            <div className="stat-label">累计销售额</div>
            <div className="stat-value">{money(totals.sales, cur)}</div>
            <div className="stat-hint">共 {totals.orders} 单 · 按下单月</div>
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
            {/* 退款是钱流出，没有从收款里减掉：说破差异，老板才不至于拿这张表去对银行流水时对不上 */}
            <div className="stat-hint">
              {totals.refundCount
                ? `按到账月合计 · 含打样费实收 · 不含退给客户的 ${totals.refundCount} 笔`
                : '按到账月合计 · 含打样费实收'}
            </div>
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
            <div className="stat-hint">
              {`折让 ${money(totals.discount, cur)} · 短款 ${money(totals.shortage, cur)}`}
            </div>
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

        <Card
          title="月度汇总"
          actions={<span className="faint">销售/成本/毛利按下单月 · 收款按到账月（退款另列，未减进收款）</span>}
          bodyClass="tight"
        >
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
                    <th className="num">折让</th>
                    <th className="num">短款核销</th>
                    <th className="num">坏账未追回</th>
                    <th className="num">收款(按到账月)</th>
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
                        {r.missingCostOrders ? (
                          <span className="faint"> （{r.missingCostOrders} 单成本未录）</span>
                        ) : null}
                      </td>
                      <td className={`num ${r.profit == null || r.orders === 0 || r.sales <= 0 ? 'na' : ''}`}>
                        {r.profit == null || r.orders === 0 || r.sales <= 0
                          ? '—'
                          : `${((r.profit / r.sales) * 100).toFixed(1)}%`}
                      </td>
                      <td className={`num ${r.discount ? '' : 'na'}`}>
                        {r.discount ? money(r.discount, cur) : '—'}
                      </td>
                      <td className={`num ${r.shortage ? '' : 'na'}`}>
                        {r.shortage ? money(r.shortage, cur) : '—'}
                      </td>
                      <td className={`num ${r.badDebt ? '' : 'na'}`}>
                        {r.badDebt ? money(r.badDebt, cur) : '—'}
                      </td>
                      <td className="num">
                        {money(r.received, cur)}
                        {/* 退款没有汇率快照，只能按原币报数；混进「收款」列会让 Excel 里 SUM 出来的数不等于银行流水 */}
                        {r.refundCount ? (
                          <span className="faint">
                            （另退 {r.refundCount} 笔 {r.refundText}，未折{cur}）
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="客户欠款榜"
          actions={<span className="faint">共 {owed.length} 家 · 合计 {money(totalOwed, cur)}</span>}
          bodyClass="tight"
        >
          {owed.length === 0 ? (
            <Empty text="没有未结清的货款：要么还没下单，要么都收齐了。" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>客户</th>
                    <th className="num">未结单数</th>
                    <th className="num">最老挂账</th>
                    <th className="num">货款待收</th>
                    <th className="num">打样费待收</th>
                    <th className="num">合计敞口</th>
                  </tr>
                </thead>
                <tbody>
                  {owed.slice(0, 12).map((o) => (
                    <tr key={o.customerId}>
                      <td>{o.customerName}</td>
                      <td className="num">{o.orders}</td>
                      {/* 账龄：催款先催挂得久的；只有打样费的客户没有未结订单，摆「—」 */}
                      <td className="num">
                        {o.oldestUnpaidDate ? (
                          o.oldestUnpaidDays >= 60 ? <span className="tag amber">{o.oldestUnpaidDays} 天</span> : `${o.oldestUnpaidDays} 天`
                        ) : '—'}
                      </td>
                      <td className="num">{money(o.goodsBase, cur)}</td>
                      <td className={`num ${o.sampleBase ? '' : 'na'}`}>
                        {o.sampleBase ? money(o.sampleBase, cur) : '—'}
                      </td>
                      <td className="num">
                        <b>{money(o.totalBase, cur)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {owed.length > 12 ? (
                <div className="hint">
                  这里只列敞口最大的 12 家；其余 {owed.length - 12} 家金额更小，逐单明细在「导出订单台账」里。
                </div>
              ) : null}
            </div>
          )}
        </Card>

        {/* R7：这些钱各自按什么月份归集、哪些不进销售额，写在页面上，别让人拿两张表互相对不上 */}
        <div className="note-box">
          <b>这几张表的算法</b>
          <br />
          销售额 = 含费用合计，与 PI 上的 TOTAL 是同一个数；成本、毛利、折让、短款、坏账都按<b>下单月</b>归集，
          收款按<b>到账月</b>归集，所以两列不能上下相减。
          <br />
          折让和短款已经扣进毛利；坏账是收不回来的钱，单列摆在这里，不去改动进货毛利。
          打样费和快递费只出现在「待收」里，不算销售额。
          <br />
          「导出订单台账」和本页算法一致，金额列可以直接求和；要连草稿、作废一起看历史，导「全量底稿」。
        </div>
      </div>
    </>
  )
}
