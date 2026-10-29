import { useEffect, useState } from 'react'
import { Modal, useToast, money, Empty, fmtDate, PaymentTag, ShipTag, Button, LoadError, PromptModal, useLoadGuard } from '../ui'
import { localDate } from '../../../shared/date'
import { INCOTERMS, PAYMENT_METHOD_LABEL, type PaymentMethod } from '../../../shared/types'
import type { Customer, CustomerCreditApplication, CustomerCreditCurrency, CustomerCreditRefund } from '../../../shared/types'

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
  shipAttn: string
  shipAddress: string
  shipZipCode: string
  shipCountry: string
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
  shipAttn: '',
  shipAddress: '',
  shipZipCode: '',
  shipCountry: '',
  paymentPref: '',
  defaultPaymentMethod: '',
  defaultDepositRatio: '',
  defaultIncoterm: '',
  defaultPortLoading: '',
  defaultPortDestination: '',
  note: ''
}

/** 客户档案 → 弹窗草稿（数字转字符串，null 转空） */
function toDraft(c: Customer): Draft {
  return {
    ...blank,
    id: c.id,
    company: c.company,
    contact: c.contact,
    email: c.email,
    phone: c.phone,
    country: c.country,
    address: c.address,
    zipCode: c.zipCode,
    attn: c.attn,
    shipAttn: c.shipAttn ?? '',
    shipAddress: c.shipAddress ?? '',
    shipZipCode: c.shipZipCode ?? '',
    shipCountry: c.shipCountry ?? '',
    paymentPref: c.paymentPref,
    defaultPaymentMethod: c.defaultPaymentMethod,
    defaultDepositRatio: c.defaultDepositRatio == null ? '' : String(c.defaultDepositRatio),
    defaultIncoterm: c.defaultIncoterm,
    defaultPortLoading: c.defaultPortLoading,
    defaultPortDestination: c.defaultPortDestination,
    note: c.note
  }
}

/** 待收行的唯一键：单据类型 + 单据号。订单和打样单各自有自己的自增 id，两个池子会撞号。 */
const rowKey = (r: { kind: string; docId: number }) => `${r.kind}:${r.docId}`

/**
 * 水单总额核对：填了总额就说一句分配合不平。
 * 提示在弹窗里常驻，保存前还要当场确认一次——不平不拦是给人留余地（分期、尾款、汇损本来就不等），
 * 但「不确认就登记」会让账上凭空少一笔或多一笔，这一步得让人看清楚。
 */
function splitMismatch(rows: any[], amounts: Record<string, string>, bankTotal: string): string {
  const total = Number(bankTotal)
  if (!(total > 0)) return ''
  if (new Set(rows.map((r) => r.currency)).size > 1) return ''
  const allocated = rows.reduce((s, r) => s + Number(amounts[rowKey(r)] ?? 0), 0)
  const diff = total - allocated
  if (Math.abs(diff) <= 0.005) return ''
  // 预收是「某一单上实收超过了它的待收」才产生的，不是水单剩下的自动进账——话术别把人误导
  return `水单总额 ${total.toFixed(2)}，这里已分 ${allocated.toFixed(2)}：${
    diff > 0
      ? `还有 ${diff.toFixed(2)} 没分到单上。登记只入账分下去的这些，剩下的钱不会自己变成预收——要让它进预收台账，得把它分到某张单上（超过那张单待收的部分才算多收）`
      : `多分了 ${(-diff).toFixed(2)}，超出这些单的待收合计：超出部分会记成这家客户的预收，请确认金额没填错`
  }`
}

export default function Customers() {
  const toast = useToast()
  const [list, setList] = useState<Customer[]>([])
  const [keyword, setKeyword] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [detail, setDetail] = useState<{
    c: Customer
    stats: any
    orders: any[]
    base: string
    prices: any[]
    credits: CustomerCreditCurrency[]
  } | null>(null)
  const [includeInactive, setIncludeInactive] = useState(false)
  /** 水单拆分收款：一笔水单按行分摊到该客户名下的待收单 */
  const [split, setSplit] = useState<{
    c: Customer
    rows: any[]
    paidAt: string
    bankRef: string
    method: string
    note: string
    /** 键是 `kind:docId`：orders 与 sample_orders 各有各的自增号，裸 docId 会让「订单 12」和「打样 12」共用一格 */
    amounts: Record<string, string>
    /** 水单总额：只用来当场核对分配合不平，不落库、不硬拦（分期/尾款/汇损都会让两边不等） */
    bankTotal: string
    saving: boolean
  } | null>(null)
  /** 客户预收抵扣弹窗：同币种、仍待收的单里挑一张 */
  const [creditApply, setCreditApply] = useState<{
    c: Customer
    currency: string
    rows: any[]
    target: string
    amount: string
    note: string
    saving: boolean
  } | null>(null)
  /** 客户预收退款弹窗：钱真退出去了，余额必须当场减 */
  const [refundModal, setRefundModal] = useState<{
    c: Customer
    currency: string
    available: number
    amount: string
    refundAt: string
    bankRef: string
    note: string
    saving: boolean
  } | null>(null)
  /**
   * 撤销抵扣 / 撤销退款前的那一句「为什么」。
   * 固定话术（「客户页手动撤销」）等于没写：后端要的留痕，得由人当场敲一句。
   */
  const [reversePrompt, setReversePrompt] = useState<
    | { kind: 'credit'; app: CustomerCreditApplication }
    | { kind: 'refund'; refund: CustomerCreditRefund }
    | null
  >(null)
  /** 读取失败不能装成「没有客户」 */
  const [loadError, setLoadError] = useState('')

  const load = async (kw = keyword) => {
    try {
      setList(await window.api.customers.list(kw, includeInactive))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '客户列表没加载出来')
    }
  }

  useEffect(() => {
    void load()
  }, [includeInactive])

  const save = async (allowDuplicate = false) => {
    if (!draft) return
    if (!draft.company.trim()) {
      toast('请填写客户公司名', 'error')
      return
    }
    try {
      await window.api.customers.save({
        ...draft,
        allowDuplicate,
        defaultDepositRatio: draft.defaultDepositRatio === '' ? null : Number(draft.defaultDepositRatio)
      })
      toast(draft.id ? '已保存' : '已新增客户')
      setDraft(null)
      await load()
    } catch (e) {
      const msg = (e as Error).message
      // 同名可能是真重复，也可能是同集团的两个采购主体：拦一下，让人确认，不替他决定
      if (msg.includes('同名')) {
        if (confirm(`${msg}\n\n确认确实是另一家，就是要再建一个？`)) {
          await save(true)
          return
        }
        return
      }
      toast(msg, 'error')
    }
  }

  const remove = async (c: Customer) => {
    if (
      !confirm(
        `确认删除客户「${c.company}」？\n\n` +
          '有订单、报价、打样或预收抵扣/退款记录的客户删不掉——那些是货和钱的凭据。\n' +
          '建错了又不想在建单下拉里看见，请用「停用」：档案和历史单据都留着，只是不再带出来。'
      )
    )
      return
    try {
      await window.api.customers.remove(c.id)
      toast('已删除')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const toggleActive = async (c: Customer) => {
    try {
      await window.api.customers.setActive(c.id, c.active ? 0 : 1)
      toast(c.active ? '已停用：建单时不再出现在客户列表，历史单据照旧' : '已重新启用')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  /**
   * 客户详情：连点两家时，先点那家的响应可能后到，把后点的盖回去；
   * 关了弹窗后迟到的响应还会把弹窗重新弹出来，所以落盘前必须问一句「我还是最新那次吗」。
   */
  const beginDetail = useLoadGuard()

  const openDetail = async (c: Customer) => {
    const { isCurrent } = beginDetail()
    try {
      const [stats, orders, settings, prices, credits] = await Promise.all([
        window.api.customers.stats(c.id),
        window.api.customers.orders(c.id),
        window.api.settings.get(),
        window.api.customers.stylePriceHistory({ customerId: c.id }),
        window.api.credits.balance(c.id)
      ])
      if (!isCurrent()) return
      setDetail({ c, stats, orders, base: settings?.baseCurrency ?? 'CNY', prices, credits })
    } catch (e) {
      if (!isCurrent()) return
      toast((e as Error).message || '客户详情没加载出来，请重试', 'error')
    }
  }

  /** 关弹窗要顺手把在飞的请求作废掉，否则晚到的响应会把刚关的窗再弹开 */
  const closeDetail = () => {
    beginDetail()
    setDetail(null)
  }

  const openSplit = async (c: Customer) => {
    try {
      const rows = (await window.api.report.customerOrderRows(c.id)).filter((r) => r.receivable > 0.001)
      if (!rows.length) {
        toast('该客户名下没有待收的订单或打样单，不用拆', 'error')
        return
      }
      setSplit({
        c,
        rows,
        paidAt: localDate(),
        bankRef: '',
        method: 'T/T',
        note: '',
        amounts: {},
        bankTotal: '',
        saving: false
      })
    } catch (e) {
      toast((e as Error).message || '待收订单没加载出来', 'error')
    }
  }

  const saveSplit = async () => {
    if (!split) return
    const bankRef = split.bankRef.trim()
    if (!bankRef) {
      toast('先填银行流水号：拆分收款靠它把几笔收款归成同一笔水单，对账时找得到来路', 'error')
      return
    }
    const filled = split.rows
      .map((r) => ({ row: r, amount: Number(split.amounts[rowKey(r)] ?? 0) }))
      .filter((x) => x.amount > 0)
    if (!filled.length) {
      toast('至少给一张单填「本次收款」的金额', 'error')
      return
    }
    if (new Set(filled.map((x) => x.row.currency)).size > 1) {
      toast('选中的几张单币种不同：一笔水单只拆同一币种的单，其他币种请单独登记', 'error')
      return
    }
    const over = filled.filter((x) => x.amount > x.row.receivable + 0.001)
    if (
      over.length &&
      !window.confirm(
        `${over.map((x) => x.row.docNo).join('、')} 本次收款超过了该单待收金额。超额一般意味着金额填错了，确认按实收登记吗？`
      )
    ) {
      return
    }
    // 水单和分下去的钱对不平：不拦，但要人当场点一次头，别让人事后翻账才发现
    const mismatch = splitMismatch(split.rows, split.amounts, split.bankTotal)
    if (mismatch && !window.confirm(`${mismatch}。\n\n确认就按现在这些金额登记？`)) {
      return
    }
    setSplit({ ...split, saving: true })
    try {
      await window.api.orders.batchAddPayments(
        filled.map((x) => ({
          ...(x.row.kind === 'sample' ? { sampleOrderId: x.row.docId } : { orderId: x.row.docId }),
          paidAt: split.paidAt,
          amount: x.amount,
          method: split.method,
          bankRef,
          note: split.note.trim()
        }))
      )
      toast(`已按水单 ${bankRef} 拆分登记 ${filled.length} 笔收款`)
      setSplit(null)
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
      setSplit((s) => (s ? { ...s, saving: false } : s))
    }
  }

  /**
   * 用客户预收抵一张单（R27）：余额不是现金，抵扣只冲目标单的待收，
   * 所以这里只让选同币种、还有待收的单。抵完刷新客户详情，余额与待收一起变。
   */
  const openApply = async (c: Customer, currency: string) => {
    try {
      const rows = (await window.api.report.customerOrderRows(c.id)).filter(
        (r) => r.currency === currency && r.receivable > 0.001
      )
      if (!rows.length) {
        toast(`这家客户没有 ${currency} 的待收单据可以抵`, 'error')
        return
      }
      setCreditApply({
        c,
        currency,
        rows,
        target: rowKey(rows[0]),
        amount: '',
        note: '',
        saving: false
      })
    } catch (e) {
      toast((e as Error).message || '待收单据没加载出来', 'error')
    }
  }

  const saveApply = async () => {
    if (!creditApply) return
    const [kind, id] = creditApply.target.split(':')
    const amount = Number(creditApply.amount)
    if (!(amount > 0)) {
      toast('填一个大于 0 的抵扣金额', 'error')
      return
    }
    setCreditApply({ ...creditApply, saving: true })
    try {
      await window.api.credits.apply({
        customerId: creditApply.c.id,
        currency: creditApply.currency,
        targetKind: kind === 'sample' ? 'sample' : 'order',
        targetId: Number(id),
        amount,
        note: creditApply.note.trim()
      })
      toast(`已用客户预收抵扣 ${amount.toFixed(2)} ${creditApply.currency}（不算现金到账）`)
      const c = creditApply.c
      setCreditApply(null)
      await openDetail(c)
    } catch (e) {
      toast((e as Error).message, 'error')
      setCreditApply((s) => (s ? { ...s, saving: false } : s))
    }
  }

  /** 执行撤销：原因由弹窗收集；没撤成（余额已被用掉等）就把弹窗留着，让人改一句话再试 */
  const doReverse = async (
    target: { kind: 'credit'; app: CustomerCreditApplication } | { kind: 'refund'; refund: CustomerCreditRefund },
    reason: string
  ): Promise<boolean> => {
    try {
      if (target.kind === 'credit') await window.api.credits.reverse(target.app.id, reason)
      else await window.api.credits.reverseRefund(target.refund.id, reason)
      toast(target.kind === 'credit' ? '已撤销这笔预收抵扣' : '已撤销这笔退款记录，余额已恢复')
      if (detail) await openDetail(detail.c)
      return true
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    }
  }

  /**
   * 退还客户预收（R28）：余额是「钱还在我们账上」，退出去必须记一笔，
   * 否则同一笔钱退了还能再抵下一张单。日期、水单、原因都是凭据。
   */
  const openRefund = (c: Customer, cc: CustomerCreditCurrency) => {
    setRefundModal({
      c,
      currency: cc.currency,
      available: cc.available,
      amount: '',
      refundAt: localDate(),
      bankRef: '',
      note: '',
      saving: false
    })
  }

  const saveRefund = async () => {
    if (!refundModal) return
    const amount = Number(refundModal.amount)
    if (!(amount > 0)) {
      toast('填一个大于 0 的退还金额', 'error')
      return
    }
    if (!refundModal.bankRef.trim()) {
      toast('先填银行水单号：这是钱已经退给客户的凭据', 'error')
      return
    }
    if (!refundModal.note.trim()) {
      toast('写一句退款原因（例如「客户取消尾单，多付退回」）', 'error')
      return
    }
    setRefundModal({ ...refundModal, saving: true })
    try {
      await window.api.credits.refund({
        customerId: refundModal.c.id,
        currency: refundModal.currency,
        amount,
        refundAt: refundModal.refundAt,
        bankRef: refundModal.bankRef.trim(),
        note: refundModal.note.trim()
      })
      toast(`已登记退还 ${amount.toFixed(2)} ${refundModal.currency}：这笔钱不再算可用预收`)
      const c = refundModal.c
      setRefundModal(null)
      await openDetail(c)
    } catch (e) {
      toast((e as Error).message, 'error')
      setRefundModal((s) => (s ? { ...s, saving: false } : s))
    }
  }

  const splitNote = split ? splitMismatch(split.rows, split.amounts, split.bankTotal) : ''

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
          <div className="field" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="show-inactive-customers"
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            <label htmlFor="show-inactive-customers" style={{ marginBottom: 0 }}>
              显示已停用
            </label>
          </div>
          <span className="faint">共 {list.length} 个客户</span>
        </div>

        <div className="card">
          <div className="card-body tight">
            {loadError ? (
              <LoadError what="客户列表" message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
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
                      <tr
                        key={c.id}
                        className="clickable"
                        style={c.active ? undefined : { opacity: 0.5 }}
                        onClick={() => openDetail(c)}
                      >
                        <td style={{ fontWeight: 550 }}>
                          {c.company}
                          {!c.active ? <span className="tag" style={{ marginLeft: 6 }}>已停用</span> : null}
                        </td>
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
                              setDraft(toDraft(c))
                            }}
                          >
                            编辑
                          </button>
                          <button
                            className="link"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleActive(c)
                            }}
                          >
                            {c.active ? '停用' : '启用'}
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
              <Button variant="primary"  onClick={() => void save()}>
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
            <div className="hint">这是账单 / 发票抬头，PI、CI 上印它。</div>
          </div>

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>收货抬头（和上面的地址不同时才填）</h3>
          <div className="hint" style={{ marginBottom: 6 }}>
            填了它，装箱单（PL）就印收货人这一套；不填则 PL 与 PI 一样印账单地址。货代和报关看的是收货人，别混。
          </div>
          <div className="field-row-3">
            <div className="field">
              <label>收货人 / 收件人</label>
              <input
                value={draft.shipAttn}
                onChange={(e) => setDraft({ ...draft, shipAttn: e.target.value })}
                placeholder="如 Warehouse / Mr. Lee"
              />
            </div>
            <div className="field">
              <label>收货邮编</label>
              <input
                value={draft.shipZipCode}
                onChange={(e) => setDraft({ ...draft, shipZipCode: e.target.value })}
              />
            </div>
            <div className="field">
              <label>收货国家</label>
              <input
                value={draft.shipCountry}
                onChange={(e) => setDraft({ ...draft, shipCountry: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>收货地址</label>
            <input
              value={draft.shipAddress}
              onChange={(e) => setDraft({ ...draft, shipAddress: e.target.value })}
              placeholder="如 1234 Industrial Rd, Long Beach"
            />
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
        <Modal title={detail.c.company} onClose={closeDetail} size="wide">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="stat">
              <div className="stat-label">订单数</div>
              <div className="stat-value small">{detail.stats.orderCount}</div>
              {detail.stats.excludedOrderCount > 0 ? (
                <div className="stat-hint">另有 {detail.stats.excludedOrderCount} 张草稿/作废单不算成交</div>
              ) : null}
            </div>
            <div className="stat">
              <div className="stat-label">累计成交额</div>
              <div className="stat-value small">{money(detail.stats.totalAmount, detail.base)}</div>
              {detail.stats.rateMissingOrders > 0 ? (
                <div className="stat-hint">
                  有 {detail.stats.rateMissingOrders} 单外币没填汇率，成交额/未收/毛利都没折进去
                </div>
              ) : null}
            </div>
            <div className="stat">
              <div className="stat-label">累计毛利</div>
              <div className="stat-value small">
                {detail.stats.missingCostOrders || detail.stats.rateMissingOrders
                  ? '—'
                  : money(detail.stats.totalProfit, detail.base)}
              </div>
              {detail.stats.missingCostOrders ? (
                <div className="stat-hint">有 {detail.stats.missingCostOrders} 单成本没录全</div>
              ) : null}
              {detail.stats.rateMissingOrders ? (
                <div className="stat-hint">有 {detail.stats.rateMissingOrders} 单汇率没填</div>
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
            {detail.c.shipAddress ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <span className="muted">收货抬头（PL）</span>
                <span>
                  {detail.c.shipAttn ? `${detail.c.shipAttn} · ` : ''}
                  {detail.c.shipAddress} {detail.c.shipZipCode} {detail.c.shipCountry}
                </span>
              </div>
            ) : null}
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

          <h3 style={{ fontSize: 13, margin: '4px 0 8px' }}>客户预收（多收 / 作废余款 / 取消单实收）</h3>
          {detail.credits.length === 0 ? (
            <p className="faint" style={{ margin: '0 0 12px' }}>
              暂无预收余额。客户多付的钱、作废单上已到的款、取消打样单的实收都会自动归到这里，可以抵下一张单。
            </p>
          ) : (
            detail.credits.map((cc) => (
              <div key={cc.currency} className="card" style={{ padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <strong>{cc.currency}</strong>
                  <span>
                    可用{' '}
                    <strong style={{ color: cc.available < -0.001 ? 'var(--danger)' : undefined }}>
                      {money(cc.available, cc.currency)}
                    </strong>
                  </span>
                  <span className="faint">
                    来源 {money(cc.gross, cc.currency)} − 已抵扣 {money(cc.applied, cc.currency)}
                    {cc.refunded > 0.001 ? ` − 已退还 ${money(cc.refunded, cc.currency)}` : ''}
                  </span>
                  <div className="spacer" />
                  {cc.available > 0.001 ? (
                    <>
                      <Button size="sm" onClick={() => void openApply(detail.c, cc.currency)}>
                        抵一张单
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openRefund(detail.c, cc)}>
                        退还
                      </Button>
                    </>
                  ) : null}
                </div>
                {cc.available < -0.001 ? (
                  <p style={{ color: 'var(--danger)', margin: '8px 0 0' }}>
                    预收出现缺口 {money(-cc.available, cc.currency)}
                    ：来源单据被改动过。请先撤销部分抵扣，再使用这笔余额。
                  </p>
                ) : null}
                {cc.sources.length > 0 ? (
                  <div className="faint" style={{ marginTop: 8, lineHeight: 1.7 }}>
                    来源：
                    {cc.sources
                      .map((s) => `${s.docNo}（${s.statusText}）${money(s.amount, s.currency)}`)
                      .join('；')}
                  </div>
                ) : null}
                {cc.applications.length > 0 ? (
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>抵扣到</th>
                          <th>日期</th>
                          <th className="num">金额</th>
                          <th>备注</th>
                          <th>操作人</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {cc.applications.map((a) => (
                          <tr key={a.id}>
                            <td className="mono">{a.targetNo}</td>
                            <td className="faint nowrap">{a.appliedAt}</td>
                            <td className="num">{money(a.amount, a.currency)}</td>
                            <td className="faint">{a.note || '—'}</td>
                            <td className="faint">{a.actor || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <Button size="sm" variant="ghost" onClick={() => setReversePrompt({ kind: 'credit', app: a })}>
                                撤销
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {cc.refunds.length > 0 ? (
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>退还日期</th>
                          <th>银行水单</th>
                          <th className="num">金额</th>
                          <th>原因</th>
                          <th>操作人</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {cc.refunds.map((f) => (
                          <tr key={f.id}>
                            <td className="faint nowrap">{f.refundAt}</td>
                            <td className="mono">{f.bankRef}</td>
                            <td className="num">{money(f.amount, f.currency)}</td>
                            <td className="faint">{f.note || '—'}</td>
                            <td className="faint">{f.actor || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <Button size="sm" variant="ghost" onClick={() => setReversePrompt({ kind: 'refund', refund: f })}>
                                撤销
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ))
          )}

          <h3 style={{ fontSize: 13, margin: '4px 0 8px' }}>历史成交价（报价前先看这家上次付了多少）</h3>
          {detail.prices.length === 0 ? (
            <Empty text="这个客户还没有成交过的款号" />
          ) : (
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>款号</th>
                    <th>颜色</th>
                    <th className="num">最近单价</th>
                    <th>币种</th>
                    <th>最近成交</th>
                    <th className="num">成交次数</th>
                    <th className="num">累计数量</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.prices.map((r, i) => (
                    <tr key={`${r.styleNo}|${r.color}|${i}`}>
                      <td className="mono">{r.styleNo}</td>
                      <td className="muted">{r.color || '—'}</td>
                      <td className="num">{money(r.lastUnitPrice, r.lastCurrency)}</td>
                      <td className="muted">{r.lastCurrency}</td>
                      <td className="faint nowrap">{fmtDate(r.lastDate)}</td>
                      <td className="num">{r.times}</td>
                      <td className="num">{r.totalQuantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
                      <td className="num">
                        {money(o.remaining, o.currency)}
                        {o.counted ? null : <span className="faint"> · 不催款</span>}
                        {o.counted && o.creditApplied > 0.001 ? (
                          <div className="faint">其中预收抵扣 {money(o.creditApplied, o.currency)}</div>
                        ) : null}
                      </td>
                      <td className="faint nowrap">{fmtDate(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 客户问「我还欠哪几张 PI、样品费收没收」时不用再逐单手抄：
              对账单是给客户看的那一份（订单 + 打样单 + 逐笔收款），不带成本毛利 */}
          {detail.orders.length > 0 || detail.stats.sampleCount > 0 ? (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              {detail.stats.outstanding > 0 ? (
                <Button variant="primary" onClick={() => void openSplit(detail.c)}>
                  水单拆分收款
                </Button>
              ) : null}
              <Button
                onClick={async () => {
                  try {
                    const f = await window.api.exporter.csv('statement', { customerId: detail.c.id })
                    if (f) toast(`已导出 ${detail.c.company} 的对账单（含打样单与收款明细）`)
                  } catch (e) {
                    toast((e as Error).message || '导出没成功', 'error')
                  }
                }}
              >
                导出对账单（Excel）
              </Button>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {creditApply ? (
        <Modal title={`用客户预收抵扣 · ${creditApply.c.company}`} onClose={() => setCreditApply(null)}>
          <p className="faint" style={{ marginTop: 0 }}>
            抵扣不是现金到账：只冲减目标单的待收，不进收款流水、月报和毛利。只能抵同一币种的单。
          </p>
          <div className="price-calc mb">
            <div>
              <span className="muted">币种</span>
              <span>{creditApply.currency}</span>
            </div>
            <div>
              <span className="muted">抵到哪张单</span>
              <select
                value={creditApply.target}
                onChange={(e) => setCreditApply({ ...creditApply, target: e.target.value })}
              >
                {creditApply.rows.map((r) => (
                  <option key={rowKey(r)} value={rowKey(r)}>
                    {r.docNo} · 待收 {money(r.receivable, r.currency)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="muted">抵扣金额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={creditApply.amount}
                onChange={(e) => setCreditApply({ ...creditApply, amount: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">备注</span>
              <input
                placeholder="选填，如「上次多收的定金转过来」"
                value={creditApply.note}
                onChange={(e) => setCreditApply({ ...creditApply, note: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setCreditApply(null)}>取消</Button>
            <Button variant="primary" disabled={creditApply.saving} onClick={() => void saveApply()}>
              {creditApply.saving ? '抵扣中…' : '确认抵扣'}
            </Button>
          </div>
        </Modal>
      ) : null}

      {refundModal ? (
        <Modal title={`退还客户预收 · ${refundModal.c.company}`} onClose={() => setRefundModal(null)}>
          <p className="faint" style={{ marginTop: 0 }}>
            退还的是已经收到的钱：登记后这笔余额当场减掉，不能再拿去抵下一张单。日期、银行水单、原因都会留在这客户的预收台账里。
          </p>
          <div className="price-calc mb">
            <div>
              <span className="muted">币种</span>
              <span>
                {refundModal.currency} · 当前可用 {money(refundModal.available, refundModal.currency)}
              </span>
            </div>
            <div>
              <span className="muted">退还金额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={refundModal.amount}
                onChange={(e) => setRefundModal({ ...refundModal, amount: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">退还日期</span>
              <input
                type="date"
                max={localDate()}
                value={refundModal.refundAt}
                onChange={(e) => setRefundModal({ ...refundModal, refundAt: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">银行水单号</span>
              <input
                value={refundModal.bankRef}
                placeholder="退款水单上的流水号（必填）"
                onChange={(e) => setRefundModal({ ...refundModal, bankRef: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">原因</span>
              <input
                placeholder="必填，如「客户取消尾单，多付退回」"
                value={refundModal.note}
                onChange={(e) => setRefundModal({ ...refundModal, note: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setRefundModal(null)}>取消</Button>
            <Button variant="primary" disabled={refundModal.saving} onClick={() => void saveRefund()}>
              {refundModal.saving ? '登记中…' : '确认退还'}
            </Button>
          </div>
        </Modal>
      ) : null}

      {reversePrompt ? (
        <PromptModal
          title={
            reversePrompt.kind === 'credit'
              ? `撤销预收抵扣 · ${reversePrompt.app.targetNo}`
              : `撤销退款记录 · ${money(reversePrompt.refund.amount, reversePrompt.refund.currency)}`
          }
          label={
            reversePrompt.kind === 'credit' ? (
              <>
                为什么撤销这笔 {reversePrompt.app.amount.toFixed(2)} {reversePrompt.app.currency} 的抵扣？（必填，写进操作历史）
                <br />
                <span className="muted">
                  撤销后客户的余额回来，{reversePrompt.app.targetNo} 的待收也跟着回来。
                </span>
              </>
            ) : (
              <>
                为什么撤销这笔 {reversePrompt.refund.amount.toFixed(2)} {reversePrompt.refund.currency} 的退款记录？（必填，写进操作历史）
                <br />
                <span className="muted">
                  只有「水单录错、钱其实没退出去」才这么做，撤销后余额会恢复。水单号 {reversePrompt.refund.bankRef}
                  也跟着腾出来，可以按正确的金额重登一笔。
                </span>
              </>
            )
          }
          okText={reversePrompt.kind === 'credit' ? '撤销抵扣' : '撤销退款记录'}
          multiline
          onOk={async (reason) => {
            if (!reason.trim()) {
              toast('原因要写一句：撤销会把余额和待收一起改回去，历史里得说清为什么。', 'error')
              return false
            }
            const ok = await doReverse(reversePrompt, reason.trim())
            if (ok) setReversePrompt(null)
            return false
          }}
          onClose={() => setReversePrompt(null)}
        />
      ) : null}

      {split ? (
        <Modal title={`水单拆分收款 · ${split.c.company}`} onClose={() => setSplit(null)} size="wide">
          <p className="faint" style={{ marginTop: 0 }}>
            客户一笔水单付多张 PI（或样品费）时，在这里按行分摊：整批共用一个流水号，任何一笔没登进去整批都会退回，不会出现落一半的钱。
          </p>
          <div className="price-calc mb">
            <div>
              <span className="muted">到账日</span>
              <input
                type="date"
                value={split.paidAt}
                max={localDate()}
                onChange={(e) => setSplit({ ...split, paidAt: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">银行流水号</span>
              <input
                value={split.bankRef}
                placeholder="水单上的流水号（必填）"
                onChange={(e) => setSplit({ ...split, bankRef: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">方式</span>
              <select value={split.method} onChange={(e) => setSplit({ ...split, method: e.target.value })}>
                {['T/T', 'L/C', 'PayPal', '西联', '其他'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <span className="muted">备注</span>
              <input
                value={split.note}
                placeholder="选填，如「客户水单 2026-10」"
                onChange={(e) => setSplit({ ...split, note: e.target.value })}
              />
            </div>
            <div>
              <span className="muted">水单总额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={split.bankTotal}
                placeholder="银行实际到账多少（选填）"
                onChange={(e) => setSplit({ ...split, bankTotal: e.target.value })}
              />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>单据号</th>
                  <th>PI号</th>
                  <th>状态</th>
                  <th className="num">待收</th>
                  <th className="num">本次收款</th>
                </tr>
              </thead>
              <tbody>
                {split.rows.map((r) => {
                  const amt = split.amounts[rowKey(r)] ?? ''
                  const over = Number(amt) > r.receivable + 0.001
                  return (
                    <tr key={`${r.kind}-${r.docId}`}>
                      <td className="mono">
                        {r.docNo}
                        {r.kind === 'sample' ? <span className="tag" style={{ marginLeft: 6 }}>打样</span> : null}
                      </td>
                      <td className="mono">{r.piNo || '—'}</td>
                      <td className="muted">{r.statusText}</td>
                      <td className="num">{money(r.receivable, r.currency)}</td>
                      <td className="num">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          style={{ width: 120, textAlign: 'right' }}
                          value={amt}
                          placeholder="0"
                          onChange={(e) =>
                            setSplit({ ...split, amounts: { ...split.amounts, [rowKey(r)]: e.target.value } })
                          }
                        />
                        {over ? <div className="faint">超过待收，提交时会再确认</div> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {splitNote ? <div className="hint" style={{ marginTop: 8 }}>{splitNote}</div> : null}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setSplit(null)}>取消</Button>
            <Button variant="primary" disabled={split.saving} onClick={() => void saveSplit()}>
              {split.saving ? '登记中…' : '整批登记'}
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
