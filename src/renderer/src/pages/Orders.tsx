import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Modal, useToast, money, num, Empty, fmtDate, today, PaymentTag, ShipTag } from '../ui'
import {
  CURRENCIES,
  INCOTERMS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  SHIP_STATUS_LABEL,
  type Currency,
  type Incoterm,
  type PaymentMethod,
  type PaymentStatus,
  type ShipStatus
} from '../../../shared/types'

export default function Orders() {
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<any[]>([])
  const [keyword, setKeyword] = useState('')
  const [statusTab, setStatusTab] = useState<string>('')
  const [sort, setSort] = useState('created_desc')
  const [showCreate, setShowCreate] = useState(params.get('new') === '1')

  const load = async () => {
    const rows = await window.api.orders.list({
      keyword,
      paymentStatus: statusTab || undefined,
      sort
    })
    setList(rows)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, statusTab, sort])

  const tabs = useMemo(
    () => [
      { key: '', label: '全部' },
      ...Object.entries(PAYMENT_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v }))
    ],
    []
  )

  return (
    <>
      <div className="topbar">
        <h1>订单</h1>
        <div className="spacer" />
        <button className="btn" onClick={() => window.api.exporter.csv('orders')}>
          导出 Excel
        </button>
        <button className="btn primary" onClick={() => setShowCreate(true)}>
          + 新建订单
        </button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索订单号 / PI号 / 客户 / PO号 / 款号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <button className="btn" onClick={load}>
            搜索
          </button>
          <select
            style={{ width: 160 }}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            title="排序方式"
          >
            <option value="created_desc">创建时间（新→旧）</option>
            <option value="created_asc">创建时间（旧→新）</option>
            <option value="amount_desc">金额（高→低）</option>
            <option value="amount_asc">金额（低→高）</option>
            <option value="ship_asc">预计出货日（近→远）</option>
          </select>
          <div className="spacer" />
          <span className="faint">共 {list.length} 单</span>
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
            {list.length === 0 ? (
              <Empty
                text={
                  keyword || statusTab
                    ? `当前筛选条件下没有订单${statusTab ? `（收款状态：${PAYMENT_STATUS_LABEL[statusTab as keyof typeof PAYMENT_STATUS_LABEL] ?? statusTab}）` : ''}${keyword ? `（关键词：${keyword}）` : ''}。单子没丢——把搜索框或状态页签清空就能看到全部。`
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
                      <th className="num">货值</th>
                      <th className="num">含费用合计</th>
                      <th className="num">件数</th>
                      <th className="num">已收</th>
                      <th className="num">待收</th>
                      <th>收款状态</th>
                      <th>出货状态</th>
                      <th>预计出货</th>
                      <th>创建日期</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((o) => (
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
                        <td className="nowrap">{o.customer?.company}</td>
                        <td className="num nowrap">{money(o.totalAmount, o.currency)}</td>
                        {/* R1-⑤：副说明改 title 提示，不再把行高从 38px 撑到 52px */}
                        <td
                          className="num nowrap"
                          title={o.charges?.length ? '含运费保险' : undefined}
                        >
                          {money(o.grandTotal, o.currency)}
                        </td>
                        <td className="num">{num(o.totalQuantity)}</td>
                        <td className="num nowrap">{money(o.paidAmount, o.currency)}</td>
                        <td className="num nowrap">
                          {o.paymentStatus === 'void' ? (
                            <span className="faint">—</span>
                          ) : (
                            money(o.remaining, o.currency)
                          )}
                        </td>
                        <td>
                          <PaymentTag status={o.paymentStatus} />
                        </td>
                        <td>
                          <ShipTag status={o.shipStatus} />
                        </td>
                        <td className="nowrap faint">{fmtDate(o.expectedShipDate) || '—'}</td>
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
                                    `待收 ${money(o.remaining, o.currency)}\n\n` +
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

  const save = async () => {
    if (!form.customerId) {
      toast('请先选择客户', 'error')
      return
    }
    if (form.exchangeRate === '' || Number(form.exchangeRate) <= 0) {
      toast('请先按今天钉盘的汇率填写汇率', 'error')
      return
    }
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
    }
  }

  return (
    <Modal
      title="新建订单"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            创建并添加商品
          </button>
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
              <button
                className="btn sm"
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
              </button>
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
