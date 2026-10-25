import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Modal,
  useToast,
  money,
  moneyOrDash,
  num,
  Empty,
  fmtDate,
  today,
  PaymentTag,
  ShipTag,
  Button,
  useDebounced,
  useLoadGuard,
  LoadError
} from '../ui'
import { isBillingStatus, shownRemaining } from '../../../shared/billing'
import {
  CURRENCIES,
  INCOTERMS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  SHIP_STATUS_LABEL,
  SHIP_STATUS_ORDER,
  type Currency,
  type Incoterm,
  type PaymentMethod,
  type PaymentStatus,
  type ShipStatus
} from '../../../shared/types'

/** 一页多少张单：跟单员一屏能扫完的量，再多就没人在列表上看明细了 */
const PAGE_SIZE = 50

export default function Orders() {
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [owedBase, setOwedBase] = useState(0)
  const [grandBase, setGrandBase] = useState(0)
  const [baseCurrency, setBaseCurrency] = useState('CNY')
  const [keyword, setKeyword] = useState('')
  const [statusTab, setStatusTab] = useState<string>('')
  const [shipStatus, setShipStatus] = useState<string>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState('created_desc')
  const [page, setPage] = useState(0)
  const [showCreate, setShowCreate] = useState(params.get('new') === '1')
  /** 查询失败要说出来：空列表 + 一句「还没有订单」会把“读取失败”说成“今天没单” */
  const [loadError, setLoadError] = useState('')
  /** 敲太快不重复打后端；后到的旧结果不许盖住新关键词 */
  const kw = useDebounced(keyword, 250)
  const begin = useLoadGuard()

  const load = async () => {
    const { isCurrent } = begin()
    try {
      const pageData = await window.api.orders.list({
        keyword: kw,
        paymentStatus: statusTab || undefined,
        shipStatus: shipStatus || undefined,
        from: from || undefined,
        to: to || undefined,
        sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      if (!isCurrent()) return
      setRows(pageData.rows)
      setTotal(pageData.total)
      setOwedBase(pageData.owedBaseTotal)
      setGrandBase(pageData.grandBaseTotal)
      if (pageData.rows[0]?.baseCurrency) setBaseCurrency(pageData.rows[0].baseCurrency)
      setLoadError('')
    } catch (e) {
      if (!isCurrent()) return
      setLoadError((e as Error).message || '订单列表没加载出来')
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, statusTab, shipStatus, from, to, sort, page])

  // 换了筛选条件就回到第一页，否则停在不存在的第 8 页上看着「没有订单」
  useEffect(() => {
    setPage(0)
  }, [kw, statusTab, shipStatus, from, to, sort])

  const tabs = useMemo(
    () => [
      { key: '', label: '全部' },
      ...Object.entries(PAYMENT_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v }))
    ],
    []
  )
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasFilter = Boolean(kw || statusTab || shipStatus || from || to)

  return (
    <>
      <div className="topbar">
        <h1>订单</h1>
        <div className="spacer" />
        <Button  onClick={() => window.api.exporter.csv('orders')}>
          导出 Excel
        </Button>
        <Button variant="primary"  onClick={() => setShowCreate(true)}>
          + 新建订单
        </Button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索订单号 / PI / 客户 / PO / 款号颜色 / 工厂 / 船名 / 目的港 / 柜号 / 提单号 / 流水号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select
            style={{ width: 160 }}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            title="排序方式"
          >
            <option value="created_desc">创建时间（新→旧）</option>
            <option value="created_asc">创建时间（旧→新）</option>
            <option value="amount_desc">货值（高→低）</option>
            <option value="amount_asc">货值（低→高）</option>
            <option value="owed_desc">待收（多→少）</option>
            <option value="overdue_first">逾期（久→近）</option>
            <option value="ship_asc">预计出货日（近→远）</option>
          </select>
          <select
            style={{ width: 130 }}
            value={shipStatus}
            onChange={(e) => setShipStatus(e.target.value)}
            title="按出货状态筛选"
          >
            <option value="">全部出货状态</option>
            {SHIP_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SHIP_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="faint">下单日期</span>
          <input type="date" className="col-num-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="faint">至</span>
          <input type="date" className="col-num-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          {hasFilter ? (
            <button
              className="link"
              onClick={() => {
                setKeyword('')
                setStatusTab('')
                setShipStatus('')
                setFrom('')
                setTo('')
              }}
            >
              清空筛选
            </button>
          ) : null}
          <div className="spacer" />
          <span className="faint" title={`按筛选出来的全部订单算，折成基准币 ${baseCurrency}（不是只算这一页）`}>
            共 {total} 单{pageCount > 1 ? ` · 第 ${page + 1}/${pageCount} 页` : ''}
            {total > 0 ? ` · 待收合计 ${money(owedBase, baseCurrency)}` : ''}
          </span>
        </div>

        <div className="card">
          <div className="tabs">
            {tabs.map((t) => (
              <div
                key={t.key}
                className={`tab ${statusTab === t.key ? 'active' : ''}`}
                onClick={() => setStatusTab(t.key)}
              >
                {t.label}
              </div>
            ))}
          </div>
          <div className="card-body tight">
            {loadError ? (
              <LoadError what="订单列表" message={loadError} onRetry={() => void load()} />
            ) : rows.length === 0 ? (
              <Empty
                text={
                  hasFilter
                    ? `当前筛选条件下没有订单${statusTab ? `（收款状态：${PAYMENT_STATUS_LABEL[statusTab as keyof typeof PAYMENT_STATUS_LABEL] ?? statusTab}）` : ''}${kw ? `（关键词：${kw}）` : ''}${from || to ? `（日期：${from || '不限'} ~ ${to || '不限'}）` : ''}。单子没丢——点「清空筛选」就能看到全部。`
                    : '还没有订单。点右上角「新建订单」开始录入。'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>订单号</th>
                      <th>PI号</th>
                      <th>客户</th>
                      <th className="num">件数</th>
                      <th className="num" title="已装进装箱单的件数（作废批次不算）">
                        已装
                      </th>
                      <th className="num">货值</th>
                      <th className="num">含费用合计</th>
                      <th className="num">已收</th>
                      <th className="num" title="草稿 / 已失效 / 已作废的单不催款，这里显示「—」">
                        待收
                      </th>
                      <th>收款状态</th>
                      <th>出货状态</th>
                      <th>预计出货</th>
                      <th title="实际开船日 / 截关日">船期</th>
                      <th>柜号</th>
                      <th>创建日期</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr
                        key={o.id}
                        className="clickable"
                        onClick={() => navigate(`/orders/${o.id}`)}
                      >
                        <td className="mono nowrap">{o.orderNo}</td>
                        {/* R4-S3：编号列不弱化——PI 号是要拿去和客户对账的唯一标识，
                            和订单号一样黑。.faint 在表格里只给日期等真·次要信息。
                            R4-P1：13 位 PI 号（PI20261021005 ≈ 101px）原来在 100px 处被截掉
                            最后两位——正好是区分订单的关键。改 12px 等宽，13 位 ≈ 93px 装得下。 */}
                        <td className="mono nowrap clip-116 mono-sm" title={o.piNo}>
                          {o.piNo}
                        </td>
                        <td className="nowrap" title={o.portOfDestination ? `目的港 ${o.portOfDestination}` : undefined}>
                          {o.customer?.company}
                        </td>
                        <td className="num">{num(o.totalQuantity)}</td>
                        <td
                          className={`num ${o.packedQuantity && o.packedQuantity < o.totalQuantity ? 'amber-num' : 'faint'}`}
                          title={
                            o.batchCount
                              ? `${o.batchCount} 个批次${o.styleCount ? ` · ${o.styleCount} 款` : ''}`
                              : '还没建装箱单'
                          }
                        >
                          {o.packedQuantity ? num(o.packedQuantity) : '—'}
                        </td>
                        <td className="num nowrap">{money(o.totalAmount, o.currency)}</td>
                        {/* R1-⑤：副说明改 title 提示，不再把行高从 38px 撑到 52px */}
                        <td
                          className="num nowrap"
                          title={o.chargesCount ? '含运费保险' : undefined}
                        >
                          {money(o.grandTotal, o.currency)}
                        </td>
                        <td className="num nowrap">{money(o.paidAmount, o.currency)}</td>
                        <td className="num nowrap" title={isBillingStatus(o.paymentStatus) ? undefined : '这张单不催款'}>
                          {isBillingStatus(o.paymentStatus) ? money(shownRemaining(o.paymentStatus, o.remaining), o.currency) : <span className="faint">—</span>}
                        </td>
                        <td>
                          <PaymentTag status={o.paymentStatus} />
                        </td>
                        <td>
                          <ShipTag status={o.shipStatus} />
                        </td>
                        <td className="nowrap">
                          {o.daysLate ? (
                            <span className="tag amber" title={`预计出货日已过 ${o.daysLate} 天，货还没走`} role="button">
                              逾期 {o.daysLate} 天
                            </span>
                          ) : (
                            <span className="faint">{fmtDate(o.expectedShipDate) || '—'}</span>
                          )}
                        </td>
                        <td className="nowrap mono-sm faint" title={`ETD ${fmtDate(o.etdDate) || '未填'} / 截关 ${fmtDate(o.cutOffDate) || '未填'}`}>
                          {fmtDate(o.etdDate).slice(5) || '—'}
                          {o.cutOffDate ? ` / ${fmtDate(o.cutOffDate).slice(5)}` : ''}
                        </td>
                        <td className="mono clip-96 mono-sm" title={o.containerNos || undefined}>
                          {o.containerNos || <span className="faint">—</span>}
                        </td>
                        <td className="nowrap faint">{fmtDate(o.createdAt)}</td>
                        <td className="cell-actions">
                          <button
                            className="link"
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (
                                !confirm(
                                  `确认作废订单 ${o.orderNo}？\n\n` +
                                    `含费用合计 ${money(o.grandTotal, o.currency)}，已收 ${money(
                                      o.paidAmount,
                                      o.currency
                                    )}。\n` +
                                    '作废后：收款记录、操作历史、单据存档全部保留，只是不再计入销售额和待收款。'
                                )
                              )
                                return
                              await window.api.orders.void(o.id, '手动作废')
                              toast('订单已作废，记录全部保留')
                              await load()
                            }}
                          >
                            作废
                          </button>
                          <button
                            className="link danger"
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (
                                !confirm(
                                  `确认删除订单 ${o.orderNo}？\n\n` +
                                    `含费用合计 ${money(o.grandTotal, o.currency)}\n` +
                                    `已收 ${money(o.paidAmount, o.currency)}\n` +
                                    `待收 ${money(shownRemaining(o.paymentStatus, o.remaining), o.currency)}\n\n` +
                                    '有明细或收款的单删了凭据会一起没有，系统会拦你。请改用「作废」。'
                                )
                              )
                                return
                              try {
                                await window.api.orders.remove(o.id)
                                toast('订单已删除')
                              } catch (err) {
                                toast((err as Error).message, 'error')
                              }
                              await load()
                            }}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="tfoot-strong">
                      <td colSpan={8} className="right faint">
                        {/* 合计按筛选出来的全部订单算（基准币），不是只算这一页 */}
                        {`本页 ${rows.length} 单 · 筛选共 ${total} 单的`}
                      </td>
                      <td className="num nowrap">{moneyOrDash(owedBase, baseCurrency)}</td>
                      <td colSpan={4} className="right faint">
                        {`成交额 ${money(grandBase, baseCurrency)}`}
                      </td>
                      <td colSpan={3}>
                        {pageCount > 1 ? (
                          <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                              上一页
                            </Button>
                            <Button
                              size="sm"
                              disabled={page + 1 >= pageCount}
                              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                            >
                              下一页
                            </Button>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreate ? (
        <CreateOrderModal
          onClose={() => {
            setShowCreate(false)
            if (params.get('new')) {
              params.delete('new')
              setParams(params, { replace: true })
            }
          }}
          onCreated={(id) => {
            setShowCreate(false)
            navigate(`/orders/${id}`)
          }}
        />
      ) : null}
    </>
  )
}

function CreateOrderModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const toast = useToast()
  const [customers, setCustomers] = useState<any[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [ports, setPorts] = useState<{ loading: string[]; destination: string[] }>({
    loading: [],
    destination: []
  })
  const [form, setForm] = useState({
    customerId: 0,
    currency: 'USD' as Currency,
    exchangeRate: '' as number | '',
    exchangeRateDate: today(),
    incoterm: 'FOB' as Incoterm,
    portOfLoading: '',
    portOfDestination: '',
    paymentMethod: 'tt_deposit' as PaymentMethod,
    depositRatio: 0.3,
    expectedShipDate: '',
    expectedArrivalDate: '',
    customerPo: '',
    note: ''
  })
  const [lastRate, setLastRate] = useState<{ rate: number; date: string } | null>(null)

  useEffect(() => {
    void (async () => {
      const [cs, s, pt, lr] = await Promise.all([
        window.api.customers.list(),
        window.api.settings.get(),
        window.api.orders.ports(),
        window.api.orders.lastExchangeRateInfo()
      ])
      setCustomers(cs)
      setSettings(s)
      setPorts(pt)
      setLastRate(lr)
      setForm((f) => ({
        ...f,
        depositRatio: s.defaultDepositRatio ?? 0.3
      }))
    })()
  }, [])

  /** 选客户后：先带出客户档案里的默认条款，再补上这个客户上一次的条款 */
  const onCustomerChange = async (id: number) => {
    setForm((f) => ({ ...f, customerId: id }))
    if (!id) return
    const cust = customers.find((c) => c.id === id)
    const terms = await window.api.orders.lastTerms(id)
    setForm((f) => ({
      ...f,
      currency: terms?.currency ?? f.currency,
      incoterm: (cust?.defaultIncoterm || terms?.incoterm || f.incoterm) as Incoterm,
      portOfLoading: cust?.defaultPortLoading || terms?.portOfLoading || f.portOfLoading,
      portOfDestination: cust?.defaultPortDestination || terms?.portOfDestination || f.portOfDestination,
      paymentMethod: (cust?.defaultPaymentMethod || terms?.paymentMethod || f.paymentMethod) as PaymentMethod,
      depositRatio:
        cust?.defaultDepositRatio != null
          ? cust.defaultDepositRatio
          : terms?.depositRatio ?? f.depositRatio
    }))
    if (cust?.paymentPref) toast(`已带出「${cust.company}」的档案条款，确认一下`)
  }

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === form.customerId),
    [customers, form.customerId]
  )

  // 建单要烧一个单号（计数器只往前走）：连点两次就是两张单、两个号，
  // 第二张还是没人知道的空单——保存期间把按钮按住
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    if (!form.customerId) {
      toast('请先选择客户', 'error')
      return
    }
    if (form.exchangeRate === '' || Number(form.exchangeRate) <= 0) {
      toast('请先按今天钉盘的汇率填写汇率', 'error')
      return
    }
    setBusy(true)
    try {
      const order = await window.api.orders.create({
        customerId: form.customerId,
        currency: form.currency,
        exchangeRate: Number(form.exchangeRate),
        exchangeRateDate: form.exchangeRateDate || null,
        baseCurrency: settings?.baseCurrency ?? 'CNY',
        incoterm: form.incoterm,
        portOfLoading: form.portOfLoading,
        portOfDestination: form.portOfDestination,
        paymentMethod: form.paymentMethod,
        depositRatio: form.depositRatio,
        expectedShipDate: form.expectedShipDate || null,
        expectedArrivalDate: form.expectedArrivalDate || null,
        customerPo: form.customerPo,
        note: form.note
      })
      toast(`订单 ${order.orderNo} 已创建`)
      onCreated(order.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建订单"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            创建并添加商品
          </Button>
        </>
      }
    >
      <div className="field">
        <label>客户 *</label>
        <select
          value={form.customerId || ''}
          onChange={(e) => void onCustomerChange(Number(e.target.value))}
        >
          <option value="">请选择客户…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.company}
              {c.country ? ` (${c.country})` : ''}
            </option>
          ))}
        </select>
        {customers.length === 0 ? (
          <div className="hint">还没有客户，请先到「客户」页面新增</div>
        ) : null}
        {selectedCustomer?.paymentPref ? (
          <div className="hint">客户档案里的付款条款：{selectedCustomer.paymentPref}（PI 上会自动印出来）</div>
        ) : null}
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>币种</label>
          <select
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>汇率（1 {form.currency} = ? {settings?.baseCurrency ?? 'CNY'}）*</label>
          <input
            type="number"
            step="0.0001"
            value={form.exchangeRate}
            onChange={(e) =>
              setForm({ ...form, exchangeRate: e.target.value === '' ? '' : Number(e.target.value) })
            }
            placeholder="请按今天钉盘的汇率填"
          />
          <div className="hint">
            请按今天钉盘的汇率填写，填了才能建单。（这里不会自动填数字）
          </div>
          {lastRate ? (
            <div className="row" style={{ marginTop: 4, gap: 5 }}>
              <Button size="sm"
                
                onClick={() =>
                  setForm({
                    ...form,
                    exchangeRate: lastRate.rate,
                    exchangeRateDate: lastRate.date || today()
                  })
                }
              >
                填入上次用的 {lastRate.rate}
                {lastRate.date ? `（${lastRate.date}）` : ''}
              </Button>
            </div>
          ) : null}
          <div style={{ marginTop: 6 }}>
            <label>汇率日期（这个汇率是哪天的）*</label>
            <input
              type="date"
              value={form.exchangeRateDate}
              onChange={(e) => setForm({ ...form, exchangeRateDate: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>贸易术语</label>
          <select
            value={form.incoterm}
            onChange={(e) => setForm({ ...form, incoterm: e.target.value as Incoterm })}
          >
            {INCOTERMS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>装运港</label>
          <input
            list="order-ports-loading"
            value={form.portOfLoading}
            onChange={(e) => setForm({ ...form, portOfLoading: e.target.value })}
            placeholder="如 Ningbo"
          />
          <datalist id="order-ports-loading">
            {ports.loading.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>目的港</label>
          <input
            list="order-ports-dest"
            value={form.portOfDestination}
            onChange={(e) => setForm({ ...form, portOfDestination: e.target.value })}
            placeholder="如 Hamburg"
          />
          <datalist id="order-ports-dest">
            {ports.destination.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>付款方式</label>
          <select
            value={form.paymentMethod}
            onChange={(e) => setForm({ ...form, paymentMethod: e.target.value as PaymentMethod })}
          >
            {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>定金比例</label>
          <select
            value={String(form.depositRatio)}
            onChange={(e) => setForm({ ...form, depositRatio: Number(e.target.value) })}
          >
            <option value="0">无定金</option>
            <option value="0.2">20%</option>
            <option value="0.3">30%</option>
            <option value="0.4">40%</option>
            <option value="0.5">50%</option>
            <option value="1">全额</option>
          </select>
        </div>
        <div className="field">
          <label>预计出货日</label>
          <input
            type="date"
            value={form.expectedShipDate}
            onChange={(e) => setForm({ ...form, expectedShipDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label>预计到港日</label>
          <input
            type="date"
            value={form.expectedArrivalDate}
            onChange={(e) => setForm({ ...form, expectedArrivalDate: e.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label>客户 PO 号</label>
        <input
          value={form.customerPo}
          onChange={(e) => setForm({ ...form, customerPo: e.target.value })}
        />
      </div>

      <div className="field">
        <label>备注（给工厂的要求等）</label>
        <textarea
          rows={2}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </div>
    </Modal>
  )
}

export { PAYMENT_STATUS_LABEL, SHIP_STATUS_LABEL, PaymentStatus, ShipStatus }
