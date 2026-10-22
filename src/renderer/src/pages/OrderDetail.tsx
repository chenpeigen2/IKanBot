import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Modal, useToast, money, num, fmtDate, fmtDateTime, Empty, Menu,
  Button, PaymentTag, ShipTag
} from '../ui'
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  SHIP_STATUS_LABEL,
  PAYMENT_STATUS_ORDER,
  SHIP_STATUS_ORDER,
  type PaymentStatus,
  type ShipStatus,
  type PaymentMethod
} from '../../../shared/types'
import { renderPi, renderPl, renderCi, orderDocAmount, ciDocAmount, type ImageMap } from '../../../shared/documents'
import { imageUrl } from '../imageUrl'
import EditOrderModal from './EditOrderModal'

type PreviewState = {
  kind: 'pi' | 'pl' | 'ci'
  plId?: number
  html: string
  docNo: string
  amount: number
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
  const [showCi, setShowCi] = useState(false)
  const [editCharges, setEditCharges] = useState(false)
  // R1-④：状态只有一种形态（tag）。点「改状态」才临时变成下拉框，改完回到 tag
  const [editPayment, setEditPayment] = useState(false)
  const [editShip, setEditShip] = useState(false)
  const [docVersions, setDocVersions] = useState<any[]>([])

  const load = async () => {
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
      title: `PI ${order.piNo}`,
      render
    })
  }

  const openPl = async (plId: number) => {
    const pl = order.packingLists.find((p: any) => p.id === plId)
    if (!pl) return
    const images = await buildImages()
    const rev = await window.api.docs.nextVersion(pl.plNo, 'pl')
    const render = (pending: boolean) => renderPl({ order, settings, images, rev, pending }, pl)
    setPreview({
      kind: 'pl',
      plId,
      html: render(true),
      docNo: pl.plNo,
      // 存档金额统一用含费用合计（PI / PL 同一个函数：shared/documents.ts orderDocAmount）
      amount: orderDocAmount(order),
      title: `PL ${pl.plNo}`,
      render
    })
  }

  const openCi = async (charges: { label: string; amount: number }[]) => {
    const images = await buildImages()
    const ciNo = order.piNo.replace(/^PI/, 'CI')
    const rev = await window.api.docs.nextVersion(ciNo, 'ci')
    // 存档金额唯一入口：货值 + 纸上印的费用行（默认费用 = 订单费用 → 与 PI 同一个数）
    const amount = ciDocAmount(order, charges)
    const render = (pending: boolean) => renderCi({ order, settings, images, rev, pending }, { charges })
    setPreview({
      kind: 'ci',
      html: render(true),
      docNo: ciNo,
      amount,
      title: `CI ${ciNo}`,
      render
    })
    setShowCi(false)
  }

  /** 另存为（自己选地方） */
  const savePdf = async () => {
    if (!preview) return
    try {
      const out = await window.api.window.printPdf({ html: preview.html, fileName: `${preview.docNo}.pdf` })
      if (out) toast('PDF 已保存')
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
        amount: preview.amount
      })
      toast(`已存档到系统：${r.path}（第 ${r.version} 版）`)
      // 存完屏幕上的纸也换成正式版本号，跟存档表一个号（N39）
      setPreview({ ...preview, html: savedHtml })
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

  if (!order) return <div className="content">加载中…</div>

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
              <Button size="sm"  onClick={() => setShowEdit(true)}>
                编辑
              </Button>
            </div>
            <div className="card-body">
              <div className="kv-grid">
                <div>
                  <span className="k">客户</span>
                  <span className="v">{order.customer?.company}</span>
                </div>
                <div>
                  <span className="k">联系人</span>
                  <span className="v">{order.customer?.attn || order.customer?.contact || '—'}</span>
                </div>
                <div>
                  <span className="k">地址</span>
                  <span className="v">
                    {order.customer?.address} {order.customer?.zipCode} {order.customer?.country}
                  </span>
                </div>
                <div>
                  <span className="k">客户 PO</span>
                  <span className="v">{order.customerPo || '—'}</span>
                </div>
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
                {order.customer?.paymentPref ? (
                  <div>
                    <span className="k">客户付款条款</span>
                    <span className="v">{order.customer.paymentPref}</span>
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
              <span className="faint">收款状态可手动改，出货状态独立推进</span>
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
                {editShip ? (
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
              <PackingTab order={order} onChange={load} onPreview={openPl} />
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
              <Button  onClick={savePdf}>
                另存为 PDF
              </Button>
              <Button variant="primary"  onClick={saveToSystem}>
                存到系统
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
  const [charges, setCharges] = useState<{ label: string; amount: number }[]>(
    (order.charges ?? []).map((c: any) => ({ label: String(c.label), amount: Number(c.amount) || 0 }))
  )
  const total = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)

  const save = async () => {
    try {
      await window.api.orders.updateCharges(
        order.id,
        charges.filter((c) => c.label.trim())
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
        <Button size="sm"  onClick={() => setCharges((cs) => [...cs, { label: '运费 Freight', amount: 0 }])}>
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
              charges.map((c, i) => (
                <tr key={i}>
                  <td>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        setCharges((cs) => cs.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
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
                          cs.map((x, k) => (k === i ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={() => setCharges((cs) => cs.filter((_, k) => k !== i))}
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
  const [charges, setCharges] = useState<{ label: string; amount: number }[]>(
    (order.charges ?? []).map((c: any) => ({ label: String(c.label), amount: Number(c.amount) || 0 }))
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
          
          onClick={() => setCharges((cs) => [...cs, { label: '运费 Freight', amount: 0 }])}
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
              {charges.map((c, i) => (
                <tr key={i}>
                  <td>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        setCharges((cs) => cs.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
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
                          cs.map((x, k) => (k === i ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={() => setCharges((cs) => cs.filter((_, k) => k !== i))}
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
                <th className="num" title="没录就填这里">
                  成本
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
                        await window.api.orders.updateItem(order.id, it.id, { color: v })
                        await refresh()
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
                        await window.api.orders.updateItem(order.id, it.id, { size: v })
                        await refresh()
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
                        const v = Number(e.target.value)
                        if (v === it.quantity) return
                        await window.api.orders.updateItem(order.id, it.id, { quantity: v })
                        await refresh()
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
                        const v = Number(e.target.value)
                        if (v === it.unitPrice) return
                        await window.api.orders.updateItem(order.id, it.id, { unitPrice: v })
                        await refresh()
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
                        await window.api.orders.updateItem(order.id, it.id, { unitCost: v })
                        toast(v == null ? '已清空这行的成本（毛利变成不可信）' : '成本已录入')
                        await refresh()
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
                        await window.api.orders.removeItem(order.id, it.id)
                        toast('已删除，操作历史里已留痕')
                        await refresh()
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
    setPrice(p.costPrice != null ? String(p.costPrice) : '')
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

  const submit = async () => {
    if (!picked) return
    const items = rows
      .filter((r) => (grid[r.key] ?? '').trim() !== '' && Number(grid[r.key]) > 0)
      .map((r) => ({
        productId: picked.id,
        styleNo: picked.styleNo,
        productName: picked.name,
        composition: picked.composition,
        color: r.color,
        size: r.size,
        quantity: Number(grid[r.key]),
        unitPrice: colorPrice[r.color] ? Number(colorPrice[r.color]) : Number(price) || 0,
        unitCost: picked.costPrice
      }))
    if (items.length === 0) {
      toast('请至少填写一个 SKU 的数量', 'error')
      return
    }
    try {
      await window.api.orders.addItem(order.id, items[0])
      for (const it of items.slice(1)) await window.api.orders.addItem(order.id, it)
      toast(`已添加 ${items.length} 个 SKU`)
      await onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
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
          <Button variant="primary"  onClick={submit}>
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
              <span className="muted">成本价</span>
              <span>{picked.costPrice == null ? '未设置' : picked.costPrice}</span>
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
    paidAt: new Date().toISOString().slice(0, 10),
    amount: '',
    method: 'T/T',
    bankRef: '',
    note: ''
  })

  const add = async () => {
    const amt = Number(form.amount)
    if (!amt || amt <= 0) {
      toast('请填写收款金额', 'error')
      return
    }
    try {
      await window.api.orders.addPayment(order.id, { ...form, amount: amt })
      toast('已记录收款')
      setForm({ ...form, amount: '', bankRef: '', note: '' })
      await onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <>
      <div className="card-body">
        <div className="price-calc mb">
          <div>
            <span className="muted">订单总额</span>
            <span>{money(order.totalAmount, order.currency)}</span>
          </div>
          <div>
            <span className="muted">定金（{Math.round(order.depositRatio * 100)}%）</span>
            <span>{money(order.depositAmount, order.currency)}</span>
          </div>
          <div>
            <span className="muted">已收</span>
            <span>{money(order.paidAmount, order.currency)}</span>
          </div>
          <div className="total">
            <span>待收</span>
            <span>{money(order.remaining, order.currency)}</span>
          </div>
        </div>

        <div className="field-row-3">
          <div className="field">
            <label>收款日期</label>
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
        <Button variant="primary"  onClick={add}>
          记录收款
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
                      
                      onClick={async () => {
                        if (!confirm('删除这条收款记录？')) return
                        await window.api.orders.deletePayment(order.id, p.id)
                        await onChange()
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
    </>
  )
}

/* ================= 装箱单 ================= */

function PackingTab({
  order,
  onChange,
  onPreview
}: {
  order: any
  onChange: () => Promise<void>
  onPreview: (plId: number) => void
}) {
  const [showCreate, setShowCreate] = useState(false)

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
              {pl.containerNo ? <span className="tag blue">柜号 {pl.containerNo}</span> : null}
              <span className="faint">{pl.lines.length} 箱</span>
              <div className="spacer" />
              <Button size="sm"  onClick={() => onPreview(pl.id)}>
                预览
              </Button>
              <Button variant="danger" size="sm"
                
                onClick={async () => {
                  if (!confirm(`删除装箱单 ${pl.plNo}？`)) return
                  await window.api.pl.remove(order.id, pl.id)
                  await onChange()
                }}
              >
                删除
              </Button>
            </div>
            <div className="table-wrap">
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
                            await window.api.pl.updateLine(order.id, pl.id, l.id, { boxNo: e.target.value })
                            await onChange()
                          }}
                        />
                      </td>
                      <td className="mono">{l.styleNo}</td>
                      <td>{l.productName}</td>
                      <td>{l.color}</td>
                      <td>{l.size}</td>
                      <td className="num">{num(l.quantity)}</td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          className="col-num-sm"
                          defaultValue={l.netWeight ?? ''}
                          onBlur={async (e) => {
                            const v = e.target.value === '' ? null : Number(e.target.value)
                            await window.api.pl.updateLine(order.id, pl.id, l.id, { netWeight: v })
                            await onChange()
                          }}
                        />
                      </td>
                      <td className="num faint">{l.grossWeight == null ? '—' : l.grossWeight.toFixed(2)}</td>
                      <td>
                        <div className="row" style={{ gap: 3 }}>
                          {(['boxLength', 'boxWidth', 'boxHeight'] as const).map((k) => (
                            <input
                              key={k}
                              type="number"
                              className="cell-input-sm"
                              defaultValue={l[k] ?? ''}
                              onBlur={async (e) => {
                                const v = e.target.value === '' ? null : Number(e.target.value)
                                await window.api.pl.updateLine(order.id, pl.id, l.id, { [k]: v })
                                await onChange()
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="right">
                        <Button variant="danger" size="sm"
                          
                          onClick={async () => {
                            await window.api.pl.deleteLine(order.id, pl.id, l.id)
                            await onChange()
                          }}
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

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
    </>
  )
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

  useEffect(() => {
    void window.api.orders.summarizeSkus(order.id).then(setSkus)
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
    let boxNo = 1
    for (const s of skus) {
      const cfg = cfgFor(s.styleNo)
      const n = Math.max(1, Math.floor(Number(cfg.pieces) || g))
      const unit = Number(cfg.unitNet ?? unitNet)
      const l = Number(cfg.l || boxSize.l) || null
      const w = Number(cfg.w || boxSize.w) || null
      const h = Number(cfg.h || boxSize.h) || null
      let remain = s.quantity
      while (remain > 0) {
        const qty = Math.min(n, remain)
        out.push({
          boxNo: `NO.${boxNo}`,
          styleNo: s.styleNo,
          productName: s.productName,
          color: s.color,
          size: s.size,
          quantity: qty,
          netWeight: unit > 0 ? Number((unit * qty).toFixed(2)) : null,
          boxLength: l,
          boxWidth: w,
          boxHeight: h
        })
        remain -= qty
        boxNo += 1
      }
    }
    setBoxes(out)
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
      <div className="table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>款号</th>
              <th>品名</th>
              <th>颜色</th>
              <th>尺码</th>
              <th className="num">数量</th>
            </tr>
          </thead>
          <tbody>
            {skus.map((s, i) => (
              <tr key={i}>
                <td className="mono">{s.styleNo}</td>
                <td>{s.productName}</td>
                <td>{s.color}</td>
                <td>{s.size}</td>
                <td className="num">{num(s.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 13, margin: '12px 0 6px' }}>
        箱明细预览（{boxes.length} 箱）
      </h3>
      {boxes.length === 0 ? (
        <div className="hint">设置每箱件数后点「重新生成箱明细」</div>
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
                <tr key={i}>
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
                <div>{e.note || e.kind}</div>
                {e.fromStatus || e.toStatus ? (
                  <div className="timeline-time">
                    {e.fromStatus ?? '—'} → {e.toStatus ?? '—'}
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

  const load = async () => {
    setPhotos(await window.api.orders.photos(order.id))
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id])

  const upload = async () => {
    const files = await window.api.images.pick()
    if (files.length === 0) return
    for (const f of files) await window.api.orders.addPhoto(order.id, f, kind, '')
    toast(`已上传 ${files.length} 张`)
    await load()
    await onChange()
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

      {photos.length === 0 ? (
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
                    await window.api.orders.delPhoto(order.id, p.id)
                    await load()
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
