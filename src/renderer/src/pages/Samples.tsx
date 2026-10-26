import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Modal, useToast, money, moneyOrDash, num, Empty, fmtDate, today, ActionMenu, SampleStatusTag, Button, SampleFeeTag, clientKey, LoadError, useDebounced, useLoadGuard } from '../ui'
import {
  SAMPLE_STATUS_LABEL,
  SAMPLE_STATUS_ORDER,
  SAMPLE_FEE_STATUS_LABEL,
  SAMPLE_FEE_STATUS_ORDER,
  CURRENCIES,
  type SampleFeeStatus,
  type SampleStatus
} from '../../../shared/types'
import { renderSample } from '../../../shared/documents'

interface LineRow {
  /** 前端行身份，见 ui.tsx clientKey；提交时不带 */
  uid: string
  productId: number | null
  styleNo: string
  productName: string
  composition: string
  color: string
  size: string
  quantity: number
  unitPrice: number
  /** 大货单价：转订单时的正式单价。打样单价只是打样费，不能拿来顶 */
  goodsUnitPrice: number | null
}

/**
 * 打样单（样品单）—— 下单之前的打样环节。
 * 公司垫的快递费、样品费在这里记账；样品单号、快递单号都能查。
 */
export default function Samples() {
  const toast = useToast()
  const navigate = useNavigate()
  const [list, setList] = useState<any[]>([])
  /** 列表金额一律折基准币（B2）：币种名取自设置，表头好写明「约 CNY」 */
  const [baseCurrency, setBaseCurrency] = useState('CNY')
  // 工作台点「打样」提醒带 ?kw=SMP-0001 跳进来：直接把那一单筛出来，别让人再搜一遍
  const [searchParams] = useSearchParams()
  const [keyword, setKeyword] = useState(searchParams.get('kw') ?? '')
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState<any | null>(null)
  /** R25：打样费实收流水（登记 / 撤销） */
  const [paying, setPaying] = useState<any | null>(null)
  const [preview, setPreview] = useState<{ html: string; no: string } | null>(null)
  const [converting, setConverting] = useState<any | null>(null)
  /** N-2：转单前必须问一句 PI 发不发（草稿单不进销售额/待收，忘了改状态就是对账事故） */
  const [convPi, setConvPi] = useState<'' | 'draft' | 'sent'>('')
  /** 读取失败不能装成「没有打样单」 */
  const [loadError, setLoadError] = useState('')
  // 敲太快时两个 list 请求在途，先发的旧结果不许盖住新关键词
  const kw = useDebounced(keyword, 250)
  const begin = useLoadGuard()

  const load = async () => {
    const { isCurrent } = begin()
    try {
      const rows = await window.api.samples.list({ keyword: kw, status: status || undefined })
      if (!isCurrent()) return
      setList(rows)
      setLoadError('')
    } catch (e) {
      if (!isCurrent()) return
      setLoadError((e as Error).message || '打样单列表没加载出来')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, status])

  useEffect(() => {
    void window.api.settings.get().then((s) => setBaseCurrency(s?.baseCurrency ?? 'CNY'))
  }, [])

  const remove = async (s: any) => {
    if (!confirm(`确认删除打样单 ${s.sampleNo}？`)) return
    // 转过订单的打样单后端会拦住并抛中文错误，得弹出来，否则用户以为按钮坏了
    try {
      await window.api.samples.remove(s.id)
      toast('已删除')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  /** N-2：转单。必须先选 PI 发不发（跟报价转单一个问法），选错可转完再改 */
  const doConvert = async (offset: boolean) => {
    if (!convPi) {
      toast('请先选一下：转出来的订单，PI 现在就发还是先存草稿？', 'error')
      return
    }
    try {
      const order = await window.api.samples.convert(converting.id, {
        offsetSampleFee: offset,
        paymentStatus: convPi as 'draft' | 'sent'
      })
      toast(
        convPi === 'sent'
          ? `已转成订单 ${order.orderNo}，状态「待确认」${offset ? '，样品费及快递费已抵扣' : '，打样费照收'}`
          : `已转成订单 ${order.orderNo}（草稿，不进销售额也不进待收）；PI 发出后记得回订单改成「待确认」`
      )
      setConverting(null)
      await load()
      navigate(`/orders/${order.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>打样单</h1>
        <div className="spacer" />
        <Button variant="primary"  onClick={() => setEditing({})}>
          + 新建打样单
        </Button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索样品单号 / 客户 / 款号 / 快递单号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button  onClick={load}>
            搜索
          </Button>
          <select
            className="col-tag"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            title="按状态筛选"
          >
            <option value="">全部状态</option>
            {SAMPLE_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SAMPLE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <div className="spacer" />
          <span className="faint">共 {list.length} 张打样单</span>
        </div>

        <div className="card">
          <div className="card-body tight">
            {loadError ? (
              <LoadError what="打样单列表" message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
              <Empty
                text={
                  keyword || status
                    ? `当前筛选条件下没有打样单${status ? `（状态：${SAMPLE_STATUS_LABEL[status as SampleStatus] ?? status}）` : ''}${keyword ? `（关键词：${keyword}）` : ''}。单子没丢——把搜索框或状态清空就能看到全部。`
                    : '还没有打样单。客户要打样的时候点右上角「新建打样单」。'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>样品单号</th>
                      <th>客户</th>
                      <th>日期</th>
                      <th>款号</th>
                      <th className="num">件数</th>
                      {/* R1：双行表头去掉，副说明改 title，表头行高回到 36px */}
                      <th className="num" title={`样品费（应收客户），按本单汇率折成 ${baseCurrency}；没填汇率显示「—」`}>
                        样品费
                      </th>
                      <th className="num" title={`快递费（公司垫付、向客户收回），按本单汇率折成 ${baseCurrency}`}>
                        快递费
                      </th>
                      <th className="num" title={`公司净垫 = 工厂打样费（${baseCurrency}）+ 快递费 − 已收回；没填汇率折不出来`}>
                        公司净垫
                      </th>
                      <th className="num" title="待收：计入工作台">
                        待收
                      </th>
                      <th>状态</th>
                      <th>打样费收款</th>
                      <th>快递单号</th>
                      <th>寄出 / 签收</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td className="mono nowrap">{s.sampleNo}</td>
                        <td className="cell-clip" title={s.customer?.company || ''}>
                          {s.customer?.company}
                        </td>
                        <td className="nowrap faint">{fmtDate(s.sampleDate)}</td>
                        <td
                          className="mono clip-96"
                          title={s.items.map((i: any) => i.styleNo).filter(Boolean).join('、')}
                        >
                          {s.items.map((i: any) => i.styleNo).filter(Boolean).join('、') || '—'}
                        </td>
                        <td className="num">{num(s.totalQuantity)}</td>
                        <td className="num nowrap">{moneyOrDash(s.sampleFeeBase, baseCurrency)}</td>
                        <td className="num nowrap">{moneyOrDash(s.expressFeeBase, baseCurrency)}</td>
                        <td className="num nowrap">{moneyOrDash(s.netAdvanceBase, baseCurrency)}</td>
                        <td className="num">
                          {s.feeStatus === 'unpaid' && s.totalFee > 0 ? (
                            s.rateMissing ? (
                              <span className="tag amber" title="汇率未填，工作台待收里少算了这单，请编辑补上">⚠ 汇率未填</span>
                            ) : (
                              <span>{money(s.receivableBase, baseCurrency)}</span>
                            )
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td>
                          {/* R4-S5：列表页状态列一律只读 tag（和旁边「打样费收款」形态一致）。
                              改状态的入口没堵：点「⋯」菜单里的「编辑」，弹窗里还是下拉框。 */}
                          <SampleStatusTag status={s.status} />
                        </td>
                        <td>
                          <SampleFeeTag status={s.feeStatus} />
                          {s.legacyPaidNoFlow ? (
                            <div className="faint" title="升级前只改了收款标记，没有流水；月报里没有这笔">
                              旧记录·无流水
                            </div>
                          ) : s.collected > 0.001 ? (
                            <div className="faint">已收 {money(s.collected)}</div>
                          ) : null}
                          {/* R27：客户预收抵的那部分不是现金，列表上单独标，别让人以为没收钱 */}
                          {s.creditApplied > 0.001 ? (
                            <div className="faint" title="用客户预收抵扣，不算现金到账">
                              预收抵 {money(s.creditApplied, s.currency)}
                            </div>
                          ) : null}
                        </td>
                        <td className="mono clip-100" title={s.trackingNo || ''}>
                          {s.trackingNo || '—'}
                        </td>
                        {/* N36：客户问「到了吗」列表一眼能答，不用点开编辑弹窗 */}
                        <td className="nowrap faint">
                          {s.shippedAt
                            ? `${s.shippedAt.slice(0, 10).slice(5)} 寄${
                                s.receivedAt ? ` / ${s.receivedAt.slice(0, 10).slice(5)} 收` : ' / 未收'
                              }`
                            : '未寄'}
                        </td>
                        <td className="cell-actions">
                          {s.totalFee > 0 || s.collected > 0 ? (
                            <button
                              className="link"
                              onClick={() => setPaying(s)}
                              title="登记 / 撤销打样费实收（按银行水单）"
                            >
                              收款
                            </button>
                          ) : null}
                          {s.convertedOrderId ? (
                            <>
                              <button
                                className="link"
                                onClick={() => navigate(`/orders/${s.convertedOrderId}`)}
                                title="已转成订单，点这里看订单"
                              >
                                看订单
                              </button>
                              {s.convertedOrderStatus === 'void' ? (
                                <button
                                  className="link"
                                  onClick={() => {
                                    setConvPi('')
                                    setConverting(s)
                                  }}
                                  title="上次转出的订单已作废：可以按新单重转，旧单仍留档"
                                >
                                  重新转单
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <button
                              className="link"
                              onClick={() => {
                                setConvPi('')
                                setConverting(s)
                              }}
                            >
                              转订单
                            </button>
                          )}
                          <ActionMenu
                            items={[
                              { text: '编辑', onClick: () => setEditing(s) },
                              {
                                text: '预览打样单',
                                onClick: async () => {
                                  const settings = await window.api.settings.get()
                                  setPreview({ html: renderSample({ sample: s, settings }), no: s.sampleNo })
                                }
                              },
                              { text: '删除', danger: true, onClick: () => void remove(s) }
                            ]}
                          />
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

      {converting ? (
        <Modal
          title={`打样单转订单 ${converting.sampleNo}`}
          onClose={() => setConverting(null)}
          footer={
            <>
              <Button  onClick={() => setConverting(null)}>
                取消
              </Button>
              {/* 不抵扣：样品费照收，转出来的订单里没有抵扣行 */}
              <Button
                disabled={converting.items.some((i: any) => !(Number(i.goodsUnitPrice) > 0))}
                onClick={() => void doConvert(false)}
              >
                不抵扣，直接转
              </Button>
              {/* 抵扣：样品费+快递费变成订单里的负费用行，打样单标记「下单抵扣」 */}
              <Button
                variant="primary"
                disabled={
                  converting.items.some((i: any) => !(Number(i.goodsUnitPrice) > 0)) ||
                  converting.feeStatus === 'paid' ||
                  converting.feeStatus === 'waived'
                }
                onClick={() => void doConvert(true)}
              >
                打样费抵扣，转订单
              </Button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>客户确认样品了，要转成正式订单吗？</p>
          {converting.items.some((i: any) => !(Number(i.goodsUnitPrice) > 0)) ? (
            <div className="alert warn">
              这些款号还没填大货单价：
              {converting.items
                .filter((i: any) => !(Number(i.goodsUnitPrice) > 0))
                .map((i: any) => i.styleNo || '(未填款号)')
                .join('、')}
              。打样单价只是打样费，不能当大货价。请先关掉这里，点「编辑」补上大货单价再转单。
            </div>
          ) : null}
          <div className="price-calc">
            <div>
              <span className="muted">客户</span>
              <span>{converting.customer?.company}</span>
            </div>
            <div>
              <span className="muted">款号</span>
              <span>{converting.items.map((i: any) => i.styleNo).filter(Boolean).join('、') || '—'}</span>
            </div>
            <div>
              <span className="muted">数量</span>
              <span>{num(converting.totalQuantity)} 件（大货数量转单后自己改）</span>
            </div>
            <div>
              <span className="muted">样品费</span>
              <span>{money(converting.sampleFee)}</span>
            </div>
            <div>
              <span className="muted">快递费</span>
              <span>{money(Number(converting.expressFee) || 0)}</span>
            </div>
            <div>
              <span className="muted">抵扣合计</span>
              <span>
                {converting.feeStatus === 'paid'
                  ? '样品费已收，转单不再抵扣'
                  : converting.feeStatus === 'waived'
                    ? '样品费已免收，转单不抵扣'
                    : money(converting.sampleFee + (Number(converting.expressFee) || 0))}
              </span>
            </div>
            <div>
              <span className="muted">大货单价（转单用）</span>
              <span>
                {converting.items
                  .map((i: any) => `${i.styleNo || '(未填款号)'} ${i.goodsUnitPrice ?? '未填'}`)
                  .join('、')}
              </span>
            </div>
          </div>
          <div className="field mt-3">
            <label>转出来的订单，PI 现在就发吗？*</label>
            <label className="row mt-1 gap-1">
              <input type="radio" name="smp-convert-pi" checked={convPi === 'sent'} onChange={() => setConvPi('sent')} />
              <span>PI 现在就发 → 状态「待确认」，进销售额、进待收，工作台会提醒</span>
            </label>
            <label className="row mt-1 gap-1">
              <input type="radio" name="smp-convert-pi" checked={convPi === 'draft'} onChange={() => setConvPi('draft')} />
              <span>先存草稿 → 不进销售额也不进待收（系统当它不存在）；PI 发出后要回订单改成「待确认」</span>
            </label>
            <div className="hint">不选就点转单会拦住你——草稿单忘了改状态，月底对账会少一笔。</div>
          </div>
          <div className="alert info mt-3">
            「抵扣」= 样品费与快递费一起从订单金额里扣掉（单据上会印一行「样品费及快递费抵扣」，客户对账能看懂），
            这张打样单会自动标成「下单抵扣」；「不抵扣」= 这两笔另外向客户收。
            选错也没关系，转完在订单里改费用行就行。
          </div>
        </Modal>
      ) : null}

      {editing ? (
        <SampleModal
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            toast(editing.id ? '打样单已修改' : '打样单已保存')
            await load()
          }}
        />
      ) : null}

      {paying ? (
        <SamplePayModal
          sample={paying}
          onClose={() => setPaying(null)}
          onChanged={load}
        />
      ) : null}

      {preview ? (
        <Modal
          title={`样品单预览 ${preview.no}`}
          onClose={() => setPreview(null)}
          size="xwide"
          footer={
            <>
              <Button  onClick={() => setPreview(null)}>
                关闭
              </Button>
              <Button variant="primary"
                
                onClick={async () => {
                  try {
                    const out = await window.api.window.printPdf({
                      html: preview.html,
                      fileName: `${preview.no}.pdf`,
                      docNo: preview.no
                    })
                    if (out) toast('PDF 已保存')
                  } catch (e) {
                    toast((e as Error).message || 'PDF 没存成', 'error')
                  }
                }}
              >
                另存为 PDF
              </Button>
            </>
          }
        >
          <div
            className="doc-preview"
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        </Modal>
      ) : null}
    </>
  )
}

/* ================= 打样费收款（R25） ================= */

function SamplePayModal({
  sample,
  onClose,
  onChanged
}: {
  sample: any
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<any>(sample)
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ paidAt: today(), amount: '', method: 'T/T', bankRef: '', note: '' })
  const [revoking, setRevoking] = useState<{ id: number; reason: string } | null>(null)

  const loadPayments = async () => {
    try {
      setRows(await window.api.samples.listPayments(sample.id))
    } catch (e) {
      toast((e as Error).message || '收款流水没加载出来', 'error')
    }
  }
  const reload = async () => {
    try {
      const fresh = await window.api.samples.get(sample.id)
      if (fresh) setDetail(fresh)
    } catch {
      // 详情拿不到时保留列表行上的数，流水列表仍可看
    }
    await loadPayments()
  }
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remaining = Math.max(
    0,
    Number(detail.totalFee ?? 0) - Number(detail.collected ?? 0) - Number(detail.creditApplied ?? 0)
  )
  const convertedLive = !!detail.convertedOrderId && detail.convertedOrderStatus !== 'void'
  const canAdd =
    detail.status !== 'cancelled' &&
    !convertedLive &&
    detail.feeStatus !== 'offset' &&
    detail.feeStatus !== 'waived' &&
    !(detail.feeStatus === 'paid' && detail.totalFee > 0.001)

  const add = async () => {
    if (busy) return
    const amount = Number(form.amount)
    if (!(amount > 0)) {
      toast('收款金额要大于 0', 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.samples.addPayment(sample.id, {
        paidAt: form.paidAt,
        amount,
        method: form.method,
        bankRef: form.bankRef.trim(),
        note: form.note.trim()
      })
      toast('已登记打样费收款')
      setForm({ ...form, amount: '', bankRef: '', note: '' })
      await reload()
      await onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!revoking || busy) return
    if (!revoking.reason.trim()) {
      toast('撤销收款要写原因（例如“金额录错”“客户退汇”）', 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.samples.deletePayment(sample.id, revoking.id, revoking.reason.trim())
      toast('已撤销这笔收款')
      setRevoking(null)
      await reload()
      await onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`打样费收款 · ${detail.sampleNo}`} onClose={onClose} size="wide">
      <div className="price-calc mb">
        <div>
          <span className="muted">应收（样品费 + 快递费）</span>
          <span>{money(Number(detail.totalFee) || 0, detail.currency)}</span>
        </div>
        <div>
          <span className="muted">已收（银行流水）</span>
          <span>{money(Number(detail.collected) || 0, detail.currency)}</span>
        </div>
        {Number(detail.creditApplied ?? 0) > 0.001 ? (
          <div>
            <span className="muted">客户预收抵扣（非现金）</span>
            <span>{money(Number(detail.creditApplied) || 0, detail.currency)}</span>
          </div>
        ) : null}
        <div className="total">
          <span>待收</span>
          <span>{money(remaining, detail.currency)}</span>
        </div>
      </div>

      {detail.legacyPaidNoFlow ? (
        <div className="alert warn">
          这笔样品费当年是按「已向客户收」记的老账，没有银行流水（月报里也没有）。要补流水，请先关掉这里，在「编辑」里把收款标记改回「未收」，再按水单登记。
        </div>
      ) : null}
      {detail.feeStatus === 'offset' ? (
        <div className="alert info">
          样品费已经抵扣到订单里了：这不是现金，不会出现在收款流水和月报里（订单的负费用行已经记过一次）。
        </div>
      ) : null}
      {detail.feeStatus === 'waived' ? <div className="alert info">这张单的样品费已免收。</div> : null}
      {convertedLive ? (
        <div className="alert info">
          这张打样单已经转成订单：转单前的实收只能看、不能再改；转单之后收到的钱请登记在订单上。
        </div>
      ) : null}
      {detail.status === 'cancelled' ? <div className="alert warn">这张打样单已取消，不能再登记收款。</div> : null}

      {canAdd ? (
        <div className="price-calc mb">
          <div>
            <span className="muted">到账日</span>
            <input
              type="date"
              value={form.paidAt}
              max={today()}
              onChange={(e) => setForm({ ...form, paidAt: e.target.value })}
            />
          </div>
          <div>
            <span className="muted">金额（{detail.currency}）</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              placeholder={remaining.toFixed(2)}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
          <div>
            <span className="muted">方式</span>
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {['T/T', 'L/C', 'PayPal', '西联', '其他'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="muted">银行流水号</span>
            <input
              value={form.bankRef}
              placeholder="选填，但填了对账更省事"
              onChange={(e) => setForm({ ...form, bankRef: e.target.value })}
            />
          </div>
          <div>
            <span className="muted">备注</span>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <div>
            <span className="muted">&nbsp;</span>
            <Button variant="primary" disabled={busy} onClick={() => void add()}>
              登记收款
            </Button>
          </div>
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>到账日</th>
              <th className="num">金额</th>
              <th>方式 / 流水号</th>
              <th>备注</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty text="还没有收款流水。客户真付了钱，用上面的表单按银行水单登记；抵扣不在这里，转订单时自动记。" />
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const rev = revoking?.id === p.id ? revoking : null
                return (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.paidAt)}</td>
                    <td className="num">{money(Number(p.amount) || 0, detail.currency)}</td>
                    <td className="mono">{p.bankRef || p.method || '—'}</td>
                    <td className="muted">{p.note || '—'}</td>
                    <td className="cell-actions">
                      {rev ? (
                        <>
                          <input
                            value={rev.reason}
                            placeholder="撤销原因（必填）"
                            onChange={(e) => setRevoking({ ...rev, reason: e.target.value })}
                          />
                          <button className="link" onClick={() => void revoke()}>
                            确认撤销
                          </button>
                          <button className="link" onClick={() => setRevoking(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          className="link"
                          disabled={convertedLive}
                          title={convertedLive ? '转单后不能撤销转单前的实收' : ''}
                          onClick={() => setRevoking({ id: p.id, reason: '' })}
                        >
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="hint">
        只有真金白银进这张表；「下单抵扣」是订单里的负费用行，不会在这里重复记一笔。撤销是更正录错的流水，原因会写进打样单的收款说明。
      </div>
    </Modal>
  )
}

/* ================= 新建 / 编辑 ================= */

function SampleModal({
  draft,
  onClose,
  onSaved
}: {
  draft: any
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const isEdit = !!draft.id
  const [customers, setCustomers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [form, setForm] = useState({
    customerId: draft.customerId ?? 0,
    // N-3：单号可在保存前改，撞号会被拦住（留一个出口）
    sampleNo: draft.sampleNo ?? '',
    sampleDate: draft.sampleDate ?? today(),
    courier: draft.courier ?? '',
    trackingNo: draft.trackingNo ?? '',
    expressFee: draft.expressFee ?? 0,
    status: (draft.status ?? 'pending') as SampleStatus,
    note: draft.note ?? '',
    shippedAt: draft.shippedAt ?? '',
    receivedAt: draft.receivedAt ?? '',
    factoryCost: draft.factoryCost ?? 0,
    feeStatus: (draft.feeStatus ?? 'unpaid') as SampleFeeStatus,
    feeNote: draft.feeNote ?? '',
    currency: draft.currency ?? 'USD',
    exchangeRate: draft.exchangeRate ?? 0,
    exchangeRateDate: draft.exchangeRateDate ?? ''
  })
  const [lines, setLines] = useState<LineRow[]>(
    (draft.items ?? []).map((it: any) => ({
      uid: clientKey(),
      productId: it.productId ?? null,
      styleNo: it.styleNo,
      productName: it.productName,
      composition: it.composition,
      color: it.color,
      size: it.size,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      goodsUnitPrice: it.goodsUnitPrice ?? null
    }))
  )

  useEffect(() => {
    // 编辑老打样单时，即使客户后来停用了也要能选回原来那个
    void window.api.customers.list('', true).then(setCustomers)
    void window.api.products.list('').then(setProducts)
  }, [])

  const sampleFee = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0)
  // 已收回预览：paid 由流水收齐推导；offset 是抵进订单的钱；未收时可能有部分实收
  const recoveredPreview =
    form.feeStatus === 'paid'
      ? sampleFee + (Number(form.expressFee) || 0)
      : form.feeStatus === 'offset'
        ? Number(draft.offsetAmount) || sampleFee + (Number(form.expressFee) || 0)
        : Number(draft.collected) || 0

  const setLine = (uid: string, patch: Partial<LineRow>) =>
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)))

  /** 手打款号：商品库里有就把品名/成分带出来 */
  const onStyleChange = (uid: string, styleNo: string) => {
    const hit = products.find((p) => p.styleNo === styleNo)
    setLine(uid, {
      styleNo,
      productId: hit?.id ?? null,
      productName: hit?.name ?? '',
      composition: hit?.composition ?? ''
    })
  }

  // 双击会烧两个样品单号、建两张单：保存期间把按钮按住
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    if (!form.customerId) {
      toast('请先选择客户', 'error')
      return
    }
    // 填了款号的行才算数，且数量必须 1 件以上——悄悄丢掉一行最坏：
    // 用户以为样品费里含那两件，账上根本没有这一行
    const filled = lines.filter((l) => l.styleNo.trim())
    if (filled.length === 0) {
      toast('请至少填写一行样品明细', 'error')
      return
    }
    const halfFilled = filled.filter((l) => !(Number(l.quantity) > 0))
    if (halfFilled.length > 0) {
      toast(`这几行填了款号但数量不是 1 件以上：${halfFilled.map((l) => l.styleNo).join('、')}。不做的行请点「删行」`, 'error')
      return
    }
    const cleanItems = filled.map(({ uid: _uid, ...rest }) => rest)
    setBusy(true)
    try {
      await window.api.samples.save({
        id: draft.id,
        customerId: form.customerId,
        sampleNo: form.sampleNo,
        sampleDate: form.sampleDate,
        courier: form.courier,
        trackingNo: form.trackingNo,
        expressFee: Number(form.expressFee) || 0,
        status: form.status,
        note: form.note,
        shippedAt: form.shippedAt,
        receivedAt: form.receivedAt,
        factoryCost: Number(form.factoryCost) || 0,
        feeStatus: form.feeStatus,
        feeNote: form.feeNote,
        currency: form.currency,
        exchangeRate: Number(form.exchangeRate) || 0,
        exchangeRateDate: form.exchangeRateDate,
        items: cleanItems
      })
      await onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const selected = useMemo(
    () => customers.find((c) => c.id === form.customerId),
    [customers, form.customerId]
  )

  return (
    <Modal
      title={isEdit ? `编辑打样单 ${draft.sampleNo}` : '新建打样单'}
      onClose={onClose}
      size="xwide"
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            保存打样单
          </Button>
        </>
      }
    >
      <div className="field">
        <label>样品单号（凭据号；留空 = 保存时自动编号）</label>
        <input
          value={form.sampleNo}
          onChange={(e) => setForm({ ...form, sampleNo: e.target.value })}
          placeholder="如 SMP20261021003，留空自动编"
        />
        <div className="hint">单号不能跟别的打样单重号——重了会红字拦住，在这里换个号再保存。</div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>客户 *</label>
          <select
            value={form.customerId || ''}
            onChange={(e) => setForm({ ...form, customerId: Number(e.target.value) })}
          >
            <option value="">请选择客户…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company}
                {c.country ? ` (${c.country})` : ''}
              </option>
            ))}
          </select>
          {selected?.address ? <div className="hint">{selected.address}</div> : null}
        </div>
        <div className="field">
          <label>打样日期</label>
          <input
            type="date"
            value={form.sampleDate}
            onChange={(e) => setForm({ ...form, sampleDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label>状态</label>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as SampleStatus })}
          >
            {SAMPLE_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SAMPLE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {form.status === 'cancelled' ? (
            <div className="hint">改成「已取消」时，备注里要写清原因：单子从此不再跟，这句话是唯一的交代。</div>
          ) : null}
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>快递公司</label>
          <input
            value={form.courier}
            onChange={(e) => setForm({ ...form, courier: e.target.value })}
            placeholder="如 顺丰 / DHL"
          />
        </div>
        <div className="field">
          <label>快递单号</label>
          <input
            value={form.trackingNo}
            onChange={(e) => setForm({ ...form, trackingNo: e.target.value })}
            placeholder="寄出后回填，客户问起来能查"
          />
        </div>
        <div className="field">
          <label>快递费（公司垫的钱）</label>
          <input
            type="number"
            step="0.01"
            value={form.expressFee}
            onChange={(e) => setForm({ ...form, expressFee: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>寄出日期（客户问「到了吗」一眼能答）</label>
          <input
            type="date"
            value={form.shippedAt}
            onChange={(e) => setForm({ ...form, shippedAt: e.target.value })}
          />
        </div>
        <div className="field">
          <label>客户签收日期</label>
          <input
            type="date"
            value={form.receivedAt}
            onChange={(e) => setForm({ ...form, receivedAt: e.target.value })}
          />
        </div>
        <div className="field">
          <label>工厂打样费（公司实际成本）</label>
          <input
            type="number"
            step="0.01"
            value={form.factoryCost}
            onChange={(e) => setForm({ ...form, factoryCost: Number(e.target.value) })}
            placeholder="付给工厂的打样费，年底算亏损用"
          />
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>打样费收款标记</label>
          <select
            value={form.feeStatus}
            disabled={Number(draft.flowCount ?? 0) > 0}
            onChange={(e) => setForm({ ...form, feeStatus: e.target.value as SampleFeeStatus })}
          >
            {SAMPLE_FEE_STATUS_ORDER.map((f) => (
              <option key={f} value={f} disabled={(f === 'paid' || f === 'offset') && form.feeStatus !== f}>
                {SAMPLE_FEE_STATUS_LABEL[f]}
              </option>
            ))}
          </select>
          <div className="hint">
            {Number(draft.flowCount ?? 0) > 0
              ? '这张单已经有收款流水：收款状态由流水自动推导，不能手工改（撤销流水后会跟着回退）。'
              : '「已向客户收」要用列表里的「收款」按水单登记，收齐后自动标记；「下单抵扣」只有转订单时才会自动记。只有「未收」会计进待收和催款提醒。'}
          </div>
        </div>
        <div className="field">
          <label>币种 / 汇率 / 汇率日期（未收时必填）</label>
          <div className="row" style={{ gap: 6 }}>
            <select
              style={{ width: 84 }}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="number"
              step="0.0001"
              placeholder="汇率"
              value={form.exchangeRate || ''}
              onChange={(e) => setForm({ ...form, exchangeRate: Number(e.target.value) })}
            />
            <input
              type="date"
              title="汇率日期"
              value={form.exchangeRateDate}
              onChange={(e) => setForm({ ...form, exchangeRateDate: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>收款说明</label>
          <input
            value={form.feeNote}
            onChange={(e) => setForm({ ...form, feeNote: e.target.value })}
            placeholder="如「已下单抵扣 PO-xxx」"
          />
        </div>
      </div>

      <div className="row sec-head">
        <strong className="sec-head">样品明细</strong>
        <div className="spacer" />
        <Button size="sm"
          
          onClick={() =>
            setLines((ls) => [
              ...ls,
              {
                uid: clientKey(),
                productId: null,
                styleNo: '',
                productName: '',
                composition: '',
                color: '',
                size: '',
                quantity: 1,
                unitPrice: 0,
                goodsUnitPrice: null
              }
            ])
          }
        >
          + 加一行
        </Button>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '15%' }}>款号</th>
              <th style={{ width: '17%' }}>品名</th>
              <th style={{ width: '11%' }}>颜色</th>
              <th style={{ width: '9%' }}>尺码</th>
              <th className="num" style={{ width: '8%' }}>件数</th>
              <th className="num" style={{ width: '12%' }} title="打样费单价，不是大货价">
                样品单价
              </th>
              <th className="num" style={{ width: '11%' }}>金额</th>
              <th className="num" style={{ width: '12%' }} title="转订单时带过去的大货单价，必填才能转单">
                大货单价
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <Empty text="还没有明细。点「+ 加一行」把要打的款号写上。" />
                </td>
              </tr>
            ) : (
              lines.map((l) => (
                <tr key={l.uid}>
                  <td>
                    <input
                      list="sample-style-list"
                      value={l.styleNo}
                      onChange={(e) => onStyleChange(l.uid, e.target.value)}
                      placeholder="款号"
                    />
                  </td>
                  <td>
                    <input value={l.productName} onChange={(e) => setLine(l.uid, { productName: e.target.value })} />
                  </td>
                  <td>
                    <input value={l.color} onChange={(e) => setLine(l.uid, { color: e.target.value })} />
                  </td>
                  <td>
                    <input value={l.size} onChange={(e) => setLine(l.uid, { size: e.target.value })} />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      className="col-num-sm"
                      value={l.quantity}
                      onChange={(e) => setLine(l.uid, { quantity: Number(e.target.value) })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.01"
                      className="col-num-sm"
                      value={l.unitPrice}
                      onChange={(e) => setLine(l.uid, { unitPrice: Number(e.target.value) })}
                    />
                  </td>
                  <td className="num">{(l.quantity * l.unitPrice).toFixed(2)}</td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.01"
                      className="col-num-sm"
                      value={l.goodsUnitPrice ?? ''}
                      placeholder="转单必填"
                      onChange={(e) =>
                        setLine(l.uid, { goodsUnitPrice: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"  onClick={() => setLines((ls) => ls.filter((x) => x.uid !== l.uid))}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="tfoot-strong">
              <td colSpan={4}>样品费合计</td>
              <td className="num">{num(totalQty)}</td>
              <td></td>
              <td className="num">{sampleFee.toFixed(2)}</td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
        <datalist id="sample-style-list">
          {products.map((p) => (
            <option key={p.id} value={p.styleNo}>
              {p.name}
            </option>
          ))}
        </datalist>
      </div>

      <div className="price-calc mt">
        <div>
          <span className="muted">样品费（应收客户）</span>
          <span>{money(sampleFee)}</span>
        </div>
        <div>
          <span className="muted">快递费（公司垫付）</span>
          <span>{money(Number(form.expressFee) || 0)}</span>
        </div>
        <div>
          <span className="muted">工厂打样费（公司成本）</span>
          <span>{money(Number(form.factoryCost) || 0)}</span>
        </div>
        <div>
          <span className="muted">公司总成本 = 工厂打样费 + 快递费</span>
          <span>{money(Number(form.factoryCost || 0) + (Number(form.expressFee) || 0))}</span>
        </div>
        <div>
          <span className="muted">已收回的样品费（实收流水 / 下单抵扣）</span>
          <span className={recoveredPreview > 0.001 ? '' : 'faint'}>
            {money(recoveredPreview)}
          </span>
        </div>
        <div className="total">
          <span>公司净垫 = 总成本 − 已收回样品费</span>
          <span>
            {money(
              Number(form.factoryCost || 0) +
                (Number(form.expressFee) || 0) -
                recoveredPreview
            )}
          </span>
        </div>
      </div>
      <div className="hint">
        应收客户的钱 = 样品费 + 快递费（只有「未收」才计进工作台待收款）；
        公司净垫 = 公司实际垫出去多少（客户免单就是真亏这么多）。
      </div>

      <div className="field mt-2">
        <label>备注</label>
        <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
    </Modal>
  )
}
