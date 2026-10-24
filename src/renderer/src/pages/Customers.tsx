import { useEffect, useState } from 'react'
import { Modal, useToast, money, Empty, fmtDate, PaymentTag, ShipTag, Button } from '../ui'
import { INCOTERMS, PAYMENT_METHOD_LABEL, type PaymentMethod } from '../../../shared/types'
import type { Customer } from '../../../shared/types'

interface Draft {
  id?: number
  company: string
  contact: string
  email: string
  phone: string
  country: string
  address: string
  zipCode: string
  attn: string
  paymentPref: string
  defaultPaymentMethod: string
  defaultDepositRatio: string
  defaultIncoterm: string
  defaultPortLoading: string
  defaultPortDestination: string
  note: string
}

const blank: Draft = {
  company: '',
  contact: '',
  email: '',
  phone: '',
  country: '',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: '',
  defaultPaymentMethod: '',
  defaultDepositRatio: '',
  defaultIncoterm: '',
  defaultPortLoading: '',
  defaultPortDestination: '',
  note: ''
}

export default function Customers() {
  const toast = useToast()
  const [list, setList] = useState<Customer[]>([])
  const [keyword, setKeyword] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [detail, setDetail] = useState<{ c: Customer; stats: any; orders: any[]; base: string } | null>(null)

  const load = async (kw = keyword) => {
    setList(await window.api.customers.list(kw))
  }

  useEffect(() => {
    void load('')
  }, [])

  const save = async () => {
    if (!draft) return
    if (!draft.company.trim()) {
      toast('请填写客户公司名', 'error')
      return
    }
    try {
      await window.api.customers.save({
        ...draft,
        defaultDepositRatio: draft.defaultDepositRatio === '' ? null : Number(draft.defaultDepositRatio)
      })
      toast(draft.id ? '已保存' : '已新增客户')
      setDraft(null)
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const remove = async (c: Customer) => {
    if (!confirm(`确认删除客户「${c.company}」？`)) return
    try {
      await window.api.customers.remove(c.id)
      toast('已删除')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const openDetail = async (c: Customer) => {
    const [stats, orders, settings] = await Promise.all([
      window.api.customers.stats(c.id),
      window.api.customers.orders(c.id),
      window.api.settings.get()
    ])
    setDetail({ c, stats, orders, base: settings?.baseCurrency ?? 'CNY' })
  }

  return (
    <>
      <div className="topbar">
        <h1>客户</h1>
        <div className="spacer" />
        <Button variant="primary"  onClick={() => setDraft({ ...blank })}>
          + 新增客户
        </Button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索公司 / 联系人 / 国家"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <Button  onClick={() => load()}>
            搜索
          </Button>
          <div className="spacer" />
          <span className="faint">共 {list.length} 个客户</span>
        </div>

        <div className="card">
          <div className="card-body tight">
            {list.length === 0 ? (
              <Empty
                text={
                  keyword
                    ? `当前搜索条件下没有客户（关键词：${keyword}）。客户没丢——把搜索框清空就能看到全部。`
                    : '还没有客户。点右上角「新增客户」开始录入。'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>公司</th>
                      <th>联系人</th>
                      <th>国家</th>
                      <th>邮箱</th>
                      <th>电话</th>
                      <th>地址</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id} className="clickable" onClick={() => openDetail(c)}>
                        <td style={{ fontWeight: 550 }}>{c.company}</td>
                        <td>{c.contact}</td>
                        <td className="muted">{c.country}</td>
                        <td className="muted">{c.email}</td>
                        <td className="muted">{c.phone}</td>
                        <td className="muted">{c.address}</td>
                        <td className="cell-actions">
                          <button
                            className="link"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDraft({
                                ...c,
                                defaultDepositRatio:
                                  c.defaultDepositRatio == null ? '' : String(c.defaultDepositRatio)
                              })
                            }}
                          >
                            编辑
                          </button>
                          <button
                            className="link danger"
                            onClick={(e) => {
                              e.stopPropagation()
                              remove(c)
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

      {draft ? (
        <Modal
          title={draft.id ? `编辑客户 ${draft.company}` : '新增客户'}
          onClose={() => setDraft(null)}
          size="wide"
          footer={
            <>
              <Button  onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button variant="primary"  onClick={save}>
                保存
              </Button>
            </>
          }
        >
          <div className="field">
            <label>公司名称 *</label>
            <input
              value={draft.company}
              onChange={(e) => setDraft({ ...draft, company: e.target.value })}
            />
          </div>
          <div className="field-row-3">
            <div className="field">
              <label>联系人</label>
              <input
                value={draft.contact}
                onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
              />
            </div>
            <div className="field">
              {/* R4-S4：应用内表单 label 一律中文 */}
              <label>收件人</label>
              <input
                value={draft.attn}
                onChange={(e) => setDraft({ ...draft, attn: e.target.value })}
                placeholder="如 Mr. Wang"
              />
            </div>
            <div className="field">
              <label>国家 / 地区</label>
              <input
                value={draft.country}
                onChange={(e) => setDraft({ ...draft, country: e.target.value })}
              />
            </div>
          </div>
          <div className="field-row-3">
            <div className="field">
              <label>邮箱</label>
              <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </div>
            <div className="field">
              <label>电话</label>
              <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </div>
            <div className="field">
              <label>邮编</label>
              <input
                value={draft.zipCode}
                onChange={(e) => setDraft({ ...draft, zipCode: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>地址</label>
            <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>付款方式偏好</label>
              <input
                value={draft.paymentPref}
                onChange={(e) => setDraft({ ...draft, paymentPref: e.target.value })}
                placeholder="如 T/T 30% 定金"
              />
              <div className="hint">这句话会原样印在 PI 上（如「见提单副本」）</div>
            </div>
            <div className="field">
              <label>备注</label>
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </div>
          </div>

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>建单默认条款（建单时自动带出）</h3>
          <div className="field-row-3">
            <div className="field">
              <label>默认付款方式</label>
              <select
                value={draft.defaultPaymentMethod}
                onChange={(e) => setDraft({ ...draft, defaultPaymentMethod: e.target.value })}
              >
                <option value="">不指定</option>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>默认定金比例</label>
              <select
                value={draft.defaultDepositRatio}
                onChange={(e) => setDraft({ ...draft, defaultDepositRatio: e.target.value })}
              >
                <option value="">不指定</option>
                <option value="0">无定金</option>
                <option value="0.2">20%</option>
                <option value="0.3">30%</option>
                <option value="0.4">40%</option>
                <option value="0.5">50%</option>
                <option value="1">全额</option>
              </select>
            </div>
            <div className="field">
              <label>默认贸易术语</label>
              <select
                value={draft.defaultIncoterm}
                onChange={(e) => setDraft({ ...draft, defaultIncoterm: e.target.value })}
              >
                <option value="">不指定</option>
                {INCOTERMS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>默认装运港</label>
              <input
                value={draft.defaultPortLoading}
                onChange={(e) => setDraft({ ...draft, defaultPortLoading: e.target.value })}
                placeholder="如 Ningbo"
              />
            </div>
            <div className="field">
              <label>默认目的港</label>
              <input
                value={draft.defaultPortDestination}
                onChange={(e) => setDraft({ ...draft, defaultPortDestination: e.target.value })}
                placeholder="如 Hamburg"
              />
            </div>
          </div>
        </Modal>
      ) : null}

      {detail ? (
        <Modal title={detail.c.company} onClose={() => setDetail(null)} size="wide">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="stat">
              <div className="stat-label">订单数</div>
              <div className="stat-value small">{detail.stats.orderCount}</div>
            </div>
            <div className="stat">
              <div className="stat-label">累计成交额</div>
              <div className="stat-value small">{money(detail.stats.totalAmount, detail.base)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">累计毛利</div>
              <div className="stat-value small">
                {detail.stats.missingCostOrders ? '—' : money(detail.stats.totalProfit, detail.base)}
              </div>
              {detail.stats.missingCostOrders ? (
                <div className="stat-hint">有 {detail.stats.missingCostOrders} 单成本没录全</div>
              ) : null}
            </div>
            {/* R4-S1：未收金额 = 钱还没到手，和工作台「待收款金额」同色（橙） */}
            <div className="stat amber">
              <div className="stat-label">未收金额</div>
              <div className="stat-value small">{money(detail.stats.outstanding, detail.base)}</div>
              {detail.stats.outstandingSamples > 0 ? (
                <div className="stat-hint">
                  订单 {money(detail.stats.outstandingOrders, detail.base)} · 打样{' '}
                  {money(detail.stats.outstandingSamples, detail.base)}
                </div>
              ) : null}
              {detail.stats.badDebt > 0 ? (
                <div className="stat-hint">
                  另有坏账未追回 {money(detail.stats.badDebt, detail.base)}
                </div>
              ) : null}
            </div>
          </div>

          <div className="price-calc mb">
            <div>
              <span className="muted">联系人</span>
              <span>{detail.c.contact || '—'}</span>
            </div>
            <div>
              <span className="muted">邮箱</span>
              <span>{detail.c.email || '—'}</span>
            </div>
            <div>
              <span className="muted">电话</span>
              <span>{detail.c.phone || '—'}</span>
            </div>
            <div>
              <span className="muted">地址</span>
              <span>
                {detail.c.address || '—'} {detail.c.zipCode} {detail.c.country}
              </span>
            </div>
            <div>
              <span className="muted">收件人</span>
              <span>{detail.c.attn || '—'}</span>
            </div>
            <div>
              <span className="muted">付款条款</span>
              <span>{detail.c.paymentPref || '—'}</span>
            </div>
            <div>
              <span className="muted">建单默认条款</span>
              <span>
                {[
                  detail.c.defaultPaymentMethod
                    ? PAYMENT_METHOD_LABEL[detail.c.defaultPaymentMethod as PaymentMethod]
                    : '',
                  detail.c.defaultDepositRatio != null
                    ? `定金 ${(detail.c.defaultDepositRatio * 100).toFixed(0)}%`
                    : '',
                  detail.c.defaultIncoterm,
                  detail.c.defaultPortLoading,
                  detail.c.defaultPortDestination
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
            </div>
            <div>
              <span className="muted">备注</span>
              <span>{detail.c.note || '—'}</span>
            </div>
          </div>

          <h3 style={{ fontSize: 13, margin: '4px 0 8px' }}>订单历史</h3>
          {detail.orders.length === 0 ? (
            <Empty text="该客户还没有订单" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>PI号</th>
                    <th>收款状态</th>
                    <th>出货状态</th>
                    <th className="num">含费用合计</th>
                    <th className="num">已收</th>
                    <th className="num">待收</th>
                    <th>日期</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.orders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.orderNo}</td>
                      <td className="mono">{o.piNo}</td>
                      <td>
                        <PaymentTag status={o.paymentStatus} />
                      </td>
                      <td>
                        <ShipTag status={o.shipStatus} />
                      </td>
                      <td className="num">{money(o.grandTotal, o.currency)}</td>
                      <td className="num">{money(o.paid, o.currency)}</td>
                      <td className="num">{money(o.remaining, o.currency)}</td>
                      <td className="faint nowrap">{fmtDate(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
