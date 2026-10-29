import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Modal, useToast, money, num, Empty, fmtDate, fmtDateTime, today, ActionMenu, QuotationStatusTag, Button, clientKey, LoadError, useDebounced, useLoadGuard } from '../ui'
import {
  CURRENCIES,
  INCOTERMS,
  PAYMENT_METHOD_LABEL,
  QUOTATION_RESULT_LABEL,
  QUOTATION_STATUS_LABEL,
  type Currency,
  type Incoterm,
  type PaymentMethod,
  type Quotation,
  type QuotationCharge,
  type QuotationResult,
  type QuotationStatus
} from '../../../shared/types'
import { renderQuotation, type ImageMap } from '../../../shared/documents'
import { docPageFingerprint } from '../../../shared/docFingerprint'
import { addDays, localDate } from '../../../shared/date'

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
}

/** 报价单状态：可人工改的几个（已转订单是系统自动的） */
const EDITABLE_QUOTE_STATUS: QuotationStatus[] = ['draft', 'sent', 'confirmed', 'expired']

/** 报价结果的颜色（成交=绿、没成交=灰、待回=琥珀） */
function quoteResultTag(result: string): string {
  if (result === 'won') return 'green'
  if (result === 'lost') return 'grey'
  return 'amber'
}

/** 已经转成订单的报价单是那单的原始凭据：只有那单作废了才重新放开编辑/删除 */
function quoteEditable(q: { convertedOrderId: number | null; convertedOrderStatus?: string }): boolean {
  return !q.convertedOrderId || q.convertedOrderStatus === 'void'
}

/** 发出之后又改存过：客户手上那份可能还是旧价，需要再发一版 */
function staleAfterSend(q: Quotation): boolean {
  return q.status === 'sent' && !!q.sentAt && q.updatedAt > q.sentAt
}

export default function Quotations() {
  const navigate = useNavigate()
  const toast = useToast()
  const [list, setList] = useState<any[]>([])
  /** 读取失败不能装成「没有报价单」 */
  const [loadError, setLoadError] = useState('')
  // 工作台点「报价」提醒带 ?kw=Q-0001 跳进来：先把这一张筛出来
  const [searchParams] = useSearchParams()
  const [keyword, setKeyword] = useState(searchParams.get('kw') ?? '')
  const [tab, setTab] = useState('')
  const [editing, setEditing] = useState<any | null>(null)
  const [detail, setDetail] = useState<any | null>(null)
  const [convertTarget, setConvertTarget] = useState<any | null>(null)
  const [convertVersions, setConvertVersions] = useState<any[]>([])
  /** 历史版本拉取失败：转单按钮要停下来，不能拿「只有一版」的假象转出去 */
  const [convertVersionsError, setConvertVersionsError] = useState('')
  const [convertRevision, setConvertRevision] = useState<number | null>(null)
  const [overrideBy, setOverrideBy] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  // 敲太快时两个 list 请求在途，先发的旧结果不许盖住新关键词
  const kw = useDebounced(keyword, 250)
  const begin = useLoadGuard()

  const load = async () => {
    const { isCurrent } = begin()
    try {
      const rows = await window.api.quotations.list({
        keyword: kw,
        status: tab || undefined
      })
      if (!isCurrent()) return
      setList(rows)
      setLoadError('')
    } catch (e) {
      if (!isCurrent()) return
      setLoadError((e as Error).message || '报价单列表没加载出来')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, tab])

  const remove = async (q: any) => {
    if (!confirm(`确认删除报价单 ${q.qNo}？`)) return
    // N-1：后端拦住已转订单的报价单时会抛中文错误，必须弹出来，
    // 否则用户以为按钮坏了 / 以为删掉了（跟 Customers.tsx 的 catch 一个写法）
    try {
      await window.api.quotations.remove(q.id)
      toast('已删除')
      if (detail?.id === q.id) setDetail(null)
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  /** 打开转单弹窗：先把历史版本拉出来，默认选当前版 */
  const openConvert = async (q: any) => {
    setConvertTarget(q)
    setConvertRevision(Number(q.revision ?? 1))
    setOverrideBy('')
    setOverrideReason('')
    await loadConvertVersions(q)
  }

  /**
   * 历史版本没拉出来时不许转单：下拉只剩「当前第 N 版」，
   * 看着像只有一版，实际可能客户确认的是更早那一版的价格。
   */
  const loadConvertVersions = async (q: any) => {
    setConvertVersionsError('')
    try {
      setConvertVersions(await window.api.quotations.versions(q.id))
    } catch (e) {
      setConvertVersions([])
      setConvertVersionsError((e as Error).message || '历史版本没拉出来')
    }
  }

  /** 转订单：问一句 PI 发不发，状态别默认落在草稿（草稿单系统不提醒） */
  const convert = async (q: any, paymentStatus: 'draft' | 'sent') => {
    const expired = isConvertExpired
    if (expired && (!overrideBy.trim() || !overrideReason.trim())) {
      toast('这张报价已经过期，要沿用旧价必须填批准人和原因', 'error')
      return
    }
    try {
      const order = await window.api.quotations.convert(q.id, {
        paymentStatus,
        revision: convertRevision ?? undefined,
        override: expired ? { approvedBy: overrideBy.trim(), reason: overrideReason.trim() } : undefined
      })
      setConvertTarget(null)
      if (paymentStatus === 'sent') {
        toast(`已转成订单 ${order.orderNo}，状态是「待确认」`)
      } else {
        toast(`已转成订单 ${order.orderNo}，先存成草稿；PI 发出去后记得改成「待确认」`)
      }
      navigate(`/orders/${order.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const selectedVersion = convertVersions.find((v) => Number(v.revision) === Number(convertRevision))
  const versionGrand = selectedVersion ? Number(selectedVersion.grandTotal) : Number(convertTarget?.grandTotal ?? 0)
  const versionDiff = convertTarget ? versionGrand - Number(convertTarget.grandTotal ?? 0) : 0
  const isConvertExpired = Boolean(
    convertTarget &&
      (convertTarget.status === 'expired' ||
        (selectedVersion?.validUntil && selectedVersion.validUntil < today()))
  )

  return (
    <>
      <div className="topbar">
        <h1>报价</h1>
        <div className="spacer" />
        <Button variant="primary"  onClick={() => setEditing({})}>
          + 新建报价单
        </Button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索报价号 / 客户 / 客户PO号 / 款号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button  onClick={load}>
            搜索
          </Button>
          <div className="spacer" />
          <span className="faint">共 {list.length} 张报价单</span>
        </div>

        <div className="card">
          <div className="tabs">
            <div className={`tab ${tab === '' ? 'active' : ''}`} onClick={() => setTab('')}>
              全部
            </div>
            {Object.entries(QUOTATION_STATUS_LABEL).map(([k, v]) => (
              <div key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
                {v}
              </div>
            ))}
          </div>
          <div className="card-body tight">
            {loadError ? (
              <LoadError what="报价单列表" message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
              <Empty
                text={
                  keyword || tab
                    ? `当前筛选条件下没有报价单${tab ? `（状态：${QUOTATION_STATUS_LABEL[tab as QuotationStatus] ?? tab}）` : ''}${keyword ? `（关键词：${keyword}）` : ''}。单子没丢——把搜索框或状态页签清空就能看到全部。`
                    : '还没有报价单。客户问价的时候点右上角「新建报价单」。'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>报价号</th>
                      <th>客户</th>
                      <th className="num">金额</th>
                      <th>状态</th>
                      <th>结果</th>
                      <th>日期</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((q) => (
                      <tr key={q.id} className="clickable" onClick={() => setDetail(q)}>
                        <td className="mono nowrap">
                          {q.qNo}
                          {q.revision > 1 ? <span className="faint"> · 第{q.revision}版</span> : null}
                        </td>
                        <td>{q.customer?.company}</td>
                        <td className="num nowrap">{money(q.grandTotal, q.currency)}</td>
                        <td>
                          {/* R4-S5：列表页状态列一律只读 tag（和旁边「结果」列形态一致）。
                              改状态的入口没堵：点这一行打开报价单详情弹窗，里面还是下拉框。 */}
                          <QuotationStatusTag status={q.status} />
                          {staleAfterSend(q) ? (
                            <div className="faint" title={`${fmtDateTime(q.sentAt ?? '')} 发出之后又改存过：客户手上那份可能还是旧价`}>
                              <span className="tag amber">待重发</span>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {/* R2-P3：结果列改成只读标签（原来也是下拉框，和旁边「状态」下拉同屏两种形态）。
                              改结果的入口没堵：点这一行打开报价单详情弹窗，里面还是下拉框。 */}
                          <span className={`tag ${quoteResultTag(q.result)}`}>
                            {QUOTATION_RESULT_LABEL[q.result as QuotationResult] ?? q.result}
                          </span>
                        </td>
                        <td className="nowrap faint">{fmtDate(q.createdAt)}</td>
                        <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                          {q.convertedOrderId ? (
                            <button
                              className="link"
                              onClick={() => navigate(`/orders/${q.convertedOrderId}`)}
                            >
                              看订单
                            </button>
                          ) : (
                            <button className="link" onClick={() => void openConvert(q)}>
                              转订单
                            </button>
                          )}
                          <ActionMenu
                            items={[
                              // 已转订单的报价单是原始凭据，不再提供编辑入口（后端也会拦）；
                              // 转出的订单作废了就不再有凭据可言，重新放开
                              ...(quoteEditable(q)
                                ? [
                                    {
                                      text: '编辑报价单',
                                      onClick: () => {
                                        setDetail(null)
                                        setEditing(q)
                                      }
                                    }
                                  ]
                                : []),
                              { text: '删除', danger: true, onClick: () => void remove(q) }
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

      {editing ? (
        <QuotationModal
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            const wasEdit = !!editing.id
            setEditing(null)
            toast(wasEdit ? '报价单已修改（报价号不变）' : '报价单已保存')
            await load()
            const q = await window.api.quotations.get(id)
            if (q) setDetail(q)
          }}
        />
      ) : null}

      {detail ? (
        <QuotationDetailModal
          quotation={detail}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            await load()
            const q = await window.api.quotations.get(detail.id)
            setDetail(q)
          }}
          onEdit={(q: any) => {
            setDetail(null)
            setEditing(q)
          }}
          onConvert={(q: any) => void openConvert(q)}
        />
      ) : null}

      {convertTarget ? (
        <Modal
          title={`把报价单 ${convertTarget.qNo} 转成正式订单`}
          onClose={() => setConvertTarget(null)}
          footer={
            <>
              <Button  onClick={() => setConvertTarget(null)}>
                取消
              </Button>
              <Button disabled={!!convertVersionsError} onClick={() => void convert(convertTarget, 'draft')}>
                先存草稿
              </Button>
              <Button
                variant="primary"
                disabled={!!convertVersionsError}
                onClick={() => void convert(convertTarget, 'sent')}
              >
                PI 现在就发（待确认）
              </Button>
            </>
          }
        >
          <div className="alert info">
            款号、颜色、尺码、数量、单价、运费保险一个数字都不用重敲，报价单的汇率和汇率日期也原样带过去。
          </div>
          {convertVersionsError ? (
            <div className="alert warn">
              历史版本没拉出来（{convertVersionsError}），先别转单——万一客户确认的是更早那一版的价格，转出去就是按错的价开票。
              <div style={{ marginTop: 8 }}>
                <Button onClick={() => void loadConvertVersions(convertTarget)}>重新拉一次</Button>
              </div>
            </div>
          ) : null}

          <div className="field">
            <label>按哪一版转？</label>
            <select
              value={convertRevision ?? ''}
              onChange={(e) => setConvertRevision(e.target.value === '' ? null : Number(e.target.value))}
            >
              {convertVersionsError ? (
                <option value={convertRevision ?? ''}>版本没拉出来，先点上面「重新拉一次」</option>
              ) : convertVersions.length === 0 ? (
                <option value={convertRevision ?? ''}>当前第 {convertTarget.revision ?? 1} 版</option>
              ) : (
                convertVersions.map((v) => (
                  <option key={v.revision} value={v.revision}>
                    第 {v.revision} 版 · 合计 {Number(v.grandTotal).toFixed(2)} {convertTarget.currency}
                    {Number(v.revision) === Number(convertTarget.revision) ? '（当前）' : ''}
                    {v.validUntil ? ` · 有效期至 ${v.validUntil}` : ''}
                  </option>
                ))
              )}
            </select>
            <div className="hint">
              转账按选定版本原样带过去，不会拿最新版偷偷替换。老报价单升级前没有存档，只能按当前版转。
            </div>
            {selectedVersion && Math.abs(versionDiff) > 0.005 ? (
              <div className="alert warn" style={{ marginTop: 6 }}>
                这一版合计 {money(versionGrand, convertTarget.currency)}
                ，比当前版（{money(convertTarget.grandTotal, convertTarget.currency)}）
                {versionDiff > 0 ? '高' : '低'} {money(Math.abs(versionDiff), convertTarget.currency)}
                。转出来的订单按这一版算。
              </div>
            ) : null}
          </div>

          {isConvertExpired ? (
            <>
              <div className="alert warn">
                这张报价已经过期
                {selectedVersion?.validUntil ? `（有效期至 ${selectedVersion.validUntil}）` : ''}。
                客户要按旧价下单的话，必须写清谁批准、为什么沿用；否则请先重报一版。
              </div>
              <div className="field-row">
                <div className="field">
                  <label>批准人 *</label>
                  <input
                    value={overrideBy}
                    onChange={(e) => setOverrideBy(e.target.value)}
                    placeholder="如 周文娟 / 老板"
                  />
                </div>
                <div className="field">
                  <label>沿用原因 *</label>
                  <input
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="如 老客户翻单，同意沿用旧价"
                  />
                </div>
              </div>
            </>
          ) : null}

          <div className="field">
            <label>PI 现在就发给客户吗？</label>
            <div className="hint">
              选「PI 现在就发」→ 订单状态直接是「待确认」，客户不回邮件时系统会提醒你。
              <br />
              选「先存草稿」→ 订单是草稿，不进销售额；PI 发出后要记得回订单里把状态改成「待确认」。
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

/* ================= 详情 ================= */

function QuotationDetailModal({
  quotation,
  onClose,
  onChanged,
  onEdit,
  onConvert
}: {
  quotation: any
  onClose: () => void
  onChanged: () => Promise<void>
  onEdit: (q: any) => void
  onConvert: (q: any) => void
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<{
    html: string
    render: (pending: boolean) => string
    rev: number
    /** 预览当时那份报价 + 设置的数据指纹；存档前主进程按库里现在的数据重算一次 */
    fp: string
    /** 预览渲染用的那份报价数据（打开预览时刚从库里取） */
    q: any
  } | null>(null)
  const [settings, setSettings] = useState<any>(null)
  // 存档在途：连点两下会撞同一个版本号，报错还差点把对方那份 PDF 删掉
  const [docSaving, setDocSaving] = useState(false)
  const [docVersions, setDocVersions] = useState<any[]>([])
  const [events, setEvents] = useState<any[]>([])
  /** 读失败和「真的没有」分开说：存档没拉出来却显示「还没有存档」，用户会以为凭据没存过 */
  const [docError, setDocError] = useState('')
  const [eventError, setEventError] = useState('')

  useEffect(() => {
    window.api.settings
      .get()
      .then(setSettings)
      .catch((e) => toast(`设置没读出来，Logo 可能不显示：${(e as Error).message}`, 'error'))
  }, [])

  /** 单据存档 + 报价单自己的操作历史 */
  const loadDocs = () => {
    setDocError('')
    window.api.docs
      .listQuotation(quotation.id)
      .then(setDocVersions)
      .catch((e) => setDocError((e as Error).message))
  }
  const loadEvents = () => {
    setEventError('')
    window.api.quotations
      .events(quotation.id)
      .then(setEvents)
      .catch((e) => setEventError((e as Error).message))
  }
  useEffect(() => {
    loadDocs()
    loadEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotation.id])

  const buildImages = async (q: any): Promise<ImageMap> => {
    const map: ImageMap = {}
    if (settings?.company?.logoFile) {
      const d = await window.api.images.readDataUrl(settings.company.logoFile)
      if (d) map['__logo__'] = d
    }
    for (const it of q.items) {
      if (map[it.styleNo]) continue
      // 停用款也要出图：报价单上印着这一款，纸面不能因为商品被停用就空着
      const p = await window.api.products.list(it.styleNo, true)
      const hit = p.find((x: any) => x.styleNo === it.styleNo)
      if (!hit) continue
      const imgs = await window.api.products.images(hit.id)
      const primary = imgs.find((i: any) => i.isPrimary) ?? imgs[0]
      if (primary) {
        const d = await window.api.images.readDataUrl(primary.fileName)
        if (d) map[it.styleNo] = d
      }
    }
    return map
  }

  /**
   * 打开预览：先按库里现在这份重取一遍。
   * 列表里的行可能是几分钟前加载的，客户名、明细、金额在别处已经改过——
   * 拿旧行渲染再存档，存进去的 PDF 就成了「看着对、其实过期」的一版。
   */
  const openPreview = async () => {
    try {
      const fresh = (await window.api.quotations.get(quotation.id)) ?? quotation
      const images = await buildImages(fresh)
      // 先问存档：这一版存进去会是第几版；没存之前纸上印「待存为第 N 版」（N39，不占还不存在的版本号）
      const rev = await window.api.docs.nextVersion(fresh.qNo, 'quotation')
      const render = (pending: boolean) => renderQuotation({ quotation: fresh, settings, images, rev, pending })
      setPreview({
        html: render(true),
        render,
        rev,
        q: fresh,
        fp: docPageFingerprint({ kind: 'quotation', docNo: fresh.qNo, quotation: fresh, settings })
      })
    } catch (e) {
      toast((e as Error).message || '生成预览失败', 'error')
    }
  }

  const saveToSystem = async () => {
    if (!preview || docSaving) return
    setDocSaving(true)
    try {
      const savedHtml = preview.render(false)
      const r = await window.api.docs.save({
        html: savedHtml,
        fileName: `${preview.q.qNo}.pdf`,
        docNo: preview.q.qNo,
        kind: 'quotation',
        quotationId: preview.q.id,
        amount: preview.q.grandTotal,
        expectedVersion: preview.rev,
        pageFingerprint: preview.fp
      })
      toast(`已存档：${r.path}（第 ${r.version} 版）`)
      // 存完屏幕上的纸也换成正式版本号，跟存档表一个号（N39）
      setPreview({ ...preview, html: savedHtml, rev: r.version })
      // 存档表立刻刷新（不然要关掉详情再打开才看得到）
      const fresh = await window.api.docs.listQuotation(quotation.id)
      setDocVersions(fresh)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setDocSaving(false)
    }
  }

  /** 另存 PDF：先存档拿正式版纸面，再把不带「待存」字样的那份给客户 */
  const saveAs = async () => {
    if (!preview || docSaving) return
    setDocSaving(true)
    try {
      const savedHtml = preview.render(false)
      const r = await window.api.docs.save({
        html: savedHtml,
        fileName: `${preview.q.qNo}.pdf`,
        docNo: preview.q.qNo,
        kind: 'quotation',
        quotationId: preview.q.id,
        amount: preview.q.grandTotal,
        expectedVersion: preview.rev,
        pageFingerprint: preview.fp
      })
      setPreview({ ...preview, html: savedHtml, rev: r.version })
      const fresh = await window.api.docs.listQuotation(quotation.id)
      setDocVersions(fresh)
      const out = await window.api.window.printPdf({
        html: savedHtml,
        fileName: `${quotation.qNo}_v${r.version}.pdf`,
        docNo: quotation.qNo
      })
      toast(out ? `已存档第 ${r.version} 版，PDF 已保存` : `已存档第 ${r.version} 版；没有另存 PDF`)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setDocSaving(false)
    }
  }

  /** 状态/结果是后端守门的（已转单、已作废都不许乱改）：报错必须弹出来，不能静默停在原地 */
  const patchMeta = async (patch: { result?: QuotationResult; status?: QuotationStatus }) => {
    try {
      await window.api.quotations.updateMeta(quotation.id, patch)
      await onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const setResult = (result: QuotationResult) => patchMeta({ result })

  const setStatus = (status: QuotationStatus) => patchMeta({ status })

  return (
    <>
      <Modal
        title={`报价单 ${quotation.qNo}`}
        onClose={onClose}
        size="xwide"
        footer={
          <>
            <Button  onClick={onClose}>
              关闭
            </Button>
            {quoteEditable(quotation) && (
              <Button  onClick={() => onEdit(quotation)}>
                编辑
              </Button>
            )}
            {quotation.convertedOrderId ? (
              <Button variant="primary"  onClick={() => navigate(`/orders/${quotation.convertedOrderId}`)}>
                看已转的订单
              </Button>
            ) : (
              <Button variant="primary"  onClick={() => onConvert(quotation)}>
                转成订单
              </Button>
            )}
          </>
        }
      >
        <div className="price-calc mb">
          <div>
            <span className="muted">客户</span>
            <span>{quotation.customer?.company}</span>
          </div>
          <div>
            <span className="muted">状态</span>
            <span>
              {quotation.status === 'converted' ? (
                QUOTATION_STATUS_LABEL.converted
              ) : (
                <select
                  value={quotation.status}
                  onChange={(e) => void setStatus(e.target.value as QuotationStatus)}
                >
                  {EDITABLE_QUOTE_STATUS.map((s) => (
                    <option key={s} value={s}>
                      {QUOTATION_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </div>
          <div>
            <span className="muted">币种 / 汇率</span>
            <span>
              {quotation.currency === quotation.baseCurrency
                ? `${quotation.currency}（本币结算，不涉汇率）`
                : `${quotation.currency} / 1${quotation.currency}=${quotation.exchangeRate}${quotation.baseCurrency}${
                    quotation.exchangeRateDate ? ` （${quotation.exchangeRateDate} 锁定）` : ' （没记日期）'
                  }`}
            </span>
          </div>
          <div>
            <span className="muted">贸易条款</span>
            <span>
              {quotation.incoterm} · {quotation.portOfLoading || '—'} → {quotation.portOfDestination || '—'}
            </span>
          </div>
          <div>
            <span className="muted">付款方式</span>
            <span>
              {PAYMENT_METHOD_LABEL[quotation.paymentMethod as PaymentMethod]}
              {quotation.paymentMethod === 'tt_deposit' && quotation.depositRatio > 0 && quotation.depositRatio < 1
                ? ` · 定金${(quotation.depositRatio * 100).toFixed(0)}% / 尾款${(
                    (1 - quotation.depositRatio) *
                    100
                  ).toFixed(0)}%`
                : ''}
            </span>
          </div>
          <div>
            <span className="muted">版本</span>
            <span>第 {quotation.revision ?? 1} 版</span>
          </div>
          <div>
            <span className="muted">有效期至</span>
            <span>{fmtDate(quotation.validUntil) || '—'}</span>
          </div>
          <div>
            <span className="muted">货值</span>
            <span>{money(quotation.totalAmount, quotation.currency)}</span>
          </div>
          <div className="total">
            <span>合计（含费用）</span>
            <span>{money(quotation.grandTotal, quotation.currency)}</span>
          </div>
        </div>

        {quotation.customer?.paymentPref ? (
          <div className="alert info">客户档案里的付款条款：{quotation.customer.paymentPref}</div>
        ) : null}

        {staleAfterSend(quotation) ? (
          <div className="alert warn">
            这张报价在 {fmtDateTime(quotation.sentAt ?? '')} 发出之后又改过：客户手上那份可能还是旧价，改完请重发一版。
          </div>
        ) : null}

        {quotation.convertedOrderStatus === 'void' ? (
          <div className="alert info">转出的订单已作废，这张报价不再锁着：可以直接改价重转。</div>
        ) : null}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>款号</th>
                <th>品名</th>
                <th>颜色</th>
                <th>尺码</th>
                <th className="num">数量</th>
                <th className="num">单价</th>
                <th className="num">金额</th>
              </tr>
            </thead>
            <tbody>
              {quotation.items.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Empty text="还没有商品明细" />
                  </td>
                </tr>
              ) : (
                quotation.items.map((it: any) => (
                  <tr key={it.id}>
                    <td className="mono">{it.styleNo}</td>
                    <td>{it.productName}</td>
                    <td>{it.color}</td>
                    <td>{it.size}</td>
                    <td className="num">{num(it.quantity)}</td>
                    <td className="num">{it.unitPrice.toFixed(2)}</td>
                    <td className="num">{(it.quantity * it.unitPrice).toFixed(2)}</td>
                  </tr>
                ))
              )}
              {quotation.charges.map((c: any, i: number) => (
                <tr key={`c${i}`}>
                  <td colSpan={6} className="right">
                    {c.label}
                  </td>
                  <td className="num">{Number(c.amount).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="tfoot-strong">
                <td colSpan={4}>合计</td>
                <td className="num">{num(quotation.totalQuantity)}</td>
                <td></td>
                <td className="num">{quotation.grandTotal.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="field-row mt-3">
          <div className="field">
            <label>报价结果</label>
            <select value={quotation.result} onChange={(e) => void setResult(e.target.value as QuotationResult)}>
              {Object.entries(QUOTATION_RESULT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <div className="hint">客户过阵子回来问「上次报的多少」，就在这里查。</div>
          </div>
        </div>

        {quotation.note ? (
          <div className="note-box">
            <b>备注</b>
            <div>{quotation.note}</div>
          </div>
        ) : null}

        <div className="mt-3">
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>单据存档（出过的每一版）</h3>
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>单据</th>
                  <th>版本</th>
                  <th className="num">金额</th>
                  <th>时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {docVersions.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      {docError ? (
                        <LoadError what="存档版本" message={docError} onRetry={loadDocs} />
                      ) : (
                        <Empty text="还没有存档。点「预览报价单」→「存到系统」就会存一版进来。" />
                      )}
                    </td>
                  </tr>
                ) : (
                  docVersions.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.docNo}</td>
                      <td>第 {d.version} 版</td>
                      <td className="num">{Number(d.amount).toFixed(2)}</td>
                      <td className="faint nowrap">{fmtDateTime(d.createdAt)}</td>
                      <td className="right nowrap">
                        <Button variant="ghost" size="sm"
                          
                          onClick={async () => {
                            try {
                              await window.api.docs.openFile(d.filePath)
                            } catch (e) {
                              toast((e as Error).message, 'error')
                            }
                          }}
                        >
                          打开
                        </Button>
                        <Button variant="ghost" size="sm"
                          
                          onClick={async () => {
                            try {
                              await window.api.docs.reveal(d.filePath)
                            } catch (e) {
                              toast((e as Error).message, 'error')
                            }
                          }}
                        >
                          所在文件夹
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>操作历史（改了什么）</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={2}>
                      {eventError ? (
                        <LoadError what="操作历史" message={eventError} onRetry={loadEvents} />
                      ) : (
                        <Empty text="还没有记录" />
                      )}
                    </td>
                  </tr>
                ) : (
                  events.map((e) => (
                    <tr key={e.id}>
                      <td className="faint nowrap">{fmtDateTime(e.at)}</td>
                      <td>{e.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="row mt-2">
          <Button  onClick={openPreview}>
            预览报价单
          </Button>
          <Button onClick={saveToSystem} disabled={!preview || docSaving}>
            {docSaving ? '存档中…' : '存到系统'}
          </Button>
          <Button onClick={saveAs} disabled={!preview || docSaving}>
            {docSaving ? '存档中…' : '另存为 PDF'}
          </Button>
        </div>
      </Modal>

      {preview ? (
        <Modal title={`报价单预览 ${quotation.qNo}`} onClose={() => setPreview(null)} size="xwide">
          <div
            className="doc-preview"
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        </Modal>
      ) : null}
    </>
  )
}

/* ================= 新建 / 编辑 ================= */

function QuotationModal({
  draft,
  onClose,
  onSaved
}: {
  draft: any
  onClose: () => void
  onSaved: (id: number) => Promise<void>
}) {
  const toast = useToast()
  const isEdit = !!draft.id
  const [customers, setCustomers] = useState<any[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [products, setProducts] = useState<any[]>([])
  const [ports, setPorts] = useState<{ loading: string[]; destination: string[] }>({
    loading: [],
    destination: []
  })
  const [showPicker, setShowPicker] = useState(false)
  const [form, setForm] = useState({
    customerId: draft.customerId ?? 0,
    currency: (draft.currency ?? 'USD') as Currency,
    exchangeRate: (draft.exchangeRate ?? '') as number | '',
    exchangeRateDate: (draft.exchangeRateDate ?? today()) as string,
    incoterm: (draft.incoterm ?? 'FOB') as Incoterm,
    portOfLoading: draft.portOfLoading ?? '',
    portOfDestination: draft.portOfDestination ?? '',
    paymentMethod: (draft.paymentMethod ?? 'tt_deposit') as PaymentMethod,
    depositRatio: draft.depositRatio ?? 0.3,
    validUntil: draft.validUntil ?? '',
    customerPo: draft.customerPo ?? '',
    note: draft.note ?? ''
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
      unitPrice: it.unitPrice
    }))
  )
  const [charges, setCharges] = useState<{ uid: string; label: string; amount: number }[]>(
    ((draft.charges ?? []) as QuotationCharge[]).map((c) => ({ uid: clientKey(), ...c }))
  )
  const [lastRate, setLastRate] = useState<{ rate: number; date: string } | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [cs, s, ps, pt] = await Promise.all([
          // 编辑老报价时，即使客户后来停用了，下拉里也得还有他
          window.api.customers.list('', true),
          window.api.settings.get(),
          window.api.products.list(''),
          window.api.orders.ports()
        ])
        setCustomers(cs)
        setSettings(s)
        setProducts(ps)
        setPorts(pt)
        if (!isEdit) {
          setForm((f) => ({
            ...f,
            depositRatio: s.defaultDepositRatio ?? f.depositRatio,
            // 本地日 + N 天：原来用 toISOString().slice(0,10) 拿的是 UTC 日，
            // UTC+8 凌晨 0~8 点开单会少一天，客户拿到的报盘比约定早 24 小时失效
            validUntil: addDays(localDate(), s.piValidDays ?? 15)
          }))
        }
      } catch (e) {
        // 以前这里没兜底：客户/商品没拉出来就是一片空白下拉，像数据被删了
        toast(`弹窗的候选数据没拉出来：${(e as Error).message}`, 'error')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 汇率参考值按币种取：USD 的 7.1 不能抄到 EUR 报价上，换币种就重新查同币种的上一次
  useEffect(() => {
    let alive = true
    window.api.orders
      .lastExchangeRateInfo(form.currency)
      .then((lr) => {
        if (alive) setLastRate(lr)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [form.currency])

  /** 这个客户的历史成交价（报价前看一眼上次卖了多少，别再凭感觉报） */
  const [lastPrices, setLastPrices] = useState<any[]>([])

  useEffect(() => {
    if (!form.customerId) {
      setLastPrices([])
      return
    }
    let alive = true
    window.api.customers
      .stylePriceHistory({ customerId: form.customerId })
      .then((rows) => {
        if (alive) setLastPrices(rows.slice(0, 8))
      })
      .catch((e) => {
        // 拉不到历史价不等于这个客户没历史价：说一声，别让人以为真是第一次报价
        if (alive) toast(`历史成交价没拉出来：${(e as Error).message}`, 'error')
      })
    return () => {
      alive = false
    }
  }, [form.customerId])

  /** 选客户后带出上一次的条款：先客户档案，再这个客户上一次的订单（跟新建订单同一套逻辑） */
  const termsGuard = useLoadGuard()
  const onCustomerChange = async (id: number) => {
    setForm((f) => ({ ...f, customerId: id }))
    if (!id) return
    const cust = customers.find((c) => c.id === id)
    if (!cust) return
    // 快速 A→B 切换时 A 的响应可能后到：币种/定金是凭据级字段，带错客户等于发错价的 PI
    const { isCurrent } = termsGuard()
    // 客户档案里的默认条款是本地就有的，先落上：后端那次「上单条款」只是补币种和没建档的兜底，
    // 不能因为它失败就连档案里写好的默认值也不给客户带。
    const applyTerms = (terms: any) =>
      setForm((f) => ({
        ...f,
        currency: (terms?.currency ?? f.currency) as Currency,
        incoterm: (cust.defaultIncoterm || terms?.incoterm || f.incoterm) as Incoterm,
        portOfLoading: cust.defaultPortLoading || terms?.portOfLoading || f.portOfLoading,
        portOfDestination: cust.defaultPortDestination || terms?.portOfDestination || f.portOfDestination,
        paymentMethod: (cust.defaultPaymentMethod || terms?.paymentMethod || f.paymentMethod) as PaymentMethod,
        depositRatio:
          cust.defaultDepositRatio != null
            ? cust.defaultDepositRatio
            : terms?.depositRatio ?? f.depositRatio
      }))
    let terms: any = null
    try {
      terms = await window.api.orders.lastTerms(id)
    } catch (e) {
      // 带不出条款不等于这客户没做过单：说一声，让人手工填，别静默留着上一家的币种
      if (!isCurrent()) return
      applyTerms(null)
      toast(`这家客户上一次的条款没带出来：${(e as Error).message}，已按客户档案的默认值填写，请手工核对币种/港口/定金`, 'error')
      return
    }
    if (!isCurrent()) return
    applyTerms(terms)
    toast(
      `已带出「${cust.company}」的条款${
        cust.defaultPortLoading || terms?.portOfLoading ? '（含港口）' : ''
      }，确认一下`
    )
  }

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === form.customerId),
    [customers, form.customerId]
  )

  const goods = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const chargeTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)

  const setLine = (uid: string, patch: Partial<LineRow>) => {
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)))
  }

  const onStyleChange = (uid: string, styleNo: string) => {
    const hit = products.find((p) => p.styleNo === styleNo)
    setLine(uid, {
      styleNo,
      productId: hit?.id ?? null,
      productName: hit?.name ?? '',
      composition: hit?.composition ?? ''
    })
  }

  /** 找到该行对应的商品（用商品库自带的尺码表/颜色表） */
  const productOf = (l: LineRow): any =>
    products.find((p) => (l.productId ? p.id === l.productId : p.styleNo === l.styleNo))

  // 本币报价没有汇率这回事：系统按 1 记，界面也不许人往里填一个假的
  const isHomeCurrency = form.currency === (settings?.baseCurrency ?? 'CNY')

  // 按住第二次点击：存一次就烧一个报价单号，双击等于两张单、两个号
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    if (!form.customerId) {
      toast('请先选择客户', 'error')
      return
    }
    // 本币单不用填汇率（系统按 1 记）；外币单不填就是不填，不许拿默认值蒙人
    if (!isHomeCurrency && (form.exchangeRate === '' || Number(form.exchangeRate) <= 0)) {
      toast('请先按今天钉盘的汇率填写汇率', 'error')
      return
    }
    // 填了款号的行才算数，数量还得是 1 件以上：
    // 直接滤掉半填的行，等于用户以为报出去了，纸面上却没有那一行
    const clean = lines.filter((l) => l.styleNo.trim())
    if (clean.length === 0) {
      toast('请至少填写一行报价明细（款号 + 数量 + 单价）', 'error')
      return
    }
    const halfFilled = clean.filter((l) => !(Number(l.quantity) > 0))
    if (halfFilled.length > 0) {
      toast(`这几行填了款号但数量不是 1 件以上：${halfFilled.map((l) => l.styleNo).join('、')}`, 'error')
      return
    }
    setBusy(true)
    try {
      const q = await window.api.quotations.save({
        id: draft.id,
        customerId: form.customerId,
        currency: form.currency,
        exchangeRate: isHomeCurrency ? 1 : Number(form.exchangeRate),
        exchangeRateDate: isHomeCurrency ? null : form.exchangeRateDate || null,
        baseCurrency: settings?.baseCurrency ?? 'CNY',
        incoterm: form.incoterm,
        portOfLoading: form.portOfLoading,
        portOfDestination: form.portOfDestination,
        paymentMethod: form.paymentMethod,
        depositRatio: form.depositRatio,
        validUntil: form.validUntil || null,
        customerPo: form.customerPo,
        note: form.note,
        charges: charges.filter((c) => c.label.trim()).map((c) => ({ label: c.label, amount: c.amount })),
        items: clean.map((l) => ({
          productId: l.productId,
          styleNo: l.styleNo,
          productName: l.productName,
          composition: l.composition,
          color: l.color,
          size: l.size,
          quantity: l.quantity,
          unitPrice: l.unitPrice
        }))
      })
      await onSaved(q.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={isEdit ? '编辑报价单' : '新建报价单'}
        onClose={onClose}
        size="xwide"
        footer={
          <>
            <Button  onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={busy} onClick={save}>
              保存报价单
            </Button>
          </>
        }
      >
        <div className="field">
          <label>客户 *</label>
          <select value={form.customerId || ''} onChange={(e) => void onCustomerChange(Number(e.target.value))}>
            <option value="">请选择客户…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company}
                {c.country ? ` (${c.country})` : ''}
              </option>
            ))}
          </select>
          {selectedCustomer?.paymentPref ? (
            <div className="hint">客户档案条款：{selectedCustomer.paymentPref}</div>
          ) : null}
          {lastPrices.length ? (
            <div className="hint">
              这个客户最近成交价：
              {lastPrices
                .map((r) => `${r.styleNo}${r.color ? `/${r.color}` : ''} ${r.lastCurrency} ${r.lastUnitPrice}`)
                .join(' · ')}
            </div>
          ) : null}
          {lastPrices.some((r) => r.lastCurrency !== form.currency) ? (
            <div className="alert warn" style={{ marginTop: 6 }}>
              上面有按其他币种成交的价，别直接照抄：先按今天的汇率折成 {form.currency} 再报价。
            </div>
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
            <label>
              汇率（1 {form.currency} = ? {settings?.baseCurrency ?? 'CNY'}）{isHomeCurrency ? '' : '*'}
            </label>
            <input
              type="number"
              step="0.0001"
              value={isHomeCurrency ? 1 : form.exchangeRate}
              disabled={isHomeCurrency}
              onChange={(e) =>
                setForm({ ...form, exchangeRate: e.target.value === '' ? '' : Number(e.target.value) })
              }
              placeholder="请按今天钉盘的汇率填"
            />
            {isHomeCurrency ? (
              <div className="hint">
                本币报价不用填汇率：系统按 1 记，转订单时也不会拿别的数去折成本。
              </div>
            ) : (
              <>
                <div className="hint">
                  请按今天钉盘的汇率填写，填了才能保存。（这里不会自动填数字）
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
                  <div className="hint">转订单时这个日期原样带过去，不会拿转单当天冒充。</div>
                </div>
              </>
            )}
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
              list="ports-loading"
              value={form.portOfLoading}
              onChange={(e) => setForm({ ...form, portOfLoading: e.target.value })}
              placeholder="如 Ningbo"
            />
            <datalist id="ports-loading">
              {ports.loading.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label>目的港</label>
            <input
              list="ports-dest"
              value={form.portOfDestination}
              onChange={(e) => setForm({ ...form, portOfDestination: e.target.value })}
              placeholder="如 Hamburg"
            />
            <datalist id="ports-dest">
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
            <label>报价有效期至</label>
            <input
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
            />
            <div className="row" style={{ marginTop: 5, gap: 5 }}>
              <Button size="sm"  onClick={() => setForm({ ...form, validUntil: today() })}>
                今天
              </Button>
              <Button size="sm"
                
                onClick={() => setForm({ ...form, validUntil: addDays(localDate(), 15) })}
              >
                +15天
              </Button>
              <Button size="sm" onClick={() => setForm({ ...form, validUntil: '' })}>
                清空（不设）
              </Button>
            </div>
            <div className="hint" style={{ marginTop: 5 }}>
              清空就是不设有效期，纸面 PI 不再印一个日期；系统不会替你改成「今天+15 天」。
            </div>
          </div>
          <div className="field">
            <label>客户 PO 号</label>
            <input value={form.customerPo} onChange={(e) => setForm({ ...form, customerPo: e.target.value })} />
          </div>
        </div>

        <div className="row sec-head">
          <strong className="sec-head">商品明细</strong>
          <div className="spacer" />
          <Button size="sm"  onClick={() => setShowPicker(true)}>
            从商品库选款
          </Button>
          <Button size="sm"
            
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { uid: clientKey(), productId: null, styleNo: '', productName: '', composition: '', color: '', size: '', quantity: 0, unitPrice: 0 }
              ])
            }
          >
            + 手工加一行
          </Button>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: '18%' }}>款号</th>
                <th style={{ width: '20%' }}>品名</th>
                <th style={{ width: '12%' }}>颜色</th>
                <th style={{ width: '10%' }}>尺码</th>
                <th className="num" style={{ width: '12%' }}>数量</th>
                <th className="num" style={{ width: '14%' }}>单价</th>
                <th className="num" style={{ width: '14%' }}>金额</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty text="还没有明细。点「从商品库选款」，或者手工加一行。" />
                  </td>
                </tr>
              ) : (
                lines.map((l) => (
                  <tr key={l.uid}>
                    <td>
                      <input
                        list="style-list"
                        value={l.styleNo}
                        onChange={(e) => onStyleChange(l.uid, e.target.value)}
                        placeholder="款号"
                      />
                    </td>
                    <td>
                      <input value={l.productName} onChange={(e) => setLine(l.uid, { productName: e.target.value })} />
                    </td>
                    <td>
                      <PickField
                        value={l.color}
                        options={productOf(l)?.colors ?? []}
                        placeholder="颜色"
                        onChange={(v) => setLine(l.uid, { color: v })}
                      />
                    </td>
                    <td>
                      <PickField
                        value={l.size}
                        options={productOf(l)?.sizes ?? []}
                        placeholder="尺码"
                        onChange={(v) => setLine(l.uid, { size: v })}
                      />
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
                <td colSpan={4}>货值合计</td>
                <td className="num">{num(lines.reduce((s, l) => s + l.quantity, 0))}</td>
                <td></td>
                <td className="num">{goods.toFixed(2)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
          <datalist id="style-list">
            {products.map((p) => (
              <option key={p.id} value={p.styleNo}>
                {p.name}
              </option>
            ))}
          </datalist>
        </div>

        <div className="row sec-head">
          <strong className="sec-head">费用（运费 / 保险费 / 其他）</strong>
          <div className="spacer" />
          <Button size="sm"
            
            onClick={() => setCharges((cs) => [...cs, { uid: clientKey(), label: '运费 Freight', amount: 0 }])}
          >
            + 加费用
          </Button>
        </div>
        {charges.map((c) => (
          <div className="field-row" key={c.uid} style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2 }}>
              <label>费用名称</label>
              <input
                value={c.label}
                onChange={(e) =>
                  setCharges((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, label: e.target.value } : x)))
                }
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>金额（{form.currency}）</label>
              <input
                type="number"
                step="0.01"
                value={c.amount}
                onChange={(e) =>
                  setCharges((cs) =>
                    cs.map((x) => (x.uid === c.uid ? { ...x, amount: Number(e.target.value) } : x))
                  )
                }
              />
            </div>
            <div className="field" style={{ flex: 0, minWidth: 60 }}>
              <Button variant="danger" size="sm"  onClick={() => setCharges((cs) => cs.filter((x) => x.uid !== c.uid))}>
                删除
              </Button>
            </div>
          </div>
        ))}

        <div className="price-calc mt">
          <div>
            <span className="muted">货值</span>
            <span>{money(goods, form.currency)}</span>
          </div>
          <div>
            <span className="muted">费用</span>
            <span>{money(chargeTotal, form.currency)}</span>
          </div>
          <div className="total">
            <span>报价合计</span>
            <span>{money(goods + chargeTotal, form.currency)}</span>
          </div>
        </div>

        <div className="field mt-2">
          <label>备注</label>
          <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
      </Modal>

      {showPicker ? (
        <ProductPickerModal
          products={products}
          currency={form.currency}
          exchangeRate={Number(form.exchangeRate) || 1}
          baseCurrency={(settings?.baseCurrency ?? 'CNY') as Currency}
          onClose={() => setShowPicker(false)}
          onPick={(rows) => {
            setLines((ls) => [...ls, ...rows])
            setShowPicker(false)
          }}
        />
      ) : null}
    </>
  )
}

/* ================= 明细里的颜色/尺码下拉 ================= */

/**
 * 款号自带尺码表/颜色表时用下拉（不自由输入，避免写出一个不存在的码），
 * 款号没设表就还是自由输入。
 */
function PickField({
  value,
  options,
  onChange,
  placeholder
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
  placeholder: string
}) {
  const list = options.length ? (options.includes(value) ? options : [value, ...options].filter(Boolean)) : []
  if (list.length === 0) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {list.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

/* ================= 从商品库选款 ================= */

function ProductPickerModal({
  products,
  currency,
  exchangeRate = 1,
  baseCurrency = 'CNY',
  onClose,
  onPick
}: {
  products: any[]
  currency: Currency
  exchangeRate?: number
  baseCurrency?: Currency
  onClose: () => void
  onPick: (rows: LineRow[]) => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<any>(null)
  const [price, setPrice] = useState('')
  const [grid, setGrid] = useState<Record<string, string>>({})
  const [colorPrice, setColorPrice] = useState<Record<string, string>>({})

  const filtered = useMemo(() => {
    const k = search.trim().toLowerCase()
    if (!k) return products
    return products.filter(
      (p) =>
        String(p.styleNo).toLowerCase().includes(k) ||
        String(p.name).toLowerCase().includes(k) ||
        String(p.composition).toLowerCase().includes(k)
    )
  }, [products, search])

  const selectProduct = (p: any) => {
    setPicked(p)
    // 工厂成本不是报价：不能自动填进「销售单价」，只作为参考显示在下面
    setPrice('')
    const g: Record<string, string> = {}
    for (const c of p.colors) for (const s of p.sizes) g[`${c}|${s}`] = ''
    setGrid(g)
    setColorPrice({})
  }

  /** 工厂价（基准币）折到本单币种，只给人看一眼参考 */
  const costHint = (() => {
    if (!picked) return ''
    if (picked.costPrice == null) return '工厂成本：未设置'
    const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1
    const inOrder = baseCurrency === currency ? picked.costPrice : picked.costPrice / rate
    return baseCurrency === currency
      ? `工厂成本：${baseCurrency} ${picked.costPrice}`
      : `工厂成本：${baseCurrency} ${picked.costPrice} ≈ ${currency} ${inOrder.toFixed(2)}（本单汇率）`
  })()

  const rows = useMemo(() => {
    if (!picked) return []
    const out: { color: string; size: string; key: string }[] = []
    for (const c of picked.colors) for (const s of picked.sizes) out.push({ color: c, size: s, key: `${c}|${s}` })
    return out
  }, [picked])

  const submit = () => {
    if (!picked) return
    const out: LineRow[] = []
    for (const r of rows) {
      const qty = Number(grid[r.key] ?? 0)
      if (!qty || qty <= 0) continue
      const cp = colorPrice[r.color]
      const unit = cp !== undefined && cp !== '' ? Number(cp) : Number(price) || 0
      out.push({
        uid: clientKey(),
        productId: picked.id,
        styleNo: picked.styleNo,
        productName: picked.name,
        composition: picked.composition,
        color: r.color,
        size: r.size,
        quantity: qty,
        unitPrice: unit
      })
    }
    if (out.length === 0) {
      toast('请至少填写一个 SKU 的数量', 'error')
      return
    }
    onPick(out)
  }

  return (
    <Modal
      title="从商品库选款"
      onClose={onClose}
      size="xwide"
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button variant="primary"  onClick={submit}>
            加入明细
          </Button>
        </>
      }
    >
      <div className="field">
        <label>搜索款号</label>
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {products.length === 0 ? (
        <div className="alert warn">商品库还是空的。可以先手工加一行把款号写上。</div>
      ) : (
        <div className="picker-list">
          {filtered.map((p) => (
            <div
              key={p.id}
              className={`picker-item ${picked?.id === p.id ? 'active' : ''}`}
              onClick={() => selectProduct(p)}
            >
              <div className="picker-main">
                <span className="mono">{p.styleNo}</span>
                <span className="picker-name">{p.name}</span>
              </div>
              <div className="picker-meta">
                <span className="faint">{p.composition}</span>
                <span className="faint">
                  {p.sizes.length ? `${p.sizes.length} 码` : '无尺码表'} ·{' '}
                  {p.colors.length ? `${p.colors.length} 色` : '无颜色表'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {picked ? (
        <>
          <div className="field">
            <label>销售单价（{currency}）</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            <div className="hint">
              {costHint}。报价要报的是卖价，不是工厂成本，所以这里不会替你填。
            </div>
          </div>

          {picked.colors.length ? (
            <div className="field-row" style={{ marginBottom: 10 }}>
              {picked.colors.map((c: string) => (
                <div className="field" key={c}>
                  <label>{c} 单价</label>
                  <input
                    type="number"
                    step="0.01"
                    value={colorPrice[c] ?? ''}
                    placeholder={price || '同上'}
                    onChange={(e) => setColorPrice({ ...colorPrice, [c]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          ) : null}

          <table className="sku-matrix">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>颜色</th>
                <th style={{ width: '30%' }}>尺码</th>
                <th>数量</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.color}</td>
                  <td>{r.size}</td>
                  <td>
                    <input
                      type="number"
                      value={grid[r.key] ?? ''}
                      onChange={(e) => setGrid({ ...grid, [r.key]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Modal>
  )
}
