import {
  PAYMENT_METHOD_LABEL,
  SAMPLE_STATUS_LABEL,
  type AppSettings,
  type OrderDetail,
  type PackingList,
  type PackingListLine,
  type PartySnapshot,
  type QuotationCharge,
  type QuotationDetail,
  type SampleOrderDetail
} from './types'
import { localDate } from './date'
import { emptyParty } from './party'

/** 图片文件名的 data URL 映射 */
export type ImageMap = Record<string, string>

export interface DocContext {
  order: OrderDetail
  settings: AppSettings
  images: ImageMap
  /** 单据版本号（打印前从存档里算出来，印在纸面上） */
  rev?: number
  /**
   * 是否「还没存进系统」的预览。
   * N39：没存之前，纸上不许印一个还不存在的版本号——印「待存为第 N 版」；
   * 存档/打印那份 HTML 传 false，才印正式的「Version N / 版本 N」。
   */
  pending?: boolean
}

export interface QuotationDocContext {
  quotation: QuotationDetail
  settings: AppSettings
  images: ImageMap
  /** 单据版本号 */
  rev?: number
  /** 同 DocContext.pending：未存档的预览印「待存为第 N 版」（N39） */
  pending?: boolean
}

/** ISO 时间戳 → 本地日期 YYYY-MM-DD（单据上的日期一律本地日期，跟单号一致） */
export function localDateOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '').slice(0, 10)
  return localDate(d)
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtMoney(v: number, currency: string): string {
  return `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtQty(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * 抬头（买方 / 收货人 / 进口方）三到四行。
 *
 * 版式一个字没动，只是数据源从「客户档案当前值」换成「这张单子上冻结的快照」：
 * 客户后来搬家、改名、换付款条件，已经发出去的 PI / PL / CI 不能跟着重写——
 * 那是报关、退税、催款的凭据。老单子没快照时自动回退档案值，印出来和从前一样。
 */
function partyRows(p: PartySnapshot | null | undefined, withEmail: boolean): string {
  const q = p ?? emptyParty()
  return `<div class="kv"><span class="k">Company</span><span>${esc(q.company)}</span></div>
      <div class="kv"><span class="k">Attn</span><span>${esc(q.attn || q.contact || '—')}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(q.address)}${
        q.zipCode ? `, ${esc(q.zipCode)}` : ''
      }${q.country ? `, ${esc(q.country)}` : ''}</span></div>${
        withEmail && q.email ? `\n      <div class="kv"><span class="k">Email</span><span>${esc(q.email)}</span></div>` : ''
      }`
}

/**
 * N39：纸面版本号必须跟存档对得上。
 * 预览还没点「存到系统」时，纸上不许印一个还不存在的版本号（印「待存为第 N 版」）；
 * 真正存档/打印的那份 HTML（pending=false）才印正式的「Version N / 版本 N」。
 * 抬头的 (Rev. N) 也是「这一版的身份」，没存之前同样不占号。
 */
function revHeadLabel(rev: number, pending: boolean): string {
  if (!rev || pending) return ''
  return ` (Rev. ${rev})`
}

function revFootHtml(rev: number, pending: boolean, dateText: string): string {
  if (!rev) return ''
  const style = 'text-align:right;font-size:8pt;color:#555;margin-top:6px'
  return pending
    ? `<div style="${style}">待存为第 ${rev} 版（点「存到系统」后才作数） / To be saved as Version ${rev}</div>`
    : `<div style="${style}">Version ${rev} / ${esc(dateText)} / 版本 ${rev}</div>`
}

/**
 * 银行账户：只认订单币种。
 * 匹配不到就**不印**——退回「第一个账户」会把 USD 账号印在 EUR 单上，
 * 客户照汇被退回，手续费和到账时间全赔进去，而纸上看着还像是对的。
 */
function bankFor(settings: AppSettings, currency: string) {
  return settings.banks.find((b) => b.currency === currency)
}

/**
 * CI 号由 PI 号派生；没有 PI 前缀就补 CI-，别把整串原样当发票号。
 * 分批出运时带批次后缀：批次号由系统发、不会因为插批/作废而变，
 * 同一个 CI 号下就不会再存两张金额不同的发票。
 */
export function ciNoOf(piNo: string, batchNo?: string): string {
  const raw = String(piNo ?? '').trim()
  const base = !raw ? 'CI' : /^PI/i.test(raw) ? raw.replace(/^PI/i, 'CI') : `CI-${raw}`
  const batch = String(batchNo ?? '').trim()
  return batch ? `${base}-${batch}` : base
}

/**
 * 同一个 CI 号可能重版过好几张（重版不作废旧版），要金额只能取每个号的最新一版。
 * 批次金额那边取的就是 MAX(version)，这里必须同一个口径——
 * 否则出过第二版的批次会在「CI 重叠」确认框里把重叠金额虚报成两倍，人可能据此作废错的那张票。
 */
export function latestAmountPerDocNo(
  rows: { docNo: string; version: number; amount: number }[]
): Map<string, number> {
  const best = new Map<string, { version: number; amount: number }>()
  for (const r of rows) {
    const cur = best.get(r.docNo)
    const version = Number(r.version) || 0
    if (!cur || version >= cur.version) best.set(r.docNo, { version, amount: Number(r.amount) || 0 })
  }
  return new Map([...best].map(([docNo, v]) => [docNo, v.amount]))
}

/** 一张装箱单的纸面日期：补录过就用补录的，否则用建单当天（本地日） */
export function plDocDateOf(pl: PackingList): string {
  return pl.docDate || localDateOf(pl.createdAt)
}

/**
 * CI 的纸面日期：跟最近一张未作废装箱单走（报关发票与装箱单/提单要同一天），
 * 没有批次才退回建单日。以前固定用建单日——3 月下的单 9 月出运，
 * 发票日期早于装运，报关行直接退单重开。
 */
export function ciDocDateOf(order: OrderDetail): string {
  let latest: PackingList | null = null
  for (const p of order.packingLists) {
    if (p.voidedAt) continue
    const d = plDocDateOf(p)
    if (!latest || d > plDocDateOf(latest)) latest = p
  }
  return latest ? plDocDateOf(latest) : localDateOf(order.createdAt)
}

/**
 * 这行的毛重是不是估的。
 * 优先照库里记的 gross_est（装箱当时就定了性）；只有升级前的老数据没记过，
 * 才退回「毛重恰好等于净重×系数」的老推断。
 * 打印和界面两处共用这一个判断，免得纸面标了 est.、屏幕上却说实测。
 */
export function isGrossEstimated(line: PackingListLine, factor: number): boolean {
  if (line.grossEst != null) return line.grossEst
  const net = line.netWeight ?? 0
  return line.grossWeight == null || (net > 0 && Math.abs(Number(line.grossWeight) - net * factor) < 0.005)
}

/**
 * 贸易条款一行。
 * 港口没填时不要印「FOB — — → —」（看着像出了错），改成「待确认」。
 */
function tradeTermsText(incoterm: string, loading?: string, destination?: string): string {
  const l = String(loading ?? '').trim()
  const d = String(destination ?? '').trim()
  if (!l && !d) return `${incoterm}（港口待确认）`
  if (!d) return `${incoterm} — ${l} → 目的港待确认`
  if (!l) return `${incoterm} — 装运港待确认 → ${d}`
  return `${incoterm} — ${l} → ${d}`
}

const PRINT_CSS = `
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
    color: #111;
    font-size: 10pt;
    line-height: 1.45;
  }
  .page { width: 210mm; min-height: 297mm; padding: 12mm 12mm 14mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #333; padding: 3.5px 6px; vertical-align: middle; }
  th { background: #efefef; font-weight: 600; text-align: left; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  .title { font-size: 18pt; font-weight: 700; letter-spacing: 0.5px; }
  .title-cn { font-size: 11pt; color: #444; }
  .meta { text-align: right; font-size: 9.5pt; line-height: 1.65; }
  .logo { max-height: 56px; max-width: 200px; margin-bottom: 4px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
  .box { border: 1px solid #333; padding: 5px 8px; }
  .box h4 {
    margin: -5px -8px 5px; padding: 2px 6px; background: #efefef;
    border-bottom: 1px solid #333; font-size: 9.5pt; font-weight: 600;
  }
  .kv { display: flex; gap: 6px; font-size: 9.5pt; padding: 1px 0; }
  .kv .k { color: #555; min-width: 78px; flex-shrink: 0; }
  .terms { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .term { border: 1px solid #333; padding: 5px 8px; font-size: 9.5pt; }
  .term b { display: block; margin-bottom: 2px; }
  .thumb { width: 40px; height: 40px; object-fit: cover; border: 1px solid #bbb; display: block; margin: 0 auto; }
  .sub-total { background: #fafafa; }
  .total td { font-weight: 700; background: #f6f6f6; }
  .sub td { background: #fafafa; font-size: 9pt; }
  .note { margin-top: 8px; border: 1px solid #333; padding: 5px 8px; font-size: 9pt; line-height: 1.6; }
  .sign { margin-top: 22px; display: flex; justify-content: space-between; font-size: 9.5pt; }
  .sign > div { width: 45%; border-top: 1px solid #333; padding-top: 4px; }

  /*
   * 多页单据：页边距交给打印区域（printToPDF 的 margins），每一页都留同样的边，
   * 而不是只有第一页有 padding、第二页直接压到纸边。
   * 屏幕预览仍按 .page 的 210mm 纸张尺寸显示，所以这些覆盖只在打印时生效。
   */
  @media print {
    .page { width: auto; min-height: 0; padding: 0; }
    thead { display: table-header-group; }
    tr, .sign, .terms, .note, .totals { break-inside: avoid; }
  }
`

/* ===================================================================
 *  单据存档金额（不变量 3）—— 唯一入口
 *  PI / PL 存档记「含费用合计」（orders.grandTotal = 货值 + 费用行，services/money.ts 算出来的），
 *  与纸面 TOTAL 同一个数；报价单存档用 quotation.grandTotal（同一个公式）；
 *  CI 存档用当时纸面的合计（报关可调费用行，调了什么纸面印什么，差异理由在纸上）。
 * =================================================================== */
export function orderDocAmount(order: { grandTotal?: number | null; totalAmount: number }): number {
  return Number(order.grandTotal ?? order.totalAmount)
}

/** CI 存档金额：货值 + 当时纸上印的费用行（报关可调，调了什么纸面印什么，差异理由在纸上） */
export function ciDocAmount(
  order: { totalAmount: number },
  charges: { amount: number | string }[]
): number {
  return (
    Number(order.totalAmount) +
    charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  )
}

/* ===================================================================
 *  PI — Proforma Invoice（形式发票）
 * =================================================================== */

export function renderPi(ctx: DocContext): string {
  const { order, settings } = ctx
  const co = settings.company
  const bank = bankFor(settings, order.currency)
  const validUntil = order.validUntil ?? ''

  // 实际明细行（逐 SKU），款号首行显示并附小计
  const detailRows = order.items
    .map((it, idx) => {
      const isFirstOfStyle = idx === 0 || order.items[idx - 1].styleNo !== it.styleNo
      const styleTotal = order.items
        .filter((x) => x.styleNo === it.styleNo)
        .reduce((s, x) => s + x.quantity * x.unitPrice, 0)
      const photo = isFirstOfStyle ? ctx.images[it.styleNo] : ''
      // R2-P6：图裂了要优雅地裂 —— 加载失败时换成 40×40 浅灰占位块，不留断图标
      const photoCell = photo
        ? `<img class="thumb" src="${photo}" onerror="this.onerror=null;var d=document.createElement('div');d.className='thumb';this.parentNode.replaceChild(d,this)">`
        : isFirstOfStyle
          ? '<div class="thumb"></div>'
          : ''
      return `<tr>
        <td class="center">${isFirstOfStyle ? esc(it.styleNo) : ''}</td>
        <td class="center">${photoCell}</td>
        <td>${isFirstOfStyle ? esc(it.productName) : ''}${
          isFirstOfStyle && it.composition
            ? `<br><span style="font-size:8pt;color:#555">${esc(it.composition)}</span>`
            : ''
        }</td>
        <td class="center">${esc(it.color)}</td>
        <td class="center">${esc(it.size)}</td>
        <td class="num">${fmtQty(it.quantity)}</td>
        <td class="num">${it.unitPrice.toFixed(2)}</td>
        <td class="num">${(it.quantity * it.unitPrice).toFixed(2)}</td>
        ${
          isFirstOfStyle
            ? `<td class="num sub-total" style="font-size:8.5pt;white-space:nowrap">${styleTotal.toFixed(2)}</td>`
            : '<td class="sub-total"></td>'
        }
      </tr>`
    })
    .join('')

  const totalQty = order.totalQuantity
  const deposit = order.depositAmount
  const balance = order.grandTotal - deposit
  // 赊销（0%）与全额前收（100%）不印定金/尾款行：印出 "Deposit: USD 0.00" 客户会当算错账，
  // 与界面（订单/报价详情）同口径，极值只看 TOTAL 行
  const showDeposit = order.depositRatio > 0 && order.depositRatio < 1
  const rev = ctx.rev && ctx.rev > 0 ? ctx.rev : 0
  const revLabel = revHeadLabel(rev, !!ctx.pending)
  const revFoot = revFootHtml(rev, !!ctx.pending, localDateOf(order.createdAt))
  // 费用行（运费/保险等）：货值 + 费用 = 合计，三行清清楚楚
  const chargeRows = order.charges.length
    ? `<tr class="sub"><td colspan="7" class="right">货值 Goods Value</td><td class="num">${order.totalAmount.toFixed(
        2
      )}</td><td></td></tr>` +
      order.charges
        .map(
          (c) =>
            `<tr class="sub"><td colspan="7" class="right">${esc(c.label)}</td><td class="num">${c.amount.toFixed(
              2
            )}</td><td></td></tr>`
        )
        .join('')
    : ''

  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>
<div class="page">
  <div class="head">
    <div>
      ${co.logoFile && ctx.images[`__logo__`] ? `<img class="logo" src="${ctx.images['__logo__']}">` : ''}
      <div style="font-weight:700;font-size:12pt">${esc(co.name)}</div>
      <div style="font-size:8.5pt;color:#555;line-height:1.5">
        ${esc(co.address)}${co.phone ? `<br>Tel: ${esc(co.phone)}` : ''}${co.email ? `<br>Email: ${esc(
          co.email
        )}` : ''}${co.website ? `<br>${esc(co.website)}` : ''}
      </div>
    </div>
    <div>
      <div class="title">PROFORMA INVOICE</div>
      <div class="title-cn">形式发票</div>
      <div class="meta">
        <b>PI No.:</b> ${esc(order.piNo)}${revLabel}<br>
        <b>Date:</b> ${esc(localDateOf(order.createdAt))}<br>
        <b>Valid Until:</b> ${esc(validUntil || '—')}<br>
        <b>Order No.:</b> ${esc(order.orderNo)}${
          order.customerPo ? `<br><b>Your PO No.:</b> ${esc(order.customerPo)}` : ''
        }
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="box">
      <h4>SELLER / 卖方</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(co.name)}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(co.address)}</span></div>
      ${co.phone ? `<div class="kv"><span class="k">Tel</span><span>${esc(co.phone)}</span></div>` : ''}
      ${co.email ? `<div class="kv"><span class="k">Email</span><span>${esc(co.email)}</span></div>` : ''}
    </div>
    <div class="box">
      <h4>BUYER / 买方</h4>
      ${partyRows(order.billTo, true)}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:10%">Style No.<br>款号</th>
        <th style="width:9%" class="center">Photo<br>图片</th>
        <th style="width:22%">Description<br>品名</th>
        <th style="width:8%">Color<br>颜色</th>
        <th style="width:7%">Size<br>尺码</th>
        <th style="width:8%" class="num">Qty<br>数量</th>
        <th style="width:9%" class="num">Unit Price<br>单价</th>
        <th style="width:11%" class="num">Amount<br>金额</th>
        <th style="width:10%" class="num">Sub-total<br>小计</th>
      </tr>
    </thead>
    <tbody>
      ${detailRows || '<tr><td colspan="8" class="center" style="padding:14px">（未添加商品）</td></tr>'}
    </tbody>
    <tbody class="totals">
      ${chargeRows}
      <tr class="total">
        <td colspan="5" class="center">TOTAL / 合计</td>
        <td class="num">${fmtQty(totalQty)}</td>
        <td></td>
        <td class="num">${order.grandTotal.toFixed(2)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <div class="terms">
    <div class="term">
      <b>Payment Terms / 付款方式</b>
      ${esc(PAYMENT_METHOD_LABEL[order.paymentMethod])}
      ${showDeposit ? ` — 定金 ${(order.depositRatio * 100).toFixed(0)}% / 尾款 ${(
        (1 - order.depositRatio) *
        100
      ).toFixed(0)}%` : ''}
      ${showDeposit ? `<div style="margin-top:3px">Deposit: ${fmtMoney(deposit, order.currency)}</div>
      <div>Balance: ${fmtMoney(balance, order.currency)}</div>` : ''}
      ${order.billTo?.paymentPref && !order.billFromProfile
        ? `<div style="margin-top:3px">Agreed Terms: ${esc(order.billTo.paymentPref)}</div>`
        : ''}
    </div>
    <div class="term">
      <b>Trade Terms / 贸易条款</b>
      ${esc(tradeTermsText(order.incoterm, order.portOfLoading, order.portOfDestination))}
      <div style="margin-top:3px">Currency: ${esc(order.currency)}</div>
      <div>Exchange Rate: 1 ${esc(order.currency)} = ${order.exchangeRate} ${esc(order.baseCurrency)}${
        order.exchangeRateDate ? ` (${esc(order.exchangeRateDate)})` : ''
      }</div>
    </div>
  </div>

  ${
    bank && (bank.bankName || bank.accountNo)
      ? `<div class="note">
          <b>Beneficiary / 收款信息</b><br>
          Account Name: ${esc(bank.accountName || co.name)}<br>
          Bank Name: ${esc(bank.bankName)}${bank.swift ? ` &nbsp;&nbsp; SWIFT: ${esc(bank.swift)}` : ''}<br>
          Account No.: ${esc(bank.accountNo)}${bank.address ? `<br>Bank Address: ${esc(bank.address)}` : ''}
        </div>`
      : ''
  }

  ${
    order.note
      ? `<div class="note"><b>Remarks / 备注</b><br>${esc(order.note).replace(/\n/g, '<br>')}</div>`
      : ''
  }

  <div class="sign">
    <div>Authorized Signature / 卖方签字</div>
    <div>Buyer's Signature / 买方签字</div>
  </div>
  ${revFoot}
</div>
</body></html>`
}

/* ===================================================================
 *  PL — Packing List（装箱单）
 * =================================================================== */

export function renderPl(ctx: DocContext, pl: PackingList): string {
  const { order, settings } = ctx
  const co = settings.company
  const factor = settings.grossWeightFactor
  const rev = ctx.rev && ctx.rev > 0 ? ctx.rev : 0
  const revLabel = revHeadLabel(rev, !!ctx.pending)
  // 页脚与抬头同一个日期：补录过单据日期的箱单，同一张纸上不能印两个「出单日」
  const revFoot = revFootHtml(rev, !!ctx.pending, pl.docDate || localDateOf(pl.createdAt))

  let totalQty = 0
  let totalNet = 0
  let totalGross = 0
  let totalVolume = 0
  let hasEstimatedGross = false
  const boxNos = new Set<string>()
  /** 箱号空着的行也各算一箱：否则这几箱在「N 箱」合计里直接消失，箱单与提单件数就对不上 */
  let unnumberedBoxes = 0

  const rows = pl.lines
    .map((l) => {
      totalQty += l.quantity
      const net = l.netWeight ?? 0
      const gross = l.grossWeight ?? Number((net * factor).toFixed(2))
      // 与「净重×系数」一致就当作系统推算值：报关行需要知道哪些毛重不是过磅实测的
      const grossEstimated = isGrossEstimated(l, factor)
      if (grossEstimated) hasEstimatedGross = true
      totalNet += net
      totalGross += gross
      // 每行 = 一箱，体积为该箱箱规，不乘件数
      const cbm =
        l.boxLength && l.boxWidth && l.boxHeight
          ? (l.boxLength * l.boxWidth * l.boxHeight) / 1000000
          : null
      if (cbm != null) totalVolume += cbm
      if (l.boxNo) boxNos.add(l.boxNo)
      else unnumberedBoxes += 1
      return `<tr>
        <td class="center">${esc(l.boxNo)}</td>
        <td>${esc(l.styleNo)}</td>
        <td>${esc(l.productName)}</td>
        <td class="center">${esc(l.color)}</td>
        <td class="center">${esc(l.size)}</td>
        <td class="num">${fmtQty(l.quantity)}</td>
        <td class="num">${net ? net.toFixed(2) : '—'}</td>
        <td class="num">${gross ? gross.toFixed(2) : '—'}${
          grossEstimated ? '<span style="font-size:7pt;color:#666"> (est.)</span>' : ''
        }</td>
        <td class="center">${
          l.boxLength && l.boxWidth && l.boxHeight
            ? `${l.boxLength}×${l.boxWidth}×${l.boxHeight}`
            : '—'
        }</td>
        <td class="num">${cbm != null ? cbm.toFixed(3) : '—'}</td>
      </tr>`
    })
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>
<div class="page">
  <div class="head">
    <div>
      ${co.logoFile && ctx.images[`__logo__`] ? `<img class="logo" src="${ctx.images['__logo__']}">` : ''}
      <div style="font-weight:700;font-size:12pt">${esc(co.name)}</div>
      <div style="font-size:8.5pt;color:#555;line-height:1.5">
        ${esc(co.address)}${co.phone ? `<br>Tel: ${esc(co.phone)}` : ''}${co.email ? `<br>Email: ${esc(
          co.email
        )}` : ''}
      </div>
    </div>
    <div>
      <div class="title">PACKING LIST</div>
      <div class="title-cn">装箱单</div>
      <div class="meta">
        <b>PL No.:</b> ${esc(pl.plNo)}${revLabel}<br>
        <b>Date:</b> ${esc(pl.docDate || localDateOf(pl.createdAt))}<br>
        <b>Order No.:</b> ${esc(order.orderNo)}<br>
        <b>PI No.:</b> ${esc(order.piNo)}
        ${pl.containerNo ? `<br><b>Container:</b> ${esc(pl.containerNo)}` : ''}
        ${pl.sealNo || order.sealNo ? `<br><b>Seal No.:</b> ${esc(pl.sealNo || order.sealNo)}` : ''}
        ${pl.blNo ? `<br><b>B/L No.:</b> ${esc(pl.blNo)}` : ''}
        ${pl.vessel || order.vessel ? `<br><b>Vessel/Voyage:</b> ${esc(pl.vessel || order.vessel)}` : ''}
        ${pl.etdDate || order.etdDate ? `<br><b>ETD:</b> ${esc(pl.etdDate || order.etdDate)}` : ''}
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="box">
      <h4>SHIPPER / 发货人</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(co.name)}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(co.address)}</span></div>
      ${co.phone ? `<div class="kv"><span class="k">Tel</span><span>${esc(co.phone)}</span></div>` : ''}
    </div>
    <div class="box">
      <h4>CONSIGNEE / 收货人</h4>
      ${partyRows(order.shipTo, false)}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:9%">Box No.<br>箱号</th>
        <th style="width:11%">Style No.<br>款号</th>
        <th style="width:22%">Description<br>品名</th>
        <th style="width:8%">Color<br>颜色</th>
        <th style="width:7%">Size<br>尺码</th>
        <th style="width:8%" class="num">Qty<br>数量</th>
        <th style="width:9%" class="num">N.W.(kg)<br>净重</th>
        <th style="width:9%" class="num">G.W.(kg)<br>毛重</th>
        <th style="width:9%" class="center">Size(cm)<br>箱规</th>
        <th style="width:8%" class="num">CBM<br>体积</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10" class="center" style="padding:14px">（无明细）</td></tr>'}
    </tbody>
    <tbody class="totals">
      <tr class="total">
        <td colspan="5" class="center">TOTAL / 合计（${boxNos.size + unnumberedBoxes} 箱 / ${
          boxNos.size + unnumberedBoxes
        } cartons）</td>
        <td class="num">${fmtQty(totalQty)}</td>
        <td class="num">${totalNet.toFixed(2)}</td>
        <td class="num">${totalGross.toFixed(2)}</td>
        <td></td>
        <td class="num">${totalVolume.toFixed(3)}</td>
      </tr>
    </tbody>
  </table>

  ${
    hasEstimatedGross
      ? '<div class="note" style="font-size:8pt">G.W. marked (est.) is estimated from N.W. × factor, not weighed. Please verify before customs / booking.</div>'
      : ''
  }

  ${
    pl.note
      ? `<div class="note"><b>Remarks / 备注</b><br>${esc(pl.note).replace(/\n/g, '<br>')}</div>`
      : ''
  }

  <div class="sign">
    <div>Shipped by / 发货人签字</div>
    <div>Checked by / 复核</div>
  </div>
  ${revFoot}
</div>
</body></html>`
}

/* ===================================================================
 *  QUOTATION — 报价单（下单之前）
 * =================================================================== */

export function renderQuotation(ctx: QuotationDocContext): string {
  const { quotation: q, settings } = ctx
  const co = settings.company
  const rev = ctx.rev && ctx.rev > 0 ? ctx.rev : 0
  // 抬头印「内容版次」（报价单改了几版，跟系统里的「第 N 版」对得上）；
  // 页脚印「存档版次」：未存档的预览印「待存为第 N 版」，存了才印「Version N」（N39，纸面和存档必须一个号）。
  const contentRev = q.revision && q.revision > 0 ? q.revision : 1
  const revLabel = ` (Rev. ${contentRev})`
  const revFoot = revFootHtml(rev, !!ctx.pending, localDateOf(q.createdAt))

  const detailRows = q.items
    .map((it, idx) => {
      const isFirstOfStyle = idx === 0 || q.items[idx - 1].styleNo !== it.styleNo
      const styleTotal = q.items
        .filter((x) => x.styleNo === it.styleNo)
        .reduce((s, x) => s + x.quantity * x.unitPrice, 0)
      const photo = isFirstOfStyle ? ctx.images[it.styleNo] : ''
      // R2-P6：同 PI —— 裂图换成浅灰占位块
      const photoCell = photo
        ? `<img class="thumb" src="${photo}" onerror="this.onerror=null;var d=document.createElement('div');d.className='thumb';this.parentNode.replaceChild(d,this)">`
        : isFirstOfStyle
          ? '<div class="thumb"></div>'
          : ''
      return `<tr>
        <td class="center">${isFirstOfStyle ? esc(it.styleNo) : ''}</td>
        <td class="center">${photoCell}</td>
        <td>${isFirstOfStyle ? esc(it.productName) : ''}${
          isFirstOfStyle && it.composition
            ? `<br><span style="font-size:8pt;color:#555">${esc(it.composition)}</span>`
            : ''
        }</td>
        <td class="center">${esc(it.color)}</td>
        <td class="center">${esc(it.size)}</td>
        <td class="num">${fmtQty(it.quantity)}</td>
        <td class="num">${it.unitPrice.toFixed(2)}</td>
        <td class="num">${(it.quantity * it.unitPrice).toFixed(2)}</td>
        ${
          isFirstOfStyle
            ? `<td class="num sub-total" style="font-size:8.5pt;white-space:nowrap">${styleTotal.toFixed(2)}</td>`
            : '<td class="sub-total"></td>'
        }
      </tr>`
    })
    .join('')

  const chargeRows = q.charges
    .map(
      (c) =>
        `<tr><td colspan="7" class="right">${esc(c.label)}</td><td class="num">${c.amount.toFixed(2)}</td><td></td></tr>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>
<div class="page">
  <div class="head">
    <div>
      ${co.logoFile && ctx.images[`__logo__`] ? `<img class="logo" src="${ctx.images['__logo__']}">` : ''}
      <div style="font-weight:700;font-size:12pt">${esc(co.name)}</div>
      <div style="font-size:8.5pt;color:#555;line-height:1.5">
        ${esc(co.address)}${co.phone ? `<br>Tel: ${esc(co.phone)}` : ''}${co.email ? `<br>Email: ${esc(
          co.email
        )}` : ''}${co.website ? `<br>${esc(co.website)}` : ''}
      </div>
    </div>
    <div>
      <div class="title">QUOTATION</div>
      <div class="title-cn">报价单</div>
      <div class="meta">
        <b>Quotation No.:</b> ${esc(q.qNo)}${revLabel}<br>
        <b>Date:</b> ${esc(localDateOf(q.createdAt))}<br>
        <b>Valid Until:</b> ${esc(q.validUntil || '—')}<br>
        ${q.customerPo ? `<b>Your PO No.:</b> ${esc(q.customerPo)}<br>` : ''}
        <b>Currency:</b> ${esc(q.currency)}
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="box">
      <h4>SELLER / 卖方</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(co.name)}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(co.address)}</span></div>
      ${co.phone ? `<div class="kv"><span class="k">Tel</span><span>${esc(co.phone)}</span></div>` : ''}
      ${co.email ? `<div class="kv"><span class="k">Email</span><span>${esc(co.email)}</span></div>` : ''}
    </div>
    <div class="box">
      <h4>BUYER / 买方</h4>
      ${partyRows(q.billTo, true)}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:10%">Style No.<br>款号</th>
        <th style="width:9%" class="center">Photo<br>图片</th>
        <th style="width:22%">Description<br>品名</th>
        <th style="width:8%">Color<br>颜色</th>
        <th style="width:7%">Size<br>尺码</th>
        <th style="width:8%" class="num">Qty<br>数量</th>
        <th style="width:9%" class="num">Unit Price<br>单价</th>
        <th style="width:11%" class="num">Amount<br>金额</th>
        <th style="width:10%" class="num">Sub-total<br>小计</th>
      </tr>
    </thead>
    <tbody>
      ${detailRows || '<tr><td colspan="9" class="center" style="padding:14px">（未添加商品）</td></tr>'}
    </tbody>
    <tbody class="totals">
      ${chargeRows}
      <tr class="total">
        <td colspan="5" class="center">TOTAL / 合计</td>
        <td class="num">${fmtQty(q.totalQuantity)}</td>
        <td></td>
        <td class="num">${q.grandTotal.toFixed(2)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <div class="terms">
    <div class="term">
      <b>Payment Terms / 付款方式</b>
      ${esc(PAYMENT_METHOD_LABEL[q.paymentMethod])}
      ${q.depositRatio > 0 && q.depositRatio < 1 ? ` — 定金 ${(q.depositRatio * 100).toFixed(0)}% / 尾款 ${(
        (1 - q.depositRatio) *
        100
      ).toFixed(0)}%` : ''}
      ${q.billTo?.paymentPref && !q.billFromProfile
        ? `<div style="margin-top:3px">Agreed Terms: ${esc(q.billTo.paymentPref)}</div>`
        : ''}
    </div>
    <div class="term">
      <b>Trade Terms / 贸易条款</b>
      ${esc(tradeTermsText(q.incoterm, q.portOfLoading, q.portOfDestination))}
      <div style="margin-top:3px">Currency: ${esc(q.currency)}</div>
      <div>Exchange Rate: 1 ${esc(q.currency)} = ${q.exchangeRate} ${esc(q.baseCurrency)}${
        q.exchangeRateDate ? ` (${esc(q.exchangeRateDate)})` : ''
      }</div>
    </div>
  </div>

  ${q.note ? `<div class="note"><b>Remarks / 备注</b><br>${esc(q.note).replace(/\n/g, '<br>')}</div>` : ''}

  <div class="sign">
    <div>Authorized Signature / 卖方签字</div>
    <div>Buyer's Signature / 买方签字</div>
  </div>
  ${revFoot}
</div>
</body></html>`
}

/* ===================================================================
 *  CI — Commercial Invoice（商业发票，报关用）
 * =================================================================== */

/** 按批次出 CI 的入参：明细与金额全部来自 services/money.packingAmounts（单一口径） */
export interface CiBatchOptions {
  plNo: string
  docDate: string
  lines: {
    styleNo: string
    productName?: string
    composition?: string
    color: string
    size: string
    quantity: number
    unitPrice: number
  }[]
  goods: number
  quantity: number
  charges: QuotationCharge[]
  total: number
  containerNo?: string
  vessel?: string
  etdDate?: string
  blNo?: string
  sealNo?: string
}

export interface CiOptions {
  /** 费用行（运费/保险等）：不给就取订单上的费用行，保证 CI 与 PI 同一套数字 */
  charges?: QuotationCharge[]
  /** 兼容：单独给运费 */
  freight?: number
  /** 兼容：单独给保险费 */
  insurance?: number
  /** 按批次出：给了就只印这一批的明细、金额和船期，CI 号带批次后缀 */
  batch?: CiBatchOptions
}

/**
 * CI 上的费用行：
 *  - 给了 charges 就用给的（用户在 CI 弹窗里改过的）
 *  - 只给了运费/保险费就拼成两行
 *  - 都没给就用订单上的费用行（PI 上印的就是这同一套数字）
 */
function resolveCiCharges(order: OrderDetail, opts: CiOptions): QuotationCharge[] {
  if (opts.charges) return opts.charges.filter((c) => c.label.trim())
  if (opts.freight != null || opts.insurance != null) {
    const out: QuotationCharge[] = []
    if (opts.freight) out.push({ label: '运费 Freight', amount: opts.freight })
    if (opts.insurance) out.push({ label: '保险费 Insurance', amount: opts.insurance })
    return out
  }
  return order.charges
}

export function renderCi(ctx: DocContext, opts: CiOptions = {}): string {
  const { order, settings } = ctx
  const co = settings.company
  const bank = bankFor(settings, order.currency)
  const rev = ctx.rev && ctx.rev > 0 ? ctx.rev : 0
  const revLabel = revHeadLabel(rev, !!ctx.pending)
  const batch = opts.batch
  const docDate = batch ? batch.docDate : ciDocDateOf(order)
  const revFoot = revFootHtml(rev, !!ctx.pending, docDate)
  // CI 与 PI 必须是同一套数字：整单取订单上的费用行；按批次出则用批次的费用分摊
  const charges = batch ? batch.charges.filter((c) => c.label.trim()) : resolveCiCharges(order, opts)
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  // 合计口径 = 货值 + 费用（与 PI 同一个函数：services/money.ts）
  const goodsTotal = batch ? batch.goods : order.totalAmount
  const total = batch ? batch.total : goodsTotal + chargesTotal
  const qtyTotal = batch ? batch.quantity : order.totalQuantity
  const rows = batch ? batch.lines : order.items

  const detailRows = rows
    .map((it, idx) => {
      const isFirstOfStyle = idx === 0 || rows[idx - 1].styleNo !== it.styleNo
      const styleTotal = rows
        .filter((x) => x.styleNo === it.styleNo)
        .reduce((s, x) => s + x.quantity * x.unitPrice, 0)
      return `<tr>
        <td class="center">${isFirstOfStyle ? esc(it.styleNo) : ''}</td>
        <td>${isFirstOfStyle ? esc(it.productName ?? '') : ''}${
          isFirstOfStyle && it.composition
            ? `<br><span style="font-size:8pt;color:#555">${esc(it.composition)}</span>`
            : ''
        }</td>
        <td class="center">${esc(it.color)}</td>
        <td class="center">${esc(it.size)}</td>
        <td class="num">${fmtQty(it.quantity)}</td>
        <td class="num">${it.unitPrice.toFixed(2)}</td>
        <td class="num">${(it.quantity * it.unitPrice).toFixed(2)}</td>
        ${
          isFirstOfStyle
            ? `<td class="num sub-total" style="font-size:8.5pt;white-space:nowrap">${styleTotal.toFixed(2)}</td>`
            : '<td class="sub-total"></td>'
        }
      </tr>`
    })
    .join('')

  const ciNo = ciNoOf(order.piNo, batch?.plNo)
  // 批次 CI 的船期取本批；没填才退回订单级（与 PL 同一套回退规则）
  const vessel = batch ? batch.vessel || order.vessel : order.vessel
  const etd = batch ? batch.etdDate || order.etdDate : order.etdDate
  const containerNo = batch?.containerNo || ''
  const blNo = batch?.blNo || ''
  // 封条号与 PL 同一套回退：本批填了用本批的，没填才退回订单级。
  // 批次 CI 上印订单级的封条，在「每批一柜」时就是个错号
  const sealNo = batch ? batch.sealNo || order.sealNo : order.sealNo

  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>
<div class="page">
  <div class="head">
    <div>
      ${co.logoFile && ctx.images[`__logo__`] ? `<img class="logo" src="${ctx.images['__logo__']}">` : ''}
      <div style="font-weight:700;font-size:12pt">${esc(co.name)}</div>
      <div style="font-size:8.5pt;color:#555;line-height:1.5">
        ${esc(co.address)}${co.phone ? `<br>Tel: ${esc(co.phone)}` : ''}${co.email ? `<br>Email: ${esc(
          co.email
        )}` : ''}${co.website ? `<br>${esc(co.website)}` : ''}
      </div>
    </div>
    <div>
      <div class="title">COMMERCIAL INVOICE</div>
      <div class="title-cn">商业发票</div>
      <div class="meta">
        <b>CI No.:</b> ${esc(ciNo)}${revLabel}<br>
        <b>Date:</b> ${esc(docDate)}<br>
        <b>Order No.:</b> ${esc(order.orderNo)}<br>
        ${batch ? `<b>Batch / 本批:</b> ${esc(batch.plNo)}（this shipment only / 仅本批）<br>` : ''}
        ${order.customerPo ? `<b>Your PO No.:</b> ${esc(order.customerPo)}<br>` : ''}
        <b>Terms:</b> ${esc(order.incoterm)}
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="box">
      <h4>EXPORTER / 出口方</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(co.name)}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(co.address)}</span></div>
      ${co.phone ? `<div class="kv"><span class="k">Tel</span><span>${esc(co.phone)}</span></div>` : ''}
      ${co.email ? `<div class="kv"><span class="k">Email</span><span>${esc(co.email)}</span></div>` : ''}
    </div>
    <div class="box">
      <h4>IMPORTER / 进口方</h4>
      ${partyRows(order.billTo, false)}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:11%">Style No.<br>款号</th>
        <th style="width:26%">Description<br>品名</th>
        <th style="width:9%">Color<br>颜色</th>
        <th style="width:8%">Size<br>尺码</th>
        <th style="width:9%" class="num">Qty<br>数量</th>
        <th style="width:10%" class="num">Unit Price<br>单价</th>
        <th style="width:13%" class="num">Amount<br>金额</th>
        <th style="width:14%" class="num">Sub-total<br>小计</th>
      </tr>
    </thead>
    <tbody>
      ${detailRows || '<tr><td colspan="8" class="center" style="padding:14px">（未添加商品）</td></tr>'}
    </tbody>
    <tbody class="totals">
      <tr class="sub"><td colspan="6" class="right">货值 Goods Value</td><td class="num">${goodsTotal.toFixed(
        2
      )}</td><td></td></tr>
      ${charges
        .map(
          (c) =>
            `<tr class="sub"><td colspan="6" class="right">${esc(c.label)}</td><td class="num">${Number(
              c.amount
            ).toFixed(2)}</td><td></td></tr>`
        )
        .join('')}
      <tr class="total">
        <td colspan="4" class="center">TOTAL / 合计</td>
        <td class="num">${fmtQty(qtyTotal)}</td>
        <td></td>
        <td class="num">${total.toFixed(2)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <div class="terms">
    <div class="term">
      <b>Shipment / 运输</b>
      ${esc(tradeTermsText(order.incoterm, order.portOfLoading, order.portOfDestination))}
      ${containerNo ? `<div style="margin-top:3px">Container No.: ${esc(containerNo)}</div>` : ''}
      ${vessel ? `<div style="margin-top:3px">Vessel/Voyage: ${esc(vessel)}</div>` : ''}
      ${etd ? `<div>ETD: ${esc(etd)}</div>` : ''}
      ${blNo ? `<div>B/L No.: ${esc(blNo)}</div>` : ''}
      ${sealNo ? `<div>Seal No.: ${esc(sealNo)}</div>` : ''}
    </div>
    <div class="term">
      <b>Amount / 金额</b>
      Currency: ${esc(order.currency)}
      <div style="margin-top:3px">Exchange Rate: 1 ${esc(order.currency)} = ${order.exchangeRate} ${esc(
        order.baseCurrency
      )}${order.exchangeRateDate ? ` (${esc(order.exchangeRateDate)})` : ''}</div>
      <div>Total Payable: ${fmtMoney(total, order.currency)}</div>
    </div>
  </div>

  ${
    bank && (bank.bankName || bank.accountNo)
      ? `<div class="note">
          <b>Beneficiary / 收款信息</b><br>
          Account Name: ${esc(bank.accountName || co.name)}<br>
          Bank Name: ${esc(bank.bankName)}${bank.swift ? ` &nbsp;&nbsp; SWIFT: ${esc(bank.swift)}` : ''}<br>
          Account No.: ${esc(bank.accountNo)}${bank.address ? `<br>Bank Address: ${esc(bank.address)}` : ''}
        </div>`
      : ''
  }

  ${order.note ? `<div class="note"><b>Remarks / 备注</b><br>${esc(order.note).replace(/\n/g, '<br>')}</div>` : ''}

  <div class="sign">
    <div>Authorized Signature / 卖方签字</div>
    <div>Buyer's Signature / 买方签字</div>
  </div>
  ${revFoot}
</div>
</body></html>`
}

/* ===================================================================
 *  SAMPLE ORDER — 样品单 / 打样单
 * =================================================================== */

export interface SampleDocContext {
  sample: SampleOrderDetail
  settings: AppSettings
  /** 打样单也要挂自家抬头 logo（data URL 内嵌，与 PI/PL/CI/报价同款） */
  images: ImageMap
}

export function renderSample(ctx: SampleDocContext): string {
  const { sample: s, settings } = ctx
  const co = settings.company
  const rows = s.items
    .map(
      (it) => `<tr>
        <td class="center">${esc(it.styleNo)}</td>
        <td>${esc(it.productName)}${
          it.composition ? `<br><span style="font-size:8pt;color:#555">${esc(it.composition)}</span>` : ''
        }</td>
        <td class="center">${esc(it.color || '—')}</td>
        <td class="center">${esc(it.size || '—')}</td>
        <td class="num">${fmtQty(it.quantity)}</td>
        <td class="num">${it.unitPrice.toFixed(2)}</td>
        <td class="num">${(it.quantity * it.unitPrice).toFixed(2)}</td>
      </tr>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>
<div class="page">
  <div class="head">
    <div>
      ${co.logoFile && ctx.images[`__logo__`] ? `<img class="logo" src="${ctx.images['__logo__']}">` : ''}
      <div style="font-weight:700;font-size:12pt">${esc(co.name)}</div>
      <div style="font-size:8.5pt;color:#555;line-height:1.5">
        ${esc(co.address)}${co.phone ? `<br>Tel: ${esc(co.phone)}` : ''}${co.email ? `<br>Email: ${esc(
          co.email
        )}` : ''}
      </div>
    </div>
    <div>
      <div class="title">SAMPLE ORDER</div>
      <div class="title-cn">样品单 / 打样单</div>
      <div class="meta">
        <b>Sample No.:</b> ${esc(s.sampleNo)}<br>
        <b>Date:</b> ${esc(s.sampleDate || localDateOf(s.createdAt))}<br>
        <b>Status:</b> ${esc(SAMPLE_STATUS_LABEL[s.status] ?? s.status)}<br>
        <b>Courier:</b> ${esc(s.courier || '—')}
        ${s.trackingNo ? `<br><b>Tracking No.:</b> ${esc(s.trackingNo)}` : ''}
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="box">
      <h4>SENDER / 寄件方</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(co.name)}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(co.address)}</span></div>
    </div>
    <div class="box">
      <h4>CONSIGNEE / 收件方</h4>
      <div class="kv"><span class="k">Company</span><span>${esc(s.customer?.company)}</span></div>
      <div class="kv"><span class="k">Attn</span><span>${esc(s.customer?.attn || s.customer?.contact || '—')}</span></div>
      <div class="kv"><span class="k">Address</span><span>${esc(s.customer?.address)}${
        s.customer?.country ? `, ${esc(s.customer.country)}` : ''
      }</span></div>
      ${s.customer?.email ? `<div class="kv"><span class="k">Email</span><span>${esc(s.customer.email)}</span></div>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:14%">Style No.<br>款号</th>
        <th style="width:30%">Description<br>品名</th>
        <th style="width:10%" class="center">Color<br>颜色</th>
        <th style="width:10%" class="center">Size<br>尺码</th>
        <th style="width:10%" class="num">Qty<br>件数</th>
        <th style="width:12%" class="num">Unit Price<br>样品单价</th>
        <th style="width:14%" class="num">Amount<br>金额</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" class="center" style="padding:14px">（无明细）</td></tr>'}
    </tbody>
    <tbody class="totals">
      <tr class="sub"><td colspan="5" class="right">样品费 Sample Fee</td><td></td><td class="num">${s.sampleFee.toFixed(
        2
      )}</td></tr>
      <tr class="sub"><td colspan="5" class="right">快递费 Courier Fee</td><td></td><td class="num">${s.expressFee.toFixed(
        2
      )}</td></tr>
      <tr class="total">
        <td colspan="4" class="center">TOTAL / 合计</td>
        <td class="num">${fmtQty(s.totalQuantity)}</td>
        <td></td>
        <td class="num">${s.totalFee.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  ${s.note ? `<div class="note"><b>Remarks / 备注</b><br>${esc(s.note).replace(/\n/g, '<br>')}</div>` : ''}

  <div class="sign">
    <div>Sender / 寄件方签字</div>
    <div>Receiver / 收件方签字</div>
  </div>
</div>
</body></html>`
}
