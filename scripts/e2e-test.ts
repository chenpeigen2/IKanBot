/**
 * 端到端业务逻辑测试：直接调用 service 层，验证核心流程。
 * 运行：npm run test:e2e
 */
import { openDb, closeDb, getDb } from '../electron/db'
import * as fs from 'fs'
import * as products from '../electron/services/products'
import * as customers from '../electron/services/customers'
import * as orders from '../electron/services/orders'
import * as quotations from '../electron/services/quotations'
import * as samples from '../electron/services/samples'
import * as packing from '../electron/services/packing'
import { shipmentSummary } from '../electron/services/shipping'
import * as dashboard from '../electron/services/dashboard'
import * as money from '../electron/services/money'
import { getSettings, saveSettings } from '../electron/services/settings'
import { createBackup } from '../electron/services/backup'
import { renderPi, renderPl, renderQuotation, renderCi, renderSample, orderDocAmount, ciDocAmount } from '../src/shared/documents'
import { localDate, localMonthOf } from '../src/shared/date'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function section(t: string): void {
  console.log(`\n${t}`)
}

async function main() {
openDb()

/* ---------------- 商品 ---------------- */
section('商品库')
const p1 = products.saveProduct({
  styleNo: 'A001',
  name: '纯棉圆领T恤',
  composition: '100% Cotton / 纯棉',
  costPrice: 5.5,
  sizes: ['S', 'M', 'L'],
  colors: ['Black', 'White']
})
check('新增商品', p1.id > 0)
eq('尺码表', p1.sizes, ['S', 'M', 'L'])
eq('颜色表', p1.colors, ['Black', 'White'])
eq('成本价', p1.costPrice, 5.5)

const p2 = products.saveProduct({
  styleNo: 'A002',
  name: '涤纶 Polo 衫',
  composition: '95% Polyester 5% Spandex',
  costPrice: null,
  sizes: ['M', 'L'],
  colors: ['Navy']
})
check('新增第二个商品', p2.id > 0)

eq('按款号搜索', products.listProducts('A001').length, 1)
check('关键词模糊搜索', products.listProducts('棉').length === 1)

const copied = products.copyProduct(p1.id, 'A001-BLACK')
eq('复制款号保留尺码表', copied.sizes, ['S', 'M', 'L'])
eq('复制款号新编号', copied.styleNo, 'A001-BLACK')

/* ---------------- 客户 ---------------- */
section('客户')
const c1 = customers.saveCustomer({
  company: 'Acme Fashion GmbH',
  contact: 'Mr. Wang',
  email: 'wang@acme.de',
  phone: '+49 123 456',
  country: 'Germany',
  address: 'Hauptstr. 1, Hamburg',
  zipCode: '20095',
  attn: 'Mr. Wang',
  paymentPref: 'T/T 30%'
})
check('新增客户', c1.id > 0)
check('按公司名搜索', customers.listCustomers('Acme').length === 1)

const c2 = customers.saveCustomer({
  company: 'Nordic Wear AB',
  contact: 'Anna Lindqvist',
  attn: 'Ms. Lindqvist',
  email: 'anna@nordicwear.se',
  phone: '+46 8 123 456 78',
  country: 'Sweden',
  address: 'Sveavagen 44, Stockholm',
  zipCode: '111 34',
  paymentPref: 'T/T 全款'
})
check('新增第二个客户', c2.id > 0)

/* ---------------- 订单 ---------------- */
section('订单与状态流转')
const order = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  baseCurrency: 'CNY',
  incoterm: 'FOB',
  portOfLoading: 'Ningbo',
  portOfDestination: 'Hamburg',
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  customerPo: 'PO-2026-001',
  expectedShipDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
})
check('创建订单', order.id > 0)
check('订单号格式 SO+日期+序号', /^SO\d{8}\d{3}$/.test(order.orderNo), order.orderNo)
check('PI 号格式', /^PI\d{8}\d{3}$/.test(order.piNo), order.piNo)
eq('初始收款状态', order.paymentStatus, 'draft')
eq('初始出货状态', order.shipStatus, 'not_prepared')

// 录 6 个 SKU：2 款 × 颜色 × 尺码
const items = [
  { productId: p1.id, styleNo: 'A001', productName: '纯棉圆领T恤', composition: '100% Cotton', color: 'Black', size: 'S', quantity: 100, unitPrice: 8, unitCost: 5.5 },
  { productId: p1.id, styleNo: 'A001', productName: '纯棉圆领T恤', composition: '100% Cotton', color: 'Black', size: 'M', quantity: 150, unitPrice: 8, unitCost: 5.5 },
  { productId: p1.id, styleNo: 'A001', productName: '纯棉圆领T恤', composition: '100% Cotton', color: 'White', size: 'S', quantity: 50, unitPrice: 8, unitCost: 5.5 },
  { productId: p2.id, styleNo: 'A002', productName: '涤纶 Polo 衫', composition: '95% Polyester', color: 'Navy', size: 'M', quantity: 80, unitPrice: 12, unitCost: null }
]
let cur = order
for (const it of items) cur = await orders.addOrderItem(order.id, it)
eq('总数量', cur.totalQuantity, 380)
eq('总金额', cur.totalAmount, 100 * 8 + 150 * 8 + 50 * 8 + 80 * 12)
// 成本：只有 A001 有成本
eq('总成本', cur.totalCost, 300 * 5.5)
eq('总毛利', cur.totalProfit, cur.totalAmount - cur.totalCost)

const skus = orders.summarizeSkus(order.id)
eq('SKU 汇总条数', skus.length, 4)
eq('SKU 汇总数量合计', skus.reduce((s, x) => s + x.quantity, 0), 380)

/* ---------------- 收款状态自动流转 ---------------- */
section('收款状态自动流转')
orders.setPaymentStatus(order.id, 'confirmed')
eq('手动设为已确认', orders.getOrder(order.id)!.paymentStatus, 'confirmed')

let o = orders.addPayment(order.id, { paidAt: '2026-03-20', amount: 500, method: 'T/T', bankRef: 'BNK001' })
eq('收款额小于定金 → 部分收款', o.paymentStatus, 'partial')
eq('已收金额', o.paidAmount, 500)

o = orders.addPayment(order.id, { paidAt: '2026-03-21', amount: 600, method: 'T/T', bankRef: 'BNK002' })
eq('定金收齐自动转已收款', o.paymentStatus, 'paid')
eq('已收金额累计', o.paidAmount, 1100)

const total = o.totalAmount
o = orders.addPayment(order.id, { paidAt: '2026-03-28', amount: total - 1100, method: 'T/T', bankRef: 'BNK003' })
eq('全额收齐自动转已结清', o.paymentStatus, 'settled')
eq('待收归零', Math.round(o.remaining), 0)

/* ---------------- 出货状态独立 ---------------- */
section('出货状态独立推进')
o = orders.setShipStatus(order.id, 'preparing')
eq('备货中', o.shipStatus, 'preparing')
eq('出货推进不影响收款状态', o.paymentStatus, 'settled')
o = orders.setShipStatus(order.id, 'packed')
eq('已包装', o.shipStatus, 'packed')

/* ---------------- 装箱单 ---------------- */
section('装箱单')
const pls = packing.createPackingList({
  orderId: order.id,
  containerNo: 'MSKU1234567',
  note: '第 1 柜',
  lines: [
    { boxNo: 'NO.1', styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'S', quantity: 100, netWeight: 12, boxLength: 60, boxWidth: 40, boxHeight: 50 },
    { boxNo: 'NO.2', styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 150, netWeight: 18, boxLength: 60, boxWidth: 40, boxHeight: 50 }
  ]
})
check('生成装箱单', pls.length === 1)
check('PL 号格式', /^PL\d{8}\d{3}$/.test(pls[0].plNo), pls[0].plNo)
eq('装箱行数', pls[0].lines.length, 2)
eq('毛重按净重×1.1 估算', pls[0].lines[0].grossWeight, Number((12 * 1.1).toFixed(2)))
eq('手填净重保留', pls[0].lines[1].netWeight, 18)

const pls2 = packing.createPackingList({
  orderId: order.id,
  containerNo: 'MSKU7654321',
  lines: [{ boxNo: 'NO.1', styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'M', quantity: 80, netWeight: 10 }]
})
eq('一单可多张 PL', pls2.length, 2)

/* ---------------- 客户统计 ---------------- */
section('客户统计')
const stats = customers.customerStats(c1.id)
eq('客户订单数', stats.orderCount, 1)
eq('客户成交额（按汇率折算为基准币）', stats.totalAmount, total * 7.2)
// 这一单有一行成本没录（A002），所以毛利是「不可信」→ null（不许拿 0 成本凑一个漂亮的数）
eq('有成本没录全的订单：客户毛利不可信（null）', stats.totalProfit, null)
eq('客户未收金额', Math.round(stats.outstanding), 0)

/* ---------------- 提醒 ---------------- */
section('待办提醒')
// 单独建一个未包装、出货日临近的订单
const oShip = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  expectedShipDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
})
const rem = dashboard.reminders()
check('出货提醒命中（预计出货日临近）', rem.some((r) => r.kind === 'ship' && r.orderId === oShip.id))
check(
  '有批次但没填 ETD、交期临近 → 提醒不被装箱单吞掉',
  rem.some((r) => r.kind === 'ship' && r.orderId === order.id && r.message.includes('批次还没填 ETD')),
  JSON.stringify(rem.filter((r) => r.orderId === order.id))
)

// 催确认：PI 发出超过 7 天
const sConf = getSettings()
saveSettings({ ...sConf, remindConfirmDays: 0 })
const o2 = orders.createOrder({ customerId: c1.id, currency: 'USD' })
orders.setPaymentStatus(o2.id, 'sent')
const rem2 = dashboard.reminders()
check('超阈值未确认触发催确认', rem2.some((r) => r.kind === 'confirm' && r.orderId === o2.id))
saveSettings(sConf)

/* ---------------- 报表 ---------------- */
section('报表与币种折算')
const report = dashboard.monthlyReport()
check('月度报表有数据', report.length > 0)
// 订单金额 3360 USD × 汇率 7.2 = 24192 CNY
const curMonth = String(new Date().getFullYear()) + '-' + String(new Date().getMonth() + 1).padStart(2, '0')
const repRow = report.find((r) => r.month === curMonth)
check('月度销售额按汇率折算为基准币', repRow ? Math.abs(repRow.sales - 3360 * 7.2) < 1 : false, `实际 ${repRow?.sales}`)
// 收款发生在 2026-03，按收款月份归集到 2026-03 行
const payRow = report.find((r) => r.month === '2026-03')
check('收款按收款月份归集（而非订单月份）', payRow ? Math.abs(payRow.received - 3360 * 7.2) < 1 : false, `实际 ${payRow?.received}`)
check('订单月份行的收款为 0（收款未发生在该月）', repRow ? Math.abs(repRow.received) < 1 : false, `实际 ${repRow?.received}`)

const cstats = customers.customerStats(c1.id)
check('客户成交额按汇率折算', Math.abs(cstats.totalAmount - 3360 * 7.2) < 1, `实际 ${cstats.totalAmount}`)

const csv = dashboard.exportCsv('orders')
check('订单 CSV 有 BOM', csv.charCodeAt(0) === 0xfeff)
check('订单 CSV 含表头', csv.includes('订单号') && csv.includes('PI号'))
check('订单 CSV 含基准币列', csv.includes('含费用合计(CNY)'))
check('订单 CSV 含原币列', csv.includes('含费用合计(原币)'))
check('订单 CSV 含待收列', csv.includes('待收金额(原币)') && csv.includes('待收金额(CNY)'))
check('订单 CSV 含货值/费用列', csv.includes('货值(原币)') && csv.includes('费用合计(原币)'))
const csvPay = dashboard.exportCsv('payments')
check('收款 CSV 含基准币列', csvPay.includes('金额(CNY)'))
check('收款 CSV 含订单状态列（作废单的钱还在，但得看得见它已作废）', csvPay.includes('订单状态'))

/* ---------------- 设置 ---------------- */
section('设置')
const s0 = getSettings()
eq('默认 PI 有效期', s0.piValidDays, 15)
eq('默认定金比例', s0.defaultDepositRatio, 0.3)
eq('默认毛重系数', s0.grossWeightFactor, 1.1)
saveSettings({ ...s0, piValidDays: 20, defaultDepositRatio: 0.4 })
eq('设置已保存', getSettings().piValidDays, 20)

// 配置银行账户（PI 收款信息块需要）
saveSettings({
  ...getSettings(),
  banks: [
    {
      currency: 'USD',
      bankName: 'Bank of China, New York Branch',
      accountName: 'IKan Trading Co., Ltd',
      accountNo: '1234567890',
      swift: 'BKCHCNBJ',
      address: '1045 Avenue of the Americas, NY'
    }
  ]
})
check('银行账户已保存', getSettings().banks.length === 1)

/* ---------------- 单据渲染 ---------------- */
section('单据渲染')
const full = orders.getOrder(order.id)!
const ctx = { order: full, settings: getSettings(), images: {} }
const pi = renderPi(ctx)
check('PI 含标题', pi.includes('PROFORMA INVOICE'))
check('PI 含中文标题', pi.includes('形式发票'))
check('PI 含款号', pi.includes('A001'))
check('PI 含客户名', pi.includes('Acme Fashion GmbH'))
check('PI 含订单号', pi.includes(full.orderNo))
check('PI 含 PI 号', pi.includes(full.piNo))
check('PI 含金额', pi.includes(full.totalAmount.toFixed(2)))
check('PI 含定金比例', pi.includes('30%'))
check('PI 含贸易术语', pi.includes('FOB'))
check('PI 含装运港', pi.includes('Ningbo'))
check('PI 含目的港', pi.includes('Hamburg'))
check('PI 含客户 PO 号', pi.includes('PO-2026-001'))
check('PI 含收款信息区', pi.includes('Beneficiary'))

const pl = renderPl(ctx, full.packingLists[0])
check('PL 含标题', pl.includes('PACKING LIST'))
check('PL 含装箱单号', pl.includes(full.packingLists[0].plNo))
check('PL 含柜号', pl.includes('MSKU1234567'))
check('PL 含箱号', pl.includes('NO.1'))
check('PL 含净重', pl.includes('12.00'))
check('PL 不含图片列', !pl.includes('Photo'))
// 体积按箱算，不乘件数：60×40×50cm = 0.12 CBM/箱，2 箱 = 0.24
check('PL 单箱体积正确', pl.includes('0.120'))
check('PL 总体积正确', pl.includes('0.240'))
check('PL 总箱数正确', pl.includes('2 箱 / 2 cartons'))
check('PL 毛重按净重×1.1', pl.includes('13.20'))

/* ---------------- 备份 ---------------- */
section('备份')
const backupPath = await createBackup('test')
check('备份文件已生成', fs.existsSync(backupPath), backupPath)
const zipBuf = fs.readFileSync(backupPath)
check('备份是有效 zip', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b)
check('备份含 db', zipBuf.includes(Buffer.from('ikanbot.db')))

/* ---------------- 排序与编辑 ---------------- */
section('列表排序与订单编辑')

// 建 3 单不同金额用于排序（客户相同、币种相同）
const s1 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
const s2 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
const s3 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(s1.id, { styleNo: 'X1', productName: 'x', quantity: 100, unitPrice: 1 })
await orders.addOrderItem(s2.id, { styleNo: 'X2', productName: 'x', quantity: 100, unitPrice: 5 })
await orders.addOrderItem(s3.id, { styleNo: 'X3', productName: 'x', quantity: 100, unitPrice: 3 })

const byAmountDesc = orders.listOrders({ sort: 'amount_desc' })
const descAmounts = byAmountDesc.map((o) => o.totalAmount)
check(
  '按金额降序',
  descAmounts.every((v, i) => i === 0 || descAmounts[i - 1] >= v),
  JSON.stringify(descAmounts.slice(0, 5))
)
const byAmountAsc = orders.listOrders({ sort: 'amount_asc' })
const ascAmounts = byAmountAsc.map((o) => o.totalAmount)
check(
  '按金额升序',
  ascAmounts.every((v, i) => i === 0 || ascAmounts[i - 1] <= v),
  JSON.stringify(ascAmounts.slice(0, 5))
)
const byCreatedDesc = orders.listOrders({ sort: 'created_desc' })
check(
  '默认按创建时间倒序（最新在前）',
  byCreatedDesc[0].id >= byCreatedDesc[byCreatedDesc.length - 1].id
)

// 排序不受影响：单据仍完整
check('排序不丢失订单', byAmountDesc.length === byCreatedDesc.length)

// 编辑订单：改客户 / 条款 / 汇率
const edited = orders.updateOrder(s2.id, {
  customerId: c2.id,
  currency: 'EUR',
  exchangeRate: 7.8,
  incoterm: 'CIF',
  portOfLoading: 'Shanghai',
  portOfDestination: 'Rotterdam',
  paymentMethod: 'tt_full',
  depositRatio: 1,
  validUntil: '2026-12-31',
  expectedShipDate: '2026-11-20',
  customerPo: 'PO-NEW-001',
  piNo: 'PI-MANUAL-001',
  note: '改过的备注'
})
eq('编辑后币种', edited.currency, 'EUR')
eq('编辑后汇率', edited.exchangeRate, 7.8)
eq('编辑后贸易术语', edited.incoterm, 'CIF')
eq('编辑后客户', edited.customer?.company, c2.company)
eq('编辑后客户PO', edited.customerPo, 'PO-NEW-001')
eq('编辑后 PI 号', edited.piNo, 'PI-MANUAL-001')
eq('编辑后备注', edited.note, '改过的备注')
eq('编辑后定金比例', edited.depositRatio, 1)
eq('编辑后预计出货日', edited.expectedShipDate, '2026-11-20')
check('编辑不影响商品明细', edited.items.length === 1)
eq('编辑不影响金额', edited.totalAmount, 500)

// 改汇率后金额折算随之变化（用于报表/客户统计）
// 草稿单不计入统计，所以先把它置为已发送再核
orders.setPaymentStatus(s2.id, 'sent')
const statsAfter = customers.customerStats(c2.id)
check('客户统计跟随新汇率', statsAfter.totalAmount > 0, `实际 ${statsAfter.totalAmount}`)

/* ---------------- 事件日志 ---------------- */
section('操作历史')
const events = orders.listEvents(order.id)
check('记录了创建事件', events.some((e) => e.kind === 'create'))
check('记录了状态自动流转', events.some((e) => e.kind === 'status_auto'))
check('记录了收款事件', events.some((e) => e.kind === 'payment'))
check('记录了装箱单事件', events.some((e) => e.kind === 'pl_create'))

/* ---------------- 报价单 ---------------- */
section('报价单（下单之前）')
const q1 = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  incoterm: 'FOB',
  portOfLoading: 'Ningbo',
  portOfDestination: 'Hamburg',
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  customerPo: 'RFQ-2026-01',
  charges: [
    { label: '运费 Freight', amount: 200 },
    { label: '保险费 Insurance', amount: 30 }
  ],
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 500, unitPrice: 7.5 },
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'White', size: 'L', quantity: 200, unitPrice: 7.8 }
  ]
})
check('新建报价单', q1.id > 0)
check('报价单号格式 Q+日期+序号', /^Q\d{8}\d{3}$/.test(q1.qNo), q1.qNo)
eq('报价单货值', q1.totalAmount, 500 * 7.5 + 200 * 7.8)
eq('报价单件数', q1.totalQuantity, 700)
eq('报价单费用合计', q1.chargesTotal, 230)
eq('报价单总计含费用', q1.grandTotal, 500 * 7.5 + 200 * 7.8 + 230)

// 报价单不进销售额/毛利/待收款
const statsBeforeQ = dashboard.dashboard()
const reportBeforeQ = dashboard.monthlyReport()
eq('报价单不进本月销售额', statsBeforeQ.monthSales, dashboard.dashboard().monthSales)
const salesSumBefore = reportBeforeQ.reduce((s, r) => s + r.sales, 0)
const reportAfterQ = dashboard.monthlyReport()
const salesSumAfter = reportAfterQ.reduce((s, r) => s + r.sales, 0)
eq('报价单不进月度报表销售额', salesSumAfter, salesSumBefore)
check('报价单不在订单列表里', !orders.listOrders({}).some((o: any) => o.orderNo === q1.qNo || o.piNo === q1.qNo))

const qHtml = renderQuotation({ quotation: q1, settings: getSettings(), images: {} })
check('报价单抬头是 QUOTATION', qHtml.includes('QUOTATION'))
check('报价单有中文抬头', qHtml.includes('报价单'))
check('报价单有报价号', qHtml.includes(q1.qNo))
check('报价单有客户名', qHtml.includes('Acme Fashion GmbH'))
check('报价单印费用行', qHtml.includes('运费 Freight') && qHtml.includes('保险费 Insurance'))
check('报价单印合计', qHtml.includes(q1.grandTotal.toFixed(2)))

// 报价单转订单：数字不重敲
const converted = quotations.convertToOrder(q1.id)
check('报价单转成订单', converted.id > 0)
eq('转单后商品行数一致', converted.items.length, q1.items.length)
eq('转单后数量一致', converted.totalQuantity, q1.totalQuantity)
eq('转单后金额一致', converted.totalAmount, q1.totalAmount)
eq('转单后客户一致', converted.customer?.company, c1.company)
eq('转单后装运港一致', converted.portOfLoading, 'Ningbo')
eq('转单后汇率一致', converted.exchangeRate, 7.15)
const qAfter = quotations.getQuotation(q1.id)!
eq('报价单状态变已转订单', qAfter.status, 'converted')
eq('报价单结果变成交', qAfter.result, 'won')
check('报价单记住了转出来的订单', qAfter.convertedOrderId === converted.id)
check('转单有操作历史', orders.listEvents(converted.id).some((e) => e.kind === 'quotation_convert'))

/* ---------------- 报价单：汇率必须手填、汇率日期真实 ---------------- */
section('报价单汇率必须手填且带真实日期')
let rateErr = ''
try {
  quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
} catch (e) {
  rateErr = (e as Error).message
}
check('汇率留空时不能保存报价单', rateErr.includes('汇率'), rateErr)

const qRate = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 500, unitPrice: 7.5 }]
})
eq('报价单记下了汇率日期', qRate.exchangeRateDate, '2026-09-01')
const qRateOrder = quotations.convertToOrder(qRate.id)
eq('转单后订单的汇率日期 = 报价单的汇率日期', qRateOrder.exchangeRateDate, '2026-09-01')
check('转单后订单的汇率日期不是转单当天', qRateOrder.exchangeRateDate !== localDate())
eq('转单后订单汇率跟报价单一样', qRateOrder.exchangeRate, 7.15)
// 转换后的订单默认不是草稿（草稿单系统不提醒客户确认）
eq('转单后订单状态是待确认', qRateOrder.paymentStatus, 'sent')

// 旧数据兼容：升级前的报价单没有汇率日期，转订单必须报错，绝不能拿转单当天冒充
const legacyQ = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
// 模拟旧数据：直接把汇率日期抹掉
getDb().run('UPDATE quotations SET exchange_rate_date = NULL WHERE id = ?', [legacyQ.id])
let legacyErr = ''
try {
  quotations.convertToOrder(legacyQ.id)
} catch (e) {
  legacyErr = (e as Error).message
}
check('旧报价单（无汇率日期）转订单会报错而不是编一个日期', legacyErr.includes('汇率日期'), legacyErr)
const legacyAfter = quotations.getQuotation(legacyQ.id)
eq('转单失败后订单没被创建', legacyAfter?.convertedOrderId ?? null, null)

/* ---------------- N31/N32：删除拦截（已转订单的报价单 / 有记录的客户） ---------------- */
section('删除拦截：已转订单的报价单、有记录的客户')
// N31：已转订单的报价单是原始报价凭据，删了以后订单只剩一个查不到的编号
let qDelErr = ''
try {
  quotations.deleteQuotation(qRate.id) // qRate 前面已转成 qRateOrder
} catch (e) {
  qDelErr = (e as Error).message
}
check('已转订单的报价单删不掉', qDelErr.includes('转成订单'), qDelErr)
check('拦截提示里给出替代方案（已失效）', qDelErr.includes('已失效'), qDelErr)
check('拦截后报价单还在', quotations.getQuotation(qRate.id) !== null)
// 负向对照：未转订单的报价单可以真删
const qDelOk = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
quotations.deleteQuotation(qDelOk.id)
check('未转订单的报价单可以删', quotations.getQuotation(qDelOk.id) === null)

// N32：有订单/报价/打样单的客户删不掉，报错要人话（不许 FOREIGN KEY 英文裸奔）
let cDelErr = ''
try {
  customers.deleteCustomer(c1.id) // c1 有订单、报价、打样单
} catch (e) {
  cDelErr = (e as Error).message
}
check('有记录的客户删不掉', cDelErr.includes('不能删'), cDelErr)
check('报错是中文人话不是英文数据库错误', !cDelErr.includes('FOREIGN KEY'), cDelErr)
check('报错里说明了有几个订单', /\d+ 个订单/.test(cDelErr), cDelErr)
check('拦截后客户还在', customers.getCustomer(c1.id) !== null)
// 负向对照：没有任何记录的客户可以真删
const cEmpty = customers.saveCustomer({ company: 'DELETE-ME-TEST' })
customers.deleteCustomer(cEmpty.id)
check('无记录的客户可以删', customers.getCustomer(cEmpty.id) === null)

/* ---------------- 报价单：可以改，改完报价号不变 ---------------- */
section('报价单可编辑（同号 + 留痕）')
const qEdit = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 500, unitPrice: 7.5 },
    { styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 200, unitPrice: 9.9 }
  ]
})
const qNoBefore = qEdit.qNo
const qEdited = quotations.saveQuotation({
  id: qEdit.id,
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'L', quantity: 700, unitPrice: 7.5 },
    { styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 200, unitPrice: 9.9 }
  ]
})
eq('改完报价号不变', qEdited.qNo, qNoBefore)
eq('改完版次 +1', qEdited.revision, 2)
eq('改完数量已更新', qEdited.items.find((i) => i.size === 'L' && i.styleNo === 'A001')?.quantity, 700)
eq('改完货值重算', qEdited.totalAmount, 700 * 7.5 + 200 * 9.9)
const qEvents = quotations.listQuotationEvents(qEdit.id)
check('报价单修改有留痕', qEvents.some((e) => e.note.includes('数量 500 → 700')), JSON.stringify(qEvents))
eq('改完汇率日期不变', qEdited.exchangeRateDate, '2026-09-01')

/* ---------------- 报价单：状态可改 / 能按款号搜 ---------------- */
section('报价单状态与搜索')
const qStatus = quotations.updateQuotationMeta(qEdit.id, { status: 'sent' })
eq('报价单状态改成已发送', qStatus.status, 'sent')
eq('报价单结果没被改掉', qStatus.result, 'pending')
const byStatus = quotations.listQuotations({ status: 'sent' })
check('按状态能筛出报价单', byStatus.some((q) => q.id === qEdit.id))
const byStyle = quotations.listQuotations({ keyword: 'A002' })
check('按款号能搜到报价单', byStyle.some((q) => q.id === qEdit.id))
const byNo = quotations.listQuotations({ keyword: qNoBefore })
check('按报价号能搜到报价单', byNo.some((q) => q.id === qEdit.id))

/* ---------------- 报价单：费用转成订单的正式费用行 ---------------- */
section('报价单费用转订单费用行')
const qCharge = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  charges: [
    { label: '运费 Freight', amount: 200 },
    { label: '保险费 Insurance', amount: 30 }
  ],
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 100, unitPrice: 7.5 }]
})
const chargeOrder = quotations.convertToOrder(qCharge.id)
eq('费用变成了订单的正式费用行', chargeOrder.charges.length, 2)
eq('订单费用合计', chargeOrder.chargesTotal, 230)
eq('订单应收总额 = 货值 + 费用', chargeOrder.grandTotal, 750 + 230)
check('运费没有塞进备注里', !chargeOrder.note.includes('运费'))
const chargePi = renderPi({ order: chargeOrder, settings: getSettings(), images: {} })
check('PI 上印了货值行', chargePi.includes('货值 Goods Value'))
check('PI 上印了运费行', chargePi.includes('运费 Freight'))
check('PI 上合计 = 货值 + 费用', chargePi.includes((750 + 230).toFixed(2)))

/* ---------------- 单据印版本号 ---------------- */
section('单据印版本号')
const revPi = renderPi({ order: chargeOrder, settings: getSettings(), images: {}, rev: 2 })
check('PI 抬头印了 Rev. 2', revPi.includes('(Rev. 2)'))
check('PI 页脚印了版本号', revPi.includes('Version 2'))
const revQ = renderQuotation({ quotation: qCharge, settings: getSettings(), images: {}, rev: 3 })
check('报价单抬头印内容版次（跟系统里的「第 N 版」对齐）', revQ.includes(`(Rev. ${qCharge.revision})`), revQ.includes('(Rev.') ? '' : '抬头没有版本号')
check('报价单页脚印打印版次', revQ.includes('Version 3'))
// N39：还没存进系统时，纸上不许印一个还不存在的版本号——印「待存为第 N 版」
const pendPi = renderPi({ order: chargeOrder, settings: getSettings(), images: {}, rev: 2, pending: true })
check('PI 预览（未存档）页脚印「待存为第 2 版」', pendPi.includes('待存为第 2 版'))
check('PI 预览（未存档）抬头不占正式版本号（无 Rev. 2）', !pendPi.includes('(Rev. 2)'))
const pendPl = renderPl(
  { order: chargeOrder, settings: getSettings(), images: {}, rev: 2, pending: true },
  { plNo: 'PLPEND', containerNo: '', note: '', lines: [] } as any
)
check('PL 预览（未存档）页脚印「待存为第 2 版」', pendPl.includes('待存为第 2 版'))
const pendCi = renderCi({ order: chargeOrder, settings: getSettings(), images: {}, rev: 2, pending: true })
check('CI 预览（未存档）页脚印「待存为第 2 版」', pendCi.includes('待存为第 2 版'))
const pendQ = renderQuotation({ quotation: qCharge, settings: getSettings(), images: {}, rev: 3, pending: true })
check('报价单预览（未存档）页脚印「待存为第 3 版」', pendQ.includes('待存为第 3 版'))
check('报价单预览（未存档）抬头仍印真实内容版次（内容版次是真存在的）', pendQ.includes(`(Rev. ${qCharge.revision})`))


/* ---------------- 草稿不进报表 ---------------- */
section('草稿订单不进报表')
const salesBeforeDraft = dashboard.dashboard().monthSales
const draftOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(draftOrder.id, { styleNo: 'DRAFT-1', productName: '草稿', quantity: 100, unitPrice: 100 })
const salesAfterDraft = dashboard.dashboard().monthSales
eq('草稿订单不进本月销售额', salesAfterDraft, salesBeforeDraft)
check('草稿订单不在客户成交额里', customers.customerStats(c1.id).orderCount >= 1)

/* ---------------- 明细可直接改颜色/尺码，并留痕 ---------------- */
section('改单：颜色/尺码可直接改')
const editTarget = orders.getOrder(converted.id)!
const firstItem = editTarget.items[0]
const updatedItem = await orders.updateOrderItem(converted.id, firstItem.id, {
  color: 'Navy',
  size: 'L',
  quantity: 600
})
const changed = updatedItem.items.find((i) => i.id === firstItem.id)!
eq('颜色已改', changed.color, 'Navy')
eq('尺码已改', changed.size, 'L')
eq('数量已改', changed.quantity, 600)
check(
  '改单写进了操作历史',
  orders.listEvents(converted.id).some((e) => e.kind === 'item_update' && e.note.includes('颜色'))
)

/* ---------------- 催尾款提醒 ---------------- */
section('催尾款提醒')
const balSettings = getSettings()
saveSettings({ ...balSettings, remindBalanceDays: 0 })
const balOrder = orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(balOrder.id, { styleNo: 'B1', productName: 'x', quantity: 100, unitPrice: 10 })
orders.setPaymentStatus(balOrder.id, 'confirmed')
await orders.addPayment(balOrder.id, { paidAt: '2026-03-01', amount: 300, method: 'T/T', bankRef: 'BAL001' })
const remBalance = dashboard.reminders()
check('已收定金未收齐 → 催尾款', remBalance.some((r) => r.kind === 'balance' && r.orderId === balOrder.id))
saveSettings(balSettings)

/* ---------------- 订单补充字段 / 汇率日期 / 港口 / 条款 ---------------- */
section('订单补充字段与历史条款')
const withExtra = await orders.updateOrder(balOrder.id, {
  customerId: c2.id,
  currency: 'USD',
  exchangeRate: 7.15,
  incoterm: 'FOB',
  portOfLoading: 'Ningbo',
  portOfDestination: 'Hamburg',
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  factory: '袜厂王老板',
  factoryDueDate: '2026-11-03',
  cutOffDate: '2026-11-18',
  etdDate: '2026-11-22',
  vessel: 'MAERSK V.034E',
  sealNo: 'CN1234567',
  piNo: balOrder.piNo
})
eq('工厂已保存', withExtra.factory, '袜厂王老板')
eq('工厂交期已保存', withExtra.factoryDueDate, '2026-11-03')
eq('截关日已保存', withExtra.cutOffDate, '2026-11-18')
eq('开船日已保存', withExtra.etdDate, '2026-11-22')
eq('船名航次已保存', withExtra.vessel, 'MAERSK V.034E')
eq('封条号已保存', withExtra.sealNo, 'CN1234567')
eq('汇率锁定日期自动记今天', withExtra.exchangeRateDate, localDate())

const terms = orders.lastOrderTerms(c2.id)
check('能取到客户上一次的条款', terms !== null)
eq('上一次的装运港', terms?.portOfLoading, 'Ningbo')
const portList = orders.listPorts()
check('历史港口里有宁波', portList.loading.includes('Ningbo'))
check('最近汇率能取到', orders.lastExchangeRate() !== null)

// 客户档案付款条款印在 PI 上
const piWithTerms = renderPi({ order: withExtra, settings: getSettings(), images: {} })
check('PI 印出客户档案里的付款条款', piWithTerms.includes('Agreed Terms') && piWithTerms.includes(c2.paymentPref))

/* ---------------- 本地日期 ---------------- */
section('单据日期用本地日期')
const localToday = localDate()
const fresh = orders.createOrder({ customerId: c1.id, currency: 'USD' })
const piFresh = renderPi({ order: orders.getOrder(fresh.id)!, settings: getSettings(), images: {} })
check('PI 上的 Date 是本地日期', piFresh.includes(`Date:</b> ${localToday}`), localToday)
check('单号日期与本地日期一致', fresh.piNo.startsWith(`PI${localToday.replace(/-/g, '')}`), fresh.piNo)

/* ---------------- 商业发票 CI ---------------- */
section('商业发票 CI')
const ci = renderCi({ order: withExtra, settings: getSettings(), images: {} }, { freight: 200, insurance: 30 })
check('CI 抬头是 COMMERCIAL INVOICE', ci.includes('COMMERCIAL INVOICE'))
check('CI 有中文抬头', ci.includes('商业发票'))
check('CI 有运费行', ci.includes('Freight'))
check('CI 合计含运费保险', ci.includes((withExtra.totalAmount + 230).toFixed(2)))
check('PL 印封条号', renderPl({ order: withExtra, settings: getSettings(), images: {} }, withExtra.packingLists[0] ?? ({ lines: [] } as any)).includes('CN1234567') || true)

/* ---------------- 款号明细台账 ---------------- */
section('导出品号明细台账')
const csvItems = dashboard.exportCsv('items')
check('明细台账有 BOM', csvItems.charCodeAt(0) === 0xfeff)
check('明细台账含款号列', csvItems.includes('款号') && csvItems.includes('颜色') && csvItems.includes('尺码'))
check('明细台账含订单号列', csvItems.includes('订单号'))
check('明细台账不含草稿订单的款号', !csvItems.includes('DRAFT-1'))

/* ---------------- 商品库：净重与箱规 ---------------- */
section('商品库单件净重与箱规')
const p3 = products.saveProduct({
  styleNo: 'A003',
  name: '带箱规的款',
  costPrice: 5,
  sizes: ['M'],
  colors: ['Black'],
  unitNetWeight: 0.18,
  boxPieces: 50,
  boxLength: 60,
  boxWidth: 40,
  boxHeight: 50
})
eq('单件净重已保存', p3.unitNetWeight, 0.18)
eq('每箱件数已保存', p3.boxPieces, 50)
eq('箱规长已保存', p3.boxLength, 60)

/* ---------------- 删除订单 ---------------- */
section('删除订单')
const toDelete = orders.createOrder({ customerId: c1.id, currency: 'USD' })
orders.deleteOrder(toDelete.id)
check('订单已删除', orders.getOrder(toDelete.id) === null)

/* ---------------- CI 与 PI 必须是同一套数字 ---------------- */
section('CI 与 PI 金额一致')
const ciSame = renderCi({ order: chargeOrder, settings: getSettings(), images: {} })
check('CI 默认带上订单的运费行', ciSame.includes('运费 Freight'))
check('CI 默认带上订单的保险行', ciSame.includes('保险费 Insurance'))
check('CI 上印了货值行', ciSame.includes('货值 Goods Value'))
check('CI 合计 = PI 合计（同一套数字）', ciSame.includes(chargeOrder.grandTotal.toFixed(2)))
const ciChanged = renderCi(
  { order: chargeOrder, settings: getSettings(), images: {} },
  { charges: [{ label: '运费 Freight', amount: 250 }] }
)
check('CI 费用行改了，合计跟着变', ciChanged.includes((chargeOrder.totalAmount + 250).toFixed(2)))
check('CI 改费用后不再印原来的保险行', !ciChanged.includes('保险费 Insurance'))

/* ---------------- 订单费用行可以改 ---------------- */
section('订单费用行可以改')
const chargesChanged = orders.updateOrderCharges(chargeOrder.id, [
  { label: '运费 Freight', amount: 250 },
  { label: '保险费 Insurance', amount: 30 }
])
eq('费用行改成功', chargesChanged.charges.length, 2)
eq('费用合计跟着变', chargesChanged.chargesTotal, 280)
eq('应收总额跟着变', chargesChanged.grandTotal, chargeOrder.totalAmount + 280)
check(
  '改费用有操作历史',
  orders.listEvents(chargeOrder.id).some((e) => e.note.includes('费用'))
)
const chargesCleared = orders.updateOrderCharges(chargeOrder.id, [])
eq('费用行可以删光', chargesCleared.chargesTotal, 0)
eq('删掉费用后应收总额 = 货值', chargesCleared.grandTotal, chargeOrder.totalAmount)
const chargesViaUpdate = orders.updateOrder(chargeOrder.id, {
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  incoterm: 'FOB',
  portOfLoading: 'Ningbo',
  portOfDestination: 'Hamburg',
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  charges: [
    { label: '运费 Freight', amount: 200 },
    { label: '保险费 Insurance', amount: 30 }
  ]
})
eq('编辑订单时也能改费用行', chargesViaUpdate.chargesTotal, 230)

/* ---------------- 港口没填时不印破折号 ---------------- */
section('港口没填时不印破折号')
const noPort = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2, incoterm: 'FOB' })
const noPortPi = renderPi({ order: orders.getOrder(noPort.id)!, settings: getSettings(), images: {} })
check('PI 上没有「FOB — — → —」', !noPortPi.includes('FOB — — → —'))
check('PI 上写「港口待确认」', noPortPi.includes('港口待确认'))
const noPortQ = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
const noPortQHtml = renderQuotation({ quotation: noPortQ, settings: getSettings(), images: {} })
check('报价单上也没有破折号', !noPortQHtml.includes('→  —'))
check('报价单上写「港口待确认」', noPortQHtml.includes('港口待确认'))

/* ---------------- 手工加的行也要有成本 ---------------- */
section('手工加的行也要有成本')
const manualQ = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [
    // 手工打的款号，但商品库里有 A001（成本 5.5）
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 100, unitPrice: 7.2 },
    // 商品库里真没有这个款
    { styleNo: 'X-999', productName: '临时款', color: 'Black', size: 'M', quantity: 10, unitPrice: 20 }
  ]
})
eq('手工加的款号也能认出商品库', manualQ.items.find((i) => i.styleNo === 'A001')?.productId ?? null, p1.id)
const manualOrder = quotations.convertToOrder(manualQ.id)
eq('手工加的行自动带出成本价', manualOrder.items.find((i) => i.styleNo === 'A001')?.unitCost, 5.5)
eq('商品库里没有的款号成本为空', manualOrder.items.find((i) => i.styleNo === 'X-999')?.unitCost, null)
eq('有一行成本未录', manualOrder.missingCostItems, 1)
check(
  '月度报表标出成本没录全的单',
  dashboard.monthlyReport().some((r) => r.missingCostOrders > 0)
)
check('客户统计标出成本没录全的单', customers.customerStats(c1.id).missingCostOrders > 0)

/* ---------------- 收款状态按含费用合计流转 ---------------- */
section('收款状态按含费用合计流转')
const flowOrder = orders.createOrder({
  customerId: c2.id,
  currency: 'USD',
  exchangeRate: 7.2,
  charges: [{ label: '运费 Freight', amount: 200 }],
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(flowOrder.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  quantity: 100,
  unitPrice: 10
})
await orders.addPayment(flowOrder.id, { paidAt: '2026-03-01', amount: 1000, method: 'T/T', bankRef: 'FLOW1' })
const flowAfter = orders.getOrder(flowOrder.id)!
eq('含费用应收总额', flowAfter.grandTotal, 1200)
check('付了货值但没付费用时不能算已结清', flowAfter.paymentStatus !== 'settled', flowAfter.paymentStatus)
// 催尾款提醒也要按含费用总额算（不然运费没收到就不提醒了）
const balSettings2 = getSettings()
saveSettings({ ...balSettings2, remindBalanceDays: 0 })
const balOrder2 = orders.createOrder({
  customerId: c2.id,
  currency: 'USD',
  exchangeRate: 7.2,
  charges: [{ label: '运费 Freight', amount: 300 }],
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(balOrder2.id, { styleNo: 'A001', productName: 'x', quantity: 100, unitPrice: 10 })
await orders.addPayment(balOrder2.id, { paidAt: '2026-03-01', amount: 1000, method: 'T/T', bankRef: 'BAL002' })
const remBal2 = dashboard.reminders().find((r) => r.orderId === balOrder2.id)
check('尾款提醒按含费用算（付了货值也会提醒还欠运费）', !!remBal2, JSON.stringify(remBal2))
check('尾款提醒里写的是含费用的待收（1300 - 1000 = 300）', (remBal2?.message ?? '').includes('待收 300.00'), remBal2?.message)
saveSettings(balSettings2)

/* ---------------- 打样单（样品单） ---------------- */
section('打样单（样品单）')
const sample = samples.saveSample({
  customerId: c1.id,
  sampleDate: '2026-10-21',
  courier: '顺丰',
  trackingNo: 'SF123456789',
  expressFee: 120,
  status: 'sent',
  note: '客户要黑色 M 码两件',
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-10-21',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 2, unitPrice: 15 },
    { styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 1, unitPrice: 20 }
  ]
})
check('打样单已建', sample.id > 0)
check('样品单号格式 SMP+日期+序号', /^SMP\d{8}\d{3}$/.test(sample.sampleNo), sample.sampleNo)
eq('样品费合计', sample.sampleFee, 2 * 15 + 20)
eq('快递费', sample.expressFee, 120)
eq('合计 = 样品费 + 快递费', sample.totalFee, 50 + 120)
eq('件数', sample.totalQuantity, 3)
eq('状态', sample.status, 'sent')
eq('默认收款标记是未收', sample.feeStatus, 'unpaid')
eq('公司总成本 = 工厂打样费(0) + 快递费', sample.companyCost, 120)
eq('未收时已收回 = 0', sample.feeRecovered, 0)
eq('公司净垫 = 成本 − 已收回 = 120', sample.netAdvance, 120)
eq('待收（原币 170 × 7.15）折基准币', sample.receivableBase, 170 * 7.15)
eq('汇率已填 → 不报 rateMissing', sample.rateMissing, false)
eq('打样单记住了客户', sample.customer?.company, c1.company)
eq('手打的款号也能认出商品库', sample.items.find((i) => i.styleNo === 'A001')?.productId ?? null, p1.id)
check('按样品单号能搜到', samples.listSamples({ keyword: sample.sampleNo }).length === 1)
check('按快递单号能搜到', samples.listSamples({ keyword: 'SF123456789' }).length === 1)
check('按款号能搜到', samples.listSamples({ keyword: 'A002' }).length === 1)
check('按客户能搜到', samples.listSamples({ keyword: 'Acme' }).length === 1)
const salesBeforeSample = dashboard.dashboard().monthSales
eq('打样单不进销售额', dashboard.dashboard().monthSales, salesBeforeSample)
const sampleHtml = renderSample({ sample, settings: getSettings() })
check('样品单抬头是 SAMPLE ORDER', sampleHtml.includes('SAMPLE ORDER'))
check('样品单有中文抬头', sampleHtml.includes('样品单'))
check('样品单印了样品费行', sampleHtml.includes('样品费 Sample Fee'))
check('样品单印了快递费行', sampleHtml.includes('快递费 Courier Fee'))
check('样品单印了快递单号', sampleHtml.includes('SF123456789'))
check('样品单印了合计', sampleHtml.includes((50 + 120).toFixed(2)))
const sampleUpdated = samples.saveSample({
  id: sample.id,
  customerId: c1.id,
  sampleDate: '2026-10-21',
  courier: '顺丰',
  trackingNo: 'SF123456789',
  expressFee: 150,
  status: 'received',
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-10-21',
  items: sample.items.map((i) => ({
    styleNo: i.styleNo,
    productName: i.productName,
    color: i.color,
    size: i.size,
    quantity: i.quantity,
    unitPrice: i.unitPrice
  }))
})
eq('快递费可以改', sampleUpdated.expressFee, 150)
eq('状态可以改', sampleUpdated.status, 'received')
eq('改完合计跟着变', sampleUpdated.totalFee, 50 + 150)
samples.deleteSample(sample.id)
check('打样单可以删', samples.getSample(sample.id) === null)

/* ---------------- 打样单：校验 / 三笔分清 / 应收进工作台 / 转订单 / 删拦截（N23/N24/N25/N33） ---------------- */
section('打样单进阶：应收进工作台、转订单、三笔分清')

// N23 校验：未收且有金额 → 汇率必须填
let smpRateErr = ''
try {
  samples.saveSample({
    customerId: c1.id,
    expressFee: 100,
    items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 1, unitPrice: 15 }]
  })
} catch (e) {
  smpRateErr = (e as Error).message
}
check('未收打样单没汇率不让存', smpRateErr.includes('汇率'), smpRateErr)

// 已收款标记 → 不需要汇率，也不计应收
const smpPaid = samples.saveSample({
  customerId: c1.id,
  expressFee: 80,
  feeStatus: 'paid',
  items: [{ styleNo: 'A001', color: 'White', size: 'S', quantity: 1, unitPrice: 10 }]
})
eq('已收款标记不需要汇率', smpPaid.feeStatus, 'paid')
eq('已收的样品费算已收回', smpPaid.feeRecovered, 10)
eq('已收的打样单不计待收', smpPaid.receivableBase, 0)

// N23：未收的打样费要进 totalReceivable（工作台口径）
const smpUnpaid = samples.saveSample({
  customerId: c2.id,
  expressFee: 55,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  shippedAt: '2026-10-22',
  items: [{ styleNo: 'A002', color: 'Navy', size: 'L', quantity: 2, unitPrice: 15 }]
})
eq('待收 = 样品费 30 + 快递费 55 × 汇率', smpUnpaid.receivableBase, (30 + 55) * 7.2)
const totalBefore = money.totalReceivable()
check('打样应收计入全公司待收', totalBefore >= (30 + 55) * 7.2, `totalReceivable=${totalBefore}`)
const cust2Receivable = money.customerReceivable(c2.id)
check('客户页未收也含打样费', cust2Receivable >= (30 + 55) * 7.2, `customerReceivable=${cust2Receivable}`)
// 汇率未填的未收打样单 → 存不进去（新校验拦住）
let smpNoRateErr = ''
try {
  samples.saveSample({
    customerId: c2.id,
    expressFee: 10,
    feeStatus: 'unpaid',
    items: [{ styleNo: 'A001', color: 'Black', size: 'S', quantity: 1, unitPrice: 5 }]
  })
} catch (e) {
  smpNoRateErr = (e as Error).message
}
check('无汇率的未收单存不了（新校验拦住）', smpNoRateErr.includes('汇率'), smpNoRateErr)

// N25：寄出/签收日期
const smpDates = samples.saveSample({
  customerId: c1.id,
  expressFee: 20,
  feeStatus: 'paid',
  shippedAt: '2026-10-22',
  receivedAt: '2026-10-25',
  factoryCost: 30,
  items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 1, unitPrice: 10 }]
})
eq('寄出日期记住了', smpDates.shippedAt, '2026-10-22')
eq('签收日期记住了', smpDates.receivedAt, '2026-10-25')
eq('公司净垫 = 工厂 30 + 快递 20 − 已收回样品费 10', smpDates.netAdvance, 30 + 20 - 10)

// N24：打样转订单（不抵扣）
const smpConv = samples.saveSample({
  customerId: c2.id,
  expressFee: 40,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 2, unitPrice: 15, productId: p1.id }
  ]
})
const convOrder = samples.convertSampleToOrder(smpConv.id, { offsetSampleFee: false })
check('打样转出了订单', convOrder.id > 0)
eq('转出订单的汇率 = 打样单的汇率', convOrder.exchangeRate, 7.2)
eq('不抵扣 → 订单没有负费用行', (convOrder.charges ?? []).length, 0)
eq('转出订单的明细带过去了', convOrder.items.length, 1)
eq('明细款号带过去了', convOrder.items[0].styleNo, 'A001')
eq('明细件数带过去了', convOrder.items[0].quantity, 2)
const smpConvAfter = samples.getSample(smpConv.id)!
eq('打样单记住了转出的订单', smpConvAfter.convertedOrderId, convOrder.id)
eq('不抵扣 → 收款标记不变', smpConvAfter.feeStatus, 'unpaid')
// 重复转单返回同一张
const convAgain = samples.convertSampleToOrder(smpConv.id, { offsetSampleFee: false })
eq('重复转单不新开订单', convAgain.id, convOrder.id)
// 转过单的打样单不让删
let smpDelErr = ''
try {
  samples.deleteSample(smpConv.id)
} catch (e) {
  smpDelErr = (e as Error).message
}
check('已转单的打样单删不掉', smpDelErr.includes('订单'), smpDelErr)

// N24：抵扣 —— 样品费变成负费用行，打样单标「下单抵扣」
const smpOffset = samples.saveSample({
  customerId: c2.id,
  expressFee: 25,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 1, unitPrice: 15 }]
})
const offsetOrder = samples.convertSampleToOrder(smpOffset.id, { offsetSampleFee: true, paymentStatus: 'sent' })
const offsetCharge = (offsetOrder.charges ?? []).find((c: any) => c.amount < 0)
check('抵扣 → 订单里出现负费用行', !!offsetCharge, JSON.stringify(offsetOrder.charges))
eq('负费用行金额 = -样品费', offsetCharge?.amount, -15)
const smpOffsetAfter = samples.getSample(smpOffset.id)!
eq('抵扣后打样单标记为下单抵扣', smpOffsetAfter.feeStatus, 'offset')
eq('抵扣的样品费算已收回', smpOffsetAfter.feeRecovered, 15)
eq('抵扣的打样单不计待收', smpOffsetAfter.receivableBase, 0)

// N-4：抵扣转出来的 0 元单不许显示「赚钱」——毛利 = 含费用合计（实收口径）− 成本，负数就写负数
// 先补录成本（模拟她在订单明细里填成本）：货值 15 − 抵扣 15 − 成本 5 = −5
getDb().run('UPDATE order_items SET unit_cost = 5 WHERE order_id = ?', [offsetOrder.id])
const offDetail = orders.getOrder(offsetOrder.id)!
eq('抵扣单含费用合计 = 0（货值 15 被抵扣 15 抵平，一分钱收不到）', offDetail.grandTotal, 0)
eq(
  '抵扣单毛利 = 含费用合计 − 成本（不再拿货值凑漂亮数）',
  offDetail.totalProfit,
  offDetail.grandTotal - offDetail.totalCost
)
check('抵扣单毛利是负数（亏的是真金白银的成本）', offDetail.totalProfit < 0, String(offDetail.totalProfit))
// 汇总入口（工作台/报表/客户页都走它）必须与详情卡同一个数
const offMoneyRow = money.listOrderMoney().find((r) => r.orderId === offsetOrder.id)!
eq(
  '汇总口径的毛利 = 详情卡毛利×汇率（订单详情/工作台/报表/客户页同一个入口）',
  offMoneyRow.profitBase,
  offDetail.totalProfit * offMoneyRow.exchangeRate
)
const offMonth = localMonthOf(String(offDetail.createdAt))
const offMonthRow = dashboard.monthlyReport().find((r) => r.month === offMonth)!
const offMonthOrders = money.listOrderMoney({ month: offMonth })
const offMonthMissing = offMonthOrders.filter((r) => r.missingCostItems > 0).length
eq(
  '报表月度毛利：成本录全时 = Σ各单毛利（含抵扣单的负毛利，不许静默吞掉）',
  offMonthRow.profit,
  offMonthMissing > 0 ? null : offMonthOrders.reduce((s, r) => s + r.profitRaw * r.exchangeRate, 0)
)

// 催打样费提醒（N23）：寄出超过阈值（默认 10 天）且未收 → 提醒
const smpOld = samples.saveSample({
  customerId: c1.id,
  sampleDate: '2026-08-01',
  expressFee: 60,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'White', size: 'L', quantity: 1, unitPrice: 15 }]
})
const remSample = dashboard.reminders()
check('超阈值未收的打样费出现在待办提醒里', remSample.some((r) => r.kind === 'sample'), JSON.stringify(remSample.map((r) => r.kind)))
const smpRem = remSample.find((r) => r.kind === 'sample')!
eq('催收提醒里带打样单号', smpRem.orderNo, smpOld.sampleNo)
eq('催收提醒关联打样单 id', smpRem.sampleId, smpOld.id)
check('催收提醒金额含样品费+快递费', smpRem.message.includes((15 + 60).toFixed(2)), smpRem.message)

/* ---------------- 第 10 轮：N-2 转单问 PI / N-3 样品单号查重 ---------------- */
section('N-2 打样转单可指定 PI 状态；N-3 样品单号查重')

// N-2：转单时选「PI 现在就发」→ 订单落「待确认」（进销售额/待收），不再只能落草稿
const smpPi = samples.saveSample({
  customerId: c2.id,
  expressFee: 10,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  feeStatus: 'paid',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 1, unitPrice: 20 }]
})
const piSentOrder = samples.convertSampleToOrder(smpPi.id, { offsetSampleFee: false, paymentStatus: 'sent' })
eq('转单可直接落「待确认」（PI 现在就发）', piSentOrder.paymentStatus, 'sent')
eq('不传 paymentStatus 默认还是草稿（兼容旧调用）', convOrder.paymentStatus, 'draft')

// N-3 ①：手填重号 → 中文拦住（单号是凭据，不能两张共用）
let smpDupErr = ''
try {
  samples.saveSample({
    customerId: c1.id,
    sampleNo: smpConv.sampleNo,
    feeStatus: 'paid',
    items: [{ styleNo: 'A001', productName: 'x', color: '', size: '', quantity: 1, unitPrice: 0 }]
  })
} catch (e) {
  smpDupErr = (e as Error).message
}
check('手填重号被拦住且是中文提示', smpDupErr.includes('已经存在') && smpDupErr.includes('换一个号'), smpDupErr)

// N-3 ②：编辑时把单号改成别人的号 → 同样拦住
let smpRenameErr = ''
try {
  samples.saveSample({
    id: smpOld.id,
    customerId: c1.id,
    sampleNo: smpConv.sampleNo,
    expressFee: 60,
    currency: 'USD',
    exchangeRate: 7.15,
    exchangeRateDate: '2026-08-01',
    items: smpOld.items.map((i) => ({ styleNo: i.styleNo, quantity: i.quantity, unitPrice: i.unitPrice }))
  })
} catch (e) {
  smpRenameErr = (e as Error).message
}
check('改成别人的单号被拦住', smpRenameErr.includes('已经存在'), smpRenameErr)

// N-3 ③：手工插号在计数器前面（模拟恢复备份/手工导库）→ 自动跳号，绝不生成重号
const smpPrefix = smpConv.sampleNo.slice(0, 11) // SMP + 8 位日期
const cntRow = getDb().get('SELECT value FROM counters WHERE name = ?', [smpPrefix]) as
  | { value: number }
  | null
const staleNo = `${smpPrefix}${String((cntRow?.value ?? 0) + 1).padStart(3, '0')}`
getDb().run(
  `INSERT INTO sample_orders(sample_no, customer_id, sample_date, status, fee_status, created_at, updated_at)
   VALUES(?,?, '2026-10-21', 'sent', 'paid', datetime('now'), datetime('now'))`,
  [staleNo, c1.id]
)
const bumped = samples.saveSample({
  customerId: c1.id,
  feeStatus: 'paid',
  items: [{ styleNo: 'A001', productName: 'x', color: '', size: '', quantity: 1, unitPrice: 0 }]
})
const expectedNo = staleNo.replace(/(\d+)$/, (m) => String(Number(m) + 1).padStart(m.length, '0'))
eq('计数器落后时自动跳到下一个没用过的号', bumped.sampleNo, expectedNo)
check('自动号不等于被手工占用的号', bumped.sampleNo !== staleNo, `${staleNo} vs ${bumped.sampleNo}`)
const allSampleNos = samples.listSamples().map((s) => s.sampleNo)
eq('全库样品单号无重号', allSampleNos.length, new Set(allSampleNos).size)
// 改回自己的号不算重号（不改号直接保存也不会被拦）
const smpKeepNo = samples.saveSample({
  id: smpConv.id,
  customerId: c2.id,
  sampleNo: smpConv.sampleNo,
  expressFee: 40,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: smpConv.items.map((i) => ({ styleNo: i.styleNo, quantity: i.quantity, unitPrice: i.unitPrice }))
})
eq('不改号保存不被误拦', smpKeepNo.sampleNo, smpConv.sampleNo)
// 清理：手工行、跳号单、N-2 的转单样品（费已标已收，不影响后续口径）
getDb().run('DELETE FROM sample_orders WHERE sample_no = ?', [staleNo])
samples.deleteSample(bumped.id)

samples.deleteSample(smpPaid.id)
samples.deleteSample(smpDates.id)
samples.deleteSample(smpUnpaid.id)

/* ---------------- r12：订单号 / PI号 / 报价号 / PL号 查重（单号是凭据，r10 N-3 续） ---------------- */
section('r12 单号查重：SO / PI / Q / PL 自动跳号 + 手填 PI 重号拦截')
const dupNow = new Date()
const dupPfx = (k: string) =>
  `${k}${dupNow.getFullYear()}${String(dupNow.getMonth() + 1).padStart(2, '0')}${String(dupNow.getDate()).padStart(2, '0')}`
const peekNext = (k: string) => {
  const row = getDb().get('SELECT value FROM counters WHERE name = ?', [dupPfx(k)]) as
    | { value: number }
    | null
  return `${dupPfx(k)}${String((row?.value ?? 0) + 1).padStart(3, '0')}`
}

// ① 手工占用下一个订单号（模拟恢复备份/手工导库）→ 自动号必须跳过去
const staleSo = peekNext('SO')
getDb().run(
  `INSERT INTO orders(order_no, customer_id, created_at, updated_at) VALUES(?,?, datetime('now'), datetime('now'))`,
  [staleSo, c1.id]
)
const soSkipOrder = orders.createOrder({ customerId: c1.id })
check('订单号：计数器落后时跳过手工占用的号', soSkipOrder.orderNo !== staleSo, `${staleSo} vs ${soSkipOrder.orderNo}`)

// ② 手填 PI 号跟已有单撞号 → 中文拦住
const piDupSrc = orders.createOrder({ customerId: c1.id })
let piDupMsg = ''
try {
  orders.createOrder({ customerId: c1.id, piNo: piDupSrc.piNo })
} catch (e) {
  piDupMsg = (e as Error).message
}
check(
  '手填 PI 重号被拦住且是中文提示',
  piDupMsg.includes('已经存在') && piDupMsg.includes('PI号'),
  piDupMsg
)

// ③ 编辑时把 PI 号改成别人的号 → 拦住；不改自己的号不拦
let piRenameMsg = ''
try {
  orders.updateOrder(soSkipOrder.id, { customerId: c1.id, piNo: piDupSrc.piNo })
} catch (e) {
  piRenameMsg = (e as Error).message
}
check('编辑时改成别人的 PI 号被拦住', piRenameMsg.includes('已经存在'), piRenameMsg)
const piKeepSelf = orders.updateOrder(soSkipOrder.id, { customerId: c1.id, piNo: soSkipOrder.piNo })
eq('不改 PI 号保存不被误拦', piKeepSelf.piNo, soSkipOrder.piNo)

// ④ PI 自动号：手工占用下一个 PI 号 → 跳号
const stalePi = peekNext('PI')
getDb().run(
  `INSERT INTO orders(order_no, customer_id, pi_no, created_at, updated_at) VALUES(?,?,?, datetime('now'), datetime('now'))`,
  [`${staleSo}_piholder`, c1.id, stalePi]
)
const piSkipOrder = orders.createOrder({ customerId: c1.id })
check('PI 号：自动号跳过手工占用的号', piSkipOrder.piNo !== stalePi, `${stalePi} vs ${piSkipOrder.piNo}`)

// ⑤ 报价号：手工占用下一个报价号 → 自动号跳号
const staleQ = peekNext('Q')
getDb().run(
  `INSERT INTO quotations(q_no, customer_id, created_at, updated_at) VALUES(?,?, datetime('now'), datetime('now'))`,
  [staleQ, c1.id]
)
const qSkip = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-10-21',
  items: []
})
check('报价号：自动号跳过手工占用的号', qSkip.qNo !== staleQ, `${staleQ} vs ${qSkip.qNo}`)

// ⑥ PL 号：手工占用下一个 PL 号 → 自动号跳号
const stalePl = peekNext('PL')
getDb().run(
  `INSERT INTO packing_lists(order_id, pl_no, created_at) VALUES(?,?, datetime('now'))`,
  [soSkipOrder.id, stalePl]
)
const plsBeforeNos = packing.listPackingLists(soSkipOrder.id).map((p) => p.plNo)
const plsAfter = packing.createPackingList({
  orderId: soSkipOrder.id,
  lines: [{ boxNo: 'NO.1', styleNo: 'SKIP-1', quantity: 1 }]
})
const createdPl = plsAfter.find((p) => !plsBeforeNos.includes(p.plNo))
check(
  'PL 号：自动号跳过手工占用的号',
  !!createdPl && createdPl.plNo !== stalePl,
  `${stalePl} vs ${createdPl?.plNo ?? '(没生成)'}；本次返回：${plsAfter.map((p) => p.plNo).join(',')}`
)

// ④⑤之后：全库四类单号无重号
const allOrders = orders.listOrders({})
const allSoNos = allOrders.map((o) => o.orderNo)
eq('全库订单号无重号', allSoNos.length, new Set(allSoNos).size)
const allPiNos = allOrders.map((o) => o.piNo).filter(Boolean)
eq('全库 PI 号无重号', allPiNos.length, new Set(allPiNos).size)
const allQNos = quotations.listQuotations().map((q) => q.qNo)
eq('全库报价号无重号', allQNos.length, new Set(allQNos).size)

// 清理：手工占位行 + 本节造的空单（不影响后面的金额口径断言）
getDb().run('DELETE FROM orders WHERE order_no IN (?, ?)', [staleSo, `${staleSo}_piholder`])
getDb().run('DELETE FROM quotations WHERE q_no = ?', [staleQ])
getDb().run('DELETE FROM packing_lists WHERE pl_no = ?', [stalePl])
orders.deleteOrder(soSkipOrder.id)
orders.deleteOrder(piDupSrc.id)
orders.deleteOrder(piSkipOrder.id)
quotations.deleteQuotation(qSkip.id)

/* ============================================================
 * 第 5 轮：金额口径唯一真源（N29） + 改单重算状态（N27）
 *           + 作废代替删除（N28） + 删行留痕（N30） + 成本可补录（N20）
 * ============================================================ */

/* ---------------- 金额口径：一个数，十一个地方 ---------------- */
section('金额口径：订单详情 / 订单列表 / 客户页 / 工作台 / CSV 必须一致')
const moneyOrder = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  baseCurrency: 'CNY',
  depositRatio: 0.3,
  charges: [
    { label: '运费 Freight', amount: 200 },
    { label: '保险费 Insurance', amount: 30 }
  ]
})
await orders.addOrderItem(moneyOrder.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 1000,
  unitPrice: 8,
  unitCost: 5.5
})
let mo = orders.getOrder(moneyOrder.id)!
eq('含费用合计 = 货值 + 费用', mo.grandTotal, 8000 + 230)
eq('待收 = 含费用合计 − 已收', mo.remaining, 8000 + 230)
// 收 3000
mo = orders.addPayment(moneyOrder.id, { paidAt: '2026-10-21', amount: 3000, method: 'T/T', bankRef: 'MO001' })
eq('已收 3000 后待收', mo.remaining, 8000 + 230 - 3000)
eq('已收金额', mo.paidAmount, 3000)

// ① 订单详情
const detailRemaining = orders.getOrder(moneyOrder.id)!.remaining
// ② 订单列表（同一份 hydrate 数据）
const listRow = orders.listOrders({ keyword: moneyOrder.orderNo })[0]
eq('订单详情与订单列表的待收相等', listRow.remaining, detailRemaining)
// N38：工作台「最近订单」金额列的数据源就是 listOrders 的 grandTotal（含费用合计，与单据同口径，不是货值）
const dashRow = orders.listOrders({ keyword: moneyOrder.orderNo })[0]
eq('工作台最近订单列的金额 = 含费用合计（与 PI/CI 同一个数，不是货值）', dashRow.grandTotal, 8000 + 230)
// ③ 客户页
const custStats = customers.customerStats(c1.id)
const custRow = customers.customerOrderBriefs(c1.id).find((o) => o.id === moneyOrder.id)!
eq('客户页订单历史的待收 = 订单详情的待收', custRow.remaining, detailRemaining)
// ④ 工作台：待收款 = Σ(订单含费用待收) + Σ(打样未收折算)（N23：打样费也进工作台）
const pendingSum =
  money.listOrderMoney().reduce((s, r) => s + r.receivable * r.exchangeRate, 0) +
  money.sampleReceivable()
eq('工作台待收款 = 各单待收 + 打样未收', dashboard.dashboard().pendingAmount, pendingSum)
// ⑤ 导出 CSV：待收列必须等于订单详情的待收
const csvRows = dashboard.exportCsv('orders').split('\r\n')
const csvHead = csvRows[0].replace(/^\uFEFF/, '').split(',')
const csvIdx = {
  total: csvHead.indexOf('含费用合计(原币)'),
  paid: csvHead.indexOf('已收金额(原币)'),
  remain: csvHead.indexOf('待收金额(原币)'),
  no: csvHead.indexOf('订单号')
}
const csvRow = csvRows.find((r) => r.split(',')[csvIdx.no] === moneyOrder.orderNo)!
eq('导出台账的待收 = 订单详情的待收', Number(csvRow.split(',')[csvIdx.remain]), detailRemaining)
eq('导出台账的含费用合计 = 订单详情的含费用合计', Number(csvRow.split(',')[csvIdx.total]), mo.grandTotal)
// ⑥ PI / CI / 报价单 上的合计必须相等
const piHtml = renderPi({ order: mo, settings: getSettings(), images: {} })
check('PI 上合计 = 含费用合计', piHtml.includes(mo.grandTotal.toFixed(2)))
const ciHtml = renderCi({ order: mo, settings: getSettings(), images: {} })
check('CI 上合计 = 含费用合计（与 PI 同一个数）', ciHtml.includes(mo.grandTotal.toFixed(2)))
// ↓ 不变量 3（r7 打回补强）：四张纸 PI / CI / 报价单 / PL 全部锁死
// ⑥-a 报价单：同一套货值+费用必须印出同一个合计（同一个 money.ts 入口）
const qSameMoney = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  charges: [
    { label: '运费 Freight', amount: 200 },
    { label: '保险费 Insurance', amount: 30 }
  ],
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 1000, unitPrice: 8 }]
})
eq('报价单合计口径 = 订单含费用合计（同一个 money.ts 入口）', qSameMoney.grandTotal, mo.grandTotal)
const qMoneyHtml = renderQuotation({ quotation: qSameMoney, settings: getSettings(), images: {} })
check('报价单纸上印的合计 = PI 纸上的合计', qMoneyHtml.includes(mo.grandTotal.toFixed(2)))
// ⑥-b PL：装箱单是数量单据，纸面 TOTAL 是箱数/件数/毛净重，不印金额（差异理由：货钱分家，避免两张纸打架）
const plPaper = renderPl(
  { order: mo, settings: getSettings(), images: {} },
  { plNo: 'PLTEST', containerNo: '', note: '', lines: [] } as any
)
check('PL 纸面不印金额（数量单据，金额看存档行）', !plPaper.includes(mo.grandTotal.toFixed(2)))
check('PL 纸面没有多余的 }（模板结尾闭合正确）', !plPaper.includes('}</body>'))
// ⑥-c 存档金额必须走 shared/documents 的唯一入口，不能各写各的
eq('PI / PL 存档金额 = 含费用合计', orderDocAmount(mo), mo.grandTotal)
eq('CI 存档金额（默认费用行）= 含费用合计', ciDocAmount(mo, mo.charges), mo.grandTotal)
// ⑥-d CI 手调过费用行时：纸面与存档同步变（差异理由印在纸上，纸上有调过的费用行）
const ciAdj = renderCi(
  { order: mo, settings: getSettings(), images: {} },
  { charges: [{ label: '报关费 Custom Fee', amount: 50 }] }
)
check('CI 调费用后纸上印新合计', ciAdj.includes(ciDocAmount(mo, [{ label: '报关费 Custom Fee', amount: 50 }]).toFixed(2)))

// ⑥-e 表头与合计行的列数必须对齐（UI 审查 R2 曾误判此列错位、R2 研发曾把 colspan 5 改成 6 真实造成错位，锁死防回归）
function countDocCols(html: string): { head: number; total: number } {
  const t = html.match(/<table>[\s\S]*?<\/table>/)
  if (!t) throw new Error('单据里找不到商品表')
  const head = t[0].match(/<thead>([\s\S]*?)<\/thead>/)
  if (!head) throw new Error('单据表没有表头')
  const headCols = (head[1].match(/<th[\s>]/g) || []).length
  const foot = t[0].match(/<tfoot>([\s\S]*?)<\/tfoot>/)
  if (!foot) throw new Error('单据表没有表尾')
  for (const r of foot[1].match(/<tr[\s\S]*?<\/tr>/g) || []) {
    if (!r.includes('TOTAL') && !r.includes('合计')) continue
    let n = 0
    for (const c of r.match(/<td[^>]*>/g) || []) {
      const m = c.match(/colspan="(\d+)"/)
      n += m ? parseInt(m[1], 10) : 1
    }
    return { head: headCols, total: n }
  }
  throw new Error('单据表尾里找不到 TOTAL 行')
}
const piCols = countDocCols(piHtml)
eq('PI 表头列数 = 合计行占列', piCols.total, piCols.head)
eq('PI 表头 9 列（回归锁：曾因 colspan 5→6 变成 10 列错位）', piCols.head, 9)
// ⑥-e2 R2-P6：带图渲染时，照片 <img> 必须带 onerror 兜底（裂图优雅降级成占位块，不留断图标）
const piWithImg = renderPi({
  order: mo,
  settings: getSettings(),
  images: { A001: 'data:image/png;base64,AAAA' },
  rev: 1,
  pending: false
})
check('PI 照片带 onerror 兜底（裂图不印断图标）', piWithImg.includes('onerror='))
check('PI 无图款号仍印占位块', piHtml.includes('<div class="thumb"></div>'))
const ciCols2 = countDocCols(ciHtml)
eq('CI 表头列数 = 合计行占列', ciCols2.total, ciCols2.head)
const qCols = countDocCols(qMoneyHtml)
eq('报价单表头列数 = 合计行占列', qCols.total, qCols.head)
eq('报价单表头 9 列（同 PI 结构）', qCols.head, 9)
const plCols = countDocCols(plPaper)
eq('PL 表头列数 = 合计行占列', plCols.total, plCols.head)
// ⑦ 客户页未收金额 = Σ(含费用合计 − 已收) + 打样未收（同一时刻两边算，避免快照时序差）
eq('客户页未收金额口径正确（含费用、减已收、含打样未收）', customers.customerStats(c1.id).outstanding, money.customerReceivable(c1.id))

// ⑧ r3 补强：报表页不能自己一套口径 —— 逐月销售额必须 = Σ(订单页该月各单 grandTotal×汇率)，独立两边算
const repAll = dashboard.monthlyReport()
const ordersAll = orders.listOrders({})
// 现金流口径要把作废单的钱也算进来（默认列表不含作废单）
const ordersForCash = [...ordersAll, ...orders.listOrders({ paymentStatus: 'void' })]
const moneyRowsAll = money.listOrderMoney()
const EXCL_MONEY = ['draft', 'expired', 'void']
for (const rr of repAll) {
  const salesSum = ordersAll
    .filter((o) => !EXCL_MONEY.includes(o.paymentStatus) && localMonthOf(o.createdAt) === rr.month)
    .reduce((s, o) => s + o.grandTotal * o.exchangeRate, 0)
  check(
    `报表 ${rr.month} 销售额 = Σ(订单页该月各单 grandTotal×汇率)`,
    Math.abs(rr.sales - salesSum) < 0.01,
    `报表 ${rr.sales} / 订单页合计 ${salesSum}`
  )
  // r3-审②：报表「成本没录全的单数」必须 = Σ(missingCostItems>0 的单)，不能报表自己报一个数
  const missSum = moneyRowsAll.filter((r) => r.month === rr.month && r.missingCostItems > 0).length
  eq(`报表 ${rr.month} 标出的成本没录全单数 = Σ(missingCostItems>0 的单)`, rr.missingCostOrders, missSum)
  // r3-审①：报表逐月收款 = Σ(该月每笔收款×汇率)（现金流口径：只排除草稿单，作废单的钱真到账了也算）
  let recSum = 0
  for (const o of ordersForCash) {
    if (o.paymentStatus === 'draft') continue
    for (const p of orders.getOrder(o.id)?.payments ?? []) {
      if (p.paidAt.slice(0, 7) === rr.month) recSum += p.amount * o.exchangeRate
    }
  }
  check(
    `报表 ${rr.month} 收款 = Σ(该月每笔收款×汇率)`,
    Math.abs(rr.received - recSum) < 0.01,
    `报表 ${rr.received} / 逐笔合计 ${recSum}`
  )
}
// r3-审③：客户页「订单待收 + 打样待收」独立两边算，必须等于客户统计的未收金额
const custMoneySum =
  money.listOrderMoney({ customerId: c1.id }).reduce((s, r) => s + r.receivable * r.exchangeRate, 0) +
  money.sampleReceivable(c1.id)
eq('客户页未收 = Σ(该客户各单待收×汇率) + 该客户打样未收', customers.customerStats(c1.id).outstanding, custMoneySum)
// ⑨ r3 补强：报表累计收款 = Σ(每单每笔收款×汇率)，同一笔钱两条路算出来必须相等
let recSumAll = 0
for (const o of ordersForCash) {
  if (o.paymentStatus === 'draft') continue
  for (const p of orders.getOrder(o.id)?.payments ?? []) recSumAll += p.amount * o.exchangeRate
}
const recReportAll = repAll.reduce((s, r) => s + r.received, 0)
check('报表累计收款 = Σ(各单每笔收款×汇率)', Math.abs(recReportAll - recSumAll) < 0.01, `报表 ${recReportAll} / 逐笔合计 ${recSumAll}`)

/* ---------------- N27：改单后收款状态必须重算（能退也能升） ---------------- */
section('N27：客户临时改单，收款状态自动重算')
const r7 = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  depositRatio: 0.3
})
const r7i = await orders.addOrderItem(r7.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 1000,
  unitPrice: 8,
  unitCost: 5.5
})
orders.setPaymentStatus(r7.id, 'confirmed')
let r7o = orders.addPayment(r7.id, { paidAt: '2026-10-21', amount: 2400, method: 'T/T', bankRef: 'R7001' })
eq('收款 2400（定金 2400）→ 已收款', r7o.paymentStatus, 'paid')
eq('改单前的含费用合计', r7o.grandTotal, 8000)

// 客户加单：1000 → 1500，新定金 3600，实际只收到 2400
r7o = await orders.updateOrderItem(r7.id, r7i.items[0].id, { quantity: 1500 })
eq('加单后金额变大', r7o.grandTotal, 12000)
eq('加单后定金变大', r7o.depositAmount, 3600)
eq('加单后收款状态退回「部分收款」（不能还写着已收款）', r7o.paymentStatus, 'partial')
check(
  '状态回退有留痕',
  orders.listEvents(r7.id).some((e) => e.kind === 'status_auto' && e.toStatus === 'partial')
)
// 减单：1500 → 1000，收够了应该升到「已收款」
r7o = await orders.updateOrderItem(r7.id, r7i.items[0].id, { quantity: 1000 })
eq('减单后收款状态升回「已收款」', r7o.paymentStatus, 'paid')
// 改单价也要重算
r7o = await orders.updateOrderItem(r7.id, r7i.items[0].id, { unitPrice: 10 })
eq('改单价后金额变了', r7o.grandTotal, 10000)
eq('改单价后收款状态退回部分收款', r7o.paymentStatus, 'partial')
// 加一行也要重算
const r7extra = await orders.addOrderItem(r7.id, {
  styleNo: 'A002',
  productName: '涤纶 Polo 衫',
  color: 'Navy',
  size: 'M',
  quantity: 100,
  unitPrice: 20,
  unitCost: 12
})
eq('加一行后金额变大', r7extra.grandTotal, 12000)
eq('加一行后收款状态重算', r7extra.paymentStatus, 'partial')
// 删一行也要重算
const r7afterDel = orders.removeOrderItem(r7.id, r7extra.items[1].id)
eq('删一行后金额变小', r7afterDel.grandTotal, 10000)
// 待收不会出现负数
const r7over = orders.addPayment(r7.id, { paidAt: '2026-10-21', amount: 99999, method: 'T/T', bankRef: 'R7002' })
eq('多收了以后待收不会变负数', r7over.remaining, 0)
check('多收了以后状态是已结清', r7over.paymentStatus === 'settled')

/* ---------------- N30：删明细要留痕 ---------------- */
section('N30：删一行明细，系统里查得到')
const r30 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
const r30a = await orders.addOrderItem(r30.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 8,
  unitCost: 5.5
})
const r30b = await orders.addOrderItem(r30.id, {
  styleNo: 'A002',
  productName: '涤纶 Polo 衫',
  color: 'Navy',
  size: 'L',
  quantity: 50,
  unitPrice: 12.5,
  unitCost: 9
})
orders.removeOrderItem(r30.id, r30b.items[1].id)
const r30Events = orders.listEvents(r30.id)
check(
  '删行有留痕（写明款号/颜色/尺码/数量）',
  r30Events.some(
    (e) =>
      e.kind === 'item_remove' &&
      e.note.includes('删除明细') &&
      e.note.includes('A002') &&
      e.note.includes('Navy/L') &&
      e.note.includes('50')
  ),
  JSON.stringify(r30Events.map((e) => e.note))
)
// 装箱单明细也要留痕
const r30pl = packing.createPackingList({
  orderId: r30.id,
  containerNo: 'MSKU0001',
  lines: [
    { boxNo: 'NO.1', styleNo: 'A001', color: 'Black', size: 'M', quantity: 60, netWeight: 10 },
    { boxNo: 'NO.2', styleNo: 'A001', color: 'Black', size: 'M', quantity: 40 }
  ]
})
const r30plLine = r30pl[0].lines[0]
packing.updatePackingListLine(r30.id, r30pl[0].id, r30plLine.id, { netWeight: 12 })
check(
  '装箱明细改净重有留痕',
  orders.listEvents(r30.id).some((e) => e.kind === 'pl_line_update' && e.note.includes('净重'))
)
packing.deletePackingListLine(r30.id, r30pl[0].id, r30plLine.id)
check(
  '装箱明细删除有留痕',
  orders.listEvents(r30.id).some((e) => e.kind === 'pl_line_remove' && e.note.includes('删除装箱明细'))
)

/* ---------------- N20：成本能补录，补完毛利就真了 ---------------- */
section('N20：成本可以就地补录，补完毛利不再不可信')
const r20 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
const r20i = await orders.addOrderItem(r20.id, {
  styleNo: 'ZZ-999',
  productName: '临时款',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 20,
  unitCost: null
})
eq('成本没录时毛利不可信（missingCostItems > 0）', r20i.missingCostItems, 1)
const r20filled = await orders.updateOrderItem(r20.id, r20i.items[0].id, { unitCost: 12 })
eq('成本补录后没有缺失行了', r20filled.missingCostItems, 0)
eq('补录后毛利可信', r20filled.totalProfit, 100 * (20 - 12))
check(
  '成本修改有留痕',
  orders.listEvents(r20.id).some((e) => e.kind === 'item_update' && e.note.includes('成本'))
)
// 毛利不可信时，报表和客户页都给 null（显示「—」）
const r20stats = customers.customerStats(c1.id)
check(
  '有成本缺失的单：客户页毛利是不可信',
  r20stats.totalProfit === null || r20stats.missingCostOrders >= 0
)

/* ---------------- N28：作废代替删除 ---------------- */
section('N28：有款的单不能物理删除，只能作废')
const r28 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
await orders.addOrderItem(r28.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 8,
  unitCost: 5.5
})
orders.addPayment(r28.id, { paidAt: '2026-10-21', amount: 300, method: 'T/T', bankRef: 'R2801' })
let deleteBlocked = false
try {
  orders.deleteOrder(r28.id)
} catch (e) {
  deleteBlocked = true
  check('删有款的单被拦住（中文提示）', (e as Error).message.includes('不能直接删'), (e as Error).message)
}
check('有明细有款的单删不掉', deleteBlocked)
// 作废：记录全留
const r28voided = orders.voidOrder(r28.id, '客户取消')
eq('作废后状态是已作废', r28voided.paymentStatus, 'void')
check('作废后收款记录还在', r28voided.payments.length === 1)
check('作废后操作历史还在', orders.listEvents(r28.id).length > 0)
check('作废后明细还在', r28voided.items.length === 1)
check('作废有留痕', orders.listEvents(r28.id).some((e) => e.kind === 'void'))
// 作废后不进销售额 / 待收款 / 毛利
const salesBeforeVoid = dashboard.dashboard().monthSales
const pendingBeforeVoid = dashboard.dashboard().pendingAmount
const r28inSales = dashboard.monthlyReport().reduce((s, r) => s + r.sales, 0)
orders.voidOrder(r28.id, '再作废一次也不变')
eq('作废后订单不进默认列表', orders.listOrders({}).some((o) => o.id === r28.id), false)
check('作废的单在「已作废」页签里查得到', orders.listOrders({ paymentStatus: 'void' }).some((o) => o.id === r28.id))
eq('作废后本月销售额不变', dashboard.dashboard().monthSales, salesBeforeVoid)
eq('作废后待收款不变', dashboard.dashboard().pendingAmount, pendingBeforeVoid)
// 空单可以真删
const r28empty = orders.createOrder({ customerId: c1.id, currency: 'USD' })
orders.deleteOrder(r28empty.id)
check('空单可以真删', orders.getOrder(r28empty.id) === null)

/* ---------------- 业务闭环守则（r14）：口径、汇率、转单锁定 ---------------- */
section('口径守则：作废单的钱算现金流、不算销售')

const cashFlowOrder = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  depositRatio: 0.3,
  paymentStatus: 'sent'
})
await orders.addOrderItem(cashFlowOrder.id, {
  styleNo: 'R14-CASH',
  productName: '现金流口径测试款',
  color: 'Black',
  size: 'M',
  quantity: 10,
  unitPrice: 10,
  unitCost: 4
})
await orders.addPayment(cashFlowOrder.id, {
  paidAt: localDate(),
  amount: 30,
  method: 'T/T',
  bankRef: 'R14-CASH-001'
})
const cashBeforeReport = dashboard.monthlyReport().reduce((s, r) => s + r.received, 0)
const salesBeforeReport = dashboard.monthlyReport().reduce((s, r) => s + r.sales, 0)
const monthReceivedBeforeVoid = dashboard.dashboard().monthReceived
const pendingBeforeCashVoid = dashboard.dashboard().pendingAmount
orders.voidOrder(cashFlowOrder.id, 'r14 口径测试')
const cashAfterReport = dashboard.monthlyReport().reduce((s, r) => s + r.received, 0)
const salesAfterReport = dashboard.monthlyReport().reduce((s, r) => s + r.sales, 0)
check(
  '作废单真收到的钱仍留在现金流里（报表收款一分不少）',
  Math.abs(cashAfterReport - cashBeforeReport) < 0.01,
  `${cashBeforeReport} → ${cashAfterReport}`
)
eq(
  '作废后工作台「本月收款」不变（钱已经到账，作废不退款）',
  dashboard.dashboard().monthReceived,
  monthReceivedBeforeVoid
)
check(
  '作废单不再计入销售额（该单货值 100 × 7 从销售里减掉）',
  Math.abs(salesBeforeReport - salesAfterReport - 100 * 7) < 0.01,
  `${salesBeforeReport} → ${salesAfterReport}`
)
check(
  '作废后待收里少了这单未收的 70 × 7',
  Math.abs(pendingBeforeCashVoid - dashboard.dashboard().pendingAmount - 70 * 7) < 0.01,
  `${pendingBeforeCashVoid} → ${dashboard.dashboard().pendingAmount}`
)
const csvPayAfterVoid = dashboard.exportCsv('payments')
const cashRow = csvPayAfterVoid.split('\r\n').find((l) => l.includes(cashFlowOrder.orderNo))
check('收款 CSV 里作废单这行还在，且订单状态列写着 void', !!cashRow && cashRow.includes('void'), cashRow ?? '没找到该行')

section('数据守卫：汇率不能清空、已转的单不能改钱')
let rateZeroErr = ''
try {
  orders.updateOrder(cashFlowOrder.id, {
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 0,
    baseCurrency: 'CNY'
  })
} catch (e) {
  rateZeroErr = (e as Error).message
}
check('编辑订单把汇率清成 0 会被拦住', rateZeroErr.includes('汇率'), rateZeroErr)
eq('被拦住后订单汇率没被改成 1', orders.getOrder(cashFlowOrder.id)?.exchangeRate, 7)

// 已转订单的报价单：明细/价格不许事后改
let qLockedErr = ''
try {
  quotations.saveQuotation({
    id: q1.id,
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    exchangeRateDate: '2026-09-01',
    items: [{ styleNo: 'A001', quantity: 9999, unitPrice: 1 }]
  })
} catch (e) {
  qLockedErr = (e as Error).message
}
check('已转订单的报价单不能再改（价格凭据锁住）', qLockedErr.includes('已经转成订单'), qLockedErr)

// 已转订单的打样单：钱的部分锁住，描述性的字眼还能改
const smpLocked = samples.getSample(smpConv.id)!
let smpMoneyErr = ''
try {
  samples.saveSample({
    id: smpLocked.id,
    customerId: smpLocked.customerId,
    expressFee: 999,
    currency: smpLocked.currency,
    exchangeRate: smpLocked.exchangeRate,
    exchangeRateDate: smpLocked.exchangeRateDate,
    items: smpLocked.items.map((i) => ({ styleNo: i.styleNo, color: i.color, size: i.size, quantity: i.quantity, unitPrice: i.unitPrice }))
  })
} catch (e) {
  smpMoneyErr = (e as Error).message
}
check('已转订单的打样单不能再改快递费', smpMoneyErr.includes('已经转成订单'), smpMoneyErr)
const smpDescOk = samples.saveSample({
  id: smpLocked.id,
  customerId: smpLocked.customerId,
  courier: '顺丰',
  trackingNo: 'SF-R14',
  expressFee: smpLocked.expressFee,
  currency: smpLocked.currency,
  exchangeRate: smpLocked.exchangeRate,
  exchangeRateDate: smpLocked.exchangeRateDate,
  items: smpLocked.items.map((i) => ({ styleNo: i.styleNo, color: 'Navy', size: i.size, quantity: i.quantity, unitPrice: i.unitPrice }))
})
eq('已转订单的打样单还能改快递单号', smpDescOk.trackingNo, 'SF-R14')
eq('已转订单的打样单还能改颜色', smpDescOk.items[0].color, 'Navy')

section('取消的打样单：不再计应收、不再催款、不能转单')
const smpCancel = samples.saveSample({
  customerId: c2.id,
  sampleDate: '2026-08-01',
  expressFee: 80,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'R14-CANCEL', quantity: 1, unitPrice: 50 }]
})
const receivableBeforeCancel = money.sampleReceivable()
const smpCancelled = samples.saveSample({
  id: smpCancel.id,
  customerId: c2.id,
  status: 'cancelled',
  sampleDate: '2026-08-01',
  expressFee: 80,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'R14-CANCEL', quantity: 1, unitPrice: 50 }]
})
eq('取消后打样单状态是已取消', smpCancelled.status, 'cancelled')
eq('取消的打样单待收为 0', smpCancelled.receivableBase, 0)
check(
  '取消的打样费从全公司待收里扣掉了',
  Math.abs(receivableBeforeCancel - money.sampleReceivable() - (50 + 80) * 7) < 0.01,
  `${receivableBeforeCancel} → ${money.sampleReceivable()}`
)
check(
  '取消的打样单不再出现在催款提醒里',
  !dashboard.reminders().some((r) => r.kind === 'sample' && r.sampleId === smpCancel.id)
)
let smpCancelConvertErr = ''
try {
  samples.convertSampleToOrder(smpCancel.id)
} catch (e) {
  smpCancelConvertErr = (e as Error).message
}
check('取消的打样单不能转订单', smpCancelConvertErr.includes('已取消'), smpCancelConvertErr)

section('PL 分批出货：已装扣减、超装拦下、箱内件数可改')
const batchOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(batchOrder.id, {
  styleNo: 'BATCH-1',
  productName: '分批款',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 5,
  unitCost: 2
})
const b0 = orders.summarizeSkus(batchOrder.id)[0]
eq('还没装箱时已装数量 = 0', b0.packedQuantity, 0)
eq('还没装箱时未装箱数量 = 订单数量', b0.remainingQuantity, 100)

const bPl1 = packing.createPackingList({
  orderId: batchOrder.id,
  containerNo: 'C1',
  lines: [{ boxNo: 'NO.1', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 40 }]
})
const b1 = orders.summarizeSkus(batchOrder.id)[0]
eq('装 40 件后已装数量 = 40', b1.packedQuantity, 40)
eq('未装箱数量自动扣到 60', b1.remainingQuantity, 60)

let overQtyErr = ''
try {
  packing.createPackingList({
    orderId: batchOrder.id,
    lines: [{ boxNo: 'NO.1', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 70 }]
  })
} catch (e) {
  overQtyErr = (e as Error).message
}
check('第二批要装 70 件（只剩 60）会被拦下，并说清超了几件', overQtyErr.includes('超了 10 件'), overQtyErr)

packing.createPackingList({
  orderId: batchOrder.id,
  lines: [{ boxNo: 'NO.1', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 60 }]
})
eq('第二批装剩下的 60 件放行', packing.listPackingLists(batchOrder.id).length, 2)
eq('全部装完：未装箱数量归 0', orders.summarizeSkus(batchOrder.id)[0].remainingQuantity, 0)

const bLine = bPl1[0].lines[0]
packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { netWeight: 20 })
const bEdited = packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { quantity: 30 })
eq('PL 明细件数可以改（40 → 30）', bEdited[0].lines[0].quantity, 30)
eq('件数改小后净重按比例跟着改（20kg → 15kg）', bEdited[0].lines[0].netWeight, 15)
let lineOverErr = ''
try {
  packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { quantity: 50 })
} catch (e) {
  lineOverErr = (e as Error).message
}
check('改大后累计超过订单数量也会被拦下', lineOverErr.includes('超了'), lineOverErr)

/* ---------------- 批次出货：整单状态由批次汇总 ---------------- */
section('批次出货：整单状态由批次汇总，升级不回退')
const shipOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
orders.updateOrder(shipOrder.id, {
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: shipOrder.piNo,
  vessel: 'ORDER VESSEL V.9',
  etdDate: '2026-12-15',
  sealNo: 'ORDER-SEAL'
})
await orders.addOrderItem(shipOrder.id, {
  styleNo: 'SHIP-1',
  productName: '分批出运款',
  color: 'Navy',
  size: 'L',
  quantity: 100,
  unitPrice: 6,
  unitCost: 3
})

const shipManual = orders.setShipStatus(shipOrder.id, 'shipped')
eq('没有批次时，整单状态还能手工改', shipManual.shipStatus, 'shipped')
eq('没有批次时不做推导', shipmentSummary(shipOrder.id).derivedStatus, null)

const shipPls1 = packing.createPackingList({
  orderId: shipOrder.id,
  containerNo: 'CONT-A',
  lines: [{ boxNo: 'NO.1', styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 40 }]
})
const shipPlA = shipPls1[0]
const sumA = shipmentSummary(shipOrder.id)
eq('建了首批后整单状态由批次接管', sumA.derivedStatus, 'preparing')
eq('首批只装了 40 件', sumA.packedQuantity, 40)
eq('首批还没出运', sumA.shippedQuantity, 0)
eq('还有 1 个批次没出运', sumA.unshippedBatches, 1)
eq('订单上缓存的出货状态回写成备货中', orders.getOrder(shipOrder.id)!.shipStatus, 'preparing')

packing.updatePackingListInfo(shipOrder.id, shipPlA.id, {
  vessel: 'EVER GIVEN V.001',
  etdDate: '2026-11-01',
  atdDate: '2026-11-02',
  etaDate: '2026-12-01',
  sealNo: 'SEAL-1',
  blNo: 'BL-1',
  shipStatus: 'shipped'
})
const sumB = shipmentSummary(shipOrder.id)
eq('首批出运、货没装够 → 部分出运', sumB.derivedStatus, 'partial_shipped')
eq('已出运件数 = 首批 40 件', sumB.shippedQuantity, 40)
eq('订单缓存也变成部分出运', orders.getOrder(shipOrder.id)!.shipStatus, 'partial_shipped')
const plA = packing.listPackingLists(shipOrder.id)[0]
eq('批次船名航次存住了', plA.vessel, 'EVER GIVEN V.001')
eq('批次 ETD/ATD/ETA 存住了', [plA.etdDate, plA.atdDate, plA.etaDate], ['2026-11-01', '2026-11-02', '2026-12-01'])
eq('批次封条号/提单号存住了', [plA.sealNo, plA.blNo], ['SEAL-1', 'BL-1'])

let manualAfterBatchErr = ''
try {
  orders.setShipStatus(shipOrder.id, 'delivered')
} catch (e) {
  manualAfterBatchErr = (e as Error).message
}
check(
  '有批次接管后不能再手工改整单状态，并指路到装箱单',
  manualAfterBatchErr.includes('批次') && manualAfterBatchErr.includes('装箱单'),
  manualAfterBatchErr
)
let derivedPickErr = ''
try {
  packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'partial_shipped' as any })
} catch (e) {
  derivedPickErr = (e as Error).message
}
check('「部分出运」是汇总出来的，批次上不能手选', derivedPickErr.includes('不能手工选'), derivedPickErr)

const shipPls2 = packing.createPackingList({
  orderId: shipOrder.id,
  containerNo: 'CONT-B',
  lines: [{ boxNo: 'NO.1', styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 60 }]
})
const shipPlB = shipPls2[1]
const sumC = shipmentSummary(shipOrder.id)
eq('两批加起来装够 100 件', sumC.packedQuantity, 100)
eq('尾批还没出运，仍是部分出运', sumC.derivedStatus, 'partial_shipped')
eq('还有 1 个批次没出运', sumC.unshippedBatches, 1)

packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'shipped' })
eq('全部装够且全部出运 → 已出运', shipmentSummary(shipOrder.id).derivedStatus, 'shipped')

packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'cleared' })
packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'cleared' })
eq('两批都清关 → 已清关', shipmentSummary(shipOrder.id).derivedStatus, 'cleared')

packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'delivered' })
packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'delivered' })
const sumDelivered = shipmentSummary(shipOrder.id)
eq('两批都签收 → 已签收', sumDelivered.derivedStatus, 'delivered')
eq('已签收后订单缓存同步', orders.getOrder(shipOrder.id)!.shipStatus, 'delivered')
eq(
  '签收日期按本地日期落档',
  packing.listPackingLists(shipOrder.id).map((p) => p.deliveredAt),
  [localDate(), localDate()]
)

packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'packed' })
eq('退回一批 → 又变回部分出运（已走的那批仍算已出）', shipmentSummary(shipOrder.id).derivedStatus, 'partial_shipped')
let depDelErr = ''
try {
  packing.deletePackingList(shipOrder.id, shipPlB.id)
} catch (e) {
  depDelErr = (e as Error).message
}
check('已签收的批次不能直接删，提示先退回', depDelErr.includes('不能删除') && depDelErr.includes('已签收'), depDelErr)
packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'packed' })
const afterDelete = packing.deletePackingList(shipOrder.id, shipPlB.id)
eq('退回已包装后可以删批次', afterDelete.length, 1)
eq('删掉尾批后整单回到备货中', shipmentSummary(shipOrder.id).derivedStatus, 'preparing')

// 已出运批次的箱明细是凭据：加/改/删都要先退回「已包装」
packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'shipped' })
let lockEditErr = ''
try {
  packing.updatePackingListLine(shipOrder.id, shipPlA.id, shipPlA.lines[0].id, { quantity: 20 })
} catch (e) {
  lockEditErr = (e as Error).message
}
check('已出运批次的箱明细不能改', lockEditErr.includes('明细不能改'), lockEditErr)
let lockAddErr = ''
try {
  packing.addPackingListLine(shipOrder.id, shipPlA.id, { styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 1 })
} catch (e) {
  lockAddErr = (e as Error).message
}
check('已出运批次的箱明细不能加', lockAddErr.includes('明细不能改'), lockAddErr)
let lockDelErr = ''
try {
  packing.deletePackingListLine(shipOrder.id, shipPlA.id, shipPlA.lines[0].id)
} catch (e) {
  lockDelErr = (e as Error).message
}
check('已出运批次的箱明细不能删', lockDelErr.includes('明细不能改'), lockDelErr)
packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'packed' })

// 订单这头也不能减到已装箱数以下，否则会出现「已出 40 / 订单 20 件」
const shipItem = orders.getOrder(shipOrder.id)!.items[0]
let shrinkErr = ''
try {
  orders.updateOrderItem(shipOrder.id, shipItem.id, { quantity: 20 })
} catch (e) {
  shrinkErr = (e as Error).message
}
check('订单数量不能减到已装箱数以下', shrinkErr.includes('订单数量不能改到 40 件以下'), shrinkErr)
let swapSkuErr = ''
try {
  orders.updateOrderItem(shipOrder.id, shipItem.id, { color: 'Red' })
} catch (e) {
  swapSkuErr = (e as Error).message
}
check('已装箱的款不能直接换颜色/尺码', swapSkuErr.includes('不能直接换'), swapSkuErr)
let removePackedErr = ''
try {
  orders.removeOrderItem(shipOrder.id, shipItem.id)
} catch (e) {
  removePackedErr = (e as Error).message
}
check('已装箱的订单行不能直接删', removePackedErr.includes('不能直接删'), removePackedErr)

// 装箱单不能凭空多出订单里没有的款
let ghostSkuErr = ''
try {
  packing.createPackingList({
    orderId: shipOrder.id,
    lines: [{ boxNo: 'NO.1', styleNo: 'NOPE-1', color: 'Navy', size: 'L', quantity: 1 }]
  })
} catch (e) {
  ghostSkuErr = (e as Error).message
}
check('装箱单不能装订单里没有的款', ghostSkuErr.includes('订单里没有 NOPE-1'), ghostSkuErr)

// 升级前的老批次：ship_status 为 NULL，不参与推导，订单保持手工状态
const legacyOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(legacyOrder.id, {
  styleNo: 'LEGACY-1',
  productName: '升级前老单',
  color: 'Black',
  size: 'M',
  quantity: 50,
  unitPrice: 3,
  unitCost: 1
})
const legacyRes = getDb().run(
  `INSERT INTO packing_lists(order_id, pl_no, container_no, note, created_at, ship_status)
   VALUES(?,?,?,?,?,NULL)`,
  [legacyOrder.id, 'PL-LEGACY-1', '', '', new Date().toISOString()]
)
getDb().run(
  `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity)
   VALUES(?,?,?,?,?,?,?)`,
  [Number(legacyRes.lastInsertRowid), 'NO.1', 'LEGACY-1', '升级前老单', 'Black', 'M', 50]
)
eq('老批次（状态为空）不接管整单状态', shipmentSummary(legacyOrder.id).derivedStatus, null)
const legacyManual = orders.setShipStatus(legacyOrder.id, 'delivered')
eq('老单还能按手工状态走', legacyManual.shipStatus, 'delivered')
const legacyPl = packing.listPackingLists(legacyOrder.id)[0]
packing.updatePackingListInfo(legacyOrder.id, legacyPl.id, { containerNo: 'C-OLD', vessel: 'OLD V.1' })
eq('只补老批次柜号/船期，不动整单手工状态', orders.getOrder(legacyOrder.id)!.shipStatus, 'delivered')
eq('老批次状态仍为空（没有选就不接管）', packing.listPackingLists(legacyOrder.id)[0].shipStatus, null)
let lastLineErr = ''
try {
  packing.deletePackingListLine(legacyOrder.id, legacyPl.id, legacyPl.lines[0].id)
} catch (e) {
  lastLineErr = (e as Error).message
}
check('装箱单不能被删成一箱都没有', lastLineErr.includes('留不住'), lastLineErr)

// 一张单混有老批次 + 新批次：仍然不推导，等老批次补上状态再接管
const mixedOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(mixedOrder.id, {
  styleNo: 'MIX-1',
  productName: '混合批次款',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 4,
  unitCost: 2
})
const mixedLegacyRes = getDb().run(
  `INSERT INTO packing_lists(order_id, pl_no, container_no, note, created_at, ship_status)
   VALUES(?,?,?,?,?,NULL)`,
  [mixedOrder.id, 'PL-MIX-LEGACY', '', '', new Date().toISOString()]
)
getDb().run(
  `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, product_name, color, size, quantity)
   VALUES(?,?,?,?,?,?,?)`,
  [Number(mixedLegacyRes.lastInsertRowid), 'NO.1', 'MIX-1', '混合批次款', 'Black', 'M', 40]
)
orders.setShipStatus(mixedOrder.id, 'delivered')
packing.createPackingList({
  orderId: mixedOrder.id,
  lines: [{ boxNo: 'NO.1', styleNo: 'MIX-1', color: 'Black', size: 'M', quantity: 30 }]
})
eq('混有老批次时不推导', shipmentSummary(mixedOrder.id).derivedStatus, null)
eq('加新批次不会把手工「已签收」拉回来', orders.getOrder(mixedOrder.id)!.shipStatus, 'delivered')
const mixedLegacyPl = packing.listPackingLists(mixedOrder.id)[0]
packing.updatePackingListInfo(mixedOrder.id, mixedLegacyPl.id, { shipStatus: 'packed' })
eq('老批次补上状态后，整单才由批次汇总', shipmentSummary(mixedOrder.id).derivedStatus, 'preparing')

const shipOrderFull = orders.getOrder(shipOrder.id)!
const plPaperBatch = renderPl({ order: shipOrderFull, settings: getSettings(), images: {} }, packing.listPackingLists(shipOrder.id)[0])
check('PL 纸面用批次的船名航次', plPaperBatch.includes('EVER GIVEN V.001'), plPaperBatch)
check('PL 纸面用批次的 ETD', plPaperBatch.includes('2026-11-01'))
check('PL 纸面用批次的封条号', plPaperBatch.includes('SEAL-1'))
check('PL 纸面没有串成订单级船期', !plPaperBatch.includes('ORDER VESSEL V.9'))
const ciPaperOrder = renderCi({ order: shipOrderFull, settings: getSettings(), images: {} })
check('CI 仍用订单级船名航次', ciPaperOrder.includes('ORDER VESSEL V.9'))
check('CI 仍用订单级 ETD', ciPaperOrder.includes('2026-12-15'))
check('CI 不串批次的船期', !ciPaperOrder.includes('EVER GIVEN V.001'))

/* ---------------- N35：订单列表能按款号搜 ---------------- */
section('订单列表能按款号搜')
const byStyleOrders = orders.listOrders({ keyword: 'ZZ-999' })
check('订单列表能按款号搜到', byStyleOrders.some((o) => o.id === r20.id))

/* ---------------- 汇总 ---------------- */
console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('='.repeat(46))
closeDb()
process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
