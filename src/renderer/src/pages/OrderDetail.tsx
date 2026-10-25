import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Modal, useToast, money, num, fmtDate, fmtDateTime, Empty, Menu,
  Button, PaymentTag, ShipTag, clientKey, LoadError
} from '../ui'
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  SHIP_STATUS_LABEL,
  PAYMENT_STATUS_ORDER,
  SHIP_STATUS_ORDER,
  SETTLEMENT_KIND_LABEL,
  type PaymentStatus,
  type PackingAmount,
  type ShipStatus,
  type PaymentMethod
} from '../../../shared/types'
import {
  renderPi,
  renderPl,
  renderCi,
  ciNoOf,
  orderDocAmount,
  ciDocAmount,
  isGrossEstimated,
  type ImageMap
} from '../../../shared/documents'
import { imageUrl } from '../imageUrl'
import { isLocalDate, localDate } from '../../../shared/date'
import EditOrderModal from './EditOrderModal'
import PartyModal from './PartyModal'

type PreviewState = {
  kind: 'pi' | 'pl' | 'ci'
  plId?: number
  html: string
  docNo: string
  amount: number
  /** 作废批次的留档预览：纸还能查，但不能再存成新版本（存档是发客户的凭据） */
  voided?: boolean
  /** 纸面缺项提醒（如本币种没配银行账户）：显示在预览上方，不属于纸面 */
  notice?: string
  /** 预览时算出的下一版版次；存档时用它核对，纸面和库里必须同号 */
  rev: number
  title: string
  /**
   * 重新生成纸面 HTML：
   * pending=true → 屏幕预览（页脚印「待存为第 N 版」，不占还不存在的版本号，N39）；
   * pending=false → 存档/打印的那份（印正式「Version N / 版本 N」，与存档表一个号）。
   */
  render: (pending: boolean) => string
} | null

export default function OrderDetail() {
  const { id } = useParams()
  const orderId = Number(id)
  const toast = useToast()
  const navigate = useNavigate()

  const [order, setOrder] = useState<any>(null)
  const [settings, setSettings] = useState<any>(null)
  const [events, setEvents] = useState<any[]>([])
  const [tab, setTab] = useState<'items' | 'payment' | 'packing' | 'timeline' | 'photos'>('items')
  const [preview, setPreview] = useState<PreviewState>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [showParty, setShowParty] = useState(false)
  const [showCi, setShowCi] = useState(false)
  const [editCharges, setEditCharges] = useState(false)
  // R1-④：状态只有一种形态（tag）。点「改状态」才临时变成下拉框，改完回到 tag
  const [editPayment, setEditPayment] = useState(false)
  const [editShip, setEditShip] = useState(false)
  const [docVersions, setDocVersions] = useState<any[]>([])
  /** 读不出来就明说并给重试，不能永远停在「加载中…」 */
  const [loadError, setLoadError] = useState('')

  const load = async () => {
    try {
      const [o, s, e, dv] = await Promise.all([
        window.api.orders.get(orderId),
        window.api.settings.get(),
        window.api.orders.events(orderId),
        window.api.docs.list(orderId)
      ])
      if (!o) {
        toast('订单不存在', 'error')
        navigate('/orders')
        return
      }
      setOrder(o)
      setSettings(s)
      setEvents(e)
      setDocVersions(dv)
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '这张订单没读出来')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  /** 收集单据所需图片（data URL 内嵌，保证 PDF 打印不缺图） */
  const buildImages = async (): Promise<ImageMap> => {
    const map: ImageMap = {}
    if (settings?.company?.logoFile) {
      const d = await window.api.images.readDataUrl(settings.company.logoFile)
      if (d) map['__logo__'] = d
    }
    const styleNos: string[] = Array.from(
      new Set<string>(((order?.items ?? []) as any[]).map((i) => String(i.styleNo)))
    )
    for (const s of styleNos) {
      const p = await window.api.products.list(s)
      const hit = p.find((x: any) => x.styleNo === s)
      if (!hit) continue
      const imgs = await window.api.products.images(hit.id)
      const primary = imgs.find((i: any) => i.isPrimary) ?? imgs[0]
      if (primary) {
        const d = await window.api.images.readDataUrl(primary.fileName)
        if (d) map[s] = d
      }
    }
    return map
  }

  /** 币种没有对应账户时纸面不印收款信息——宁可空着，也不能拿别的币种账号顶替 */
  const bankNotice = (): string | undefined =>
    settings && !(settings.banks ?? []).some((b: any) => b.currency === order.currency)
      ? `本单用 ${order.currency} 结算，但设置里没有 ${order.currency} 账户：纸上不会印收款账号（不会拿别的币种顶替）。请到「设置 → 收款账户」补一个。`
      : undefined

  const openPi = async () => {
    const images = await buildImages()
    // 存进去会是第几版：先问存档；没存之前纸上印「待存为第 N 版」（N39，不占还不存在的版本号）
    const rev = await window.api.docs.nextVersion(order.piNo, 'pi')
    const render = (pending: boolean) => renderPi({ order, settings, images, rev, pending })
    setPreview({
      kind: 'pi',
      html: render(true),
      docNo: order.piNo,
      // 存档金额唯一入口：含费用合计（与 PI 纸面 TOTAL 同一个数）
      amount: orderDocAmount(order),
      rev,
      title: `PI ${order.piNo}`,
      notice: bankNotice(),
      render
    })
  }

  const openPl = async (plId: number) => {
    const pl = order.packingLists.find((p: any) => p.id === plId)
    if (!pl) return
    const isVoid = !!pl.voidedAt
    // 纸面缺项不拦死，但要让人知道这一版会空着什么（不改版式，不补字段）
    const missing: string[] = []
    if (!pl.containerNo) missing.push('柜号')
    // 纸面会回退到订单级船期，订单上有就不算空着
    if (!(pl.vessel || order.vessel)) missing.push('船名航次')
    if (!(pl.etdDate || order.etdDate)) missing.push('ETD')
    if (!(pl.sealNo || order.sealNo)) missing.push('封条号')
    if (pl.lines.some((l: any) => l.netWeight == null)) missing.push('净重')
    if (
      !isVoid &&
      missing.length > 0 &&
      !confirm(`批次 ${pl.plNo} 还有没填的：${missing.join('、')}。纸面上会空着，仍要预览吗？`)
    ) {
      return
    }
    const images = await buildImages()
    const rev = await window.api.docs.nextVersion(pl.plNo, 'pl')
    const render = (pending: boolean) => renderPl({ order, settings, images, rev, pending }, pl)
    // 存档金额按批次摊：三个批次各存自己那一份，加起来才等于 PI（服务层唯一口径 money.packingAmounts）
    const amounts = await window.api.pl.amounts(order.id)
    const thisAmount = amounts.find((a: PackingAmount) => a.plId === plId)?.total ?? 0
    setPreview({
      kind: 'pl',
      plId,
      html: render(true),
      docNo: pl.plNo,
      amount: thisAmount,
      voided: isVoid,
      rev,
      title: isVoid ? `PL ${pl.plNo}（已作废 · 仅留档）` : `PL ${pl.plNo}`,
      render
    })
  }

  const openCi = async (charges: { label: string; amount: number }[]) => {
    const images = await buildImages()
    const ciNo = ciNoOf(order.piNo)
    const rev = await window.api.docs.nextVersion(ciNo, 'ci')
    // 存档金额唯一入口：货值 + 纸上印的费用行（默认费用 = 订单费用 → 与 PI 同一个数）
    const amount = ciDocAmount(order, charges)
    const render = (pending: boolean) => renderCi({ order, settings, images, rev, pending }, { charges })
    setPreview({
      kind: 'ci',
      html: render(true),
      docNo: ciNo,
      amount,
      rev,
      title: `CI ${ciNo}`,
      notice: bankNotice(),
      render
    })
    setShowCi(false)
  }

  /**
   * 另存为（自己选地方）：先存系统存档，再拿正式版纸面去保存。
   * 绝不能把预览稿（页脚印「待存为第 N 版」）发给客户或报关行。
   */
  const savePdf = async () => {
    if (!preview) return
    try {
      const savedHtml = preview.render(false)
      const r = await window.api.docs.save({
        html: savedHtml,
        fileName: `${preview.docNo}.pdf`,
        docNo: preview.docNo,
        kind: preview.kind,
        orderId: order.id,
        amount: preview.amount,
        expectedVersion: preview.rev
      })
      setPreview({ ...preview, html: savedHtml, rev: r.version })
      await load()
      const out = await window.api.window.printPdf({
        html: savedHtml,
        fileName: `${preview.docNo}_v${r.version}.pdf`,
        docNo: preview.docNo
      })
      toast(
        out
          ? `已存档第 ${r.version} 版，PDF 已保存`
          : `已存档第 ${r.version} 版；没有另存 PDF`
      )
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  /** 存到系统存档：自动记版本、记操作历史。存档那份纸印正式版本号（它就是这一版） */
  const saveToSystem = async () => {
    if (!preview) return
    try {
      const savedHtml = preview.render(false)
      const r = await window.api.docs.save({
        html: savedHtml,
        fileName: `${preview.docNo}.pdf`,
        docNo: preview.docNo,
        kind: preview.kind,
        orderId: order.id,
        amount: preview.amount,
        expectedVersion: preview.rev
      })
      toast(`已存档到系统：${r.path}（第 ${r.version} 版）`)
      // 存完屏幕上的纸也换成正式版本号，跟存档表一个号（N39）
      setPreview({ ...preview, html: savedHtml, rev: r.version })
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const removeOrder = async () => {
    // 删之前必须让她看到这单收了多少钱（老板的规矩：所有订单必须留痕）
    const paid = Number(order.paidAmount ?? 0)
    const total = Number(order.grandTotal ?? order.totalAmount ?? 0)
    const msg =
      `确认删除订单 ${order.orderNo}？\n\n` +
      `含费用合计 ${money(total, order.currency)}\n` +
      `已收 ${money(paid, order.currency)}\n` +
      `待收 ${money(order.remaining, order.currency)}\n\n` +
      (paid > 0 || (order.items?.length ?? 0) > 0
        ? '这一单有明细或收款，删了收款记录和操作历史会一起没有。\n建议改用「作废」：记录全留，只是不再计入销售额和待收款。'
        : '这是一张空单，删了就找不回来了。')
    if (!confirm(msg)) return
    try {
      await window.api.orders.remove(order.id)
      toast('订单已删除')
      navigate('/orders')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  /** 作废：记录全留，但不再进货值 / 待收 / 毛利 */
  const voidOrder = async () => {
    if (
      !confirm(
        `确认作废订单 ${order.orderNo}？\n\n` +
          `含费用合计 ${money(order.grandTotal, order.currency)}，已收 ${money(
            order.paidAmount,
            order.currency
          )}。\n` +
          '作废后：收款记录、操作历史、单据存档全部保留，只是不再计入销售额、待收款和毛利。'
      )
    )
      return
    try {
      await window.api.orders.void(order.id, '手动作废')
      toast('订单已作废，记录全部保留')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  if (!order) {
    return (
      <div className="content">
        {loadError ? (
          <LoadError what="这张订单" message={loadError} onRetry={() => void load()} />
        ) : (
          <div className="empty loading">加载中…</div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="topbar">
        <Button variant="ghost"  onClick={() => navigate('/orders')}>
          ← 返回
        </Button>
        <h1 className="mono">{order.orderNo}</h1>
        <span className="faint mono">{order.piNo}</span>
        <PaymentTag status={order.paymentStatus} />
        <ShipTag status={order.shipStatus} />
        <div className="spacer" />
        {/* R1-④：页头只留 2 种按钮形态（描边 + 主按钮），
            「作废此单」「删除订单」收进「⋯」菜单，不再是裸文字链接 */}
        <Button  onClick={() => setShowCi(true)}>
          商业发票 CI
        </Button>
        <Button variant="primary"  onClick={openPi}>
          生成 PI
        </Button>
        <Menu
          label="⋯"
          items={[
            ...(order.paymentStatus !== 'void'
              ? [{ text: '作废此单', onClick: () => void voidOrder() }]
              : []),
            { text: '删除订单', danger: true, onClick: () => void removeOrder() }
          ]}
        />
      </div>

      <div className="content">
        {order.paymentStatus === 'draft' ? (
          <div className="alert warn">
            这单还是「草稿」：PI 发出去以后，请把收款状态改成「待确认」，不然客户不回邮件系统不会提醒你。
          </div>
        ) : null}
        {order.paymentStatus === 'void' ? (
          <div className="alert warn">
            这单已作废：记录、收款历史、单据存档全部保留，只是不再计入销售额、待收款和毛利。
          </div>
        ) : null}
        {/* R4-S1：统计卡默认全黑，一屏最多 1 张卡上色（这里是 4 张，全黑） */}
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">订单金额</div>
            <div className="stat-value">{money(order.totalAmount, order.currency)}</div>
            {/* R4-P2：副行两个数用 flex 分开（gap 12px），不再用中点挤在一行 */}
            <div className="stat-hint split">
              <span>{num(order.totalQuantity)} 件</span>
              {order.charges?.length ? <span>含费用合计 {money(order.grandTotal, order.currency)}</span> : null}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">已收 / 待收</div>
            <div className="stat-value">{money(order.paidAmount, order.currency)}</div>
            <div className="stat-hint split">
              <span>待收 {money(order.remaining, order.currency)}</span>
              <span>定金 {money(order.depositAmount, order.currency)}</span>
              {order.remainingRaw < 0 ? (
                <span>已多收 {money(-order.remainingRaw, order.currency)}，不算在待收里</span>
              ) : null}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">毛利</div>
            <div className="stat-value">
              {order.missingCostItems ? '—' : money(order.totalProfit, order.currency)}
            </div>
            <div className="stat-hint">
              {order.missingCostItems ? (
                <>有 {order.missingCostItems} 行成本未录入，毛利不算（免得给你一个假数字）</>
              ) : (
                <>
                  成本 {money(order.totalCost, order.currency)}
                  {(() => {
                    // N-4：抵扣/折让是真让掉的钱，已从毛利里扣——纸面上写清楚，免得和旧口径对不上
                    const neg = (order.charges ?? [])
                      .filter((c: { amount: number }) => c.amount < 0)
                      .reduce((s: number, c: { amount: number }) => s + c.amount, 0)
                    return neg < 0
                      ? ` · 已扣抵扣/折让 ${money(neg, order.currency)}（毛利不再按货值算，收 0 元的单不显示赚钱）`
                      : ''
                  })()}
                  {' · 汇率 1'}
                  {order.currency}={order.exchangeRate}
                  {order.baseCurrency}
                </>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">装箱单</div>
            <div className="stat-value">{order.packingLists.length}</div>
            <div className="stat-hint">预计出货 {fmtDate(order.expectedShipDate) || '未设置'}</div>
          </div>
        </div>

        <div className="grid-2 grid-top">
          <div className="card">
            <div className="card-head">
              <h3>客户与条款</h3>
              <div className="spacer" />
              <Button size="sm" onClick={() => setShowParty(true)}>
                抬头
              </Button>
              <Button size="sm"  onClick={() => setShowEdit(true)}>
                编辑
              </Button>
            </div>
            <div className="card-body">
              <div className="kv-grid">
                <div>
                  <span className="k">买方抬头</span>
                  <span className="v">{order.billTo?.company || '—'}</span>
                </div>
                <div>
                  <span className="k">联系人</span>
                  <span className="v">{order.billTo?.attn || order.billTo?.contact || '—'}</span>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span className="k">地址</span>
                  <span className="v">
                    {order.billTo?.address} {order.billTo?.zipCode} {order.billTo?.country}
                  </span>
                </div>
                {order.shipTo && order.shipTo.address !== order.billTo?.address ? (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span className="k">收货抬头（PL）</span>
                    <span className="v">
                      {order.shipTo.company} · {order.shipTo.address} {order.shipTo.zipCode} {order.shipTo.country}
                    </span>
                  </div>
                ) : null}
                <div>
                  <span className="k">客户 PO</span>
                  <span className="v">{order.customerPo || '—'}</span>
                </div>
                {order.sourceQuotationNo ? (
                  <div>
                    <span className="k">来源报价</span>
                    <span className="v">
                      {order.sourceQuotationNo}
                      {order.sourceRevision ? ` · 第 ${order.sourceRevision} 版` : ''}
                      <span className="faint">（转单时的价格快照，之后改报价不影响这张单）</span>
                    </span>
                  </div>
                ) : null}
                <div>
                  <span className="k">贸易条款</span>
                  <span className="v">
                    {order.incoterm} · {order.portOfLoading || '—'} → {order.portOfDestination || '—'}
                  </span>
                </div>
                <div>
                  <span className="k">付款方式</span>
                  <span className="v">
                    {PAYMENT_METHOD_LABEL[order.paymentMethod as PaymentMethod] ?? order.paymentMethod}
                    {order.paymentMethod === 'tt_deposit' && order.depositRatio > 0 && order.depositRatio < 1
                      ? ` · 定金${(order.depositRatio * 100).toFixed(0)}% / 尾款${(
                          (1 - order.depositRatio) *
                          100
                        ).toFixed(0)}%`
                      : ''}
                  </span>
                </div>
                {order.billTo?.paymentPref ? (
                  <div>
                    <span className="k">客户付款条款</span>
                    <span className="v">{order.billTo.paymentPref}</span>
                  </div>
                ) : null}
                <div>
                  <span className="k">汇率</span>
                  <span className="v">
                    1{order.currency} = {order.exchangeRate}
                    {order.baseCurrency}
                    {order.exchangeRateDate ? ` （${order.exchangeRateDate} 锁定）` : ''}
                  </span>
                </div>
                <div>
                  <span className="k">工厂 / 交期</span>
                  <span className="v">
                    {order.factory || '—'}
                    {order.factoryDueDate ? ` · 交货 ${order.factoryDueDate}` : ''}
                  </span>
                </div>
                <div>
                  <span className="k">船期</span>
                  <span className="v">
                    {order.factoryDueDate ? `交货 ${order.factoryDueDate} → ` : ''}
                    {order.cutOffDate ? `截关 ${order.cutOffDate} → ` : ''}
                    {order.etdDate ? `开船 ${order.etdDate}` : '未填船期'}
                    {order.vessel ? ` · ${order.vessel}` : ''}
                  </span>
                </div>
                <div>
                  <span className="k">封条号</span>
                  <span className="v">{order.sealNo || '—'}</span>
                </div>
                <div>
                  <span className="k">PI 有效期</span>
                  <span className="v">{fmtDate(order.validUntil) || '—'}</span>
                </div>
                <div>
                  <span className="k">预计到港</span>
                  <span className="v">{fmtDate(order.expectedArrivalDate) || '—'}</span>
                </div>
                {order.charges?.length ? (
                  <div>
                    <span className="k">费用（运费/保险）</span>
                    <span className="v">
                      {order.charges.map((c: any) => `${c.label} ${Number(c.amount).toFixed(2)}`).join('，')}
                      {!editCharges ? (
                        <Button variant="ghost" size="sm"
                          
                          style={{ marginLeft: 8 }}
                          onClick={() => setEditCharges(true)}
                        >
                          改费用
                        </Button>
                      ) : null}
                    </span>
                  </div>
                ) : null}
                {order.note ? (
                  <div>
                    <span className="k">备注</span>
                    <span className="v">{order.note}</span>
                  </div>
                ) : null}
              </div>
              {order.customer && order.billTo && (order.customer.address || '') !== (order.billTo.address || '')
                ? (
                  <div className="hint mt-2">
                    客户档案的地址已改成「{order.customer.address || '空'}」，这张单仍按建单时钉住的抬头打印——
                    已发出的 PI / PL / CI 不会因为改档案而被重写。要跟着改请点「抬头」。
                  </div>
                )
                : null}
              {editCharges ? (
                <div className="mt-2">
                  <ChargesEditor
                    order={order}
                    onClose={() => setEditCharges(false)}
                    onSaved={async () => {
                      setEditCharges(false)
                      await load()
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>状态推进</h3>
              <div className="spacer" />
              <span className="faint">收款状态可手动改；出货状态有批次时由批次汇总</span>
            </div>
            <div className="card-body">
              {/* R1-④：状态只有一种形态（tag）。不点「改状态」就不出现下拉框，
                  避免同一个状态在同一屏里既是标签又是下拉 */}
              <div className="field">
                <label>收款状态</label>
                {editPayment ? (
                  <select
                    value={order.paymentStatus}
                    autoFocus
                    onChange={async (e) => {
                      await window.api.orders.setPaymentStatus(
                        orderId,
                        e.target.value as PaymentStatus
                      )
                      setEditPayment(false)
                      await load()
                    }}
                  >
                    {PAYMENT_STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {PAYMENT_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="row">
                    <PaymentTag status={order.paymentStatus} />
                    <Button variant="ghost" size="sm"  onClick={() => setEditPayment(true)}>
                      改状态
                    </Button>
                  </div>
                )}
                <div className="hint">收到定金/尾款时系统会自动流转，这里是手动覆盖。</div>
              </div>
              <div className="field">
                <label>出货状态</label>
                {order.shipSummary?.derivedStatus ? (
                  <>
                    <div className="row">
                      <ShipTag status={order.shipStatus} />
                      <span className="faint">
                        已出 {num(order.shipSummary.shippedQuantity)} / {num(order.shipSummary.orderedQuantity)} 件 ·{' '}
                        {order.shipSummary.batchCount} 个批次
                        {order.shipSummary.unshippedBatches > 0
                          ? `，还有 ${order.shipSummary.unshippedBatches} 批没出运`
                          : ''}
                      </span>
                    </div>
                    <div className="hint">
                      整单状态由装箱单批次汇总，不能在这里手改。到下面「装箱单」里改对应批次的出运状态。
                    </div>
                  </>
                ) : editShip ? (
                  <select
                    value={order.shipStatus}
                    autoFocus
                    onChange={async (e) => {
                      await window.api.orders.setShipStatus(orderId, e.target.value as ShipStatus)
                      setEditShip(false)
                      await load()
                    }}
                  >
                    {SHIP_STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {SHIP_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="row">
                    <ShipTag status={order.shipStatus} />
                    <Button variant="ghost" size="sm"  onClick={() => setEditShip(true)}>
                      改状态
                    </Button>
                  </div>
                )}
                {!order.shipSummary?.derivedStatus && (
                  <div className="hint">
                    {order.shipSummary?.batchCount > 0
                      ? '装箱单是升级前的老批次，出运状态还没标，整单仍按手工状态推进。到「装箱单」里补上状态后，会自动改由批次汇总。'
                      : '还没有装箱单批次，这张单仍按手工状态推进。'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="tabs">
            <div className={`tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>
              商品明细 ({order.items.length})
            </div>
            <div className={`tab ${tab === 'payment' ? 'active' : ''}`} onClick={() => setTab('payment')}>
              收款记录 ({order.payments.length})
            </div>
            <div className={`tab ${tab === 'packing' ? 'active' : ''}`} onClick={() => setTab('packing')}>
              装箱单 ({order.packingLists.length})
            </div>
            <div className={`tab ${tab === 'timeline' ? 'active' : ''}`} onClick={() => setTab('timeline')}>
              操作历史 ({events.length})
            </div>
            <div className={`tab ${tab === 'photos' ? 'active' : ''}`} onClick={() => setTab('photos')}>
              验货 / 装柜照
            </div>
          </div>
          <div className="card-body tight">
            {tab === 'items' ? <ItemsTab order={order} onChange={load} /> : null}
            {tab === 'payment' ? <PaymentTab order={order} onChange={load} /> : null}
            {tab === 'packing' ? (
              <PackingTab order={order} onChange={load} onPreview={openPl} grossFactor={Number(settings?.grossWeightFactor ?? 1.1)} />
            ) : null}
            {tab === 'timeline' ? <TimelineTab events={events} docVersions={docVersions} /> : null}
            {tab === 'photos' ? <PhotosTab order={order} onChange={load} /> : null}
          </div>
        </div>
      </div>

      {showEdit ? (
        <EditOrderModal
          order={order}
          settings={settings}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false)
            await load()
          }}
        />
      ) : null}

      {showParty ? (
        <PartyModal
          order={order}
          onClose={() => setShowParty(false)}
          onSaved={async () => {
            setShowParty(false)
            await load()
          }}
        />
      ) : null}

      {showCi ? (
        <CiModal
          order={order}
          onClose={() => setShowCi(false)}
          onPreview={(charges) => void openCi(charges)}
        />
      ) : null}

      {preview ? (
        <Modal
          title={`${preview.title} 预览`}
          onClose={() => setPreview(null)}
          size="xwide"
          footer={
            <>
              <Button  onClick={() => setPreview(null)}>
                关闭
              </Button>
              {preview.voided ? (
                <span className="faint" style={{ marginRight: 'auto' }}>
                  这一批已作废，纸面只作留档查询，不能再存成新版本
                </span>
              ) : (
                <>
                  <Button  onClick={savePdf}>
                    另存为 PDF
                  </Button>
                  <Button variant="primary"  onClick={saveToSystem}>
                    存到系统
                  </Button>
                </>
              )}
            </>
          }
        >
          {preview.notice ? <div className="alert warn">{preview.notice}</div> : null}
          <div
            className="doc-preview"
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        </Modal>
      ) : null}
    </>
  )
}

/* ================= 费用行（运费/保险）就地修改 ================= */

function ChargesEditor({
  order,
  onClose,
  onSaved
}: {
  order: any
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [charges, setCharges] = useState<{ uid: string; label: string; amount: number }[]>(
    (order.charges ?? []).map((c: any) => ({ uid: clientKey(), label: String(c.label), amount: Number(c.amount) || 0 }))
  )
  const total = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)

  const save = async () => {
    try {
      await window.api.orders.updateCharges(
        order.id,
        charges.filter((c) => c.label.trim()).map((c) => ({ label: c.label, amount: c.amount }))
      )
      toast('费用已改，PI / CI 上的合计同步变了')
      await onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div style={{ border: '1px solid #e2e6ee', borderRadius: 6, padding: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong className="sec-head">费用（运费 / 保险费 / 其他）</strong>
        <div className="spacer" />
        <Button size="sm"  onClick={() => setCharges((cs) => [...cs, { uid: clientKey(), label: '运费 Freight', amount: 0 }])}>
          + 加费用
        </Button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>费用名称</th>
              <th className="num" style={{ width: '30%' }}>
                金额（{order.currency}）
              </th>
              <th className="col-num-sm"></th>
            </tr>
          </thead>
          <tbody>
            {charges.length === 0 ? (
              <tr>
                <td colSpan={3} className="faint">
                  还没有费用行。CIF/CFR/FOB 天天变，运费改了这里就能改。
                </td>
              </tr>
            ) : (
              charges.map((c) => (
                <tr key={c.uid}>
                  <td>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        setCharges((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, label: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.01"
                      className="col-num-lg"
                      value={c.amount}
                      onChange={(e) =>
                        setCharges((cs) =>
                          cs.map((x) => (x.uid === c.uid ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={() => setCharges((cs) => cs.filter((x) => x.uid !== c.uid))}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="tfoot-strong">
              <td>费用合计</td>
              <td className="num">{total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="row mt-2">
        <div className="hint">含费用合计 {money(order.totalAmount + total, order.currency)}</div>
        <div className="spacer" />
        <Button size="sm"  onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" size="sm"  onClick={() => void save()}>
          保存费用
        </Button>
      </div>
    </div>
  )
}

/* ================= 商业发票 CI ================= */

function CiModal({
  order,
  onClose,
  onPreview
}: {
  order: any
  onClose: () => void
  onPreview: (charges: { label: string; amount: number }[]) => void
}) {
  // 费用行默认按订单上的一行行带出来：CI 与 PI 必须是同一套数字
  const [charges, setCharges] = useState<{ uid: string; label: string; amount: number }[]>(
    (order.charges ?? []).map((c: any) => ({ uid: clientKey(), label: String(c.label), amount: Number(c.amount) || 0 }))
  )
  const chargeTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const total = order.totalAmount + chargeTotal
  const piTotal = Number(order.grandTotal ?? order.totalAmount)
  const mismatch = Math.abs(total - piTotal) > 0.005
  const clean = charges.filter((c) => c.label.trim())
  return (
    <Modal
      title="商业发票 CI（报关用）"
      onClose={onClose}
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button variant="primary"  onClick={() => onPreview(clean)}>
            生成 CI 预览
          </Button>
        </>
      }
    >
      <div className="alert info">
        CI 的抬头是 COMMERCIAL INVOICE / 商业发票，跟 PI 不一样，不会让客户以为已经下单。
        <br />
        运费、保险费已经按订单上的费用行带出来了（PI 上印的就是这同一套数字），确认一眼就行。
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
      {charges.length === 0 ? (
        <div className="hint">这张单没有费用行，CI 合计 = 货值。</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>费用名称</th>
                <th className="num" style={{ width: '30%' }}>
                  金额（{order.currency}）
                </th>
                <th className="col-num-sm"></th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.uid}>
                  <td>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        setCharges((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, label: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.01"
                      className="col-num-lg"
                      value={c.amount}
                      onChange={(e) =>
                        setCharges((cs) =>
                          cs.map((x) => (x.uid === c.uid ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={() => setCharges((cs) => cs.filter((x) => x.uid !== c.uid))}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="price-calc mt">
        <div>
          <span className="muted">货值</span>
          <span>{money(order.totalAmount, order.currency)}</span>
        </div>
        <div>
          <span className="muted">费用</span>
          <span>{money(chargeTotal, order.currency)}</span>
        </div>
        <div className="total">
          <span>CI 合计</span>
          <span>{money(total, order.currency)}</span>
        </div>
      </div>
      {mismatch ? (
        <div className="alert error">
          CI 合计 {money(total, order.currency)}，与 PI 合计 {money(piTotal, order.currency)} 不一致，确认一下！
          信用证客户拿到两张不一样的数字，银行会挑不符点。
        </div>
      ) : (
        <div className="alert info">CI 合计与 PI 合计一致（{money(piTotal, order.currency)}），可以直接用。</div>
      )}
    </Modal>
  )
}

/* ================= 商品明细 ================= */

function ItemsTab({ order, onChange }: { order: any; onChange: () => Promise<void> }) {
  const toast = useToast()
  const [products, setProducts] = useState<any[]>([])
  const [showAdd, setShowAdd] = useState(false)

  useEffect(() => {
    void window.api.products.list('').then(setProducts)
  }, [])

  /** 款号 → 可选颜色/尺码，供明细表里直接改颜色、尺码 */
  const options = useMemo(() => {
    const map: Record<string, { colors: string[]; sizes: string[] }> = {}
    for (const p of products) map[p.styleNo] = { colors: p.colors ?? [], sizes: p.sizes ?? [] }
    return map
  }, [products])

  const refresh = async () => {
    await onChange()
  }

  // 已装箱/已出运的明细改不动：报错要说给人听，输入框也要跟着回退到真实值
  const saveItem = async (itemId: number, patch: Record<string, unknown>, okMsg?: string): Promise<boolean> => {
    let ok = false
    try {
      await window.api.orders.updateItem(order.id, itemId, patch)
      ok = true
      if (okMsg) toast(okMsg)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    await refresh()
    return ok
  }

  const removeItem = async (itemId: number) => {
    try {
      await window.api.orders.removeItem(order.id, itemId)
      toast('已删除，操作历史里已留痕')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    await refresh()
  }

  return (
    <>
      <div className="toolbar sec-top">
        <div className="spacer" />
        <Button variant="primary"  onClick={() => setShowAdd(true)}>
          + 添加商品
        </Button>
      </div>

      {order.items.length === 0 ? (
        <Empty text="还没有商品。点「添加商品」从商品库选款。" />
      ) : (
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
                <th className="num" title="本单币种的成本价，不是工厂报的人民币价；没录就填这里">
                  成本（{order.currency}）
                </th>
                <th className="num">金额</th>
                <th className="num">毛利</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it: any) => (
                <tr key={it.id}>
                  <td className="mono nowrap">{it.styleNo}</td>
                  <td>{it.productName}</td>
                  <td>
                    <input
                      list={`colors-${it.id}`}
                      value={it.color}
                      className="col-num"
                      onBlur={async (e) => {
                        const v = e.target.value
                        if (v === it.color) return
                        await saveItem(it.id, { color: v })
                      }}
                    />
                    <datalist id={`colors-${it.id}`}>
                      {(options[it.styleNo]?.colors ?? []).map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </td>
                  <td>
                    <input
                      list={`sizes-${it.id}`}
                      value={it.size}
                      className="col-num-sm"
                      onBlur={async (e) => {
                        const v = e.target.value
                        if (v === it.size) return
                        await saveItem(it.id, { size: v })
                      }}
                    />
                    <datalist id={`sizes-${it.id}`}>
                      {(options[it.styleNo]?.sizes ?? []).map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      className="col-num-sm"
                      defaultValue={it.quantity}
                      onBlur={async (e) => {
                        // 清空 = 没改，不是「改成 0」；被服务层拦下来的数要弹回真值，
                        // 不然格子里显示 500、账上还是 300，用户带着错数去跟工厂排产
                        if (e.target.value.trim() === '') {
                          e.target.value = String(it.quantity)
                          return
                        }
                        const v = Number(e.target.value)
                        if (v === it.quantity) return
                        if (!(await saveItem(it.id, { quantity: v }))) e.target.value = String(it.quantity)
                      }}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.01"
                      className="col-num"
                      defaultValue={it.unitPrice}
                      onBlur={async (e) => {
                        if (e.target.value.trim() === '') {
                          e.target.value = String(it.unitPrice)
                          return
                        }
                        const v = Number(e.target.value)
                        if (v === it.unitPrice) return
                        if (!(await saveItem(it.id, { unitPrice: v }))) e.target.value = String(it.unitPrice)
                      }}
                    />
                  </td>
                  <td className="num">
                    {/* 成本可填：空的时候给一句「未录，点这里补」，不给死胡同 */}
                    <input
                      type="number"
                      step="0.01"
                      className="col-num"
                      defaultValue={it.unitCost ?? ''}
                      placeholder="未录，点这里补"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim()
                        const v = raw === '' ? null : Number(raw)
                        if (v === it.unitCost) return
                        await saveItem(it.id, { unitCost: v }, v == null ? '已清空这行的成本（毛利变成不可信）' : '成本已录入')
                      }}
                    />
                  </td>
                  <td className="num">{(it.quantity * it.unitPrice).toFixed(2)}</td>
                  <td className="num">
                    {it.unitCost == null ? '—' : (it.quantity * (it.unitPrice - it.unitCost)).toFixed(2)}
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={async () => {
                        if (
                          !confirm(
                            `删除 ${it.styleNo} ${it.color}/${it.size} × ${it.quantity}？\n\n` +
                              '（删了会在操作历史里记一笔「删除明细」，客户后来取消的这一单系统也记得）'
                          )
                        )
                          return
                        await removeItem(it.id)
                      }}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="tfoot-strong">
                <td colSpan={4}>合计</td>
                <td className="num">{num(order.totalQuantity)}</td>
                <td></td>
                <td className="num faint">{order.totalCost.toFixed(2)}</td>
                <td className="num">{order.totalAmount.toFixed(2)}</td>
                <td className="num">{order.missingCostItems ? '—' : order.totalProfit.toFixed(2)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {showAdd ? (
        <AddItemsModal
          order={order}
          products={products}
          onClose={() => setShowAdd(false)}
          onDone={async () => {
            setShowAdd(false)
            await refresh()
          }}
        />
      ) : null}
    </>
  )
}

/** 从商品库选款，生成 SKU 矩阵 */
function AddItemsModal({
  order,
  products,
  onClose,
  onDone
}: {
  order: any
  products: any[]
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const toast = useToast()
  const [picked, setPicked] = useState<any>(null)
  const [price, setPrice] = useState('')
  const [colorPrice, setColorPrice] = useState<Record<string, string>>({})
  const [grid, setGrid] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')

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

  const selectProduct = async (p: any) => {
    setPicked(p)
    // 成本价是工厂价，不是卖价：绝不能自动填进「销售单价」
    setPrice('')
    const g: Record<string, string> = {}
    for (const c of p.colors) for (const s of p.sizes) g[`${c}|${s}`] = ''
    setGrid(g)
    setColorPrice({})
  }

  const rows = useMemo(() => {
    if (!picked) return []
    const out: { color: string; size: string; key: string }[] = []
    for (const c of picked.colors) for (const s of picked.sizes) out.push({ color: c, size: s, key: `${c}|${s}` })
    return out
  }, [picked])

  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy || !picked) return
    const rows2 = rows.filter((r) => (grid[r.key] ?? '').trim() !== '')
    const half = rows2.filter((r) => !Number.isInteger(Number(grid[r.key])) || Number(grid[r.key]) <= 0)
    if (half.length > 0) {
      toast(
        `这几格填的数量不是 1 件以上的整数：${half.map((r) => `${r.color}/${r.size}「${grid[r.key]}」`).join('、')}。不做的组合请留空`,
        'error'
      )
      return
    }
    const items = rows2.map((r) => ({
      productId: picked.id,
      styleNo: picked.styleNo,
      productName: picked.name,
      composition: picked.composition,
      color: r.color,
      size: r.size,
      quantity: Number(grid[r.key]),
      unitPrice: colorPrice[r.color] ? Number(colorPrice[r.color]) : Number(price) || 0,
      // 交工厂价（基准币），由服务端按本单汇率折算——前端不自己除，免得又算出两套数
      costBase: picked.costPrice
    }))
    if (items.length === 0) {
      toast('请至少填写一个 SKU 的数量', 'error')
      return
    }
    const noPrice = items.filter((i) => !(i.unitPrice > 0))
    if (noPrice.length > 0) {
      toast(
        `这 ${noPrice.length} 个组合还没单价（${noPrice.map((i) => `${i.color}/${i.size}`).join('、')}）。按 0 保存会把整单金额、应收和毛利一起做成 0——请先在「单价」里填价`,
        'error'
      )
      return
    }
    setBusy(true)
    try {
      // 一次批量调用：整批一个事务，第 3 行不合格时前两行不会已经躺在库里
      await window.api.orders.addItems(order.id, items)
      toast(`已添加 ${items.length} 个 SKU`)
      await onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="添加商品"
      onClose={onClose}
      size="xwide"
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            添加到订单
          </Button>
        </>
      }
    >
      <div className="field">
        <label>选择款号</label>
        <input
          autoFocus
          value={search}
          placeholder="输入款号或品名搜索…"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {products.length === 0 ? (
        <div className="alert warn">商品库还是空的，先到「商品库」新增款号。</div>
      ) : (
        <div className="picker-list">
          {filtered.length === 0 ? (
            <div className="hint" style={{ padding: '10px 12px' }}>
              没有匹配的款号
            </div>
          ) : (
            filtered.map((p) => (
              <div
                key={p.id}
                className={`picker-item ${picked?.id === p.id ? 'active' : ''}`}
                onClick={() => void selectProduct(p)}
              >
                <div className="picker-main">
                  <span className="mono">{p.styleNo}</span>
                  <span className="picker-name">{p.name}</span>
                </div>
                <div className="picker-meta">
                  {p.composition ? <span className="faint">{p.composition}</span> : null}
                  <span className="faint">
                    {p.sizes.length ? `${p.sizes.length} 码` : '无尺码表'} ·{' '}
                    {p.colors.length ? `${p.colors.length} 色` : '无颜色表'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {!picked ? (
        <Empty text="先选择一个款号" />
      ) : (
        <>
          <div className="price-calc mb">
            <div>
              <span className="muted">款号</span>
              <span>{picked.styleNo}</span>
            </div>
            <div>
              <span className="muted">品名</span>
              <span>{picked.name}</span>
            </div>
            <div>
              <span className="muted">成分</span>
              <span>{picked.composition || '—'}</span>
            </div>
            <div>
              <span className="muted">工厂成本价</span>
              <span>
                {picked.costPrice == null
                  ? '未设置'
                  : `${order.baseCurrency || 'CNY'} ${picked.costPrice}${
                      Number(order.exchangeRate) > 0 && order.baseCurrency !== order.currency
                        ? ` ≈ ${order.currency} ${(picked.costPrice / Number(order.exchangeRate)).toFixed(2)}（本单汇率）`
                        : ''
                    }`}
              </span>
            </div>
          </div>

          <div className="field">
            <label>销售单价（{order.currency}）</label>
            <input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <div className="hint">同款不同色可以给不同价：在下面按颜色填，会覆盖上面的单价。</div>
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

          {rows.length === 0 ? (
            <div className="alert warn">该款号还没有设置尺码表和颜色表，请先到商品库补充。</div>
          ) : (
            <table className="sku-matrix">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>颜色</th>
                  <th style={{ width: '30%' }}>尺码</th>
                  <th>数量（留空或 0 表示不出货）</th>
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
          )}
        </>
      )}
    </Modal>
  )
}

/* ================= 收款 ================= */

function PaymentTab({ order, onChange }: { order: any; onChange: () => Promise<void> }) {
  const toast = useToast()
  const [form, setForm] = useState({
    paidAt: localDate(),
    amount: '',
    method: 'T/T',
    bankRef: '',
    note: ''
  })
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [settleKind, setSettleKind] = useState<'shortage' | 'bad_debt' | 'recovery' | null>(null)
  const [settleForm, setSettleForm] = useState({
    amount: '',
    at: localDate(),
    reason: '',
    evidence: '',
    paidAt: localDate(),
    bankRef: ''
  })
  const [settleSaving, setSettleSaving] = useState(false)
  const [reverseTarget, setReverseTarget] = useState<any | null>(null)
  const [reverseReason, setReverseReason] = useState('')
  const [reversing, setReversing] = useState(false)

  const add = async () => {
    const amt = Number(form.amount)
    if (!isLocalDate(form.paidAt)) {
      toast('请选择收款日期。空日期的收款不会进本月收款和月报。', 'error')
      return
    }
    if (!amt || amt <= 0) {
      toast('请填写收款金额', 'error')
      return
    }
    if (saving) return
    setSaving(true)
    try {
      await window.api.orders.addPayment(order.id, { ...form, amount: amt })
      toast('已记录收款')
      setForm({ ...form, amount: '', bankRef: '', note: '' })
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const openSettle = (kind: 'shortage' | 'bad_debt' | 'recovery', amount = '') => {
    setSettleForm({
      amount,
      at: localDate(),
      reason: '',
      evidence: '',
      paidAt: localDate(),
      bankRef: ''
    })
    setSettleKind(kind)
  }

  const saveSettle = async () => {
    if (!settleKind || settleSaving) return
    if (!settleForm.reason.trim()) {
      toast('请写清楚原因，核销和坏账都会进操作历史', 'error')
      return
    }
    if (settleKind === 'recovery' && !isLocalDate(settleForm.paidAt)) {
      toast('追回款要填到账日期', 'error')
      return
    }
    setSettleSaving(true)
    try {
      await window.api.orders.addSettlement(order.id, {
        kind: settleKind,
        amount: settleForm.amount === '' ? undefined : Number(settleForm.amount),
        at: settleForm.at,
        reason: settleForm.reason.trim(),
        evidence: settleForm.evidence.trim(),
        paidAt: settleKind === 'recovery' ? settleForm.paidAt : undefined,
        bankRef: settleForm.bankRef.trim()
      })
      toast(settleKind === 'recovery' ? '已登记追回款' : settleKind === 'bad_debt' ? '已标坏账' : '已核销短款')
      setSettleKind(null)
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSettleSaving(false)
    }
  }

  const reverse = async () => {
    if (!reverseTarget || reversing) return
    if (!reverseReason.trim()) {
      toast('撤销要写原因，操作历史要留痕', 'error')
      return
    }
    setReversing(true)
    try {
      await window.api.orders.reverseSettlement(order.id, reverseTarget.id, reverseReason.trim())
      toast('已撤销，原记录和撤销记录都留在台账里')
      setReverseTarget(null)
      setReverseReason('')
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setReversing(false)
    }
  }

  const remove = async () => {
    if (!deleteTarget || deleting) return
    const why = deleteReason.trim()
    if (!why) {
      toast('请写一句删除原因，操作历史要留痕', 'error')
      return
    }
    setDeleting(true)
    try {
      await window.api.orders.deletePayment(order.id, deleteTarget.id, why)
      toast('已删除，操作历史里已留痕')
      setDeleteTarget(null)
      setDeleteReason('')
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setDeleting(false)
    }
  }

  const settleLocked = ['draft', 'expired', 'void'].includes(order.paymentStatus)
  const settlements: any[] = order.settlements ?? []
  const reversedIds = new Set(
    settlements.filter((s) => s.reversesId != null).map((s) => Number(s.reversesId))
  )
  const settleTitle =
    settleKind === 'recovery' ? '登记坏账追回' : settleKind === 'bad_debt' ? '标坏账' : '登记短款核销'

  return (
    <>
      <div className="card-body">
        <div className="price-calc mb">
          <div>
            <span className="muted">货值</span>
            <span>{money(order.totalAmount, order.currency)}</span>
          </div>
          {order.chargesTotal ? (
            <div>
              <span className="muted">含费用合计</span>
              <span>{money(order.grandTotal, order.currency)}</span>
            </div>
          ) : null}
          <div>
            <span className="muted">定金（{Math.round(order.depositRatio * 100)}%）</span>
            <span>{money(order.depositAmount, order.currency)}</span>
          </div>
          <div>
            <span className="muted">已收</span>
            <span>{money(order.paidAmount, order.currency)}</span>
          </div>
          {order.writeOffShortage ? (
            <div>
              <span className="muted">短款核销</span>
              <span>−{money(order.writeOffShortage, order.currency)}</span>
            </div>
          ) : null}
          {order.writeOffBadDebt ? (
            <div>
              <span className="muted">坏账核销</span>
              <span>−{money(order.writeOffBadDebt, order.currency)}</span>
            </div>
          ) : null}
          {order.badDebtOutstanding ? (
            <div>
              <span className="muted">坏账未追回</span>
              <span>{money(order.badDebtOutstanding, order.currency)}</span>
            </div>
          ) : null}
          <div className="total">
            <span>待收</span>
            <span>{money(order.remaining, order.currency)}</span>
          </div>
        </div>
        {order.chargesTotal ? (
          <div className="hint mb">定金和待收都按「含费用合计」算，运费保险也算在应收里。</div>
        ) : null}
        {order.writtenOff ? (
          <div className="hint mb">
            待收已经扣掉核销金额。短款是让利，会进毛利；坏账只从待收里拿掉，月回款仍只认银行到账。
          </div>
        ) : null}

        <div className="field-row-3">
          <div className="field">
            <label>收款日期 *</label>
            <input
              type="date"
              value={form.paidAt}
              onChange={(e) => setForm({ ...form, paidAt: e.target.value })}
            />
          </div>
          <div className="field">
            <label>金额（{order.currency}）</label>
            <input
              type="number"
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
          <div className="field">
            <label>方式</label>
            <input value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>银行流水号</label>
            <input
              value={form.bankRef}
              onChange={(e) => setForm({ ...form, bankRef: e.target.value })}
              placeholder="对账凭据"
            />
          </div>
          <div className="field">
            <label>备注</label>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
        <Button variant="primary" onClick={add} disabled={saving}>
          {saving ? '保存中…' : '记录收款'}
        </Button>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>日期</th>
              <th className="num">金额</th>
              <th>方式</th>
              <th>银行流水号</th>
              <th>备注</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {order.payments.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty text="还没有收款记录。收到款后在「添加收款」里登记。" />
                </td>
              </tr>
            ) : (
              order.payments.map((p: any) => (
                <tr key={p.id}>
                  <td className="nowrap">{fmtDate(p.paidAt)}</td>
                  <td className="num">{money(p.amount, order.currency)}</td>
                  <td>{p.method}</td>
                  <td className="mono">{p.bankRef || '—'}</td>
                  <td className="faint">{p.note}</td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      onClick={() => {
                        setDeleteReason('')
                        setDeleteTarget(p)
                      }}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="card-body">
        <div className="field-row" style={{ alignItems: 'center' }}>
          <div>
            <strong>核销与坏账</strong>
            <div className="hint">
              客户少付、银行扣费、抹零 → 短款核销；确实收不回来 → 坏账。都只追加，撤销也留一条记录。
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button
              size="sm"
              onClick={() => openSettle('shortage', String(order.remaining || ''))}
              disabled={settleLocked || order.remaining <= 0}
            >
              登记短款
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => openSettle('bad_debt', String(order.remaining || ''))}
              disabled={settleLocked || order.remaining <= 0}
            >
              标坏账
            </Button>
            <Button
              size="sm"
              onClick={() => openSettle('recovery')}
              disabled={settleLocked || order.badDebtOutstanding <= 0}
            >
              坏账追回
            </Button>
          </div>
        </div>
        {settleLocked ? (
          <div className="hint mb">草稿、已失效、已作废的订单不能核销；先把订单状态改成正式单。</div>
        ) : null}

        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>日期</th>
                <th>类型</th>
                <th className="num">金额</th>
                <th>原因</th>
                <th>证据说明</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {settlements.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <Empty text="还没有核销记录。少收的钱不要靠改写单据来平账。" />
                  </td>
                </tr>
              ) : (
                settlements.map((s) => {
                  const isReversal = s.amount < 0
                  return (
                    <tr key={s.id}>
                      <td className="nowrap">{fmtDate(s.at)}</td>
                      <td>
                        {SETTLEMENT_KIND_LABEL[s.kind as keyof typeof SETTLEMENT_KIND_LABEL] ?? s.kind}
                        {isReversal ? ' · 撤销' : ''}
                      </td>
                      <td className="num">{money(s.amount, order.currency)}</td>
                      <td>{s.reason}</td>
                      <td className="faint">{s.evidence || '—'}</td>
                      <td className="right">
                        {s.amount > 0 && s.kind !== 'recovery' && !reversedIds.has(s.id) ? (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setReverseReason('')
                              setReverseTarget(s)
                            }}
                          >
                            撤销
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {settleKind ? (
        <Modal
          title={settleTitle}
          onClose={() => setSettleKind(null)}
          footer={
            <>
              <Button onClick={() => setSettleKind(null)} disabled={settleSaving}>
                取消
              </Button>
              <Button
                variant={settleKind === 'bad_debt' ? 'danger' : 'primary'}
                onClick={saveSettle}
                disabled={settleSaving}
              >
                {settleSaving ? '保存中…' : '确认'}
              </Button>
            </>
          }
        >
          {settleKind === 'shortage' ? (
            <p>
              客户少付的那部分从待收里扣掉，也会进毛利（这是让利，不是坏账）。不要为了结清单去改 PI 金额。
            </p>
          ) : settleKind === 'bad_debt' ? (
            <p>
              坏账从待收里拿掉，订单和收款记录一条不删。报表里单列信用损失，不会悄悄从销售额里扣。
            </p>
          ) : (
            <p>
              追回的钱会先落一笔收款（进本月回款），再冲减坏账余额；待收不会重新冒出来。
            </p>
          )}
          {settleKind === 'recovery' ? (
            <div className="field-row">
              <div className="field">
                <label>到账日期 *</label>
                <input
                  type="date"
                  value={settleForm.paidAt}
                  onChange={(e) => setSettleForm({ ...settleForm, paidAt: e.target.value })}
                />
              </div>
              <div className="field">
                <label>追回金额（{order.currency}）</label>
                <input
                  type="number"
                  step="0.01"
                  value={settleForm.amount}
                  onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })}
                  placeholder={`未追回 ${order.badDebtOutstanding.toFixed(2)}`}
                />
              </div>
            </div>
          ) : (
            <div className="field-row">
              <div className="field">
                <label>核销日期 *</label>
                <input
                  type="date"
                  value={settleForm.at}
                  onChange={(e) => setSettleForm({ ...settleForm, at: e.target.value })}
                />
              </div>
              <div className="field">
                <label>金额（{order.currency}）</label>
                <input
                  type="number"
                  step="0.01"
                  value={settleForm.amount}
                  onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })}
                  placeholder={`当前待收 ${order.remaining.toFixed(2)}`}
                />
              </div>
            </div>
          )}
          <div className="field">
            <label>原因 *</label>
            <input
              value={settleForm.reason}
              onChange={(e) => setSettleForm({ ...settleForm, reason: e.target.value })}
              placeholder={
                settleKind === 'shortage'
                  ? '例如：银行扣费 / 客户抹零 / 汇差 / 我方让价'
                  : settleKind === 'bad_debt'
                    ? '例如：客户破产 / 失联 / 拒付'
                    : '例如：客户分期补付第一笔'
              }
            />
          </div>
          {settleKind === 'recovery' ? (
            <div className="field">
              <label>银行流水号</label>
              <input
                value={settleForm.bankRef}
                onChange={(e) => setSettleForm({ ...settleForm, bankRef: e.target.value })}
                placeholder="对账凭据"
              />
            </div>
          ) : null}
          <div className="field">
            <label>证据说明</label>
            <input
              value={settleForm.evidence}
              onChange={(e) => setSettleForm({ ...settleForm, evidence: e.target.value })}
              placeholder="邮件日期、律师函编号、破产公告等（附件在后续版本补）"
            />
          </div>
        </Modal>
      ) : null}

      {reverseTarget ? (
        <Modal
          title={`撤销${SETTLEMENT_KIND_LABEL[reverseTarget.kind as keyof typeof SETTLEMENT_KIND_LABEL] ?? ''} ${money(reverseTarget.amount, order.currency)}`}
          onClose={() => setReverseTarget(null)}
          footer={
            <>
              <Button onClick={() => setReverseTarget(null)} disabled={reversing}>
                取消
              </Button>
              <Button variant="danger" onClick={reverse} disabled={reversing}>
                {reversing ? '撤销中…' : '确认撤销'}
              </Button>
            </>
          }
        >
          <p>
            撤销不会删原记录，而是在台账里追加一条负数。待收和收款状态会自动重算，原因会写进操作历史。
          </p>
          <div className="field">
            <label>撤销原因 *</label>
            <input
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="例如：客户又把钱补来了 / 核销金额录错"
            />
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title={`删除收款 ${money(deleteTarget.amount, order.currency)}`}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
                取消
              </Button>
              <Button variant="danger" onClick={remove} disabled={deleting}>
                {deleting ? '删除中…' : '确认删除'}
              </Button>
            </>
          }
        >
          <p>
            {fmtDate(deleteTarget.paidAt)} 收到的这笔钱会从「已收」里减掉，收款状态自动重算。
            金额、日期、流水号和你写的原因都会留在操作历史里，不会凭空消失。
          </p>
          <div className="field">
            <label>删除原因 *</label>
            <input
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="例如：金额录错 / 客户退汇 / 重复登记"
            />
          </div>
        </Modal>
      ) : null}
    </>
  )
}

/* ================= 装箱单 ================= */

/** 一批装出去多少件：明细一行就是一箱，同款拆多箱也逐行相加 */
function batchQty(pl: any): number {
  return (pl?.lines ?? []).reduce((s: number, l: any) => s + (Number(l.quantity) || 0), 0)
}

/**
 * 一批的净重/毛重/体积合计，跟纸面 TOTAL 同一算法：
 * 毛重没填的按净重×系数估；箱规三边齐了才算体积。给货代订舱报数时不用再按计算器。
 */
function batchWeights(pl: any, factor: number): { net: number; gross: number; cbm: number; estimated: boolean } {
  let net = 0
  let gross = 0
  let cbm = 0
  let estimated = false
  for (const l of pl?.lines ?? []) {
    const n = Number(l.netWeight) || 0
    const raw = l.grossWeight == null ? null : Number(l.grossWeight)
    const isEst = isGrossEstimated(l, factor)
    net += n
    gross += raw == null ? Number((n * factor).toFixed(2)) : raw
    if (isEst) estimated = true
    const L = Number(l.boxLength) || 0
    const W = Number(l.boxWidth) || 0
    const H = Number(l.boxHeight) || 0
    if (L && W && H) cbm += (L * W * H) / 1000000
  }
  return { net, gross, cbm, estimated }
}

/**
 * 这张订单已经用到的最大箱号序号（跨所有批次，作废的也算——箱号不能重复发）。
 * 一单分三批出运时，客户仓库和提单上要用连续箱号；每批都从 NO.1 重排，
 * 两份箱单都写着 NO.1–NO.20，提货时就说不清哪一箱属于哪一批。
 */
function maxBoxSeq(order: any): number {
  let max = 0
  for (const pl of order?.packingLists ?? []) {
    for (const l of pl?.lines ?? []) {
      const m = /(\d+)\s*$/.exec(String(l.boxNo ?? '').trim())
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return max
}

/** 批次合计行：件数、重量、体积，跟箱单纸面一个口径 */
function BatchTotals({ pl, factor }: { pl: any; factor: number }) {
  const w = batchWeights(pl, factor)
  return (
    <tr className="tfoot-strong">
      <td colSpan={5}>{`本批合计${w.estimated ? '（毛重含估算）' : ''}`}</td>
      <td className="num">{batchQty(pl)}</td>
      <td className="num">{w.net.toFixed(2)}</td>
      <td className="num">{w.gross.toFixed(2)}</td>
      <td>{`${w.cbm.toFixed(3)} m³`}</td>
      <td></td>
    </tr>
  )
}

function PackingTab({
  order,
  onChange,
  onPreview,
  grossFactor
}: {
  order: any
  onChange: () => Promise<void>
  onPreview: (plId: number) => void
  /** 毛重系数：合计行要按纸面同一口径估（净重×系数），不然屏幕上和箱单上两个数 */
  grossFactor: number
}) {
  const toast = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [editPl, setEditPl] = useState<any | null>(null)
  const [addBoxPl, setAddBoxPl] = useState<any | null>(null)

  // 每批的纸面金额：本批货值 + 按货值摊到的费用，由 money.ts 算一份。
  // 分批出运时箱单/存档上不能再挂整单的数——三批各存一次「12000」，看的人以为卖了 36000。
  const [amounts, setAmounts] = useState<Record<number, PackingAmount>>({})
  useEffect(() => {
    let alive = true
    window.api.pl
      .amounts(order.id)
      .then((rows) => {
        if (alive) setAmounts(Object.fromEntries(rows.map((a) => [a.plId, a])))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [order.id, order.packingLists])

  const voidBatch = async (pl: any) => {
    if (
      !confirm(
        `作废装箱单 ${pl.plNo}？\n这一批不再参与出货状态、件数和本批金额；记录、箱明细和已经存好的 PDF 一条不删（发到客户手里的单据必须还查得到）。`
      )
    )
      return
    try {
      await window.api.pl.void(order.id, pl.id)
      toast(`${pl.plNo} 已作废留档`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    await onChange()
  }

  const unvoidBatch = async (pl: any) => {
    if (!confirm(`撤销作废 ${pl.plNo}？这一批重新参与出货状态、件数和本批金额。`)) return
    try {
      await window.api.pl.unvoid(order.id, pl.id)
      toast(`${pl.plNo} 已恢复`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    await onChange()
  }

  // 已出运批次的箱明细是锁住的：报错要弹出来，输入框跟着回退到库里的值
  const saveLine = async (plId: number, lineId: number, patch: Record<string, unknown>, revert?: () => void) => {
    try {
      await window.api.pl.updateLine(order.id, plId, lineId, patch)
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
      revert?.()
      await onChange()
    }
  }

  const removeLine = async (plId: number, lineId: number) => {
    try {
      await window.api.pl.deleteLine(order.id, plId, lineId)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    await onChange()
  }

  return (
    <>
      <div className="toolbar sec-top">
        <div className="spacer" />
        <Button variant="primary"  onClick={() => setShowCreate(true)}>
          + 新建装箱单
        </Button>
      </div>

      {order.packingLists.length === 0 ? (
        <Empty text="还没有装箱单。点「新建装箱单」按 SKU 自动汇总生成。" />
      ) : (
        order.packingLists.map((pl: any) => (
          <div key={pl.id} style={{ borderBottom: '1px solid #eef1f6' }}>
            <div className="toolbar sec-top">
              <strong className="mono">{pl.plNo}</strong>
              {pl.shipStatus ? <ShipTag status={pl.shipStatus} /> : <span className="faint">升级前的老批次</span>}
              {pl.containerNo ? <span className="tag blue">柜号 {pl.containerNo}</span> : null}
              <span className="faint">
                {pl.lines.length} 箱 · {batchQty(pl)} 件
              </span>
              {amounts[pl.id] ? (
                <span className="tag grey" title="本批货值 + 按货值摊到的运费/保险：分批的几张单据金额相加等于 PI">
                  本批金额 {money(amounts[pl.id].total, order.currency)}
                </span>
              ) : null}
              {pl.receivedQty != null ? (
                <span
                  className={Number(pl.receivedQty) < batchQty(pl) ? 'tag amber' : 'tag green'}
                  title="客户实收件数：没填就按发数全收算"
                >
                  实收 {pl.receivedQty} 件
                  {Number(pl.receivedQty) < batchQty(pl) ? `（短 ${batchQty(pl) - Number(pl.receivedQty)}）` : ''}
                </span>
              ) : null}
              {pl.voidedAt ? <span className="tag red">已作废 · 仅留档</span> : null}
              <div className="spacer" />
              {pl.voidedAt ? (
                <Button size="sm"  onClick={() => unvoidBatch(pl)}>
                  撤销作废
                </Button>
              ) : (
                <>
                  <Button size="sm"  onClick={() => setAddBoxPl(pl)}>
                    + 加一箱
                  </Button>
                  <Button size="sm"  onClick={() => voidBatch(pl)}>
                    作废
                  </Button>
                </>
              )}
              <Button size="sm"  onClick={() => onPreview(pl.id)}>
                {pl.voidedAt ? '查看留档' : '预览'}
              </Button>
              {pl.voidedAt ? null : (
                <>
                  <Button size="sm"  onClick={() => setEditPl(pl)}>
                    编辑批次
                  </Button>
                  <Button variant="danger" size="sm"
                    
                    onClick={async () => {
                      if (!confirm(`删除装箱单 ${pl.plNo}？`)) return
                      try {
                        await window.api.pl.remove(order.id, pl.id)
                        await onChange()
                      } catch (e) {
                        toast((e as Error).message, 'error')
                      }
                    }}
                  >
                    删除
                  </Button>
                </>
              )}
            </div>
            <div className="faint" style={{ fontSize: 12, padding: '0 0 6px' }}>
              {[
                pl.vessel && `船名航次 ${pl.vessel}`,
                pl.etdDate && `ETD ${pl.etdDate}`,
                pl.atdDate && `实际开船 ${pl.atdDate}`,
                pl.etaDate && `ETA ${pl.etaDate}`,
                pl.sealNo && `封条 ${pl.sealNo}`,
                pl.blNo && `提单 ${pl.blNo}`,
                pl.note
              ]
                .filter(Boolean)
                .join(' · ') || '船期未填，点「编辑批次」补录'}
            </div>
            {/* 作废 = 只读留档：明细不再可改，要接着发先「撤销作废」 */}
            <div className="table-wrap" style={pl.voidedAt ? { opacity: 0.6 } : undefined}>
              <table className="data">
                <thead>
                  <tr>
                    <th>箱号</th>
                    <th>款号</th>
                    <th>品名</th>
                    <th>颜色</th>
                    <th>尺码</th>
                    <th className="num">数量</th>
                    <th className="num">净重kg</th>
                    <th className="num">毛重kg</th>
                    <th>箱规cm</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pl.lines.map((l: any) => (
                    <tr key={l.id}>
                      <td>
                        <input
                          className="col-num-sm"
                          defaultValue={l.boxNo}
                          onBlur={async (e) => {
                            const input = e.target
                            await saveLine(pl.id, l.id, { boxNo: input.value }, () => {
                              input.value = String(l.boxNo ?? '')
                            })
                          }}
                        />
                      </td>
                      <td className="mono">{l.styleNo}</td>
                      <td>{l.productName}</td>
                      <td>{l.color}</td>
                      <td>{l.size}</td>
                      <td className="num">
                        <input
                          type="number"
                          className="col-num-sm"
                          defaultValue={l.quantity}
                          onBlur={async (e) => {
                            const input = e.target
                            const v = Number(input.value)
                            if (!(v > 0)) {
                              toast('箱内件数必须大于 0', 'error')
                              input.value = String(l.quantity)
                              return
                            }
                            if (v === l.quantity) return
                            // 超装会被后端拦下：把输入框还原成库里的数，别让人以为已经改成功
                            await saveLine(pl.id, l.id, { quantity: v }, () => {
                              input.value = String(l.quantity)
                            })
                          }}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          className="col-num-sm"
                          defaultValue={l.netWeight ?? ''}
                          onBlur={async (e) => {
                            const input = e.target
                            const v = input.value === '' ? null : Number(input.value)
                            await saveLine(pl.id, l.id, { netWeight: v }, () => {
                              input.value = l.netWeight == null ? '' : String(l.netWeight)
                            })
                          }}
                        />
                      </td>
                      <td className="num">
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <input
                            type="number"
                            step="0.01"
                            className="col-num-sm"
                            title="报关/订舱请填实测毛重；留空按净重×系数估算（纸上标 est.）"
                            defaultValue={l.grossWeight ?? ''}
                            placeholder="按净重估"
                            onBlur={async (e) => {
                              const input = e.target
                              const v = input.value === '' ? null : Number(input.value)
                              // 只有真的改过才提交：毛重的「估 / 实测」身份在库里就定死了，
                              // 点进去又原样退出来不能算「这箱我过磅了」，否则估算值会被洗成实测值
                              const unchanged =
                                (v == null && l.grossWeight == null) ||
                                (v != null && l.grossWeight != null && Number(v) === Number(l.grossWeight))
                              if (unchanged) return
                              await saveLine(pl.id, l.id, { grossWeight: v }, () => {
                                input.value = l.grossWeight == null ? '' : String(l.grossWeight)
                              })
                            }}
                          />
                          {isGrossEstimated(l, grossFactor) ? (
                            <span className="faint" style={{ fontSize: 11 }} title="这箱毛重是净重×系数估的，没过磅">
                              估
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 3 }}>
                          {(['boxLength', 'boxWidth', 'boxHeight'] as const).map((k) => (
                            <input
                              key={k}
                              type="number"
                              className="cell-input-sm"
                              defaultValue={l[k] ?? ''}
                              onBlur={async (e) => {
                                const input = e.target
                                const v = input.value === '' ? null : Number(input.value)
                                await saveLine(pl.id, l.id, { [k]: v }, () => {
                                  input.value = l[k] == null ? '' : String(l[k])
                                })
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="right">
                        <Button variant="danger" size="sm"
                          
                          onClick={async () => {
                            await removeLine(pl.id, l.id)
                          }}
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <BatchTotals pl={pl} factor={grossFactor} />
                </tfoot>
              </table>
            </div>
          </div>
        ))
      )}

      {addBoxPl ? (
        <AddBoxModal
          order={order}
          pl={addBoxPl}
          onClose={() => setAddBoxPl(null)}
          onDone={async () => {
            setAddBoxPl(null)
            await onChange()
          }}
        />
      ) : null}

      {showCreate ? (
        <CreatePlModal
          order={order}
          onClose={() => setShowCreate(false)}
          onDone={async () => {
            setShowCreate(false)
            await onChange()
          }}
        />
      ) : null}

      {editPl ? (
        <EditBatchModal
          order={order}
          pl={editPl}
          onClose={() => setEditPl(null)}
          onDone={async () => {
            setEditPl(null)
            await onChange()
          }}
        />
      ) : null}
    </>
  )
}

/** 装柜现场补一箱：在这张批次里加一行，箱规与单位净重自动跟着同批同款的老箱走 */
function AddBoxModal({
  order,
  pl,
  onClose,
  onDone
}: {
  order: any
  pl: any
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const toast = useToast()
  // 只能补这一批已经装过的款：新的一款属于下一批，走「新建装箱单」，免得批次之间串货
  const skus = useMemo(() => {
    const map = new Map<string, { key: string; styleNo: string; productName: string; color: string; size: string }>()
    for (const l of pl.lines ?? []) {
      const key = [l.styleNo, l.color, l.size].join('|')
      if (!map.has(key)) {
        map.set(key, {
          key,
          styleNo: String(l.styleNo ?? ''),
          productName: String(l.productName ?? ''),
          color: String(l.color ?? ''),
          size: String(l.size ?? '')
        })
      }
    }
    return [...map.values()]
  }, [pl])
  const [form, setForm] = useState({ key: skus[0]?.key ?? '', quantity: '', boxNo: `NO.${maxBoxSeq(order) + 1}` })

  const save = async () => {
    const sku = skus.find((s) => s.key === form.key)
    if (!sku) {
      toast('先选要补哪一款', 'error')
      return
    }
    const qty = Number(form.quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      toast('这一箱的件数要填 1 件以上的整数——半件在箱单和报关上都说不清', 'error')
      return
    }
    try {
      await window.api.pl.addLine(order.id, pl.id, {
        boxNo: form.boxNo.trim(),
        styleNo: sku.styleNo,
        productName: sku.productName,
        color: sku.color,
        size: sku.size,
        quantity: qty
      })
      toast(`已加一箱 ${sku.styleNo} ${sku.color}/${sku.size} × ${qty}`)
      await onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal
      title={`在 ${pl.plNo} 里加一箱`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save}>
            加这一箱
          </Button>
        </>
      }
    >
      <div className="field">
        <label>补哪一款（只在这批已装过的款里选）</label>
        <select value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
          {skus.map((s) => (
            <option key={s.key} value={s.key}>
              {`${s.styleNo} ${s.color}/${s.size}`}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>这一箱件数</label>
        <input
          type="number"
          value={form.quantity}
          placeholder="装柜多出来的也按整件填"
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
      </div>
      <div className="field">
        <label>箱号</label>
        <input value={form.boxNo} onChange={(e) => setForm({ ...form, boxNo: e.target.value })} />
      </div>
      <div className="hint">
        净重按这一批同款箱的单件净重自动带上，箱规照抄，加完在明细里还能改。已经出运的批次箱明细锁着，加不进去——先把这批的状态改回「已包装」。
      </div>
    </Modal>
  )
}

/** 批次信息：柜号、船期、封条、提单号与出运状态 */
function EditBatchModal({
  order,
  pl,
  onClose,
  onDone
}: {
  order: any
  pl: any
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const toast = useToast()
  // 升级前的老批次状态是空的：默认保持空，只补柜号/船期不会把整单状态从手工切到批次汇总
  const isLegacy = pl.shipStatus == null
  const [form, setForm] = useState({
    containerNo: String(pl.containerNo ?? ''),
    vessel: String(pl.vessel ?? ''),
    etdDate: String(pl.etdDate ?? ''),
    atdDate: String(pl.atdDate ?? ''),
    etaDate: String(pl.etaDate ?? ''),
    sealNo: String(pl.sealNo ?? ''),
    blNo: String(pl.blNo ?? ''),
    note: String(pl.note ?? ''),
    shipStatus: (pl.shipStatus ?? '') as ShipStatus | '',
    receivedQty: pl.receivedQty == null ? '' : String(pl.receivedQty),
    docDate: String(pl.docDate ?? ''),
    deliveredDate: String(pl.deliveredAt ?? '')
  })

  const save = async () => {
    try {
      await window.api.pl.updateInfo(order.id, pl.id, {
        containerNo: form.containerNo,
        vessel: form.vessel,
        etdDate: form.etdDate || null,
        atdDate: form.atdDate || null,
        etaDate: form.etaDate || null,
        sealNo: form.sealNo,
        blNo: form.blNo,
        note: form.note,
        shipStatus: form.shipStatus || undefined,
        receivedQty: form.receivedQty === '' ? null : Number(form.receivedQty),
        docDate: form.docDate || null,
        deliveredDate: form.deliveredDate || null
      })
      toast('批次信息已保存')
      await onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal
      title={`批次 ${pl.plNo}`}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save}>
            保存批次
          </Button>
        </>
      }
    >
      <div className="field-row-3">
        <div className="field">
          <label>柜号 / 批次</label>
          <input
            value={form.containerNo}
            onChange={(e) => setForm({ ...form, containerNo: e.target.value })}
            placeholder="订到柜再补也来得及"
          />
        </div>
        <div className="field">
          <label>船名航次</label>
          <input value={form.vessel} onChange={(e) => setForm({ ...form, vessel: e.target.value })} />
        </div>
        <div className="field">
          <label>出运状态</label>
          <select
            value={form.shipStatus}
            onChange={(e) => setForm({ ...form, shipStatus: e.target.value as ShipStatus | '' })}
          >
            {isLegacy && <option value="">未设置（订单继续手工状态）</option>}
            {SHIP_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SHIP_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isLegacy && (
        <div className="hint">
          这是升级前的批次，出运状态还没设置。只补柜号/船期不会动整单状态；选一个状态后，整单出货状态才改由批次汇总。
        </div>
      )}
      <div className="field-row-3">
        <div className="field">
          <label>ETD（计划开船）</label>
          <input type="date" value={form.etdDate} onChange={(e) => setForm({ ...form, etdDate: e.target.value })} />
        </div>
        <div className="field">
          <label>实际开船日</label>
          <input type="date" value={form.atdDate} onChange={(e) => setForm({ ...form, atdDate: e.target.value })} />
        </div>
        <div className="field">
          <label>ETA（预计到港）</label>
          <input type="date" value={form.etaDate} onChange={(e) => setForm({ ...form, etaDate: e.target.value })} />
        </div>
      </div>
      <div className="field-row-3">
        <div className="field">
          <label>实收数量（客户实际收到）</label>
          <input
            type="number"
            value={form.receivedQty}
            placeholder={`留空按发数 ${batchQty(pl)} 件全收`}
            onChange={(e) => setForm({ ...form, receivedQty: e.target.value })}
          />
        </div>
        <div className="field">
          <label>单据日期（纸面 Date）</label>
          <input type="date" value={form.docDate} onChange={(e) => setForm({ ...form, docDate: e.target.value })} />
        </div>
        <div className="field">
          <label>签收日期</label>
          <input
            type="date"
            value={form.deliveredDate}
            disabled={form.shipStatus !== 'delivered'}
            onChange={(e) => setForm({ ...form, deliveredDate: e.target.value })}
          />
        </div>
      </div>
      <div className="hint">
        实收留空等于按发数全收；短卸、破损扣款就填客户实际收到的件数，差异会标在批次上。
        单据日期空则用建单当天——箱单日期要落在出运前后、不晚于提单日。签收日期可以补录客户实际签收那天，不必记成今天。
      </div>
      <div className="field-row-3">
        <div className="field">
          <label>封条号</label>
          <input value={form.sealNo} onChange={(e) => setForm({ ...form, sealNo: e.target.value })} />
        </div>
        <div className="field">
          <label>提单号</label>
          <input value={form.blNo} onChange={(e) => setForm({ ...form, blNo: e.target.value })} />
        </div>
        <div className="field">
          <label>备注</label>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
      </div>
      <div className="hint">
        出运状态会汇总到订单（分批发时显示「部分出运」）。改成「已包装」后这个批次才能删除——出运过的批次必须留档。
      </div>
    </Modal>
  )
}

/** 装箱 SKU 的唯一键：款号×颜色×尺码（品名不参与归组） */
function skuKey(s: { styleNo?: string; color?: string; size?: string }): string {
  return [s.styleNo ?? '', s.color ?? '', s.size ?? ''].join('|')
}

function CreatePlModal({
  order,
  onClose,
  onDone
}: {
  order: any
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const toast = useToast()
  const [skus, setSkus] = useState<any[]>([])
  const [containerNo, setContainerNo] = useState('')
  const [note, setNote] = useState('')
  const [boxes, setBoxes] = useState<any[]>([])
  const [perBox, setPerBox] = useState('40')
  const [unitNet, setUnitNet] = useState('')
  const [boxSize, setBoxSize] = useState({ l: '', w: '', h: '' })
  // 按款号的箱规：款号 → { pieces, unitNet, l, w, h }
  const [styleCfg, setStyleCfg] = useState<Record<string, any>>({})
  // 本次出货数量：默认 = 订单数量 − 已经装箱的数量（分批出货只装剩下的）
  const [shipQty, setShipQty] = useState<Record<string, string>>({})
  // 数量改过之后旧预览就作废了，空状态要提示「重新生成」而不是「还没设置每箱件数」
  const [previewStale, setPreviewStale] = useState(false)

  useEffect(() => {
    void window.api.orders.summarizeSkus(order.id).then((rows: any[]) => {
      setSkus(rows)
      setShipQty(Object.fromEntries(rows.map((s) => [skuKey(s), String(s.remainingQuantity)])))
    })
  }, [order.id])

  /** 按商品库里的单件净重/每箱件数/箱规套用 */
  const applyFromLibrary = async () => {
    const products = await window.api.products.list('')
    const next: Record<string, any> = {}
    for (const s of skus) {
      const p = products.find((x: any) => x.styleNo === s.styleNo)
      if (!p) continue
      next[s.styleNo] = {
        pieces: p.boxPieces != null ? String(p.boxPieces) : '',
        unitNet: p.unitNetWeight != null ? String(p.unitNetWeight) : '',
        l: p.boxLength != null ? String(p.boxLength) : '',
        w: p.boxWidth != null ? String(p.boxWidth) : '',
        h: p.boxHeight != null ? String(p.boxHeight) : ''
      }
    }
    setStyleCfg(next)
    toast('已按商品库里的单件净重和箱规套用')
  }

  const cfgFor = (styleNo: string) => styleCfg[styleNo] ?? {}

  /** 按每箱件数把 SKU 拆成箱，净重按 单件净重 × 件数 自动算 */
  const build = () => {
    const g = Math.max(1, Math.floor(Number(perBox) || 1))
    const out: any[] = []
    // 箱号接着这张单已有的批次排，不每批都从 NO.1 重来
    let boxNo = maxBoxSeq(order) + 1
    for (const s of skus) {
      const qty = Math.floor(Number(shipQty[skuKey(s)] ?? s.remainingQuantity))
      if (!(qty > 0)) continue
      if (qty > s.remainingQuantity) {
        toast(
          `款号 ${s.styleNo} ${s.color}/${s.size} 只剩 ${s.remainingQuantity} 件没装箱，本次不能装 ${qty} 件`,
          'error'
        )
        return
      }
      const cfg = cfgFor(s.styleNo)
      const n = Math.max(1, Math.floor(Number(cfg.pieces) || g))
      const unit = Number(cfg.unitNet ?? unitNet)
      const l = Number(cfg.l || boxSize.l) || null
      const w = Number(cfg.w || boxSize.w) || null
      const h = Number(cfg.h || boxSize.h) || null
      let remain = qty
      while (remain > 0) {
        const q = Math.min(n, remain)
        out.push({
          boxNo: `NO.${boxNo}`,
          styleNo: s.styleNo,
          productName: s.productName,
          color: s.color,
          size: s.size,
          quantity: q,
          netWeight: unit > 0 ? Number((unit * q).toFixed(2)) : null,
          boxLength: l,
          boxWidth: w,
          boxHeight: h
        })
        remain -= q
        boxNo += 1
      }
    }
    if (out.length === 0) {
      toast('每款的「本次出货」都是 0，没有可装箱的件数', 'error')
      return
    }
    setBoxes(out)
    setPreviewStale(false)
  }

  const submit = async () => {
    if (boxes.length === 0) {
      toast('请先生成箱明细', 'error')
      return
    }
    try {
      await window.api.pl.create({ orderId: order.id, containerNo, note, lines: boxes })
      toast('装箱单已生成')
      await onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal
      title="新建装箱单"
      onClose={onClose}
      size="xwide"
      footer={
        <>
          <Button  onClick={onClose}>
            取消
          </Button>
          <Button  onClick={build}>
            重新生成箱明细
          </Button>
          <Button variant="primary"  onClick={submit}>
            生成装箱单
          </Button>
        </>
      }
    >
      {order.packingLists?.some((p: any) => p.shipStatus == null) && (
        <div className="hint mb">
          这张单还有升级前的老批次没标出运状态。新建批次后整单仍按手工状态推进；建议先到「装箱单」里给老批次补上状态，整单才会改由批次汇总。
        </div>
      )}
      <div className="field-row-3">
        <div className="field">
          <label>柜号 / 批次</label>
          <input value={containerNo} onChange={(e) => setContainerNo(e.target.value)} placeholder="如 MSKU1234567" />
        </div>
        <div className="field">
          <label>默认每箱件数</label>
          <input type="number" value={perBox} onChange={(e) => setPerBox(e.target.value)} />
        </div>
        <div className="field">
          <label>默认单件净重（kg）</label>
          <input
            type="number"
            step="0.001"
            value={unitNet}
            onChange={(e) => setUnitNet(e.target.value)}
            placeholder="填了就按 件数×单件净重 自动算每箱净重"
          />
        </div>
      </div>

      <div className="field">
        <label>默认箱规（长×宽×高 cm）</label>
        <div className="row" style={{ gap: 4 }}>
          {(['l', 'w', 'h'] as const).map((k) => (
            <input
              key={k}
              type="number"
              placeholder={k}
              value={boxSize[k]}
              onChange={(e) => setBoxSize({ ...boxSize, [k]: e.target.value })}
            />
          ))}
        </div>
      </div>

      <div className="row sec-head">
        <strong className="sec-head">按款号设箱规（不同款号箱规不一样时用）</strong>
        <div className="spacer" />
        <Button size="sm"  onClick={applyFromLibrary}>
          按商品库套用
        </Button>
      </div>
      <div className="table-wrap" style={{ maxHeight: 160, overflowY: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>款号</th>
              <th className="num">每箱件数</th>
              <th className="num">单件净重kg</th>
              <th>箱规cm</th>
            </tr>
          </thead>
          <tbody>
            {skus.map((s) => {
              const cfg = cfgFor(s.styleNo)
              return (
                <tr key={s.styleNo}>
                  <td className="mono">{s.styleNo}</td>
                  <td className="num">
                    <input
                      type="number"
                      className="col-num-sm"
                      value={cfg.pieces ?? ''}
                      onChange={(e) =>
                        setStyleCfg({ ...styleCfg, [s.styleNo]: { ...cfg, pieces: e.target.value } })
                      }
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.001"
                      className="col-num-sm"
                      value={cfg.unitNet ?? ''}
                      onChange={(e) =>
                        setStyleCfg({ ...styleCfg, [s.styleNo]: { ...cfg, unitNet: e.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 3 }}>
                      {(['l', 'w', 'h'] as const).map((k) => (
                        <input
                          key={k}
                          type="number"
                          className="cell-input-sm"
                          value={cfg[k] ?? ''}
                          onChange={(e) =>
                            setStyleCfg({ ...styleCfg, [s.styleNo]: { ...cfg, [k]: e.target.value } })
                          }
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="field">
        <label>备注</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <h3 style={{ fontSize: 13, margin: '10px 0 6px' }}>SKU 汇总</h3>
      <div className="hint" style={{ marginBottom: 6 }}>
        分批发货的话，这里默认填的是「还没装过箱」的数量；已经装过的会自动扣掉。
      </div>
      <div className="table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>款号</th>
              <th>品名</th>
              <th>颜色</th>
              <th>尺码</th>
              <th className="num">订单数量</th>
              <th className="num">已装箱</th>
              <th className="num">本次出货</th>
            </tr>
          </thead>
          <tbody>
            {skus.map((s) => {
              const key = skuKey(s)
              return (
                <tr key={key}>
                  <td className="mono">{s.styleNo}</td>
                  <td>{s.productName}</td>
                  <td>{s.color}</td>
                  <td>{s.size}</td>
                  <td className="num">{num(s.quantity)}</td>
                  <td className="num faint">{num(s.packedQuantity)}</td>
                  <td className="num">
                    <input
                      type="number"
                      min={0}
                      max={s.remainingQuantity}
                      className="col-num-sm"
                      disabled={s.remainingQuantity === 0}
                      title={s.remainingQuantity === 0 ? '这一款已经全部装过箱了' : undefined}
                      value={shipQty[key] ?? ''}
                      onChange={(e) => {
                        setShipQty({ ...shipQty, [key]: e.target.value })
                        // 数量一改，旧预览就作废了，必须重新生成
                        setBoxes([])
                        setPreviewStale(true)
                      }}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 13, margin: '12px 0 6px' }}>
        箱明细预览（{boxes.length} 箱）
      </h3>
      {boxes.length === 0 ? (
        <div className="hint">
          {previewStale ? '本次出货已改，点「重新生成箱明细」看新的箱数。' : '设置每箱件数后点「重新生成箱明细」'}
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>箱号</th>
                <th>款号</th>
                <th>颜色</th>
                <th>尺码</th>
                <th className="num">数量</th>
                <th className="num">净重kg</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b, i) => (
                <tr key={`${b.boxNo}-${b.styleNo}-${b.color}-${b.size}-${i}`}>
                  <td>{b.boxNo}</td>
                  <td className="mono">{b.styleNo}</td>
                  <td>{b.color}</td>
                  <td>{b.size}</td>
                  <td className="num">{b.quantity}</td>
                  <td className="num">{b.netWeight ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/* ================= 时间线 ================= */

/** 没写 note 的历史也要说人话，不能把 payment_status 这种内部字段名摆给业务看 */
const EVENT_KIND_LABEL: Record<string, string> = {
  create: '创建订单',
  update: '修改订单',
  party_update: '修改抬头',
  item_add: '添加明细',
  item_update: '修改明细',
  item_replace: '替换明细',
  payment: '记录收款',
  payment_delete: '删除收款',
  payment_status: '收款状态变更',
  status_auto: '收款状态自动流转',
  ship_status: '出货状态变更',
  void: '作废订单',
  photo: '照片变动',
  pl_create: '新建装箱单',
  pl_delete: '删除装箱单',
  pl_line_update: '修改箱明细',
  pl_unvoid: '撤销作废批次',
  settlement: '核销',
  settlement_reverse: '撤销核销'
}

/** 状态值按事件类型翻译：收款事件印中文收款状态，出货事件印中文出货状态 */
function statusText(kind: string, v: string | null): string {
  if (!v) return '—'
  const table = kind === 'ship_status' || kind === 'pl_unvoid' ? SHIP_STATUS_LABEL : PAYMENT_STATUS_LABEL
  return (table as Record<string, string>)[v] ?? v
}

function TimelineTab({ events, docVersions }: { events: any[]; docVersions: any[] }) {
  const toast = useToast()
  return (
    <div className="card-body">
      {docVersions.length ? (
        <>
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
                {docVersions.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.docNo}</td>
                    <td>第 {d.version} 版</td>
                    <td className="num">{d.amount.toFixed(2)}</td>
                    <td className="faint nowrap">{fmtDateTime(d.createdAt)}</td>
                    <td className="right nowrap">
                      <Button variant="ghost" size="sm"
                        
                        onClick={async () => {
                          // N34：每一版直接打开看，不用去文件夹里认文件名
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
                          // 打开这一版所在的文件夹（不是整个 docs 根目录）
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
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {events.length === 0 ? (
        <Empty text="还没有操作记录。这张单从创建到现在的每一步都会记在这里。" />
      ) : (
        <div className="timeline">
          {events.map((e) => (
            <div key={e.id} className="timeline-item">
              <span className="timeline-dot" />
              <div className="timeline-main">
                <div>
                  {e.note || EVENT_KIND_LABEL[e.kind] || e.kind}
                  {e.actor ? <span className="faint"> · {e.actor}</span> : null}
                </div>
                {e.fromStatus || e.toStatus ? (
                  <div className="timeline-time">
                    {statusText(e.kind, e.fromStatus)} → {statusText(e.kind, e.toStatus)}
                  </div>
                ) : null}
              </div>
              <div className="timeline-time">{fmtDateTime(e.at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ================= 验货 / 装柜照 ================= */

function PhotosTab({ order, onChange }: { order: any; onChange: () => Promise<void> }) {
  const toast = useToast()
  const [photos, setPhotos] = useState<any[]>([])
  const [kind, setKind] = useState<'inspection' | 'container'>('inspection')
  const [loadError, setLoadError] = useState('')

  const load = async () => {
    try {
      setPhotos(await window.api.orders.photos(order.id))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '照片没加载出来')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id])

  const upload = async () => {
    try {
      const files = await window.api.images.pick()
      if (files.length === 0) return
      for (const f of files) await window.api.orders.addPhoto(order.id, f, kind, '')
      toast(`已上传 ${files.length} 张`)
      await load()
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="card-body">
      <div className="row mb">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'inspection' | 'container')} className="col-tag">
          <option value="inspection">验货照</option>
          <option value="container">柜照</option>
        </select>
        <Button variant="primary"  onClick={upload}>
          上传照片
        </Button>
        <div className="spacer" />
        {/* R4-P9：正文里不出现仓库路径（data/images/），
            换成对业务员有用的一句话 */}
        <span className="faint">照片存在本机，跟单走，客户要的时候直接发</span>
      </div>

      {loadError ? (
        <LoadError what="验货 / 装柜照" message={loadError} onRetry={() => void load()} />
      ) : photos.length === 0 ? (
        <Empty text="还没有照片。验货时拍的几张传上来，客户要的时候直接发。" />
      ) : (
        <div className="photo-grid">
          {photos.map((p) => (
            <div key={p.id} className="photo-cell">
              <img src={imageUrl(p.fileName)} alt={p.note || p.kind} />
              <div className="photo-foot">
                <span className="faint">{p.kind === 'container' ? '柜照' : '验货照'}</span>
                <Button variant="danger" size="sm"
                  
                  onClick={async () => {
                    if (!confirm('删除这张照片？')) return
                    try {
                      await window.api.orders.delPhoto(order.id, p.id)
                      await load()
                    } catch (e) {
                      toast((e as Error).message, 'error')
                    }
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
