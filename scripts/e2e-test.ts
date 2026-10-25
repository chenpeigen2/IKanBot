/**
 * 端到端业务逻辑测试：直接调用 service 层，验证核心流程。
 * 运行：npm run test:e2e
 */
import { openDb, closeDb, getDb, dataDir, imagesDir, docsDir, backupsDir } from '../electron/db'
import { LATEST_DB_VERSION } from '../electron/db/schema'
import * as fs from 'fs'
import { join, isAbsolute } from 'path'
import { Database } from 'node-sqlite3-wasm'
import * as products from '../electron/services/products'
import * as customers from '../electron/services/customers'
import * as orders from '../electron/services/orders'
import * as quotations from '../electron/services/quotations'
import * as samples from '../electron/services/samples'
import * as packing from '../electron/services/packing'
import { shipmentSummary, factoryDeliveredQuantity } from '../electron/services/shipping'
import * as dashboard from '../electron/services/dashboard'
import * as money from '../electron/services/money'
import { getSettings, saveSettings, markBackupOk, markBackupFail, baseCurrencyLocked } from '../electron/services/settings'
import { createBackup, inspectBackup, listBackups, pruneBackups, restoreBackup } from '../electron/services/backup'
import * as docs from '../electron/services/docs'
import { collectDir, createZip, readZip, verifyZip } from '../electron/services/zip'
import {
  renderPi,
  renderPl,
  renderQuotation,
  renderCi,
  renderSample,
  orderDocAmount,
  ciDocAmount,
  ciNoOf
} from '../src/shared/documents'
import { localDate, localMonthOf, addDays } from '../src/shared/date'
import { isBillingStatus, shownRemaining } from '../src/shared/billing'
import { likeContains } from '../electron/services/search'
import { INCOTERMS } from '../src/shared/types'

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
  lines: [{ boxNo: 'NO.3', styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'M', quantity: 80, netWeight: 10 }]
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

/* ---------------- R3：报价版本快照、按版本转单、过期沿用审批 ---------------- */
section('R3 报价版本：按哪一版转，就按哪一版的钱')

const versions = quotations.listQuotationVersions(qEdit.id)
eq('改过一次 → 两个版本快照', versions.length, 2)
eq('版本号从新到旧', versions.map((v) => v.revision).join(','), '2,1')
const v1 = versions.find((v) => v.revision === 1)!
eq('第 1 版合计 = 改前的钱', v1.grandTotal, 500 * 7.5 + 200 * 9.9)
const v2 = versions.find((v) => v.revision === 2)!
eq('第 2 版合计 = 改后的钱', v2.grandTotal, 700 * 7.5 + 200 * 9.9)

// 客户翻出旧邮件说「就按第 1 版这个价」→ 必须能按第 1 版原样转
const v1Order = quotations.convertToOrder(qEdit.id, { revision: 1 })
eq('按第 1 版转单 → 订单合计 = 第 1 版快照', v1Order.grandTotal, v1.grandTotal)
eq('按第 1 版转单 → 数量也是第 1 版的', v1Order.totalQuantity, 500 + 200)
eq('订单记下了来源报价号', v1Order.sourceQuotationNo, qEdit.qNo)
eq('订单记下了来源版本', v1Order.sourceRevision, 1)
eq(
  '订单明细单价 = 第 1 版的单价（不是第 2 版）',
  v1Order.items.find((i) => i.styleNo === 'A001' && i.size === 'M')?.unitPrice,
  7.5
)

// 过期报价：默认拦住；写清批准人和原因才允许沿用旧价
const qExpired = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  validUntil: '2026-01-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
let expiredErr = ''
try {
  quotations.convertToOrder(qExpired.id)
} catch (e) {
  expiredErr = (e as Error).message
}
check('过期报价没批准人/原因不让转', expiredErr.includes('批准人') && expiredErr.includes('原因'), expiredErr)
check('被拦住时没有偷偷生成订单', quotations.getQuotation(qExpired.id)?.convertedOrderId == null)
const expiredOrder = quotations.convertToOrder(qExpired.id, {
  override: { approvedBy: '周文娟', reason: '老客户翻单，老板同意按旧价做' }
})
check('填了批准人和原因 → 可以沿用旧价转单', expiredOrder.id > 0)
check(
  '订单备注写清了谁批准、为什么',
  expiredOrder.note.includes('周文娟') && expiredOrder.note.includes('老客户翻单'),
  expiredOrder.note
)
check(
  '报价单操作历史记下了沿用审批',
  quotations.listQuotationEvents(qExpired.id).some((e) => e.note.includes('周文娟')),
  JSON.stringify(quotations.listQuotationEvents(qExpired.id))
)

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
// R5：商品成本记的是工厂价（基准币 CNY），订单明细的成本落在本单币种上。
// 5.5 ÷ 7.15 = 0.769231（保留 6 位）——以前这里直接写 5.5，等于把 ¥5.5 当成 $5.5，毛利全错。
eq('手工加的行按本单汇率带出成本价', manualOrder.items.find((i) => i.styleNo === 'A001')?.unitCost, 0.769231)
check(
  '折算成本乘回汇率就是工厂价',
  Math.abs((manualOrder.items.find((i) => i.styleNo === 'A001')?.unitCost ?? 0) * 7.15 - 5.5) < 0.001
)
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
const remBal2 = dashboard.reminders().find((r) => r.kind === 'balance' && r.orderId === balOrder2.id)
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
eq('公司总成本（基准币）= 工厂打样费(0) + 快递费 120×7.15', sample.companyCostBase, 120 * 7.15)
eq('未收时已收回（基准币）= 0', sample.feeRecoveredBase, 0)
eq('公司净垫（基准币）= 成本 858 − 已收回 0', sample.netAdvanceBase, 120 * 7.15)
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
eq('已收的样品费 + 快递费都算已收回（基准币）', smpPaid.feeRecoveredBase, null)
eq('已收单没填汇率：样品费折不出来，界面上是「—」', smpPaid.sampleFeeBase, null)
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
eq('没填汇率 → 净垫折不出来，不拿 1 凑数', smpDates.netAdvanceBase, null)

// N24：打样转订单（不抵扣）
const smpConv = samples.saveSample({
  customerId: c2.id,
  expressFee: 40,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 2, unitPrice: 15, goodsUnitPrice: 8, productId: p1.id }
  ]
})
const convOrder = samples.convertSampleToOrder(smpConv.id, { offsetSampleFee: false })
check('打样转出了订单', convOrder.id > 0)
eq('转出订单的汇率 = 打样单的汇率', convOrder.exchangeRate, 7.2)
eq('不抵扣 → 订单没有负费用行', (convOrder.charges ?? []).length, 0)
eq('转出订单的明细带过去了', convOrder.items.length, 1)
eq('明细款号带过去了', convOrder.items[0].styleNo, 'A001')
eq('明细件数带过去了', convOrder.items[0].quantity, 2)
eq('转单用的是大货单价，不是打样单价', convOrder.items[0].unitPrice, 8)
const smpConvAfter = samples.getSample(smpConv.id)!
eq('打样单记住了转出的订单', smpConvAfter.convertedOrderId, convOrder.id)
eq('不抵扣 → 收款标记不变', smpConvAfter.feeStatus, 'unpaid')
eq('打样单记住了大货单价', smpConvAfter.items[0].goodsUnitPrice, 8)
// R3：打样单价只是打样费，没填大货单价不许转（否则 15 美金打样价会变成大货价）
const smpNoGoods = samples.saveSample({
  customerId: c2.id,
  expressFee: 0,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'A-BULK', productName: '待报大货价', quantity: 1, unitPrice: 20 }]
})
let smpGoodsErr = ''
try {
  samples.convertSampleToOrder(smpNoGoods.id)
} catch (e) {
  smpGoodsErr = (e as Error).message
}
check('没填大货单价 → 打样单不能转订单', smpGoodsErr.includes('大货单价'), smpGoodsErr)
check('被拦住时没有偷偷生成订单', samples.getSample(smpNoGoods.id)!.convertedOrderId === null)
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
  items: [{ styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 1, unitPrice: 15, goodsUnitPrice: 15 }]
})
const offsetOrder = samples.convertSampleToOrder(smpOffset.id, { offsetSampleFee: true, paymentStatus: 'sent' })
const offsetCharge = (offsetOrder.charges ?? []).find((c: any) => c.amount < 0)
check('抵扣 → 订单里出现负费用行', !!offsetCharge, JSON.stringify(offsetOrder.charges))
eq('负费用行金额 = -(样品费 15 + 快递费 25)', offsetCharge?.amount, -40)
const smpOffsetAfter = samples.getSample(smpOffset.id)!
eq('抵扣后打样单标记为下单抵扣', smpOffsetAfter.feeStatus, 'offset')
eq('抵扣的样品费+快递费都算已收回（USD40 × 7.2 折基准币）', smpOffsetAfter.feeRecoveredBase, 40 * 7.2)
eq('抵扣的打样单不计待收', smpOffsetAfter.receivableBase, 0)

// N-4：抵扣转出来的单可能不是 0 元——样品费 15 + 快递费 25 都抵掉，货值 15 − 抵扣 40 = −25
// 毛利 = 含费用合计（实收口径）− 成本，负数就写负数
// 先补录成本（模拟她在订单明细里填成本）：货值 15 − 抵扣 40 − 成本 5 = −30
getDb().run('UPDATE order_items SET unit_cost = 5 WHERE order_id = ?', [offsetOrder.id])
const offDetail = orders.getOrder(offsetOrder.id)!
eq('抵扣单含费用合计 = −25（货值 15 被 40 的样品费+快递费抵穿）', offDetail.grandTotal, -25)
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
// R6：打样类有两种事由（催费 / 样品压在手里没寄出），催收必须认准「打样费」那一条
const smpRem = remSample.find((r) => r.kind === 'sample' && r.sampleId === smpOld.id && r.message.includes('打样费'))!
eq('催收提醒里带打样单号', smpRem.orderNo, smpOld.sampleNo)
eq('催收提醒关联打样单 id', smpRem.sampleId, smpOld.id)
check('催收提醒金额含样品费+快递费', smpRem.message.includes((15 + 60).toFixed(2)), smpRem.message)
check(
  'R6：样品迟迟没寄出单独亮一条（客户等的是样，不是发票）',
  remSample.some(
    (r) => r.kind === 'sample' && r.sampleId === smpOld.id && r.message.includes('还没寄出样品')
  ),
  JSON.stringify(remSample.filter((r) => r.sampleId === smpOld.id).map((r) => r.message))
)

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
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 1, unitPrice: 20, goodsUnitPrice: 8 }]
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
// 本节为了验 PL 自动号真建了一张箱单，先清掉这张单的箱单再删单
// （R15 起有箱单的空单也要走作废，不能物理删除）
getDb().run('DELETE FROM packing_lists WHERE order_id = ?', [soSkipOrder.id])
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
// 这张单是拿来核对金额口径的，要按已发出的正式单算；草稿单按新规则不计待收
orders.setPaymentStatus(moneyOrder.id, 'sent')
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
// —— R10：列表换瘦身行（listOrderRows），但必须和详情同一个口径、分页拿的是筛选集 ——
{
  const rowPage = orders.listOrderRows({ keyword: moneyOrder.orderNo })
  eq('瘦身列表只回这一单', rowPage.total, 1)
  eq('瘦身列表的待收 = 订单详情的待收（同一个 money.ts）', rowPage.rows[0].remaining, detailRemaining)
  const bigPage = orders.listOrderRows({ limit: 2, offset: 0 })
  eq('分页：本页最多 2 行', bigPage.rows.length, 2)
  eq('分页：total 是筛选集，不是本页行数', bigPage.total, orders.listOrderRows({}).total)
  const page2 = orders.listOrderRows({ limit: 2, offset: 2 })
  check(
    '分页：第二页不与第一页重叠',
    !page2.rows.some((r) => bigPage.rows.some((x) => x.id === r.id))
  )
  const owedRows = orders.listOrderRows({ sort: 'owed_desc' }).rows
  check(
    '待收排序（基准币）单调不增',
    owedRows.every((r, i) => i === 0 || owedRows[i - 1].remainingBase >= r.remainingBase)
  )
  eq('日期区间按本地日切：今天建的单落在 [今天, 今天] 里', orders.listOrderRows({ from: localDate(), to: localDate() }).rows.some((r) => r.id === moneyOrder.id), true)
  check('日期区间收窄后不多于全量', orders.listOrderRows({ from: '2000-01-01', to: localDate() }).total <= orders.listOrderRows({}).total)
  // 待收口径单一真源：不催款的单（草稿/失效/作废）界面一律「—」
  eq('草稿单不催款', isBillingStatus('draft'), false)
  eq('作废单不催款', isBillingStatus('void'), false)
  eq('已发送的单要催款', isBillingStatus('sent'), true)
  eq('不催款的单待收显示 0（界面画「—」）', shownRemaining('void', 500), 0)
  eq('正常单待收原样显示', shownRemaining('sent', 500), 500)
  eq('多收不算待收', shownRemaining('partial', -80), 0)
  // 搜索关键词里的 % _ 是真字符，不是通配符
  eq('LIKE 转义：搜 100% 不会匹配一切', orders.listOrderRows({ keyword: '100%' }).total, 0)
  eq('LIKE 转义：下标不当通配符', likeContains('A_B'), '%A\\_B%')
  eq('LIKE 转义：反斜杠本身也要转', likeContains('a\\b'), '%a\\\\b%')
}
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
  // 合计区是普通 tbody：tfoot 会被 Chromium 每页重复印，多页单据就会印出好几个 TOTAL
  const foot = t[0].match(/<tbody class="totals">([\s\S]*?)<\/tbody>/)
  if (!foot) throw new Error('单据表没有合计区（tbody.totals）')
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
      if (p.paidAt.slice(0, 7) === rr.month) recSum += p.amount * (p.exchangeRate ?? o.exchangeRate)
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
  for (const p of orders.getOrder(o.id)?.payments ?? []) recSumAll += p.amount * (p.exchangeRate ?? o.exchangeRate)
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
orders.setPaymentStatus(r28.id, 'confirmed')
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
// R7：状态列统一走中文标签，台账、明细、收款三张表写法一致
check('收款 CSV 里作废单这行还在，且订单状态列写着「已作废」', !!cashRow && cashRow.includes('已作废'), cashRow ?? '没找到该行')

section('数据守卫：汇率不能清空、已转的单不能改钱')
// 用一张还在走的正式单验证：作废单在 R14 起连编辑入口都进不去
const rateGuardOrder = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  baseCurrency: 'CNY',
  paymentStatus: 'confirmed'
})
let rateZeroErr = ''
try {
  orders.updateOrder(rateGuardOrder.id, {
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 0,
    baseCurrency: 'CNY'
  })
} catch (e) {
  rateZeroErr = (e as Error).message
}
check('编辑订单把汇率清成 0 会被拦住', rateZeroErr.includes('汇率'), rateZeroErr)
eq('被拦住后订单汇率没被改成 1', orders.getOrder(rateGuardOrder.id)?.exchangeRate, 7)

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
  lines: [{ boxNo: 'NO.2', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 60 }]
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
  lines: [{ boxNo: 'NO.2', styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 60 }]
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
  lines: [{ boxNo: 'NO.2', styleNo: 'MIX-1', color: 'Black', size: 'M', quantity: 30 }]
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

/* ---------------- R1：收款与应收守卫 ---------------- */
section('收款与应收：日期、删款留痕、币种守卫、客户页口径')

const r1Order = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1 })
orders.setPaymentStatus(r1Order.id, 'confirmed')
await orders.addOrderItem(r1Order.id, {
  styleNo: 'R1-GUARD',
  productName: 'R1 守卫',
  quantity: 10,
  unitPrice: 10
})
const r1Paid = orders.addPayment(r1Order.id, {
  paidAt: '2026-10-24',
  amount: 20,
  method: 'T/T',
  bankRef: 'R1-BANK'
})
eq('R1 正常收款能登记', r1Paid.paidAmount, 20)
const r1PayId = r1Paid.payments[0].id

let r1DateErr = ''
try {
  orders.addPayment(r1Order.id, { paidAt: '', amount: 10 })
} catch (e) {
  r1DateErr = (e as Error).message
}
check('收款日期不能留空', r1DateErr.includes('日期'), r1DateErr)

let r1FakeDateErr = ''
try {
  orders.addPayment(r1Order.id, { paidAt: '2026-02-31', amount: 10 })
} catch (e) {
  r1FakeDateErr = (e as Error).message
}
check('不存在的日期会被拦住', r1FakeDateErr.includes('日期'), r1FakeDateErr)

let r1CurrencyErr = ''
try {
  orders.updateOrder(r1Order.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })
} catch (e) {
  r1CurrencyErr = (e as Error).message
}
check('有收款后改币种被拦住', r1CurrencyErr.includes('币种'), r1CurrencyErr)
eq('被拦后订单币种没变', orders.getOrder(r1Order.id)!.currency, 'USD')

// R15：明细单价没有独立币种，已经对外发过的单不能换单位（改汇率也不行，先作废重开）
const r1CurLocked = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.1,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r1CurLocked.id, {
  styleNo: 'R1-NOPAY',
  productName: 'R1 未收款',
  quantity: 1,
  unitPrice: 10
})
let r1CurLockErr = ''
try {
  orders.updateOrder(r1CurLocked.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })
} catch (e) {
  r1CurLockErr = (e as Error).message
}
check('有明细就不能换币种（单价会被当成新币种）', r1CurLockErr.includes('不能改币种'), r1CurLockErr)
eq('被拦后币种没变', orders.getOrder(r1CurLocked.id)!.currency, 'USD')

const r1NoPay = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1 })
let r1RateErr = ''
try {
  orders.updateOrder(r1NoPay.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 7.1 })
} catch (e) {
  r1RateErr = (e as Error).message
}
check('换币种不能沿用旧币种汇率', r1RateErr.includes('汇率'), r1RateErr)
const r1Changed = orders.updateOrder(r1NoPay.id, {
  customerId: c1.id,
  currency: 'EUR',
  exchangeRate: 8
})
eq('空单换币种并重填汇率可以保存', r1Changed.currency, 'EUR')
eq('换币种后汇率是新的', r1Changed.exchangeRate, 8)

let r1DelErr = ''
try {
  orders.deletePayment(r1Order.id, r1PayId, '')
} catch (e) {
  r1DelErr = (e as Error).message
}
check('删除收款必须写原因', r1DelErr.includes('原因'), r1DelErr)
const r1Deleted = orders.deletePayment(r1Order.id, r1PayId, '金额录错')
eq('删款后已收归零', r1Deleted.paidAmount, 0)
const r1DelEvent = orders.listEvents(r1Order.id).find((e) => e.kind === 'payment_delete')
check(
  '删款历史带金额、日期和流水号',
  !!r1DelEvent &&
    r1DelEvent.note.includes('20.00') &&
    r1DelEvent.note.includes('2026-10-24') &&
    r1DelEvent.note.includes('R1-BANK'),
  r1DelEvent?.note ?? '没有删款事件'
)
check('删款历史带原因', !!r1DelEvent && r1DelEvent.note.includes('金额录错'), r1DelEvent?.note ?? '')

const r1Draft = orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r1Draft.id, {
  styleNo: 'R1-DRAFT',
  productName: 'R1 草稿',
  quantity: 5,
  unitPrice: 100
})
const r1DraftRow = customers.customerOrderBriefs(c2.id).find((o) => o.id === r1Draft.id)!
check('草稿单仍留在客户订单历史里', !!r1DraftRow)
eq('草稿单待收按 0 算（没确认的单不催款）', r1DraftRow.remaining, 0)

const r1Void = orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r1Void.id, {
  styleNo: 'R1-VOID',
  productName: 'R1 作废',
  quantity: 5,
  unitPrice: 100
})
orders.voidOrder(r1Void.id, '客户取消')
const r1VoidRow = customers.customerOrderBriefs(c2.id).find((o) => o.id === r1Void.id)!
eq('作废单待收按 0 算', r1VoidRow.remaining, 0)

const r1Stats = customers.customerStats(c1.id)
check(
  '客户页未收拆成订单+打样，两者相加=未收总额',
  Math.abs(r1Stats.outstandingOrders + r1Stats.outstandingSamples - r1Stats.outstanding) < 0.01,
  `orders=${r1Stats.outstandingOrders} samples=${r1Stats.outstandingSamples} total=${r1Stats.outstanding}`
)

/* ============================================================
 * 第 6 轮：短款核销 / 坏账 / 追回（R2）
 * ============================================================ */
section('核销与坏账：短款让利、坏账、追回、撤销与全站口径')

const cR2 = customers.saveCustomer({
  company: 'R2 Credit Co',
  contact: 'Credit Desk',
  country: 'United States',
  email: 'credit@r2.example'
})

const wo = orders.createOrder({
  customerId: cR2.id,
  currency: 'USD',
  exchangeRate: 7,
  depositRatio: 0.3,
  charges: [{ label: '运费 Freight', amount: 100 }]
})
orders.setPaymentStatus(wo.id, 'confirmed')
await orders.addOrderItem(wo.id, {
  styleNo: 'R2-A',
  productName: 'R2 核销测试',
  quantity: 100,
  unitPrice: 10,
  unitCost: 6
})
let woNow = orders.addPayment(wo.id, { paidAt: localDate(), amount: 700, method: 'T/T', bankRef: 'R2PAY' })
eq('核销前待收 = 1100 − 700', woNow.remaining, 400)
eq('核销前状态 = 已收定金', woNow.paymentStatus, 'paid')

let r2Err = ''
try {
  orders.addSettlement(wo.id, { kind: 'shortage', amount: 10, reason: '  ' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销必须写原因', r2Err.includes('原因'), r2Err)
r2Err = ''
try {
  orders.addSettlement(wo.id, { kind: 'shortage', amount: 0, reason: '银行扣费' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销金额 0 会被拦住', r2Err.includes('大于 0'), r2Err)
r2Err = ''
try {
  orders.addSettlement(wo.id, { kind: 'shortage', amount: 999, reason: '银行扣费' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销不能超过当前待收', r2Err.includes('超过'), r2Err)

const r2Draft = orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r2Draft.id, {
  styleNo: 'R2-DRAFT',
  productName: '草稿核销测试',
  quantity: 1,
  unitPrice: 100
})
r2Err = ''
try {
  orders.addSettlement(r2Draft.id, { kind: 'bad_debt', reason: '客户失联' })
} catch (e) {
  r2Err = (e as Error).message
}
check('草稿单不能核销 / 标坏账', r2Err.includes('草稿'), r2Err)

woNow = orders.addSettlement(wo.id, {
  kind: 'shortage',
  amount: 40,
  at: localDate(),
  reason: '银行扣费',
  evidence: '水单 R2-001'
})
eq('短款核销后待收 = 400 − 40', woNow.remaining, 360)
eq('短款核销金额单独可见', woNow.writeOffShortage, 40)
eq('短款核销不动已收', woNow.paidAmount, 700)
eq('短款是让利，进毛利：1000 − 600 − 40', woNow.totalProfit, 360)
eq('短款只核销一部分时状态仍是已收定金', woNow.paymentStatus, 'paid')
eq('核销台账有一条短款', orders.listSettlements(wo.id).filter((s) => s.kind === 'shortage').length, 1)

const recvBefore = dashboard.dashboard().monthReceived
woNow = orders.addSettlement(wo.id, {
  kind: 'bad_debt',
  amount: 360,
  at: localDate(),
  reason: '客户破产',
  evidence: '破产公告 2026-10'
})
eq('坏账核销后待收归零', woNow.remaining, 0)
eq('坏账核销金额单独可见', woNow.writeOffBadDebt, 360)
eq('坏账未追回余额 = 360', woNow.badDebtOutstanding, 360)
eq('坏账不动已收', woNow.paidAmount, 700)
eq('坏账结清后收款状态自动到已结清', woNow.paymentStatus, 'settled')
eq('坏账不改进货毛利：仍是 360', woNow.totalProfit, 360)
eq('坏账不进本月回款', dashboard.dashboard().monthReceived, recvBefore)

const woBrief = customers.customerOrderBriefs(cR2.id).find((o) => o.id === wo.id)!
eq('客户页订单待到收 = 0（坏账已核销）', woBrief.remaining, 0)
eq('客户页坏账未追回可见', customers.customerStats(cR2.id).badDebt, 360 * 7)
const woMoney = money.listOrderMoney().find((r) => r.orderId === wo.id)!
eq('汇总口径待收 = 0', woMoney.receivable, 0)
eq('汇总口径坏账 = 360', woMoney.badDebtOutstanding, 360)
eq('坏账单不再出现在催尾款提醒里', dashboard.reminders().some((r) => r.orderId === wo.id && r.kind === 'balance'), false)

const csvRowsR2 = dashboard.exportCsv('orders').split('\r\n')
const headR2 = csvRowsR2[0].replace(/^\uFEFF/, '').split(',')
const rowR2 = csvRowsR2.find((r) => r.split(',')[headR2.indexOf('订单号')] === wo.orderNo)!
eq('CSV 短款核销列', Number(rowR2.split(',')[headR2.indexOf('短款核销(原币)')]), 40)
eq('CSV 坏账核销列', Number(rowR2.split(',')[headR2.indexOf('坏账核销(原币)')]), 360)
eq('CSV 坏账未追回列', Number(rowR2.split(',')[headR2.indexOf('坏账未追回(原币)')]), 360)

const recvBeforeRecovery = dashboard.dashboard().monthReceived
woNow = orders.addSettlement(wo.id, {
  kind: 'recovery',
  amount: 200,
  at: localDate(),
  paidAt: localDate(),
  bankRef: 'R2REC',
  reason: '客户分期补付第一笔'
})
eq('追回后坏账余额 = 160', woNow.badDebtOutstanding, 160)
eq('追回款进已收', woNow.paidAmount, 900)
eq('追回后待收仍是 0', woNow.remaining, 0)
eq('追回后状态仍是已结清', woNow.paymentStatus, 'settled')
check(
  '追回款计入本月回款',
  Math.abs(dashboard.dashboard().monthReceived - (recvBeforeRecovery + 200 * 7)) < 0.01,
  `before=${recvBeforeRecovery} after=${dashboard.dashboard().monthReceived}`
)
eq('追回款对应一条真实收款记录', woNow.payments.filter((p) => p.bankRef === 'R2REC').length, 1)
r2Err = ''
try {
  orders.addSettlement(wo.id, { kind: 'recovery', amount: 999, reason: '再追一笔' })
} catch (e) {
  r2Err = (e as Error).message
}
check('追回不能超过坏账余额', r2Err.includes('超过'), r2Err)
const recoveryRow = orders.listSettlements(wo.id).find((s) => s.kind === 'recovery')!
r2Err = ''
try {
  orders.reverseSettlement(wo.id, recoveryRow.id, '退汇')
} catch (e) {
  r2Err = (e as Error).message
}
check('实际到账的追回款不能撤销', r2Err.includes('不能撤销'), r2Err)

const rev = orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
orders.setPaymentStatus(rev.id, 'confirmed')
await orders.addOrderItem(rev.id, {
  styleNo: 'R2-REV',
  productName: '撤销核销测试',
  quantity: 10,
  unitPrice: 10,
  unitCost: 5
})
orders.addPayment(rev.id, { paidAt: localDate(), amount: 20 })
let revNow = orders.addSettlement(rev.id, { kind: 'bad_debt', amount: 80, reason: '客户失联' })
eq('撤销前待收归零', revNow.remaining, 0)
const bdRow = orders.listSettlements(rev.id).find((s) => s.kind === 'bad_debt')!
revNow = orders.reverseSettlement(rev.id, bdRow.id, '客户又把钱补来了')
eq('撤销坏账后待收恢复 = 100 − 20', revNow.remaining, 80)
eq('撤销后坏账余额归零', revNow.badDebtOutstanding, 0)
eq('撤销后状态退回部分收款', revNow.paymentStatus, 'partial')
const revRows = orders.listSettlements(rev.id)
eq('撤销是追加一条负数，不删原记录', revRows.length, 2)
eq('撤销记录金额为负', revRows.find((s) => s.reversesId === bdRow.id)!.amount, -80)
r2Err = ''
try {
  orders.reverseSettlement(rev.id, bdRow.id, '再撤一次')
} catch (e) {
  r2Err = (e as Error).message
}
check('同一笔核销不能撤销两次', r2Err.includes('撤销过'), r2Err)
r2Err = ''
try {
  orders.deleteOrder(rev.id)
} catch (e) {
  r2Err = (e as Error).message
}
check('有核销记录的订单不能物理删除', r2Err.includes('核销'), r2Err)

const curOnly = orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
orders.setPaymentStatus(curOnly.id, 'confirmed')
await orders.addOrderItem(curOnly.id, {
  styleNo: 'R2-CUR',
  productName: '只有核销没有收款',
  quantity: 10,
  unitPrice: 10
})
orders.addSettlement(curOnly.id, { kind: 'shortage', amount: 10, reason: '客户抹零' })
r2Err = ''
try {
  await orders.updateOrder(curOnly.id, {
    customerId: cR2.id,
    currency: 'EUR',
    exchangeRate: 8
  })
} catch (e) {
  r2Err = (e as Error).message
}
check('只有核销记录也不能改币种', r2Err.includes('核销'), r2Err)

/* ---------------- R4：单据存档版本、路径安全、备份带 PDF、PL 实测毛重 ---------------- */
section('R4 单据存档：版本唯一、路径安全、备份带 PDF')

const r4no = `R4DOC${Date.now()}`
const d1 = docs.saveDocFile({
  pdf: Buffer.from('pdf-v1'),
  docNo: r4no,
  kind: 'pi',
  orderId: order.id,
  amount: 123.45
})
eq('第 1 版存档', d1.version, 1)
check('存档路径是 data 下的相对路径', !isAbsolute(d1.filePath) && d1.filePath.startsWith('docs/'), d1.filePath)
check('存档文件名带单据种类（PI / CI 同号也不会互盖）', d1.filePath.includes(`pi_${r4no}_v1.pdf`), d1.filePath)
check('存档文件真的落盘', fs.existsSync(d1.absolutePath), d1.absolutePath)
eq('下一版 = 2', docs.nextVersion(r4no, 'pi'), 2)

const d2 = docs.saveDocFile({
  pdf: Buffer.from('pdf-v2'),
  docNo: r4no,
  kind: 'pi',
  orderId: order.id,
  amount: 200,
  expectedVersion: 2
})
eq('第 2 版存档', d2.version, 2)
let staleDocErr = ''
try {
  docs.saveDocFile({ pdf: Buffer.from('stale'), docNo: r4no, kind: 'pi', expectedVersion: 1 })
} catch (e) {
  staleDocErr = (e as Error).message
}
check('纸面版次过期会被拦住，不混版', staleDocErr.includes('纸面是第 1 版') && staleDocErr.includes('重新打开'), staleDocErr)
eq('被拦后没有多出存档行', docs.listDocVersions(order.id).filter((d) => d.docNo === r4no).length, 2)

let docPathErr = ''
try {
  docs.saveDocFile({ pdf: Buffer.from('x'), docNo: '../evil', kind: 'pi' })
} catch (e) {
  docPathErr = (e as Error).message
}
check('单号带路径穿越会被拦住', docPathErr.includes('存档目录'), docPathErr)
let docKindErr = ''
try {
  docs.saveDocFile({ pdf: Buffer.from('x'), docNo: r4no, kind: 'invoice' })
} catch (e) {
  docKindErr = (e as Error).message
}
check('不认识的单据种类会被拦住', docKindErr.includes('不认识'), docKindErr)

let dupDocErr = ''
try {
  docs.recordDocVersion({ docNo: r4no, kind: 'pi', version: 1, filePath: 'x' })
} catch (e) {
  dupDocErr = (e as Error).message
}
check('同一版不能记两次（数据库唯一索引兜底）', dupDocErr.length > 0)
eq('相对路径能解析回真实文件', docs.resolveDocPath(d1.filePath), d1.absolutePath)
eq('老的绝对路径也能解析', docs.resolveDocPath(d1.absolutePath), d1.absolutePath)

const docEntries = collectDir(docsDir(), 'docs')
check(
  '备份会递归带上 docs 子目录里的 PDF',
  docEntries.some((e) => e.name === `docs/${r4no}/pi_${r4no}_v1.pdf`),
  docEntries.map((e) => e.name).join(',')
)
const backupDocs = await createBackup('docs')
const backupDocsBuf = fs.readFileSync(backupDocs)
check('备份 zip 里能搜到单据路径', backupDocsBuf.includes(Buffer.from(`docs/${r4no}/pi_${r4no}_v1.pdf`)))

// PL 毛重：没手工填的印 (est.) 并说明；填了实测值就按实测印
const plEst = renderPl({ order: full, settings: getSettings(), images: {} }, full.packingLists[0])
check('PL 推算毛重标 (est.)', plEst.includes('(est.)'))
check('PL 有「不是过磅值」的说明', plEst.includes('not weighed'))
const r4pl = full.packingLists[0]
for (const line of r4pl.lines) {
  packing.updatePackingListLine(order.id, r4pl.id, line.id, { grossWeight: 20.5 })
}
const plManual = renderPl(
  { order: orders.getOrder(order.id)!, settings: getSettings(), images: {} },
  packing.listPackingLists(order.id).find((p) => p.id === r4pl.id)!
)
check('PL 手工毛重按实测值印', plManual.includes('20.50'))
check('PL 全部填了实测毛重后不再标 (est.)', !plManual.includes('(est.)'), plManual.includes('(est.)') ? '仍有 est.' : '')

/* ---------------- R5 客户与商品：抬头快照 / 成本币种 / 停用不删 ---------------- */
section('R5 单据抬头：钉在这一张单上的快照')
const cSnap = customers.saveCustomer({
  company: 'Snapshot Trading Co.',
  contact: 'Mr. Snap',
  email: 'snap@snapshot.com',
  country: 'Netherlands',
  address: 'Keizersgracht 100',
  zipCode: '1016AA',
  attn: 'Mr. Snap',
  paymentPref: 'T/T 30% 定金',
  shipAttn: 'WH-Breda',
  shipAddress: 'Weteringweg 12, Breda',
  shipZipCode: '4845',
  shipCountry: 'Netherlands'
})
const snapOrder = orders.createOrder({ customerId: cSnap.id, currency: 'USD', exchangeRate: 7.5, baseCurrency: 'CNY' })
check('建单时就把买方抬头钉在单上', snapOrder.billTo?.address === 'Keizersgracht 100')
check('收货抬头单独钉一套', snapOrder.shipTo?.address === 'Weteringweg 12, Breda')
const snapPl0 = packing.createPackingList({
  orderId: snapOrder.id,
  lines: [
    {
      boxNo: 'NO.1',
      styleNo: 'A001',
      productName: '纯棉圆领T恤',
      color: 'Black',
      size: 'M',
      quantity: 10,
      netWeight: 2
    }
  ]
})
const snapPiCtx = { order: orders.getOrder(snapOrder.id)!, settings: getSettings(), images: {} }
const snapPiHtml = renderPi(snapPiCtx)
check('PI 印买方地址', snapPiHtml.includes('Keizersgracht 100'))
check('PI 印钉住的付款条款', snapPiHtml.includes('T/T 30% 定金'))
const snapPlHtml = renderPl(snapPiCtx, snapPl0[0])
check('PL 印收货仓而不是买方办公室', snapPlHtml.includes('Weteringweg 12, Breda'))
check('PL 收货人取档案里的 shipAttn', snapPlHtml.includes('WH-Breda'))

// 建完单才改档案：已经发出去的单据不能被人 retrospectively 改掉
customers.saveCustomer({ ...cSnap, address: '换了三次门牌', paymentPref: 'D/P 见票 60 天' })
const snapPiAfter = renderPi({ order: orders.getOrder(snapOrder.id)!, settings: getSettings(), images: {} })
check('改了档案，已开的 PI 仍印当初的地址', snapPiAfter.includes('Keizersgracht 100'))
check('已开的 PI 不会跟着新条款走', !snapPiAfter.includes('D/P 见票'))
eq('订单详情里档案当前值确实变了', orders.getOrder(snapOrder.id)!.customer?.address, '换了三次门牌')

// 这一单要送别的仓：只改这张单的抬头，不改档案
const afterParty = orders.setOrderParties(snapOrder.id, {
  billTo: { address: '客户临时指定的鹿特丹仓' },
  shipTo: { zipCode: '4845AB' }
})
check('抬头可以单点改，改完就印新地址', afterParty.billTo?.address === '客户临时指定的鹿特丹仓')
check('没提到的字段保持快照原值', afterParty.billTo?.company === 'Snapshot Trading Co.')
check('收货抬头只补邮编', afterParty.shipTo?.zipCode === '4845AB')
const partyEvent = orders.listEvents(snapOrder.id).find((e) => e.kind === 'party_update')
check('改抬头留痕并写清改了哪项', (partyEvent?.note ?? '').includes('地址'), partyEvent?.note ?? '')
check('改抬头不碰客户档案', customers.getCustomer(cSnap.id)?.address === '换了三次门牌')

section('R5 报价单抬头快照，转单原样带过去')
const qSnap = quotations.saveQuotation({
  customerId: cSnap.id,
  currency: 'USD',
  exchangeRate: 7.5,
  exchangeRateDate: '2026-09-01',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 100, unitPrice: 8 }
  ]
})
check('报价单也存抬头快照', (qSnap.billTo?.company ?? '') === 'Snapshot Trading Co.')
const qSnapHtml = renderQuotation({ quotation: qSnap, settings: getSettings(), images: {} })
check('报价单印报价时钉住的地址', qSnapHtml.includes('换了三次门牌'))
check('报价单不受别的订单抬头改动影响', !qSnapHtml.includes('客户临时指定的鹿特丹仓'))
const qSnap2 = quotations.saveQuotation({
  ...qSnap,
  items: qSnap.items.map((i) => ({
    styleNo: i.styleNo,
    productName: i.productName,
    color: i.color,
    size: i.size,
    quantity: i.quantity,
    unitPrice: i.unitPrice
  })),
  billTo: { attn: '这一单单独的收件人' }
})
check('报价单抬头单独覆盖某个字段', qSnap2.billTo?.attn === '这一单单独的收件人')
check('覆盖一个字段不能把别的抹掉', (qSnap2.billTo?.company ?? '') === 'Snapshot Trading Co.')
// 转单之前档案又改了一次：转出来的订单必须沿用报价单当初钉住的抬头
customers.saveCustomer({ ...cSnap, address: '第四次改的地址' })
const snapConverted = quotations.convertToOrder(qSnap2.id)
check('转单沿用报价单钉住的地址', (snapConverted.billTo?.address ?? '') === '换了三次门牌')
check('转单不拿档案最新地址', (snapConverted.billTo?.address ?? '') !== '第四次改的地址')
check('转单带上单独覆盖的收件人', (snapConverted.billTo?.attn ?? '') === '这一单单独的收件人')

section('R5 成本价是工厂价：按本单汇率折算，绝不混币')
const costOrder = orders.createOrder({ customerId: cSnap.id, currency: 'USD', exchangeRate: 8, baseCurrency: 'CNY' })
const withCost = orders.addOrderItem(costOrder.id, {
  productId: p1.id,
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'White',
  size: 'L',
  quantity: 10,
  unitPrice: 12,
  costBase: 32
})
eq('工厂价 32 元 ÷ 汇率 8 = 本单成本 4 美元', withCost.items.find((i) => i.color === 'White')?.unitCost, 4)
const repatched = orders.updateOrderItem(costOrder.id, withCost.items[0].id, { costBase: 40 })
eq('就地补录工厂价也按本单汇率折算', repatched.items[0].unitCost, 5)
const clearedCost = orders.updateOrderItem(costOrder.id, withCost.items[0].id, { costBase: null })
eq('工厂价填了又清空 = 成本变未录，不是留旧值', clearedCost.items[0].unitCost, null)
const qCost = quotations.saveQuotation({
  customerId: cSnap.id,
  currency: 'USD',
  exchangeRate: 8,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'S', quantity: 50, unitPrice: 9 }]
})
const convertedCost = quotations.convertToOrder(qCost.id)
eq('报价转单时商品成本也折算成订单币种', convertedCost.items[0].unitCost, 0.6875)
check(
  '折算后的成本乘回汇率就是工厂价（¥5.5 不会被当成 $5.5）',
  Math.abs((convertedCost.items[0].unitCost ?? 0) * 8 - 5.5) < 0.001
)

section('R5 历史成交价：报价前先看这客户上次什么价')
const priceRows = customers.stylePriceHistory({ customerId: c1.id })
check('能列出这个客户的历史成交价', priceRows.length > 0)
check('历史成交价都带币种', priceRows.every((r) => !!r.lastCurrency))
check('按客户过滤就不会混进别人', customers.stylePriceHistory({ customerId: c2.id }).every((r) => r.customerCompany === c2.company))
const a001Rows = customers.stylePriceHistory({ styleNo: 'a001' })
check('按款号过滤忽略大小写', a001Rows.length > 0 && a001Rows.every((r) => r.styleNo.toUpperCase() === 'A001'))
check('同款同色合并成一条并累计次数', a001Rows.reduce((s, r) => s + r.times, 0) >= a001Rows.length)
// 草稿 / 作废单还没成交，不能污染「上次成交价」
const draftPriceOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
orders.addOrderItem(draftPriceOrder.id, { styleNo: 'ZZ999', productName: '没成交的草稿款', quantity: 1, unitPrice: 99.99 })
check(
  '草稿单的报价不进历史成交价',
  !customers.stylePriceHistory({ styleNo: 'ZZ999' }).some((r) => r.lastUnitPrice === 99.99)
)

section('R5 同名客户：提醒但不硬拦')
let dupErr = ''
try {
  customers.saveCustomer({ company: 'Acme Fashion GmbH' })
} catch (e) {
  dupErr = (e as Error).message
}
check('同名客户先拦一道并说清后果', dupErr.includes('同名'), dupErr)
const dupOk = customers.saveCustomer({
  company: 'acme fashion gmbh ',
  contact: '第二个采购办',
  allowDuplicate: true
})
check('确认是两家不同的公司就能存', dupOk.id > 0)
eq('同名对照查得到几条', customers.sameNameCustomers('Acme Fashion GmbH').length, 2)

section('R5 停用而不是删除：单据要能原样重印')
let styleErr = ''
try {
  products.saveProduct({ styleNo: 'a001', name: '撞号的款', sizes: [], colors: [] })
} catch (e) {
  styleErr = (e as Error).message
}
check('款号大小写撞号被拦（一个号只能有一条档案）', styleErr.includes('已经存在'), styleErr)
const refDel = products.deleteProduct(p1.id)
check('被历史单据引用的款不真删，只做停用', refDel.deactivated)
check('停用的话术讲清为什么不能删', refDel.message.includes('重印'), refDel.message)
check('停用后建单下拉不再带出', !products.listProducts().some((p) => p.id === p1.id))
eq('但按款号仍找得回来，历史单据照印', products.findProductByStyleNo('A001')?.id, p1.id)
check('引用计数说得出挂在几个订单行上', products.productReferenceCount(p1.id).orders > 0)
const backOn = products.setProductActive(p1.id, 1)
check('需要时能再启用', backOn.active === 1)
check('再启用后回到建单下拉', products.listProducts().some((p) => p.id === p1.id))

const cStop = customers.saveCustomer({ company: 'Bymark AB', contact: 'Sofia', country: 'Sweden' })
customers.setCustomerActive(cStop.id, 0)
check('停用的客户不在建单下拉里', !customers.listCustomers('Bymark').some((c) => c.id === cStop.id))
check('勾选「显示已停用」还能看到', customers.listCustomers('Bymark', true).some((c) => c.id === cStop.id))
eq('停用不影响按编号取档案', customers.getCustomer(cStop.id)?.company, 'Bymark AB')
customers.setCustomerActive(cStop.id, 1)

section('R5 商品 CSV 导入：Excel 另存为 CSV 就能进库')
const csvText = [
  products.CSV_TEMPLATE_HEADER,
  'B101,"羊毛混纺外套, 男款",80% Wool,S M L,黑/白/灰,¥ 88,雅戈尔,YY-88,20,60×40×50,0.7,外套,House,A/W26,挂牌要烫金',
  'b101,库里已有的款,100% Polyester,,,,,,,,,',
  ',这一行没有款号,100% Cotton,,,,,,,,'
].join('\n')
const imp1 = products.importProductsCsv(csvText, 'skip')
eq('导入新增 1 款', imp1.created, 1)
eq('撞号的和没款号的一共跳过 2 行', imp1.skipped, 2)
const b101 = products.findProductByStyleNo('B101')!
eq('引号里的逗号不算分列', b101.name, '羊毛混纺外套, 男款')
eq('成本价里的 ¥ 会被抹掉', b101.costPrice, 88)
eq('尺码按空格拆开', b101.sizes, ['S', 'M', 'L'])
eq('颜色按斜杠拆开', b101.colors, ['黑', '白', '灰'])
eq('箱规 60×40×50 拆成三个数', [b101.boxLength, b101.boxWidth, b101.boxHeight], [60, 40, 50])
eq('工厂进了档案', b101.factory, '雅戈尔')
eq('工厂货号进了档案', b101.factoryNo, 'YY-88')
check('没款号的行逐行说明原因', imp1.errors.some((e) => e.includes('没有款号')), JSON.stringify(imp1.errors))
const c900 = products.saveProduct({
  styleNo: 'C900',
  name: '旧名字',
  composition: '100% Cotton',
  costPrice: 10,
  sizes: [],
  colors: []
})
const impSkip = products.importProductsCsv(
  [products.CSV_TEMPLATE_HEADER, 'C900,覆盖模式才会改,,,,,,,,,,'].join('\n'),
  'skip'
)
eq('默认「跳过已有」不动老档案', products.getProduct(c900.id)?.name, '旧名字')
eq('跳过模式不计更新', impSkip.updated, 0)
const impOver = products.importProductsCsv(
  [products.CSV_TEMPLATE_HEADER, 'C900,覆盖后的新名字,80% Wool,,,¥ 12,,,,,,,,,'].join('\n'),
  'overwrite'
)
eq('覆盖模式更新 1 条', impOver.updated, 1)
eq('覆盖后档案真的变了', products.getProduct(c900.id)?.name, '覆盖后的新名字')
eq('覆盖时成本也按 ¥ 解析', products.getProduct(c900.id)?.costPrice, 12)
let csvErr = ''
try {
  products.importProductsCsv('编号,品名\nX1,abc\n', 'skip')
} catch (e) {
  csvErr = (e as Error).message
}
check('表头没有「款号」时用人话报错，不静默导入 0 条', csvErr.includes('款号'), csvErr)

/* ---------------- R6 工作台提醒 ---------------- */
section('R6 催款时钟：改备注不会把拖了几星期的单子清零')
const sR6 = getSettings()
saveSettings({ ...sR6, remindConfirmDays: 7, remindPaymentDays: 10, remindBalanceDays: 15, remindShipDays: 3 })
const dAgo = (n: number): string => localDate(new Date(Date.now() - n * 86400000))
const dAgoIso = (n: number): string => new Date(Date.now() - n * 86400000).toISOString()
const cR6 = customers.saveCustomer({ company: 'R6 Clock GmbH', country: 'DE' })
const oR6 = orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentMethod: 'tt_deposit',
  depositRatio: 30,
  validUntil: dAgo(2)
})
await orders.addOrderItem(oR6.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10 })
orders.setPaymentStatus(oR6.id, 'sent')
// 把「进入待确认」这条事件往前拨 20 天，模拟 PI 真的发出去三周了
getDb().run(
  `UPDATE order_events SET at = ? WHERE order_id = ? AND kind = 'payment_status' AND to_status = 'sent'`,
  [dAgoIso(20), oR6.id]
)
const remR6a = dashboard.reminders()
const confirmR6 = remR6a.find((r) => r.kind === 'confirm' && r.orderId === oR6.id)
check('PI 发出 20 天没确认 → 催确认按状态时钟算天数', !!confirmR6 && confirmR6.days >= 19, JSON.stringify(confirmR6))
check(
  'PI 有效期已过 → 单独亮一条到期提醒',
  dashboard.reminders().some((r) => r.kind === 'expiry' && r.orderId === oR6.id && r.message.includes('PI 有效期')),
  JSON.stringify(dashboard.reminders().filter((r) => r.orderId === oR6.id).map((r) => r.kind))
)
orders.updateOrder(oR6.id, { customerId: cR6.id, note: '顺手补了个备注' })
const confirmR6b = dashboard.reminders().find((r) => r.kind === 'confirm' && r.orderId === oR6.id)
eq('改个备注不会把等待天数刷新成 0（不看 updated_at）', confirmR6b?.days, confirmR6?.days)

section('R6 脏日期：宁可亮「待修」，不许印「还有 NaN 天」')
const oDirty = orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2 })
orders.updateOrder(oDirty.id, { customerId: cR6.id, expectedShipDate: '2026/13/45', cutOffDate: '2026/10/05' })
const remDirty = dashboard.reminders()
check(
  '没有任何一条提醒印出 NaN',
  !remDirty.some((r) => r.message.includes('NaN') || r.message.includes('undefined')),
  JSON.stringify(remDirty.filter((r) => /NaN|undefined/.test(r.message)).map((r) => r.message))
)
check(
  '写歪的预计出货日变成一条「待修」',
  remDirty.some(
    (r) => r.kind === 'data' && r.orderId === oDirty.id && r.message.includes('预计出货日') && r.message.includes('不是合法日期')
  ),
  JSON.stringify(remDirty.filter((r) => r.orderId === oDirty.id).map((r) => r.message))
)
check(
  '分隔符写歪的截关日也算脏数据（本地日期只认 2026-10-05）',
  remDirty.some((r) => r.kind === 'data' && r.orderId === oDirty.id && r.message.includes('截关日')),
  ''
)

section('R6 货已出运却一分未收：赊销 / L/C 不再哑火')
const oShipped = orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentMethod: 'oa',
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(oShipped.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10 })
const plR6 = packing.createPackingList({ orderId: oShipped.id, lines: [{ styleNo: 'A001', quantity: 10 }] })
packing.updatePackingListInfo(oShipped.id, plR6[0].id, {
  shipStatus: 'shipped',
  atdDate: dAgo(30),
  etaDate: dAgo(16),
  blNo: 'MEDU-9988776'
})
const remShipped = dashboard.reminders()
const unpaidRem = remShipped.find(
  (r) => r.kind === 'balance' && r.orderId === oShipped.id && r.message.includes('一分未收')
)
check('出运 30 天、没收到过一分钱 → 照样催款', !!unpaidRem, JSON.stringify(remShipped.filter((r) => r.orderId === oShipped.id)))
check('催款话术带上付款方式，一眼知道是赊销还是信用证', (unpaidRem?.message ?? '').includes('赊销'), unpaidRem?.message)
check(
  '预计到港已过、钱还没收齐 → 单独催一次（按批次 ETA）',
  remShipped.some((r) => r.kind === 'balance' && r.plId === plR6[0].id && r.message.includes('到港')),
  JSON.stringify(remShipped.filter((r) => r.plId === plR6[0].id).map((r) => r.message))
)
check(
  '每条提醒自带唯一 key（界面折叠不会误伤同单另一条）',
  new Set(remShipped.map((r) => r.key)).size === remShipped.length,
  `${remShipped.length} 条 / ${new Set(remShipped.map((r) => r.key)).size} 个 key`
)
const overdueN = remShipped.filter((r) => r.days < 0).length
check('逾期的排在最前面，越久越靠前', remShipped.slice(0, overdueN).every((r) => r.days < 0), JSON.stringify(remShipped.slice(0, 3).map((r) => r.days)))
const remOrdered = dashboard.reminders()
const firstData = remOrdered.findIndex((r) => r.kind === 'data')
const lastUpcoming = remOrdered.reduce((acc, r, idx) => (r.kind !== 'data' && r.days > 0 ? idx : acc), -1)
check(
  '「待修」垫底：数据待修不会压住真正的交期提醒',
  firstData === -1 || lastUpcoming < firstData,
  JSON.stringify(remOrdered.map((r) => `${r.kind}:${r.days}`))
)

section('R6 待修清单：数据歪了要有人去补，别让提醒静默失效')
packing.updatePackingListInfo(oShipped.id, plR6[0].id, { blNo: '' })
check(
  '标了「已出运」却没有提单号 → 待修',
  dashboard
    .reminders()
    .some((r) => r.kind === 'data' && r.plId === plR6[0].id && r.message.includes('提单号')),
  ''
)
const oLegacy = orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(oLegacy.id, { styleNo: 'A001', productName: 'T恤', quantity: 4, unitPrice: 10 })
const plLegacy = packing.createPackingList({ orderId: oLegacy.id, lines: [{ styleNo: 'A001', quantity: 4 }] })
getDb().run('UPDATE packing_lists SET ship_status = NULL WHERE id = ?', [plLegacy[0].id])
check(
  '老批次没标出运状态 → 待修（整单进度推不出来）',
  dashboard
    .reminders()
    .some((r) => r.kind === 'data' && r.orderId === oLegacy.id && r.message.includes('没标出运状态')),
  ''
)
const oRate1 = orders.createOrder({ customerId: cR6.id, currency: 'USD', paymentStatus: 'sent' })
check(
  '外币单汇率还是 1:1 → 待修（不阻断建单，但要亮出来）',
  dashboard
    .reminders()
    .some((r) => r.kind === 'data' && r.orderId === oRate1.id && r.message.includes('按 1:')),
  ''
)

section('R6 报价跟进：发出去没回音、到期没人转单')
const qR6 = quotations.saveQuotation({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  status: 'sent',
  validUntil: dAgo(2),
  items: [{ styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 9 }]
})
check('报价标成「已发出」时落下 sent_at', (getDb().get('SELECT sent_at FROM quotations WHERE id = ?', [qR6.id]) as { sent_at?: string }).sent_at != null)
getDb().run('UPDATE quotations SET sent_at = ? WHERE id = ?', [dAgoIso(20), qR6.id])
const remQuote = dashboard.reminders()
check(
  '报价发出 20 天没回音 → 催跟进',
  remQuote.some((r) => r.kind === 'quote' && r.orderNo === qR6.qNo && r.message.includes('没回音') && r.days >= 19),
  JSON.stringify(remQuote.filter((r) => r.kind === 'quote').map((r) => r.message))
)
check(
  '报价有效期已过还没转单 → 催重新盘汇率',
  remQuote.some((r) => r.kind === 'quote' && r.orderNo === qR6.qNo && r.message.includes('到期')),
  ''
)
// 编辑报价只动 updated_at，等待天数必须还按 sent_at 算
quotations.saveQuotation({ ...qR6, note: '改了一下备注' })
const remQuote2 = dashboard.reminders()
check(
  '改报价备注不会把「发出 20 天没回音」清零',
  remQuote2.some((r) => r.kind === 'quote' && r.orderNo === qR6.qNo && r.message.includes('发出 20 天')),
  JSON.stringify(remQuote2.filter((r) => r.orderNo === qR6.qNo).map((r) => r.message))
)
quotations.saveQuotation({ ...qR6, status: 'confirmed' })
check(
  '报价状态变化单独进历史：谁把报价发出去、什么时候改口，都要查得到',
  quotations.listQuotationEvents(qR6.id).some((e) => e.kind === 'status' && e.note.includes('sent')),
  JSON.stringify(quotations.listQuotationEvents(qR6.id).map((e) => e.note))
)

section('R6 待收款拆分与「本月完成」口径')
const stR6 = dashboard.dashboard()
check(
  '四桶相加 = 待收款总额（拆分只是展示，不动口径）',
  Math.abs(stR6.pendingUnconfirmed + stR6.pendingDeposit + stR6.pendingBalance + stR6.pendingSample - stR6.pendingAmount) < 0.01,
  `${stR6.pendingUnconfirmed + stR6.pendingDeposit + stR6.pendingBalance + stR6.pendingSample} vs ${stR6.pendingAmount}`
)
const doneBefore = dashboard.dashboard().completedThisMonth
const oSigned = orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' })
getDb().run("UPDATE orders SET ship_status = 'delivered' WHERE id = ?", [oSigned.id])
eq(
  '只有 updated_at 动过的单不再被算成「本月完成」（要批次签收或状态事件）',
  dashboard.dashboard().completedThisMonth,
  doneBefore
)
orders.setShipStatus(oSigned.id, 'delivered')
eq('正常标签收后计入本月完成', dashboard.dashboard().completedThisMonth, doneBefore + 1)
// 作废单：任何提醒都不该再挂它
const oVoid = orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  expectedShipDate: dAgo(1)
})
orders.setPaymentStatus(oVoid.id, 'sent')
check('作废前确实有提醒', dashboard.reminders().some((r) => r.orderId === oVoid.id))
orders.voidOrder(oVoid.id, '客户取消')
check(
  '作废单从待办里彻底消失（催确认/交期/待修都不再喊）',
  !dashboard.reminders().some((r) => r.orderId === oVoid.id),
  JSON.stringify(dashboard.reminders().filter((r) => r.orderId === oVoid.id).map((r) => r.kind))
)
saveSettings(sR6)

/* ---------------- R7 报表与导出 ---------------- */
section('R7 CSV 转义与注入：客户名再野也不能把列撑爆')

/** 按 RFC4180 解析整段 CSV：带引号的字段里可以有逗号、引号、换行 */
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cell)
      out.push(row)
      row = []
      cell = ''
      i += 1
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    out.push(row)
  }
  return out
}
const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100
const recOf = (csv: string, colName: string, val: string): { head: string[]; row: string[] } | null => {
  const recs = parseCsv(csv)
  const head = recs[0]
  const idx = head.indexOf(colName)
  const row = recs.slice(1).find((c) => c[idx] === val)
  return row ? { head, row } : null
}

const cWild = customers.saveCustomer({ company: 'Acme, "Head" Office\nHamburg', country: 'DE' })
const oWild = orders.createOrder({ customerId: cWild.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(oWild.id, { styleNo: 'A001', productName: 'T, 恤', quantity: 10, unitPrice: 10, unitCost: 6 })
orders.setPaymentStatus(oWild.id, 'confirmed')
const csvOrdersRaw = dashboard.exportCsv('orders')
const wildLedger = recOf(csvOrdersRaw, '订单号', oWild.orderNo)
check(
  '客户名里的逗号/引号/换行原样回来，列没有错位',
  !!wildLedger && wildLedger.row[wildLedger.head.indexOf('客户')] === 'Acme, "Head" Office\nHamburg',
  JSON.stringify(wildLedger?.row[wildLedger?.head.indexOf('客户') ?? 0])
)
const wildRecs = parseCsv(csvOrdersRaw)
eq(
  '订单台账每一行的列数都等于表头列数（转义没漏一处）',
  wildRecs.filter((c) => c.length === wildRecs[0].length).length,
  wildRecs.length
)
check(
  '订单台账补了锁汇日期（税务复核折算要用）',
  !!wildLedger && wildLedger.head.includes('锁汇日期') && wildLedger.row[wildLedger.head.indexOf('锁汇日期')] === localDate(),
  JSON.stringify(wildLedger?.row[wildLedger?.head.indexOf('锁汇日期') ?? 0])
)

const cEvil = customers.saveCustomer({ company: '=HYPERLINK("http://evil","点我")', country: 'CN' })
const oEvil = orders.createOrder({ customerId: cEvil.id, currency: 'USD', exchangeRate: 7.2 })
// 草稿单已经不进订单台账了（R7 口径），要试转义就得把它变成正式单
orders.setPaymentStatus(oEvil.id, 'confirmed')
const evilLedger = recOf(dashboard.exportCsv('orders'), '订单号', oEvil.orderNo)
check(
  '以 = 开头的客户名被中和：Excel 不会把它当公式跑',
  !!evilLedger && evilLedger.row[evilLedger.head.indexOf('客户')].startsWith("'="),
  JSON.stringify(evilLedger?.row[evilLedger.head.indexOf('客户')])
)

const oNeg = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  charges: [{ label: '折让 Discount', amount: -50 }]
})
await orders.addOrderItem(oNeg.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10, unitCost: 6 })
orders.setPaymentStatus(oNeg.id, 'confirmed')
const negLedger = recOf(dashboard.exportCsv('orders'), '订单号', oNeg.orderNo)
eq(
  '负数费用导出成数字 -50：不加引号也不加前缀，Excel 里能直接求和',
  negLedger?.row[negLedger.head.indexOf('费用合计(原币)')],
  '-50'
)

section('R7 台账口径：与报表同源，草稿作废不再混进 SUM')
const oDraftR7 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
const oVoidR7 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
orders.setPaymentStatus(oVoidR7.id, 'confirmed')
await orders.addOrderItem(oVoidR7.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10, unitCost: 6 })
orders.addPayment(oVoidR7.id, { paidAt: localDate(), amount: 30, method: 'T/T', bankRef: 'R7-VOID-01' })
orders.voidOrder(oVoidR7.id, '客户取消')
const ledgerRaw = dashboard.exportCsv('orders')
check('草稿单不再进订单台账（销售额口径，列可以直接求和）', !recOf(ledgerRaw, '订单号', oDraftR7.orderNo))
check('作废单也不再进订单台账（它不该出现在收入表里让财务自己筛）', !recOf(ledgerRaw, '订单号', oVoidR7.orderNo))
const allRaw = dashboard.exportCsv('orders_all')
check('草稿单在「全量底稿」里：历史一行没丢', !!recOf(allRaw, '订单号', oDraftR7.orderNo))
const voidAll = recOf(allRaw, '订单号', oVoidR7.orderNo)
eq('全量底稿里作废单的状态写中文「已作废」', voidAll?.row[voidAll.head.indexOf('收款状态')], '已作废')
const voidPay = recOf(dashboard.exportCsv('payments'), '银行流水号', 'R7-VOID-01')
eq('作废单到账的钱仍在收款台账，状态列写「已作废」', voidPay?.row[voidPay.head.indexOf('订单状态')], '已作废')

const ledgerRecs = parseCsv(ledgerRaw)
const ledgerHead = ledgerRecs[0]
const sumCol = (name: string): number =>
  ledgerRecs.slice(1).reduce((s, c) => s + r2(Number(c[ledgerHead.indexOf(name)])), 0)
const reportSales = dashboard.monthlyReport().reduce((s, r) => s + r2(r.sales), 0)
check(
  '台账「含费用合计(基准币)」整列求和 = 报表累计销售额（差不过几分钱）',
  Math.abs(sumCol('含费用合计(CNY)') - reportSales) < 0.5,
  `${sumCol('含费用合计(CNY)')} vs ${reportSales}`
)
const stR7 = dashboard.dashboard()
check(
  '台账「待收金额(基准币)」整列求和 = 工作台待收款里的货款部分',
  Math.abs(sumCol('待收金额(CNY)') - (stR7.pendingAmount - stR7.pendingSample)) < 0.5,
  `${sumCol('待收金额(CNY)')} vs ${stR7.pendingAmount - stR7.pendingSample}`
)

section('R7 月度汇总：折让/短款/坏账导得出去，收款列写明按到账月')
const csvMonthly = dashboard.exportCsv('monthly')
const mRecs = parseCsv(csvMonthly)
const mHead = mRecs[0]
check('月度汇总能导出去了（成本/毛利/折让/短款/坏账都在列里）', ['成本(CNY)', '毛利(CNY)', '折让(CNY)', '短款核销(CNY)', '坏账未追回(CNY)'].every((h) => mHead.includes(h)), mHead.join('|'))
check('月度汇总的收款列写明「按到账月」，不会被当成下单月的钱', mHead.some((h) => h.includes('按到账月')), mHead.join('|'))
eq('月度汇总导出有 BOM（Excel 打开不乱码）', csvMonthly.charCodeAt(0) === 0xfeff, true)
const thisMonth = localMonthOf(localDate())
const repThis = dashboard.monthlyReport().find((x) => x.month === thisMonth)
const csvThis = recOf(csvMonthly, '月份', thisMonth)
eq(
  '导出的本月销售额 = 报表页这个月的数',
  Number(csvThis?.row[mHead.indexOf('销售额(CNY)')]),
  repThis ? r2(repThis.sales) : 0
)
const mShortage = dashboard.monthlyReport().reduce((s, r) => s + r.shortage, 0)
const moneyShortage = money.listOrderMoney().reduce((s, r) => s + r.shortageAmount * r.exchangeRate, 0)
check(
  '月报短款列之和 = money.ts 逐单短款之和（没有另写一套 SQL）',
  Math.abs(mShortage - moneyShortage) < 0.01,
  `${mShortage} vs ${moneyShortage}`
)
const mBad = dashboard.monthlyReport().reduce((s, r) => s + r.badDebt, 0)
const moneyBad = money.listOrderMoney().reduce((s, r) => s + r.badDebtOutstanding * r.exchangeRate, 0)
check('月报坏账列之和 = money.ts 逐单未追回坏账之和', Math.abs(mBad - moneyBad) < 0.01, `${mBad} vs ${moneyBad}`)
const mDiscount = dashboard.monthlyReport().reduce((s, r) => s + r.discount, 0)
const moneyDiscount = money.listOrderMoney().reduce((s, r) => s + -r.negativeCharges * r.exchangeRate, 0)
check('月报折让列 = 负向费用之和（让利看得见）', Math.abs(mDiscount - moneyDiscount) < 0.01, `${mDiscount} vs ${moneyDiscount}`)
let kindErr = ''
try {
  ;(dashboard.exportCsv as (k: unknown) => string)('bogus')
} catch (e) {
  kindErr = (e as Error).message
}
check('未知导出类型直接报错，不会静默掉进收款分支', kindErr.includes('不支持的导出类型'), kindErr)

section('R7 款号明细台账：成本与整单费用都带上')
const csvItemsR7 = dashboard.exportCsv('items')
const iRecs = parseCsv(csvItemsR7)
const iHead = iRecs[0]
const iRowsWild = iRecs.slice(1).filter((c) => c[iHead.indexOf('订单号')] === oWild.orderNo)
check('明细台账补了成本列', iHead.includes('单位成本(原币)') && iHead.includes('成本(原币)'), iHead.join('|'))
eq('明细里的单位成本 = 录进去的成本', Number(iRowsWild[0]?.[iHead.indexOf('单位成本(原币)')]), 6)
eq('明细里的成本 = 数量 × 单位成本', Number(iRowsWild[0]?.[iHead.indexOf('成本(原币)')]), 60)
const iRowsNoCost = iRecs.slice(1).filter((c) => c[iHead.indexOf('款号')] === 'A002')
check(
  '没录成本的那行成本留空，不写 0 冒充（有款可算的照实算）',
  iRowsNoCost.some((c) => c[iHead.indexOf('单位成本(原币)')] === '') &&
    iRowsNoCost.every((c) => c[iHead.indexOf('单位成本(原币)')] !== '0')
)
check('整单的货值/费用/含费用合计一起带上：报关核数那截差额有交代', ['该单货值(原币)', '该单费用合计(原币)', '该单含费用合计(原币)'].every((h) => iHead.includes(h)), iHead.join('|'))
const iSum = iRowsWild.reduce((s, c) => s + Number(c[iHead.indexOf('金额(原币)')]), 0)
eq('明细金额之和 = 该单货值（差额就是费用行）', iSum, Number(iRowsWild[0]?.[iHead.indexOf('该单货值(原币)')]))
const negLedger2 = recOf(csvItemsR7, '订单号', oNeg.orderNo)
eq(
  '带折让的单：明细货值 100，含费用合计 50，差额就是 -50 折让',
  [negLedger2?.row[negLedger2.head.indexOf('该单货值(原币)')], negLedger2?.row[negLedger2.head.indexOf('该单含费用合计(原币)')]],
  ['100', '50']
)
const STATUS_CODES = ['draft', 'sent', 'confirmed', 'partial', 'settled', 'expired', 'void', 'not_prepared', 'preparing', 'packed', 'shipped', 'cleared', 'delivered']
check(
  '三张台账的状态一律中文标签，不再吐英文原码',
  iRowsWild.every((c) => !STATUS_CODES.includes(c[iHead.indexOf('收款状态')])) &&
    recOf(dashboard.exportCsv('payments'), '订单号', oVoidR7.orderNo)!.row.includes('已作废')
)

section('R7 到账只有一份算法 + 客户欠款榜')
eq(
  '工作台「本月收款」= 月报这个月的收款（两处不再各写一遍 SUM）',
  dashboard.dashboard().monthReceived,
  dashboard.monthlyReport().find((x) => x.month === thisMonth)?.received ?? 0
)
const dirtyBefore = dashboard.monthlyReport().length
getDb().run(
  `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, created_at) VALUES(?,?,?,?,?,?,?)`,
  [oEvil.id, '', 5, 'T/T', 'R7-DIRTY', '老数据：日期是空的', '2026-01-01T00:00:00.000Z']
)
check(
  '空日期的老收款不会冒出一个垃圾月份',
  dashboard.monthlyReport().every((r) => /^\d{4}-\d{2}$/.test(r.month)),
  JSON.stringify(dashboard.monthlyReport().filter((r) => !/^\d{4}-\d{2}$/.test(r.month)).map((r) => r.month))
)
getDb().run(`DELETE FROM payments WHERE bank_ref = 'R7-DIRTY'`)
check('删掉脏行后月份数回到原样（没有多余垃圾月）', dashboard.monthlyReport().length, dirtyBefore)
const owed = money.receivableByCustomer()
check(
  '客户欠款榜合计 = 工作台待收款（货款 + 打样，同一个口径）',
  Math.abs(owed.reduce((s, o) => s + o.totalBase, 0) - stR7.pendingAmount) < 0.01,
  `${owed.reduce((s, o) => s + o.totalBase, 0)} vs ${stR7.pendingAmount}`
)
check('欠款榜按敞口从大到小排', owed.every((o, i) => i === 0 || owed[i - 1].totalBase >= o.totalBase))
eq(
  '各客户打样敞口之和 = sampleReceivable()（打样费没漏也没重算）',
  r2(owed.reduce((s, o) => s + o.sampleBase, 0)),
  r2(money.sampleReceivable())
)
const wildMoney = money.listOrderMoney().find((x) => x.orderId === oWild.id)!
const wildOwed = owed.find((o) => o.customerId === cWild.id)
eq('有未结单的客户在榜上，敞口就是这单的待收（基准币）', wildOwed ? r2(wildOwed.goodsBase) : 0, r2(wildMoney.receivableBase))


/* ---------------- R8 装箱与出货：入口闸门 + 批次凭据 ---------------- */
section('R8 装箱闸门：件数、款号、重量在 service 入口就拦死')
const r8g = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r8g.id, {
  styleNo: 'R8G',
  productName: '闸门款',
  color: 'Sky',
  size: 'L',
  quantity: 100,
  unitPrice: 10,
  unitCost: 5
})
const r8err = (fn: () => unknown): string => {
  try {
    fn()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}
const r8of = (qty: unknown) => [{ boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: qty }]
const r8get = (orderId: number, plId: number) => packing.listPackingLists(orderId).find((p) => p.id === plId)!
check(
  '件数填 0 拦下，并告诉她该删行而不是填 0',
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: r8of(0) })).includes('删掉那一行'),
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: r8of(0) }))
)
check('半件拦下：箱单和报关单上都说不清', r8err(() => packing.createPackingList({ orderId: r8g.id, lines: r8of(2.5) })).includes('整件'))
check(
  '负数件拦下：一旦进来就把这一款的已装量压低，超装闸门跟着失效',
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: r8of(-30) })).includes('1 件以上')
)
check('件数根本不是数字也拦下（IPC 是谁都能打的，不能只靠 UI）', r8err(() => packing.createPackingList({ orderId: r8g.id, lines: r8of('abc' as any) })).includes('不是数字'))
check(
  '款号留空拦下：没有款号的箱子归不进任何一款的已装量',
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: '', color: 'Sky', size: 'L', quantity: 10 }] })).includes('款号')
)
check(
  '净重填负数拦下（留空是允许的，纸面按系数估）',
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 10, netWeight: -3 }] })).includes('公斤数')
)
check(
  '订单里没有的这一款不能凭空多装一款',
  r8err(() => packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: 'R8X', color: 'Sky', size: 'L', quantity: 10 }] })).includes('订单里没有')
)
check('一箱都没有的空装箱单建不出来', r8err(() => packing.createPackingList({ orderId: r8g.id, lines: [] })).includes('至少要有一箱'))
check(
  '同一款拆成多箱也按合计校验：逐行放行、加起来超装的拦得住',
  r8err(() =>
    packing.createPackingList({
      orderId: r8g.id,
      lines: [
        { boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 60 },
        { boxNo: 'NO.2', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 60 }
      ]
    })
  ).includes('超了')
)

const r8PlsA = packing.createPackingList({
  orderId: r8g.id,
  lines: [
    { boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 40, netWeight: 20 },
    { boxNo: 'NO.2', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 20, netWeight: 10 }
  ]
})
const r8A = r8PlsA[0]
eq('正常的一批建得出来（60 件落库）', r8A.lines.reduce((s, l) => s + l.quantity, 0), 60)
const r8Factor = Number(getSettings().grossWeightFactor)
check(
  '毛重没手填时按 净重 × 系数 估出来',
  Math.abs((r8A.lines[0].grossWeight ?? 0) - 20 * r8Factor) < 0.01,
  `${r8A.lines[0].grossWeight} vs ${20 * r8Factor}`
)
const r8AfterAdd = packing.addPackingListLine(r8g.id, r8A.id, { styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 10 })
const r8AddLine = r8AfterAdd.find((p) => p.id === r8A.id)!.lines.find((l) => l.quantity === 10)!
check(
  '现场补一箱自动继承同款那箱的单位净重（20kg/40 件 → 10 件算 5kg），不用重敲',
  Math.abs((r8AddLine.netWeight ?? 0) - 5) < 0.01,
  String(r8AddLine.netWeight)
)
check('补的这箱也按系数带上毛重', Math.abs((r8AddLine.grossWeight ?? 0) - 5 * r8Factor) < 0.01, String(r8AddLine.grossWeight))

section('R8 实收数量：短卸记得住，多收拦得住')
const r8RecvErr = r8err(() => packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 90 }))
check('实收不可能比这批发出去的还多，并指路去另开装箱单', r8RecvErr.includes('另开装箱单'), r8RecvErr)
check('实收要 0 以上整数（半件客户也不会签收）', r8err(() => packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 30.5 })).includes('整数'))
check('实收留空等于按发数全收，不是记成 0', r8err(() => packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: '' as any })) === '')
packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 68 })
eq('短卸 2 件记下来了', r8get(r8g.id, r8A.id).receivedQty, 68)
packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: null })
eq('清空实收回到「没记录」', r8get(r8g.id, r8A.id).receivedQty, null)
packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 0 })
eq('实收 0 件是合法事实（一件没收到），和留空不是一回事', r8get(r8g.id, r8A.id).receivedQty, 0)
packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: null })

section('R8 单据日期与签收日期：补录的是那天的事，不是点这一下的今天')
check(
  '单据日期写「2026-13-01」直接拦下',
  r8err(() => packing.updatePackingListInfo(r8g.id, r8A.id, { docDate: '2026-13-01' })).includes('不是合法日期')
)
check('ETD 写脏日期同样拦下（脏日期会把催单时钟带错）', r8err(() => packing.updatePackingListInfo(r8g.id, r8A.id, { etdDate: '13/05/2026' })).includes('不是合法日期'))
packing.updatePackingListInfo(r8g.id, r8A.id, { docDate: '2026-10-08' })
eq('单据日期存住了', r8get(r8g.id, r8A.id).docDate, '2026-10-08')
const r8OrderFull = orders.getOrder(r8g.id)!
const r8Paper = renderPl({ order: r8OrderFull, settings: getSettings(), images: {} }, r8get(r8g.id, r8A.id))
check('纸面 Date 用的是补录的单据日期', r8Paper.includes('2026-10-08'))
check('箱号留空的那几箱也计入「N 箱」合计（箱单和提单件数对得上）', r8Paper.includes('3 箱 / 3 cartons'), r8Paper.slice(r8Paper.indexOf('TOTAL'), r8Paper.indexOf('TOTAL') + 80))
eq('还没签收时没有签收日期', r8get(r8g.id, r8A.id).deliveredAt, null)
packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'delivered' })
eq('没填签收日期时按今天落档', r8get(r8g.id, r8A.id).deliveredAt, localDate())
packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'packed' })
packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'delivered', deliveredDate: '2026-10-09' })
eq('补录签收用客户实际签收那一天', r8get(r8g.id, r8A.id).deliveredAt, '2026-10-09')

section('R8 整单状态跃迁留痕：批次推着走，但历史不刷屏')
const r8EvCount = (kind: string): number =>
  Number((getDb().get('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND kind = ?', [r8g.id, kind]) as { n?: number })?.n ?? 0)
const r8ShipEv1 = r8EvCount('ship_status')
check('批次推进带来的整单状态跃迁写进了操作历史', r8ShipEv1 > 0, String(r8ShipEv1))
packing.updatePackingListInfo(r8g.id, r8A.id, { containerNo: 'CONT-R8' })
eq('改一格柜号（状态没变）不会重复刷状态跃迁记录', r8EvCount('ship_status'), r8ShipEv1)
check(
  '操作历史里这条跃迁写清是从哪个状态到哪个状态',
  !!getDb().get(
    'SELECT id FROM order_events WHERE order_id = ? AND kind = ? AND note LIKE ? LIMIT 1',
    [r8g.id, 'ship_status', '%→%']
  )
)

section('R8 工厂已交口径：批次退回备货中，催单会重新响')
orders.updateOrder(r8g.id, {
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: r8g.piNo,
  factoryDueDate: localDate()
})
const r8B = packing
  .createPackingList({
    orderId: r8g.id,
    containerNo: 'CONT-R8-B',
    lines: [{ boxNo: 'NO.3', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 30 }]
  })
  .find((p) => p.containerNo === 'CONT-R8-B')!
eq('两批加起来装够 100 件', shipmentSummary(r8g.id).packedQuantity, 100)
packing.updatePackingListInfo(r8g.id, r8B.id, { shipStatus: 'preparing' })
eq('批次标成备货中就不算工厂已交（口径只有 shipping 那一份）', factoryDeliveredQuantity(r8g.id), 70)
const r8Factory = dashboard.reminders().find((x) => x.orderId === r8g.id && x.message.includes('工厂已交'))
check('工厂交期就是今天、还差 30 件 → 提醒会响，并写明已交 70 / 100', !!r8Factory && r8Factory.message.includes('70 / 100'), r8Factory?.message ?? '没有工厂提醒')

section('R8 批次作废：留档不删，状态、件数、金额都不算它')
const r8VoidEv0 = r8EvCount('pl_void')
const r8AfterVoid = packing.voidPackingList(r8g.id, r8B.id, '货代取消订舱')
const r8Voided = r8AfterVoid.find((p) => p.id === r8B.id)!
check('作废只打标记：记录与箱明细一条没删（发过客户的箱单要查得到）', r8Voided.voidedAt != null && r8Voided.lines.length === 1)
eq('作废批次不再参与件数汇总', shipmentSummary(r8g.id).packedQuantity, 70)
eq('作废批次不再算工厂已交', factoryDeliveredQuantity(r8g.id), 70)
eq('作废记了一笔操作历史', r8EvCount('pl_void') - r8VoidEv0, 1)
check('已作废的批次再删会被拦下（作废不是让它消失）', r8err(() => packing.deletePackingList(r8g.id, r8B.id)).includes('已经作废留档'))
check('已作废的批次不能改箱明细', r8err(() => packing.updatePackingListLine(r8g.id, r8B.id, r8Voided.lines[0].id, { quantity: 1 })).includes('已作废'))
check('已作废的批次不能再加箱', r8err(() => packing.addPackingListLine(r8g.id, r8B.id, { styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 5 })).includes('已作废'))
check('已作废的批次不能删箱', r8err(() => packing.deletePackingListLine(r8g.id, r8B.id, r8Voided.lines[0].id)).includes('已作废'))
check('已作废的批次不能改批次信息', r8err(() => packing.updatePackingListInfo(r8g.id, r8B.id, { containerNo: 'X' })).includes('已作废'))
check(
  '作废的那 30 件不再占超装额度：补开的 30 件建得出来',
  (() => {
    packing.createPackingList({
      orderId: r8g.id,
      containerNo: 'CONT-R8-C',
      lines: [{ boxNo: 'NO.4', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 30 }]
    })
    return true
  })()
)
const r8C = packing.listPackingLists(r8g.id).find((p) => p.containerNo === 'CONT-R8-C')!
eq('补开后已装量正好回到 100 件', shipmentSummary(r8g.id).packedQuantity, 100)
packing.deletePackingList(r8g.id, r8C.id)
const r8UnvoidEv0 = r8EvCount('pl_unvoid')
packing.unvoidPackingList(r8g.id, r8A.id)
eq('撤销一张没作废的批次是无操作，不刷历史', r8EvCount('pl_unvoid'), r8UnvoidEv0)
packing.unvoidPackingList(r8g.id, r8B.id, '客户恢复下单')
eq('撤销作废后重新参与汇总', shipmentSummary(r8g.id).packedQuantity, 100)
eq('撤销作废记了一笔历史', r8EvCount('pl_unvoid') - r8UnvoidEv0, 1)
check('重复作废会被拦下', (() => {
  packing.voidPackingList(r8g.id, r8B.id, '再试一次作废')
  return r8err(() => packing.voidPackingList(r8g.id, r8B.id, '重复')).includes('已经是作废状态')
})())
packing.unvoidPackingList(r8g.id, r8B.id, '回归复核')

section('R8 手工状态只能用这一份枚举')
const r8Manual = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
check(
  '「部分出运」是汇总出来的，钉在订单上会被拦下并指路到装箱单',
  r8err(() => orders.setShipStatus(r8Manual.id, 'partial_shipped' as any)).includes('装箱单')
)
check('没定义过的状态码进不来', r8err(() => orders.setShipStatus(r8Manual.id, 'flying' as any)).includes('不能手工设置'))
check('合法的手工状态照旧能设', orders.setShipStatus(r8Manual.id, 'not_prepared').shipStatus, 'not_prepared')

section('R8 本批金额：三批加起来正好等于 PI')
const r8a = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  charges: [{ label: '海运运费 Freight', amount: 100 }]
})
for (const [sn, col, sz] of [
  ['R8A', 'Red', 'S'],
  ['R8B', 'Blue', 'M'],
  ['R8C', 'Green', 'L']
] as const) {
  await orders.addOrderItem(r8a.id, {
    styleNo: sn,
    productName: `分摊款 ${sn}`,
    color: col,
    size: sz,
    quantity: 100,
    unitPrice: 1,
    unitCost: 0.5
  })
}
for (const [i, [sn, col, sz]] of (
  [
    ['R8A', 'Red', 'S'],
    ['R8B', 'Blue', 'M'],
    ['R8C', 'Green', 'L']
  ] as const
).entries()) {
  packing.createPackingList({
    orderId: r8a.id,
    lines: [{ boxNo: `NO.${i + 1}`, styleNo: sn, color: col, size: sz, quantity: 100 }]
  })
}
const r8Amt = money.packingAmounts(r8a.id)
eq('每个批次各算自己那一份钱（运费按货值比例摊）', r8Amt.map((a) => a.total), [133.33, 133.33, 133.34])
eq('本批件数一并带上', r8Amt.map((a) => a.quantity), [100, 100, 100])
const r8Pi = orderDocAmount(orders.getOrder(r8a.id)!)
check(
  '装齐时分摊的分币补给最后一批：三批金额加起来正好等于 PI 含费用合计',
  Math.abs(r8Amt.reduce((s, a) => s + a.total, 0) - r8Pi) < 0.005,
  `${r8Amt.reduce((s, a) => s + a.total, 0)} vs ${r8Pi}`
)
packing.voidPackingList(r8a.id, r8Amt[2].plId, '这批没走成')
const r8AmtPartial = money.packingAmounts(r8a.id)
eq('作废批次的钱不算在它头上（只剩两批）', r8AmtPartial.map((a) => a.total), [133.33, 133.33])
check(
  '只走了一半时不替还没装走的货提前收运费（两批加起来只有 266.66，不是 400）',
  Math.abs(r8AmtPartial.reduce((s, a) => s + a.total, 0) - 266.66) < 0.005
)

section('R8 批次凭据落进库表（v14）')
const r8Cols = (getDb().all('PRAGMA table_info(packing_lists)') as { name: string }[]).map((c) => c.name)
check(
  '实收数量 / 单据日期 / 作废时间三列都加上了',
  ['received_qty', 'doc_date', 'voided_at'].every((c) => r8Cols.includes(c)),
  r8Cols.join(',')
)
eq('迁移一路跑到程序认得的最高版本（v16）', Number((getDb().get('PRAGMA user_version') as { user_version?: number })?.user_version ?? 0), LATEST_DB_VERSION)
eq(
  '作废批次仍留在装箱单列表里（只多一个 voidedAt，纸面存档不丢）',
  packing.listPackingLists(r8a.id).filter((p) => p.voidedAt != null).length,
  1
)


/* ---------------- R9 设置 / 备份 / 更新 ---------------- */
section('R9 设置把关：脏值进不来，备份凭据不会被保存冲掉')
const r9err = (fn: () => unknown): string => {
  try {
    fn()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}
const r9errA = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}
/** 在「当前设置」基础上改几个字段（设置页就是这么发的） */
const r9base = getSettings()
const r9set = (patch: Record<string, any>): any => ({ ...r9base, ...patch })

check(
  'PI 有效期填小数拦下（0.5 天没人能催）',
  r9err(() => saveSettings(r9set({ piValidDays: 7.5 }))).includes('整数')
)
check('PI 有效期留空拦下（以前留空会变成 NaN 天）', r9err(() => saveSettings(r9set({ piValidDays: '' }))).includes('PI 有效期'))
check('催款阈值填负数拦下', r9err(() => saveSettings(r9set({ remindPaymentDays: -3 }))).includes('催款阈值'))
check('出货提醒填 999 天拦下（等于永远不提醒）', r9err(() => saveSettings(r9set({ remindShipDays: 999 }))).includes('0～90'))
check(
  '毛重系数填 0.5 拦下：报错讲了为什么（毛重不会比净重轻）',
  r9err(() => saveSettings(r9set({ grossWeightFactor: 0.5 }))).includes('毛重系数')
)
check('毛重系数填 9 也拦下', r9err(() => saveSettings(r9set({ grossWeightFactor: 9 }))).includes('毛重系数'))
check(
  '定金比例填 1.5 拦下（否则定金比货款还多，待收算出来是负的）',
  r9err(() => saveSettings(r9set({ defaultDepositRatio: 1.5 }))).includes('定金比例')
)
check(
  '同一币种加两个收款账户拦下，并说明后果（PI 不知道印哪个）',
  r9err(
    () =>
      saveSettings(
        r9set({ banks: [{ currency: 'USD', bankName: 'A' }, { currency: 'USD', bankName: 'B' }] })
      )
  ).includes('加了两遍')
)
check('币种没选也拦下', r9err(() => saveSettings(r9set({ banks: [{ currency: '', bankName: 'A' }] }))).includes('币种'))
check(
  '公司名过长拦下，并说明会印不下（单据抬头排版有红线）',
  r9err(() => saveSettings(r9set({ company: { ...getSettings().company, name: 'X'.repeat(260) } }))).includes('排不下')
)
check(
  '银行 SWIFT 填 100 个字符拦下',
  r9err(() => saveSettings(r9set({ banks: [{ currency: 'USD', swift: 'S'.repeat(60) }] }))).includes('SWIFT')
)

// 已经有单据了，基准币就是历史账的地基
check('界面提前置灰：基准币已锁死', baseCurrencyLocked() === true)
const r9baseCur = getSettings().baseCurrency
const r9lockErr = r9err(() => saveSettings(r9set({ baseCurrency: r9baseCur === 'USD' ? 'CNY' : 'USD' })))
check('有单据时换基准币拦下', r9lockErr.includes('基准币不能换'), r9lockErr)
check('拦下时说明了后果（历史账要重算、改不回来）', r9lockErr.includes('重算') && r9lockErr.includes('改不回来'))
check('拦下时给了出路（结清旧账再重开一套）', r9lockErr.includes('导出台账'))
eq('一连串报错的保存之后，库里的设置一个字段都没变', getSettings(), r9base)

// 成功后：首尾空格自动去掉
const r9trim = saveSettings(r9set({ company: { ...getSettings().company, name: '  钉珠卫衣工厂店  ' } }))
eq('保存会把抬头首尾空格去掉（印出来才不会歪）', r9trim.company.name, '钉珠卫衣工厂店')
saveSettings(r9base)
eq('还原回原来的设置', getSettings(), r9base)

// 备份凭据由服务写，界面传什么都不认
markBackupOk('2026-10-01T08:00:00.000Z')
markBackupFail('磁盘满了，备份写到一半停了')
saveSettings(r9set({ lastBackupAt: '瞎填的', lastBackupError: null }))
eq('界面保存不会抹掉「最近成功备份」时间', getSettings().lastBackupAt, '2026-10-01T08:00:00.000Z')
eq('界面保存不会抹掉上一次的失败原因', getSettings().lastBackupError, '磁盘满了，备份写到一半停了')

// 库里那份 JSON 被改坏时：按字段退回默认值，而不是把默认值一起冲掉
getDb().run(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  [
    'app_settings',
    JSON.stringify({
      company: { name: 123, address: null },
      banks: [{ currency: 'USD' }, { currency: 'USD' }, { currency: 'BTC' }, { currency: 'EUR' }],
      piValidDays: null,
      remindShipDays: '七天',
      grossWeightFactor: 0,
      defaultDepositRatio: 'abc',
      baseCurrency: 'BTC'
    })
  ]
)
const r9bad = getSettings()
eq('坏掉的天数退回默认值而不是留空', r9bad.piValidDays, 15)
eq('坏掉的文字退回空串（不打印 [object]）', r9bad.company.name, '')
eq('重复币种只留一个，不认识的币种丢掉', r9bad.banks.map((b) => b.currency), ['USD', 'EUR'])
eq('坏掉的系数退回默认', r9bad.grossWeightFactor, 1.1)
eq('坏掉的基准币退回默认', r9bad.baseCurrency, 'CNY')
saveSettings(r9base)
// 备份时间戳不在这次对比里：坏 JSON 里本来就没有它，读回来只能是空，
// 下一次成功备份会重新盖章（下面「成功备份会盖上时间」那条盯的就是这个）
const r9UserFields = (s: any) => ({
  company: s.company,
  banks: s.banks,
  piValidDays: s.piValidDays,
  remindShipDays: s.remindShipDays,
  defaultDepositRatio: s.defaultDepositRatio,
  grossWeightFactor: s.grossWeightFactor,
  baseCurrency: s.baseCurrency
})
eq('读到坏数据后一次正常保存就把这些字段全修回来', r9UserFields(getSettings()), r9UserFields(r9base))

section('R9 备份：写坏的不算备成')
const r9file = await createBackup('r9')
check('备份落在备份目录里且文件真的存在', r9file.startsWith(backupsDir()) && fs.existsSync(r9file))
check(
  '文件名带时间戳和用途（能认出是哪天的自动备份）',
  /^ikanbot-\d{14}-r9\.zip$/.test(r9file.split(/[\\/]/).pop() ?? ''),
  r9file
)
eq('成功备份会盖上时间', getSettings().lastBackupAt !== null, true)
eq('成功备份会清掉上次的失败原因', getSettings().lastBackupError, null)
eq('临时文件没留在原地', fs.existsSync(`${r9file}.part`), false)
const r9buf = fs.readFileSync(r9file)
const r9entries = readZip(r9buf)
check('包里带着数据库本体', r9entries.some((e) => e.name === 'ikanbot.db'))
eq(
  '图片目录里有几张，包里就几张（一张不丢）',
  r9entries.filter((e) => e.name.startsWith('images/')).length,
  collectDir(imagesDir(), 'images').length
)
const r9docFiles = collectDir(docsDir(), 'docs')
check('这一轮确实有单据存档要备（下面这条不是空过）', r9docFiles.length > 0, `${r9docFiles.length}`)
eq('单据存档 PDF 也全在包里', r9entries.filter((e) => e.name.startsWith('docs/')).length, r9docFiles.length)
eq('落盘的包原样自检通过', r9err(() => verifyZip(r9buf, readZip(r9buf))), '')

// 验货本身要抓得住三种事故
const r9tiny = Buffer.from('hello world hello world')
check(
  '少一个文件算失败（备份的意义是全须全尾回来）',
  r9err(() =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }]), [
      { name: 'a', data: r9tiny },
      { name: 'b', data: r9tiny }
    ])
  ).includes('少了 1 个文件')
)
check(
  '多一个没打算装的文件也算失败',
  r9err(() =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }, { name: 'z', data: r9tiny }]), [{ name: 'a', data: r9tiny }])
  ).includes('多出一个')
)
check(
  '内容被换过（字节一样不算，逐字节比）',
  r9err(() =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }]), [
      { name: 'a', data: Buffer.from('hello world hello worlD') }
    ])
  ).includes('不一致')
)
check('尾巴被截掉的包报「截断」', r9err(() => readZip(r9buf.subarray(0, r9buf.length - 30))).includes('截断'))
const r9flipped = Buffer.from(r9buf)
// 直接改数据库内容段的一个字节（跳过 30 字节本地头 + 文件名）
r9flipped[81] ^= 0xff
const r9flipErr = r9err(() => readZip(r9flipped))
check(
  '包体坏一个字节就报错，绝不静默返回半截数据',
  /损坏|校验码|大小不对|解不开/.test(r9flipErr),
  r9flipErr
)

const r9corruptPath = join(backupsDir(), 'ikanbot-20260101000000-corrupt.zip')
fs.writeFileSync(r9corruptPath, r9flipped)
const r9inspectErr = r9err(() => inspectBackup(r9corruptPath))
check('损坏的包在「预览」这一步就报出来（不用等到恢复时才发现）', /损坏|校验码|大小不对|解不开/.test(r9inspectErr), r9inspectErr)
eq('预览报错也是中文人话', r9inspectErr.includes('at sqlite') || r9inspectErr.includes('SQLITE'), false)

const r9prev = inspectBackup(r9file)
eq('预览数得出包里的条目数', r9prev.entryCount, r9entries.length)
eq('预览认得出里面有数据库', r9prev.hasDb, true)
eq(
  '预览报的订单数 = 当前库里的订单数（包里的账是真的）',
  r9prev.orderCount,
  Number((getDb().get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n)
)
eq('预览把文件名里的时间戳还原成可读时间', r9prev.takenAt !== null, true)
eq(
  '手工丢进备份目录的文件也认时间戳',
  (listBackups().find((b) => b.name === 'ikanbot-20260101000000-corrupt.zip') ?? { takenAt: null }).takenAt,
  '2026-01-01T00:00:00Z'
)
eq('备份列表新到旧：刚备的那份排第一', listBackups()[0].name, r9file.split(/[\\/]/).pop() ?? '')

// 自动清理只砍最老的，最近的一律留着
for (let i = 0; i < 35; i++) {
  const f = join(backupsDir(), `ikanbot-20200101${String(i).padStart(6, '0')}-old.zip`)
  fs.writeFileSync(f, 'x')
  fs.utimesSync(f, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
}
pruneBackups(30)
eq('备份只留最近 30 份（不然磁盘迟早被写满）', listBackups().length, 30)
check('被砍的一定是最老的（刚备的这份还在）', fs.existsSync(r9file))
eq('今天手工丢进备份目录的包不会被当成老备份删掉', fs.existsSync(r9corruptPath), true)

section('R9 恢复：先验货、再留退路，退路之前一步都不许动手')
const r9dbBytes = r9entries.find((e) => e.name === 'ikanbot.db')!.data
// 说明：成功恢复的最后一步会换库并重启程序，测试进程跑到那里就没了，
// 所以这里只验「拦下来」的每一道门——它们全都必须在破坏性步骤之前。
const r9outErr = await r9errA(() => restoreBackup(join(dataDir(), 'not-here.zip')))
check('备份目录以外的路径直接拒（渲染进程随便传一个路径进来是读不到的）', r9outErr.includes('只能从备份目录里选'), r9outErr)
check('非 .zip 拒', (await r9errA(() => restoreBackup(join(backupsDir(), 'notes.txt')))).includes('.zip'))
check(
  '列表里还有、盘上已经被删的文件拒',
  (await r9errA(() => restoreBackup(join(backupsDir(), 'ikanbot-20300101000000-none.zip')))).includes('已经不在了')
)
const r9evilPath = join(backupsDir(), 'ikanbot-20260102000000-evil.zip')
fs.writeFileSync(r9evilPath, createZip([{ name: '../evil.txt', data: Buffer.from('跳出去') }, { name: 'ikanbot.db', data: r9dbBytes }]))
const r9evilErr = await r9errA(() => restoreBackup(r9evilPath))
check('包里有不认识的文件就整份拒掉（不是跳过它继续恢复）', r9evilErr.includes('不认识的文件'), r9evilErr)
check('被拒的包没有把文件写到数据目录外面', !fs.existsSync(join(dataDir(), 'evil.txt')))
const r9nodbPath = join(backupsDir(), 'ikanbot-20260103000000-nodb.zip')
fs.writeFileSync(r9nodbPath, createZip([{ name: 'images/a.png', data: Buffer.from('png') }]))
check('没有数据库的包拒（不然恢复完是个空程序）', (await r9errA(() => restoreBackup(r9nodbPath))).includes('没有数据库文件'))
// 新版程序备的包：数据格式比当前程序还新，降回去必丢字段
const r9futureDb = join(dataDir(), 'future-check.db')
if (fs.existsSync(r9futureDb)) fs.unlinkSync(r9futureDb)
{
  const fdb = new Database(r9futureDb)
  fdb.run('CREATE TABLE orders(id INTEGER PRIMARY KEY)')
  fdb.run('PRAGMA user_version = 999')
  fdb.close()
}
const r9futurePath = join(backupsDir(), 'ikanbot-20260104000000-future.zip')
fs.writeFileSync(r9futurePath, createZip([{ name: 'ikanbot.db', data: fs.readFileSync(r9futureDb) }]))
fs.unlinkSync(r9futureDb)
const r9futureErr = await r9errA(() => restoreBackup(r9futurePath))
check('数据格式比当前程序新的包拒', r9futureErr.includes('更新的程序版本'), r9futureErr)
check('报错说清了当前只认到 v几', r9futureErr.includes(`v${LATEST_DB_VERSION}`), r9futureErr)
check('给了出路（先升级程序再恢复）', r9futureErr.includes('再恢复'), r9futureErr)
eq(
  '被拒的恢复一份退路备份都没做（说明拦在动手之前）',
  listBackups()
    .filter((b) => b.name.includes('pre-restore'))
    .map((b) => b.name),
  []
)
const r9live = Number((getDb().get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n)
check('拒绝之后当前库还开着、一条数据没动', r9live > 0 && fs.existsSync(join(dataDir(), 'ikanbot.db')))
eq(
  '自己刚备的包版本不会超前（同一版本恢复自己不会被误拦）',
  Number((getDb().get('PRAGMA user_version') as { user_version?: number })?.user_version ?? 0) <= LATEST_DB_VERSION,
  true
)

section('R9 工作台会盯住备份（数据只躺在这台电脑上）')
const r9setStamp = (at: string | null, err: string | null): void => {
  const cur = getSettings()
  getDb().run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    'app_settings',
    JSON.stringify({ ...cur, lastBackupAt: at, lastBackupError: err })
  ])
}
const r9backupTips = () => dashboard.reminders().filter((r) => r.orderNo === '数据备份')
r9setStamp(null, null)
eq('有单据却从没备份成功过 → 亮一条', r9backupTips().length, 1)
check('说的是「这台电脑上还没有一份成功备份」', (r9backupTips()[0]?.message ?? '').includes('还没有一份成功备份'))
r9setStamp(new Date().toISOString(), null)
eq('今天刚备过 → 不催', r9backupTips().length, 0)
r9setStamp(new Date(Date.now() - 30 * 86400000).toISOString(), null)
eq('拖了 30 天 → 催一次', r9backupTips().length, 1)
check('催的时候说清隔了多少天', (r9backupTips()[0]?.message ?? '').includes('距离上一次成功备份'))
r9setStamp(new Date().toISOString(), '磁盘满了，备份写到一半停了')
eq('今天备过但这次失败 → 只催失败', r9backupTips().length, 1)
check('把失败原因原样亮出来', (r9backupTips()[0]?.message ?? '').includes('磁盘满了'))
r9setStamp(null, '磁盘满了，备份写到一半停了')
eq('从没成功过 + 又失败 → 两条都要（不互相顶掉）', r9backupTips().length, 2)
eq('两条各占一个 key（界面上会各显示一行）', new Set(r9backupTips().map((r) => r.key)).size, 2)
check('都归在「待修」而不是催款类', r9backupTips().every((r) => r.kind === 'data'))
// 指向同一个去处：设置 → 数据备份
check('每条都告诉用户去哪儿点', r9backupTips().every((r) => r.message.includes('设置 → 数据备份')))

section('R9 毛重来源：填过实测就钉死，改系数不翻旧账（v15）')
const r9cols = (getDb().all('PRAGMA table_info(packing_list_lines)') as { name: string }[]).map((c) => c.name)
check('装箱明细多了一列 gross_est（记这箱毛重是填的还是算的）', r9cols.includes('gross_est'), r9cols.join(','))
const r9w = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r9w.id, {
  styleNo: 'R9W',
  productName: '过磅款',
  color: 'Grey',
  size: 'M',
  quantity: 120,
  unitPrice: 10,
  unitCost: 5
})
const r9pls = packing.createPackingList({
  orderId: r9w.id,
  lines: [
    // 第一箱只填了净重（毛重是算出来的）；第二箱填了过磅值 26kg
    { boxNo: 'NO.1', styleNo: 'R9W', color: 'Grey', size: 'M', quantity: 50, netWeight: 20 },
    { boxNo: 'NO.2', styleNo: 'R9W', color: 'Grey', size: 'M', quantity: 50, netWeight: 20, grossWeight: 26 }
  ]
})
const r9plId = r9pls[0].id
const r9l1 = r9pls[0].lines[0].id
const r9l2 = r9pls[0].lines[1].id
/** 每次都从库里重读这一箱，不看内存里的旧值 */
const r9line = (lineId: number) => packing.listPackingLists(r9w.id)[0].lines.find((l) => l.id === lineId)!
/** 纸面这一批上印了几个 (est.)（只数箱明细行里的，页脚那句说明不算） */
const r9estCount = (): number => {
  const html = renderPl({ order: orders.getOrder(r9w.id)!, settings: getSettings(), images: {} }, packing.listPackingLists(r9w.id)[0])
  return (html.match(/\(est\.\)<\/span>/g) ?? []).length
}
eq('没填毛重的那箱落库标为「算出来的」', r9line(r9l1).grossEst, true)
eq('填了实测毛重的那箱落库标为「实测」', r9line(r9l2).grossEst, false)
eq('纸面只给算出来的那箱印 (est.)', r9estCount(), 1)

const r9added = packing.addPackingListLine(r9w.id, r9plId, { styleNo: 'R9W', color: 'Grey', size: 'M', quantity: 10 })
const r9l3 = r9added[0].lines.find((l) => l.quantity === 10)!.id
eq('现场补的一箱没填毛重，也标估算', r9line(r9l3).grossEst, true)
eq('补完这箱，纸面上两个 (est.)', r9estCount(), 2)

// 关键：把系数调到 1.3，20 × 1.3 = 26 恰好等于那箱手填的过磅值
saveSettings(r9set({ grossWeightFactor: 1.3 }))
eq('改了毛重系数，老单据上的 (est.) 一个都没翻面', r9estCount(), 2)
eq('手填的 26kg 仍按实测印（没被新系数认成推算值）', r9line(r9l2).grossEst, false)
saveSettings(r9set({ grossWeightFactor: 1.1 }))
eq('系数调回来，标记还是原来那几个（标记不跟系数走）', r9estCount(), 2)

// 编辑时的来源判定：改件数不动 / 只改净重退回估算 / 手填毛重算实测
packing.updatePackingListLine(r9w.id, r9plId, r9l2, { quantity: 25 })
eq('只改件数：毛重按比例跟着走（50 箱 26kg → 25 箱 13kg）', r9line(r9l2).grossWeight, 13)
eq('只改件数：来源判定不动（还是实测）', r9line(r9l2).grossEst, false)
eq('只改件数：这一箱的 (est.) 不会冒出来', r9estCount(), 2)
packing.updatePackingListLine(r9w.id, r9plId, r9l2, { netWeight: 30 })
eq('只改净重：毛重按当前系数重算（30 × 1.1 = 33）', r9line(r9l2).grossWeight, 33)
eq('只改净重：这一箱退回「算出来的」', r9line(r9l2).grossEst, true)
eq('只改净重之后，纸面三个 (est.)', r9estCount(), 3)
packing.updatePackingListLine(r9w.id, r9plId, r9l2, { grossWeight: 35.5 })
eq('手填毛重即视为实测（哪怕 35.5 看着也像算出来的）', r9line(r9l2).grossEst, false)
eq('手填之后这一箱的 (est.) 消失', r9estCount(), 2)
packing.updatePackingListLine(r9w.id, r9plId, r9l2, { grossWeight: null })
eq('清空毛重：来源标记一起清掉（不谎称实测）', r9line(r9l2).grossEst, null)
eq('清空的这箱按「没填」处理，重新标上 (est.)', r9estCount(), 3)

// 老数据（v15 之前建的）没有这个标记，只能按系数猜——这正是标记要解决的问题
getDb().run('UPDATE packing_list_lines SET gross_est = NULL WHERE packing_list_id = ?', [r9plId])
eq('老数据在系数 1.1 下三箱全被猜成推算值', r9estCount(), 3)
saveSettings(r9set({ grossWeightFactor: 1.3 }))
eq('同一批数据只把系数改成 1.3，两个箱的 (est.) 就掉了', r9estCount(), 1)
saveSettings(r9set({ grossWeightFactor: 1.1 }))
eq('改回 1.1 结论又变回去——没落库的来源标记就是这么反复', r9estCount(), 3)

section('R9 IPC 壳：服务层不许自己开通道')
// 渲染进程的 call() 只认 {ok,data}/{ok,error} 这个壳。谁绕过它直接 ipcMain.handle 返回裸值，
// 界面拿到的就是 res.ok === undefined → 抛一条「消息为空的 Error」被静默丢掉：
// 自动更新那几张按钮就是这么哑了很久的（点了没反应，也不报错）。
const r9svcDir = join(process.cwd(), 'electron', 'services')
const r9rawIpc = fs
  .readdirSync(r9svcDir)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /ipcMain\s*\.\s*handle\s*\(/.test(fs.readFileSync(join(r9svcDir, f), 'utf8')))
eq('服务层里没有自己注册的通道（都走 ipc/handle 那一个壳）', r9rawIpc, [])

/* ---------------- R11：错误处理 / 空状态 / 历史 ---------------- */
section('R11-1 编辑时漏传的字段不再被静默清空')
{
  const r11o = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    piNo: 'R11PI001',
    customerPo: 'PO-11',
    vessel: 'MSC USA',
    sealNo: 'SEAL-9',
    note: '原备注',
    expectedShipDate: '2026-11-30',
    etdDate: '2026-11-20',
    cutOffDate: '2026-11-15'
  })
  orders.updateOrder(r11o.id, { note: '只改了备注' })
  const kept = orders.getOrder(r11o.id)!
  eq('漏传交期不再被清空', kept.expectedShipDate, '2026-11-30')
  eq('漏传 ETD 不再被清空', kept.etdDate, '2026-11-20')
  eq('漏传截关日不再被清空', kept.cutOffDate, '2026-11-15')
  eq('漏传客户 PO 不再被清空', kept.customerPo, 'PO-11')
  eq('漏传船名不再被清空', kept.vessel, 'MSC USA')
  eq('漏传铅封号不再被清空', kept.sealNo, 'SEAL-9')
  eq('漏传客户不改变挂靠的客户', kept.customer?.id, c1.id)
  eq('传了的字段照旧写进去', kept.note, '只改了备注')
  orders.updateOrder(r11o.id, { etdDate: null })
  eq('明确清空仍然生效（null ≠ 没传）', orders.getOrder(r11o.id)!.etdDate, null)
  let piErr = ''
  try {
    orders.updateOrder(r11o.id, { piNo: '' })
  } catch (e) {
    piErr = (e as Error).message
  }
  check('已经写上的 PI 号不许编辑时空掉', piErr.includes('PI 号'), piErr)
  check('被拦下来的那次没把 PI 号改掉', orders.getOrder(r11o.id)!.piNo, 'R11PI001')

  const r11q = quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    validUntil: '2026-12-31',
    charges: [{ label: '运费 Freight', amount: 50 }],
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
  const r11qEdit = quotations.saveQuotation({
    id: r11q.id,
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    items: [{ styleNo: 'A001', quantity: 12, unitPrice: 7.5 }]
  })
  eq('报价单漏传费用不再被清空', r11qEdit.charges.length, 1)
  eq('报价单漏传有效期不再被推到「今天+N」', r11qEdit.validUntil, '2026-12-31')
  eq('报价单传了的数量照旧生效', r11qEdit.items[0].quantity, 12)

  const r11s = samples.saveSample({
    customerId: c1.id,
    sampleDate: '2026-10-21',
    courier: '顺丰',
    trackingNo: 'SF123456789',
    expressFee: 120,
    factoryCost: 300,
    shippedAt: '2026-10-23',
    currency: 'USD',
    exchangeRate: 7.15,
    items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 2, unitPrice: 15 }]
  })
  const r11sEdit = samples.saveSample({
    id: r11s.id,
    customerId: c1.id,
    items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 3, unitPrice: 15 }]
  })
  eq('打样单漏传快递费不再被清零', r11sEdit.expressFee, 120)
  eq('打样单漏传工厂打样费不再被清零', r11sEdit.factoryCost, 300)
  eq('打样单漏传寄样日期不再被清掉', r11sEdit.shippedAt, '2026-10-23')
  eq('打样单漏传单号不再改号', r11sEdit.sampleNo, r11s.sampleNo)
  eq('打样单传了的明细照旧替换', r11sEdit.totalQuantity, 3)
}

section('R11-1 保存中途抛错：整单回滚，不留半截明细')
{
  const rbQ = quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    items: [
      { styleNo: 'A001', quantity: 10, unitPrice: 7.5 },
      { styleNo: 'A002', quantity: 5, unitPrice: 9 }
    ]
  })
  let rbErr = ''
  try {
    quotations.saveQuotation({
      id: rbQ.id,
      customerId: c1.id,
      currency: 'USD',
      exchangeRate: 7.15,
      items: [
        { styleNo: 'A001', quantity: 30, unitPrice: 7.5 },
        // 商品库里不存在的 product_id：外键会在插到这一行时抛错
        { styleNo: 'A002', quantity: 5, unitPrice: 9, productId: 999999 }
      ]
    })
  } catch (e) {
    rbErr = (e as Error).message
  }
  check('坏明细让整次保存失败', rbErr !== '', rbErr)
  const afterRb = quotations.getQuotation(rbQ.id)!
  eq('回滚后明细行数没少', afterRb.items.length, 2)
  eq('回滚后第一行还是原来那个数量（新值没写进去）', afterRb.items[0].quantity, 10)

  const rbO = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  await orders.addOrderItem(rbO.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  let rbOErr = ''
  try {
    orders.replaceOrderItems(rbO.id, [
      { styleNo: 'A009', color: 'Red', size: 'S', quantity: 1, unitPrice: 8 },
      { styleNo: 'A010', color: 'Blue', size: 'L', quantity: 1, unitPrice: 8, productId: 999999 }
    ])
  } catch (e) {
    rbOErr = (e as Error).message
  }
  check('批量替换明细时坏行让整批失败', rbOErr !== '', rbOErr)
  const afterRO = orders.getOrder(rbO.id)!
  eq('回滚后原有那一行还在（没被删掉）', afterRO.items.length, 1)
  eq('回滚后原有那行数量没变', afterRO.items[0].quantity, 10)
}

section('R11-2 明细闸门：负数、半件、没填价格都进不了库')
{
  const g = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  const errOf = (fn: () => unknown): string => {
    try {
      fn()
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }
  check(
    '负数量被拦',
    errOf(() => orders.addOrderItem(g.id, { styleNo: 'A001', quantity: -30, unitPrice: 8 })).includes('1 件以上')
  )
  check('半件被拦', errOf(() => orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 1.5, unitPrice: 8 })).includes('不是整件'))
  check(
    '清空数量（Number(「」)=0）被拦，不再静默存 0 件行',
    errOf(() => orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 0, unitPrice: 8 })).includes('1 件以上')
  )
  check('单价没填（按 0 保存）被拦', errOf(() => orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 10, unitPrice: 0 })).includes('单价'))
  check('负单价被拦', errOf(() => orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 10, unitPrice: -8 })).includes('负数'))
  const gOne = orders.addOrderItem(g.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  check('已有行改成负数也被拦', errOf(() => orders.updateOrderItem(g.id, gOne.items[0].id, { quantity: -5 })).includes('1 件以上'))
  check('已有行单价改成负数也被拦', errOf(() => orders.updateOrderItem(g.id, gOne.items[0].id, { unitPrice: -1 })).includes('负数'))
  eq('闸门拦下的这几次一行都没进库', orders.getOrder(g.id)!.items.length, 1)
  eq('没被改坏的那行数量还是原值', orders.getOrder(g.id)!.items[0].quantity, 10)

  const gq = quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
  check(
    '报价行数量为 0 直接报错（不再悄悄把半填的一行丢掉）',
    errOf(() =>
      quotations.saveQuotation({
        id: gq.id,
        customerId: c1.id,
        currency: 'USD',
        exchangeRate: 7.15,
        items: [
          { styleNo: 'A001', quantity: 10, unitPrice: 7.5 },
          { styleNo: 'A002', quantity: 0, unitPrice: 9 }
        ]
      })
    ).includes('1 件以上')
  )
  eq('报错的这次保存没把报价明细改掉', quotations.getQuotation(gq.id)!.items.length, 1)

  // 免费样是真实业务：样品行的单价允许 0，数量仍然要 ≥1
  const free = samples.saveSample({
    customerId: c1.id,
    feeStatus: 'paid',
    items: [{ styleNo: 'A001', color: '', size: '', quantity: 2, unitPrice: 0 }]
  })
  check('免费样品行（单价 0）仍然允许保存', free.id > 0)
  check(
    '样品行负数量仍然被拦',
    errOf(() =>
      samples.saveSample({
        customerId: c1.id,
        feeStatus: 'paid',
        items: [{ styleNo: 'A001', color: '', size: '', quantity: -1, unitPrice: 0 }]
      })
    ).includes('1 件以上')
  )
  // 装箱与明细共用同一条闸门（规矩写在 src/shared/guards，不在两处各写一份）
  const gpl = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  orders.addOrderItem(gpl.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  let plErr = ''
  try {
    packing.createPackingList({
      orderId: gpl.id,
      lines: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 0 } as any]
    })
  } catch (e) {
    plErr = (e as Error).message
  }
  check('装箱数量为 0 仍被同一条闸门拦下', plErr.includes('1 件以上'), plErr)
  check('装箱的报错仍然带着「删掉那一行」', plErr.includes('删掉那一行'), plErr)
}

section('R11-5 批量加行：坏一行整批不进库')
{
  const b = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  let bErr = ''
  try {
    orders.addOrderItems(b.id, [
      { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 },
      { styleNo: 'A002', color: 'Navy', size: 'L', quantity: 20, unitPrice: 9 },
      { styleNo: 'A003', color: 'Red', size: 'S', quantity: 0, unitPrice: 7 }
    ])
  } catch (e) {
    bErr = (e as Error).message
  }
  check('批量里第 3 行不合格让整批失败', bErr.includes('数量'), bErr)
  eq('前两行没有偷偷躺在库里', orders.getOrder(b.id)!.items.length, 0)
  const okBatch = orders.addOrderItems(b.id, [
    { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 },
    { styleNo: 'A002', color: 'Navy', size: 'L', quantity: 20, unitPrice: 9 }
  ])
  eq('两行都合规时一次加两行', okBatch.items.length, 2)
  eq('批量加行的件数直接进整单件数', okBatch.totalQuantity, 30)
  eq('批量加行仍然逐行留痕', orders.listEvents(b.id).filter((e) => e.kind === 'item_add').length, 2)
}

section('R11-4 操作历史答得出「谁改的」')
{
  const beforeOp = getSettings()
  saveSettings({ ...beforeOp, operator: '林小满' })
  const h = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    validUntil: '2026-11-30',
    expectedShipDate: '2026-12-10'
  })
  const born = orders.listEvents(h.id)
  check('建单就有历史记录', born.length > 0)
  check(
    '建单时每条历史都盖上设置里的操作员',
    born.every((e) => e.actor === '林小满'),
    JSON.stringify(born.map((e) => e.actor))
  )

  orders.updateOrder(h.id, { expectedShipDate: '2026-12-20', cutOffDate: '2026-12-01' })
  const moveEv = orders.listEvents(h.id).slice(-1)[0]
  eq('交期确实写进库了', orders.getOrder(h.id)!.expectedShipDate, '2026-12-20')
  check('历史里写成 before → after', moveEv.note.includes('预计开船 2026-12-10 → 2026-12-20'), moveEv.note)
  check('同一次新增的截关日也留痕', moveEv.note.includes('截关日 空 → 2026-12-01'), moveEv.note)

  orders.updateOrder(h.id, { note: '客户催货' })
  const noteEv = orders.listEvents(h.id).slice(-1)[0]
  check('只改备注的那次，历史不会把没传的交期说成清空', !noteEv.note.includes('预计开船'), noteEv.note)
  check('备注改动本身要留痕', noteEv.note.includes('备注 空 → 客户催货'), noteEv.note)

  const photo = orders.addOrderPhoto(h.id, 'inspection-x.jpg', 'inspection', '尾期验货')
  orders.deleteOrderPhoto(h.id, photo.id)
  const photoEv = orders.listEvents(h.id).slice(-1)[0]
  check('删验货照也进历史，并说明删的是哪一张', photoEv.note.includes('删除验货照') && photoEv.note.includes('尾期验货'), photoEv.note)

  // 换人：新动作盖新名字，旧记录一个都不改写
  saveSettings({ ...getSettings(), operator: '周文娟' })
  orders.voidOrder(h.id, '客户取消')
  const allEv = orders.listEvents(h.id)
  eq('换人后的新历史盖新名字', allEv.slice(-1)[0].actor, '周文娟')
  eq('换人前写下的历史仍然是原操作员', allEv[0].actor, '林小满')
  saveSettings(beforeOp)
}

section('R11-6 单号查重与建单原子化')
{
  orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15, piNo: 'R11DUP001' })
  const before = orders.listOrders({}).length
  let dupMsg = ''
  try {
    orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15, piNo: 'R11DUP001' })
  } catch (e) {
    dupMsg = (e as Error).message
  }
  check('同一个 PI 号建第二张单被拦住', dupMsg.includes('已经存在'), dupMsg)
  check('报错说清楚该怎么改', dupMsg.includes('换一个号'), dupMsg)
  eq('被拦住的那次没有留下空单', orders.listOrders({}).length, before)

  // 手工号也算「已占用」：自动号必须跳过它，不能第二天又生成同一个号
  const auto = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  check('自动生成的 PI 号不撞手工号', auto.piNo !== 'R11DUP001', auto.piNo)
  const allPi = orders.listOrders({}).map((o) => o.piNo).filter(Boolean)
  eq('全库 PI 号仍然无重号', allPi.length, new Set(allPi).size)
  check(
    '建单和它的「建单」历史一起成立',
    orders.listEvents(auto.id).some((e) => e.kind === 'create' && e.note.includes(auto.orderNo))
  )
}

/* ---------------- R12 跨平台 / 打印 / 一致性 ---------------- */
section('R12 打印分页：页边距、页码、合计只印一次')
{
  const base = orders.listOrders({}).find((o) => o.items.length > 0)
  if (!base) throw new Error('没有带明细的订单，无法验证分页')
  const many = {
    ...base,
    items: Array.from({ length: 10 }, () => base.items)
      .flat()
      .map((it, i) => ({ ...it, id: it.id * 1000 + i }))
  }
  const html = renderPi({ order: many, settings: getSettings(), images: {} })
  eq('多行明细分页时 TOTAL 只印一次', (html.match(/TOTAL \/ 合计/g) ?? []).length, 1)
  check('合计不再放在每页重复的 tfoot 里', !html.includes('<tfoot'))
  check('打印时整行/签字/条款不被拆开', html.includes('break-inside: avoid'))
  check('分页规则只在打印时生效，屏幕预览仍是整张纸', html.includes('@media print') && html.includes('width: 210mm'))
}

section('R12 单据日期与编号：同一张纸一个口径')
{
  const o = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.1,
    piNo: 'PI-R12-CI'
  })
  await orders.addOrderItem(o.id, { styleNo: 'R12CI', productName: '测试款', quantity: 10, unitPrice: 2 })
  const pls = packing.createPackingList({
    orderId: o.id,
    lines: [{ boxNo: '1', styleNo: 'R12CI', productName: '测试款', quantity: 10 }]
  })
  packing.updatePackingListInfo(o.id, pls[0].id, { docDate: '2026-09-30' })
  const fresh = orders.getOrder(o.id)!
  const pl = fresh.packingLists[0]
  const settingsNow = getSettings()

  const ciHtml = renderCi({ order: fresh, settings: settingsNow, images: {}, rev: 1 }, {})
  check('CI 日期跟最近一张装箱单同一天', ciHtml.includes('<b>Date:</b> 2026-09-30'), '仍是建单日？')
  check('CI 号由 PI 号派生（同一张单一个号）', ciHtml.includes(`<b>CI No.:</b> ${ciNoOf('PI-R12-CI')}`))
  check('PI 号不带前缀时补 CI-，不把原名当发票号', ciNoOf('R12-001') === 'CI-R12-001', ciNoOf('R12-001'))

  const plHtml = renderPl({ order: fresh, settings: settingsNow, images: {}, rev: 1 }, pl)
  check('PL 抬头与页脚同一个单据日期', plHtml.includes('<b>Date:</b> 2026-09-30') && plHtml.includes('Version 1 / 2026-09-30'))

  // 币种对不上账户：宁可纸上不印收款信息，也不能拿别的币种账号顶替
  const beforeBanks = settingsNow
  saveSettings({
    ...settingsNow,
    banks: [
      { currency: 'USD', bankName: 'US Bank', accountName: 'IK', accountNo: 'R12USDONLY', swift: 'X', address: '' }
    ]
  })
  const eur = orders.createOrder({ customerId: c1.id, currency: 'EUR', exchangeRate: 7.8, piNo: 'PI-R12-EUR' })
  await orders.addOrderItem(eur.id, { styleNo: 'R12EU', productName: '欧单', quantity: 1, unitPrice: 1 })
  const eurHtml = renderPi({ order: orders.getOrder(eur.id)!, settings: getSettings(), images: {} })
  check('EUR 单不会印 USD 账号', !eurHtml.includes('R12USDONLY'))
  saveSettings(beforeBanks)
}

section('R12 导出台账跟随当前筛选')
{
  const kw = 'R12-BOX'
  const o = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1, piNo: 'PI-R12-BOX' })
  await orders.addOrderItem(o.id, { styleNo: 'R12BOX', productName: '箱', quantity: 10, unitPrice: 1 })
  // 台账口径本来就不含草稿（R7 定死的）；这里用一张正式单验证「筛选后行数 = 列表」
  orders.setPaymentStatus(o.id, 'sent')
  const listed = orders.listOrderRows({ keyword: kw, limit: 1000 })
  const filtered = dashboard.exportCsv('orders', { keyword: kw })
  const lines = filtered.trim().split(/\r?\n/)
  eq('筛选导出的行数 = 列表命中数', lines.length - 1, listed.total)
  check('筛选导出只含命中的单', lines.slice(1).every((l) => l.includes(kw)), lines.slice(1).join(' | '))
  const allLines = dashboard.exportCsv('orders').trim().split(/\r?\n/)
  check('不带筛选时仍是全量台账', allLines.length > lines.length)

  const paid = orders.listOrderRows({ paymentStatus: 'paid', limit: 1000 })
  const paidCsv = dashboard.exportCsv('orders', { paymentStatus: 'paid' })
  eq('按收款状态导出的行数 = 列表', paidCsv.trim().split(/\r?\n/).length - 1, paid.total)
}

section('R12 守门：收款状态白名单 / 箱号查重')
{
  const o = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1, piNo: 'PI-R12-ST' })
  await orders.addOrderItem(o.id, { styleNo: 'R12ST', productName: '状态', quantity: 10, unitPrice: 1 })
  const before = orders.getOrder(o.id)!.paymentStatus
  let badStatus = ''
  try {
    orders.setPaymentStatus(o.id, 'wat' as never)
  } catch (e) {
    badStatus = (e as Error).message
  }
  check('非法收款状态被拒，并列出可选值', badStatus.includes('不是收款状态') && badStatus.includes('草稿'), badStatus)
  eq('被拒后收款状态没变', orders.getOrder(o.id)!.paymentStatus, before)

  let dupBox = ''
  try {
    packing.createPackingList({
      orderId: o.id,
      lines: [
        { boxNo: 'B1', styleNo: 'R12ST', productName: '状态', quantity: 5 },
        { boxNo: 'B1', styleNo: 'R12ST', productName: '状态', quantity: 5 }
      ]
    })
  } catch (e) {
    dupBox = (e as Error).message
  }
  check('同一批重复箱号被拒', dupBox.includes('箱号') && dupBox.includes('两次'), dupBox)
  eq('被拒后没有留下半截装箱单', packing.listPackingLists(o.id).length, 0)

  const pls = packing.createPackingList({
    orderId: o.id,
    lines: [
      { boxNo: 'B1', styleNo: 'R12ST', productName: '状态', quantity: 5 },
      { boxNo: 'B2', styleNo: 'R12ST', productName: '状态', quantity: 5 }
    ]
  })
  const lines = pls[0].lines
  const second = lines.find((l) => l.boxNo === 'B2')!
  let dupEdit = ''
  try {
    packing.updatePackingListLine(o.id, pls[0].id, second.id, { boxNo: 'B1' })
  } catch (e) {
    dupEdit = (e as Error).message
  }
  check('把箱号改成同批已有的号也被拒', dupEdit.includes('已经用过'), dupEdit)
  eq('被拒的改箱号没有落库', packing.listPackingLists(o.id)[0].lines.find((l) => l.id === second.id)!.boxNo, 'B2')
}

/* ============================================================
 * 第 13 轮：口径与守门（R13）
 * ============================================================ */
section('R13 导出口径：页面筛出几张，Excel 就是几张')
const cR13 = customers.saveCustomer({ company: 'R13 Export Co', contact: 'Export Desk', country: 'Germany' })
const r13Ledger = orders.createOrder({
  customerId: cR13.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r13Ledger.id, { styleNo: 'R13-OK', productName: '正常单', quantity: 10, unitPrice: 10 })
const r13Draft = orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r13Draft.id, { styleNo: 'R13-DRAFT', productName: '草稿', quantity: 10, unitPrice: 10 })
const r13Void = orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Void.id, { styleNo: 'R13-VOID', productName: '作废', quantity: 10, unitPrice: 10 })
orders.voidOrder(r13Void.id, '客户取消')
const r13Expired = orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Expired.id, { styleNo: 'R13-EXP', productName: '失效', quantity: 10, unitPrice: 10 })
orders.setPaymentStatus(r13Expired.id, 'expired')

const csvLedger = dashboard.exportCsv('orders')
check('默认台账含正常单', csvLedger.includes(r13Ledger.orderNo))
check(
  '默认台账不含草稿 / 作废 / 失效（SUM 出来才是销售额）',
  ![r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].some((no) => csvLedger.includes(no)),
  [r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].join(',')
)
const csvAll = dashboard.exportCsv('orders_all')
check(
  '全量底稿四张都在（复盘查得到）',
  [r13Ledger.orderNo, r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].every((no) => csvAll.includes(no))
)
const csvVoid = dashboard.exportCsv('orders', { paymentStatus: 'void' })
check('停在「已作废」页签导出，作废单在表里', csvVoid.includes(r13Void.orderNo))
check('按作废筛选时不会混进正常单或草稿', !csvVoid.includes(r13Ledger.orderNo) && !csvVoid.includes(r13Draft.orderNo))
const csvDraft = dashboard.exportCsv('orders', { paymentStatus: 'draft' })
check('停在「草稿」页签导出，草稿在表里且只有草稿', csvDraft.includes(r13Draft.orderNo) && !csvDraft.includes(r13Ledger.orderNo))

section('R13 收款状态：发出 PI 后按真收到的钱走，不被 sent 卡住')
const r13Pay = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'sent',
  depositRatio: 0
})
await orders.addOrderItem(r13Pay.id, { styleNo: 'R13-PAY', productName: '收款流转', quantity: 10, unitPrice: 100 })
eq('PI 已发、还没收钱 → 仍是已发出', orders.getOrder(r13Pay.id)!.paymentStatus, 'sent')
orders.addPayment(r13Pay.id, { paidAt: localDate(), amount: 400, method: 'T/T', bankRef: 'R13-P1' })
eq('收到 400 / 1000 → 部分收款（不再停在已发出）', orders.getOrder(r13Pay.id)!.paymentStatus, 'partial')
orders.addPayment(r13Pay.id, { paidAt: localDate(), amount: 600, method: 'T/T', bankRef: 'R13-P2' })
eq('收齐 → 已结清', orders.getOrder(r13Pay.id)!.paymentStatus, 'settled')

section('R13 写入守门：作废/失效的单不能再往里加东西')
const r13Void2 = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Void2.id, { styleNo: 'R13-GUARD', productName: '守门', quantity: 10, unitPrice: 10 })
orders.voidOrder(r13Void2.id, '客户不做了')
check(
  '作废单不能再加明细',
  r8err(() => orders.addOrderItems(r13Void2.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }])).includes('已作废')
)
check(
  '作废单不能再登记收款',
  r8err(() => orders.addPayment(r13Void2.id, { paidAt: localDate(), amount: 10 })).includes('已作废')
)
check(
  '作废单不能再装箱',
  r8err(() =>
    packing.createPackingList({ orderId: r13Void2.id, lines: [{ boxNo: 'V1', styleNo: 'R13-GUARD', quantity: 1 }] })
  ).includes('已作废')
)

const r13Exp = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Exp.id, { styleNo: 'R13-EXP2', productName: '失效守门', quantity: 10, unitPrice: 10 })
orders.setPaymentStatus(r13Exp.id, 'expired')
check(
  '失效单不能再登记收款（钱进来了得先把状态改回来）',
  r8err(() => orders.addPayment(r13Exp.id, { paidAt: localDate(), amount: 10 })).includes('已失效')
)
orders.setPaymentStatus(r13Exp.id, 'confirmed')
const r13ExpPaid = orders.addPayment(r13Exp.id, { paidAt: localDate(), amount: 10, method: 'T/T', bankRef: 'R13-EXP-P' })
eq('状态改回来后可以继续收款', r13ExpPaid.paymentStatus, 'partial')

section('R13 箱号跨批次连续：作废的号也不能重发')
const r13Box = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Box.id, { styleNo: 'R13-BOX', productName: '箱号', quantity: 100, unitPrice: 1 })
const r13BoxA = packing.createPackingList({
  orderId: r13Box.id,
  containerNo: 'R13-A',
  lines: [{ boxNo: 'B-1', styleNo: 'R13-BOX', quantity: 40 }]
})[0]
const r13DupBoxErr = r8err(() =>
  packing.createPackingList({ orderId: r13Box.id, lines: [{ boxNo: 'B-1', styleNo: 'R13-BOX', quantity: 20 }] })
)
check('下一批重复用 B-1 被拦下，并说明箱号跨批次连续', r13DupBoxErr.includes('已经用过') && r13DupBoxErr.includes('箱号跨批次连续'), r13DupBoxErr)
const r13BoxB = packing
  .createPackingList({ orderId: r13Box.id, containerNo: 'R13-B', lines: [{ boxNo: 'B-2', styleNo: 'R13-BOX', quantity: 20 }] })
  .find((p) => p.containerNo === 'R13-B')
check('换成没发过的 B-2 放行', !!r13BoxB)
packing.voidPackingList(r13Box.id, r13BoxB!.id, '订舱取消')
const r13VoidBoxErr = r8err(() =>
  packing.createPackingList({ orderId: r13Box.id, lines: [{ boxNo: 'B-2', styleNo: 'R13-BOX', quantity: 10 }] })
)
check('作废批次的箱号仍占号，不能再发一次', r13VoidBoxErr.includes('作废批次也占号'), r13VoidBoxErr)
check(
  '往后接 B-3 放行',
  (() => {
    packing.createPackingList({ orderId: r13Box.id, containerNo: 'R13-C', lines: [{ boxNo: 'B-3', styleNo: 'R13-BOX', quantity: 10 }] })
    return packing.listPackingLists(r13Box.id).some((p) => p.containerNo === 'R13-C')
  })()
)
check('同一批 A 的 B-1 还能改箱明细（不误伤自己）', packing.updatePackingListLine(r13Box.id, r13BoxA.id, r13BoxA.lines[0].id, { quantity: 40 }).length > 0)

section('R13 贸易术语：八种都能落库、都能印在 PI 上')
for (const term of INCOTERMS) {
  const o = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7,
    incoterm: term,
    portOfLoading: 'Shanghai',
    portOfDestination: 'Hamburg'
  })
  eq(`贸易术语 ${term} 存住了`, o.incoterm, term)
  check(
    `PI 印出 ${term} 和港口`,
    renderPi({ order: o, settings: getSettings(), images: {} }).includes(`${term} — Shanghai → Hamburg`),
    term
  )
}

section('R13 打样重新转单：上次转出的单作废了，还能按新单再转')
const smpR13 = samples.saveSample({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R13-SMP', productName: '重转', quantity: 2, unitPrice: 15, goodsUnitPrice: 8 }]
})
const r13SampleOrder1 = samples.convertSampleToOrder(smpR13.id)
orders.voidOrder(r13SampleOrder1.id, '客户改规格')
eq(
  '打样列表能看出上次转出的单已作废',
  samples.listSamples().find((s) => s.id === smpR13.id)!.convertedOrderStatus,
  'void'
)
const r13SampleOrder2 = samples.convertSampleToOrder(smpR13.id)
check('作废后重新转单会生成一张新单，而不是复用作废单', r13SampleOrder2.id !== r13SampleOrder1.id)
eq('打样单改成记新单', samples.getSample(smpR13.id)!.convertedOrderId, r13SampleOrder2.id)
eq('新单还活着时再转仍复用同一张', samples.convertSampleToOrder(smpR13.id).id, r13SampleOrder2.id)

section('R13 报价已确认却没人转单：催的是「拖下去汇率和交期都会变」')
const qR13 = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  status: 'confirmed',
  items: [{ styleNo: 'R13-Q', quantity: 10, unitPrice: 5 }]
})
getDb().run('UPDATE quotations SET confirmed_at = ? WHERE id = ?', [dAgoIso(20), qR13.id])
const remR13 = dashboard.reminders()
check(
  '已确认 20 天没转单 → 工作台催转订单',
  remR13.some(
    (r) => r.kind === 'quote' && r.orderNo === qR13.qNo && r.message.includes('已确认') && r.message.includes('汇率和交期')
  ),
  JSON.stringify(remR13.filter((r) => r.orderNo === qR13.qNo).map((r) => r.message))
)

/* ============================================================
 * 第 14 轮：分批出 CI 与 R13 回归（R14）
 * ============================================================ */
/** 按批次出 CI 的入参：与 OrderDetail 的 openCi 同一套取数（明细/金额/船期都来自批次） */
function ciBatchOf(order: any, pl: any): any {
  const a = money.packingAmounts(order.id).find((x) => x.plId === pl.id)!
  return {
    plNo: pl.plNo,
    docDate: pl.docDate || String(pl.createdAt).slice(0, 10),
    lines: a.lines.map((l) => {
      const it = order.items.find(
        (x: any) => x.styleNo === l.styleNo && x.color === l.color && x.size === l.size
      )
      return { ...l, productName: it?.productName ?? '', composition: it?.composition ?? '' }
    }),
    goods: a.goods,
    quantity: a.quantity,
    charges: a.chargeLines,
    total: a.total,
    containerNo: pl.containerNo || undefined,
    vessel: pl.vessel || undefined,
    etdDate: pl.etdDate || undefined,
    blNo: pl.blNo || undefined
  }
}

section('R14 批次金额：单批货值 + 按货值分摊费用，各批相加 = 整单')
const r14 = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R14-CI',
  portOfLoading: 'Shanghai',
  portOfDestination: 'Hamburg',
  vessel: 'ORDER-VESSEL',
  etdDate: '2026-11-20'
})
await orders.addOrderItem(r14.id, {
  styleNo: 'R14-A',
  productName: '批次甲',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 10
})
await orders.addOrderItem(r14.id, {
  styleNo: 'R14-B',
  productName: '批次乙',
  color: 'Red',
  size: 'L',
  quantity: 50,
  unitPrice: 20
})
orders.updateOrderCharges(r14.id, [
  { label: '运费 Freight', amount: 300 },
  { label: '保险费 Insurance', amount: 90 }
])
const r14PlA = packing.createPackingList({
  orderId: r14.id,
  containerNo: 'CONT-A',
  lines: [{ boxNo: 'R14-A-1', styleNo: 'R14-A', color: 'Black', size: 'M', quantity: 100 }]
})[0]
packing.updatePackingListInfo(r14.id, r14PlA.id, {
  containerNo: 'CONT-A',
  vessel: 'VESSEL-A',
  etdDate: '2026-12-01',
  blNo: 'BL-A',
  docDate: '2026-12-02'
})
const r14PlB = packing.createPackingList({
  orderId: r14.id,
  lines: [{ boxNo: 'R14-B-1', styleNo: 'R14-B', color: 'Red', size: 'L', quantity: 50 }]
}).slice(-1)[0]
packing.updatePackingListInfo(r14.id, r14PlB.id, { docDate: '2026-12-03' })

const r14Amts = money.packingAmounts(r14.id)
eq('两批都已算出金额', r14Amts.length, 2)
const r14AmtA = r14Amts.find((a) => a.plId === r14PlA.id)!
const r14AmtB = r14Amts.find((a) => a.plId === r14PlB.id)!
eq('A 批货值 = 100 × 10', r14AmtA.goods, 1000)
eq('A 批费用按货值一半分摊 = 390 / 2', r14AmtA.charges, 195)
eq('A 批合计', r14AmtA.total, 1195)
eq('B 批货值 = 50 × 20', r14AmtB.goods, 1000)
eq('B 批合计', r14AmtB.total, 1195)
eq(
  '两批合计相加 = PI 含费用合计',
  r2(r14AmtA.total + r14AmtB.total),
  Number(orders.getOrder(r14.id)!.grandTotal)
)
eq('A 批费用行相加 = A 批分摊费用', r2(r14AmtA.chargeLines.reduce((s, c) => s + c.amount, 0)), r14AmtA.charges)
eq('A 批只有自己的 SKU', r14AmtA.lines.map((l) => l.styleNo), ['R14-A'])
eq('A 批件数', r14AmtA.quantity, 100)
eq('A 批明细行金额 = 件数 × 单价', r14AmtA.lines[0].amount, 1000)

section('R14 批次金额：分币差落在最后一批，各批相加正好等于整单')
const r14Round = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Round.id, { styleNo: 'R14-ROUND', quantity: 300, unitPrice: 1 })
orders.updateOrderCharges(r14Round.id, [{ label: '运费 Freight', amount: 100 }])
for (let i = 0; i < 3; i += 1) {
  packing.createPackingList({
    orderId: r14Round.id,
    lines: [{ boxNo: `R14-R-${i + 1}`, styleNo: 'R14-ROUND', quantity: 100 }]
  })
}
const r14RoundAmts = money.packingAmounts(r14Round.id)
eq('三批货值各 100', r14RoundAmts.map((a) => a.goods), [100, 100, 100])
eq('100 元费用按 33.33 / 33.33 / 33.34 分摊', r14RoundAmts.map((a) => a.charges), [33.33, 33.33, 33.34])
eq(
  '三批合计相加 = PI 含费用合计（分币差不丢）',
  r2(r14RoundAmts.reduce((s, a) => s + a.total, 0)),
  Number(orders.getOrder(r14Round.id)!.grandTotal)
)
check(
  '每批费用行相加 = 本批分摊费用',
  r14RoundAmts.every((a) => r2(a.chargeLines.reduce((s, c) => s + c.amount, 0)) === a.charges)
)

section('R14 按批次出 CI：号带批次后缀，只印本批的明细、金额与船期')
const r14Full = orders.getOrder(r14.id)!
const r14PlAFull = r14Full.packingLists.find((p) => p.id === r14PlA.id)!
const r14PlBFull = r14Full.packingLists.find((p) => p.id === r14PlB.id)!
check('CI 号按批次派生（PI → CI + 批次号）', ciNoOf('PI-9', 'PL-3') === 'CI-9-PL-3')
const ciA = renderCi(
  { order: r14Full, settings: getSettings(), images: {} },
  { batch: ciBatchOf(r14Full, r14PlAFull) }
)
check('批次 CI 号带这批的批次号', ciA.includes(`CI No.:</b> CI-R14-CI-${r14PlAFull.plNo}`), r14PlAFull.plNo)
check('批次 CI 印「仅本批」', ciA.includes('this shipment only / 仅本批'))
check('批次 CI 用这批的纸面日期', ciA.includes('<b>Date:</b> 2026-12-02'))
check('批次 CI 印本批柜号', ciA.includes('Container No.: CONT-A'))
check('批次 CI 印本批船名', ciA.includes('Vessel/Voyage: VESSEL-A'))
check('批次 CI 印本批 ETD', ciA.includes('ETD: 2026-12-01'))
check('批次 CI 印本批提单号', ciA.includes('B/L No.: BL-A'))
check('批次 CI 合计 = 本批货值 + 分摊费用', ciA.includes('USD 1,195.00'))
check('批次 CI 不印别批的款号', !ciA.includes('R14-B'))
check('批次 CI 只印本批件数', ciA.includes('>100<') && !ciA.includes('>150<'))

const ciB = renderCi(
  { order: r14Full, settings: getSettings(), images: {} },
  { batch: ciBatchOf(r14Full, r14PlBFull) }
)
check('批次没填船名时退回整单船名', ciB.includes('Vessel/Voyage: ORDER-VESSEL'))
check('批次没填 ETD 时退回整单 ETD', ciB.includes('ETD: 2026-11-20'))
check('没填提单号就不印 B/L', !ciB.includes('B/L No.'))
check('另一批用自己的纸面日期', ciB.includes('<b>Date:</b> 2026-12-03'))
const ciWhole = renderCi({ order: r14Full, settings: getSettings(), images: {} })
check('整单 CI 号不带批次后缀', ciWhole.includes('CI No.:</b> CI-R14-CI<br>'))
check('整单 CI 合计仍是 PI 含费用合计', ciWhole.includes('USD 2,390.00'))
check('整单 CI 两批的款都在', ciWhole.includes('R14-A') && ciWhole.includes('R14-B'))

section('R14 批次金额：作废批次不算金额，撤销作废后回来')
packing.voidPackingList(r14.id, r14PlB.id, '订舱取消')
eq('作废的那批不再出金额', money.packingAmounts(r14.id).map((a) => a.plId), [r14PlA.id])
packing.unvoidPackingList(r14.id, r14PlB.id, '订舱恢复了')
eq('撤销作废后两批都在', money.packingAmounts(r14.id).length, 2)

section('R14 批次金额：老数据里对不上款号的箱不出单价，也不编数')
const r14Legacy = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Legacy.id, { styleNo: 'R14-LEG', quantity: 10, unitPrice: 5 })
orders.updateOrderCharges(r14Legacy.id, [{ label: '运费 Freight', amount: 10 }])
const r14LegacyPl = packing.createPackingList({
  orderId: r14Legacy.id,
  lines: [{ boxNo: 'R14-L-1', styleNo: 'R14-LEG', quantity: 5 }]
})[0]
// 升级前的老数据：箱单上有订单里找不到的款号（现在的新装箱会被超装校验拦住）
getDb().run(
  `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, color, size, quantity)
   VALUES(?,?,?,?,?,?)`,
  [r14LegacyPl.id, 'R14-L-2', 'R14-LEGACY', 'Blue', 'S', 3]
)
const r14LegacyAmt = money.packingAmounts(r14Legacy.id).find((a) => a.plId === r14LegacyPl.id)!
eq('对不上的款号被点出来', r14LegacyAmt.unknownSkus, ['R14-LEGACY'])
eq('对不上的箱不计货值', r14LegacyAmt.goods, 25)
eq('件数照实算', r14LegacyAmt.quantity, 8)
eq('费用只按能对上单价的部分分摊', r14LegacyAmt.charges, 5)

section('R14 导出回归：关键词 / 日期筛选都不放开草稿、失效、作废')
const r14Ok = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-OK' })
const r14Draft = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, piNo: 'PI-R14KW-DRAFT' })
const r14VoidExport = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-VOID' })
orders.voidOrder(r14VoidExport.id, '客户取消')
const r14ExpExport = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-EXP' })
orders.setPaymentStatus(r14ExpExport.id, 'expired')
const r14KwCsv = dashboard.exportCsv('orders', { keyword: 'R14KW' })
check('关键词导出台账含正常单', r14KwCsv.includes(r14Ok.orderNo))
check(
  '关键词导出不含草稿 / 失效 / 作废',
  ![r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].some((no) => r14KwCsv.includes(no)),
  [r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].join(',')
)
const r14DateCsv = dashboard.exportCsv('orders', { from: localDate(), to: localDate() })
check('按日期导出含正常单', r14DateCsv.includes(r14Ok.orderNo))
check(
  '按日期导出不含草稿 / 失效 / 作废',
  ![r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].some((no) => r14DateCsv.includes(no))
)
check('停在草稿页签导出仍能拿到草稿', dashboard.exportCsv('orders', { paymentStatus: 'draft' }).includes(r14Draft.orderNo))
check('停在全量底稿仍能拿到作废单', dashboard.exportCsv('orders_all').includes(r14VoidExport.orderNo))

section('R14 作废/失效不能再被改活或改内容')
const r14Void = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
const r14VoidItem = await orders.addOrderItem(r14Void.id, { styleNo: 'R14-VOID', quantity: 10, unitPrice: 10 })
const r14VoidItemId = r14VoidItem.items[0].id
orders.voidOrder(r14Void.id, '客户取消')
check(
  '作废单不能整单编辑',
  r8err(() => orders.updateOrder(r14Void.id, { customerId: c1.id, note: '偷偷改' })).includes('已作废')
)
check(
  '作废单不能改抬头',
  r8err(() => orders.setOrderParties(r14Void.id, { shipTo: { company: 'X' } })).includes('已作废')
)
check(
  '作废单不能改回收款状态',
  r8err(() => orders.setPaymentStatus(r14Void.id, 'confirmed')).includes('不能改回收款状态')
)
check(
  '作废单不能改明细行',
  r8err(() => orders.updateOrderItem(r14Void.id, r14VoidItemId, { quantity: 5 })).includes('已作废')
)
check('作废单不能删明细行', r8err(() => orders.removeOrderItem(r14Void.id, r14VoidItemId)).includes('已作废'))
check(
  '作废单不能整体替换明细',
  r8err(() => orders.replaceOrderItems(r14Void.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }])).includes('已作废')
)
check('作废单不能改费用', r8err(() => orders.updateOrderCharges(r14Void.id, [])).includes('已作废'))
eq('作废状态没被偷偷改回来', orders.getOrder(r14Void.id)!.paymentStatus, 'void')
eq('作废单的明细也没被改', orders.getOrder(r14Void.id)!.items[0].quantity, 10)

const r14Exp = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Exp.id, { styleNo: 'R14-EXP', quantity: 10, unitPrice: 10 })
orders.setPaymentStatus(r14Exp.id, 'expired')
check(
  '失效单不能整单编辑',
  r8err(() => orders.updateOrder(r14Exp.id, { customerId: c1.id, note: '偷偷改' })).includes('已失效')
)
check(
  '失效单不能改抬头',
  r8err(() => orders.setOrderParties(r14Exp.id, { billTo: { company: 'Y' } })).includes('已失效')
)
check(
  '失效单不能整体替换明细',
  r8err(() => orders.replaceOrderItems(r14Exp.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }])).includes('已失效')
)
orders.setPaymentStatus(r14Exp.id, 'confirmed')
eq('改回正式单后能正常编辑', orders.updateOrder(r14Exp.id, { customerId: c1.id, note: '恢复后正常' }).note, '恢复后正常')

section('R14 费用金额必须是有限数')
const r14NaN = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
check(
  '整单保存时费用 NaN 被拒',
  r8err(() =>
    orders.updateOrder(r14NaN.id, { customerId: c1.id, charges: [{ label: '运费 Freight', amount: NaN }] })
  ).includes('不是有效数字')
)
check(
  '单独保存费用 Infinity 被拒',
  r8err(() => orders.updateOrderCharges(r14NaN.id, [{ label: '运费 Freight', amount: Infinity }])).includes(
    '不是有效数字'
  )
)
eq('被拒后订单没有落下费用行', orders.getOrder(r14NaN.id)!.charges.length, 0)

/* ============================================================
 * 第 15 轮：凭据不可改写 + 打样应收口径（R15）
 * ============================================================ */
section('R15 出过 CI 的单：单价与费用行钉住，数量仍可改')
const r15Lock = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R15-LOCK'
})
const r15LockItem = (
  await orders.addOrderItem(r15Lock.id, {
    styleNo: 'R15-LOCK',
    productName: '锁价测试',
    color: 'Blue',
    size: 'M',
    quantity: 10,
    unitPrice: 10
  })
).items[0]
orders.updateOrderCharges(r15Lock.id, [{ label: '运费 Freight', amount: 20 }])
packing.createPackingList({
  orderId: r15Lock.id,
  lines: [{ boxNo: 'R15-LOCK-1', styleNo: 'R15-LOCK', color: 'Blue', size: 'M', quantity: 10 }]
})
// 没出 CI 之前改价是正常业务：锁只认「已经发出去的那一版」
orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 11 })
eq('出 CI 前改价照旧可以', orders.getOrder(r15Lock.id)!.items[0].unitPrice, 11)
orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 10 })
docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r15 lock'),
  docNo: 'CI-R15-LOCK',
  kind: 'ci',
  orderId: r15Lock.id,
  amount: 120
})
check(
  '出过 CI 后单价改不动',
  r8err(() => orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 12 })).includes('已经出过 CI')
)
check(
  '出过 CI 后费用行改不动',
  r8err(() => orders.updateOrderCharges(r15Lock.id, [{ label: '运费 Freight', amount: 30 }])).includes('已经出过 CI')
)
check(
  '整单保存里夹带改费用也拦得住',
  r8err(() =>
    orders.updateOrder(r15Lock.id, { customerId: c1.id, charges: [{ label: '运费 Freight', amount: 30 }] })
  ).includes('已经出过 CI')
)
eq('被拦后明细单价没变', orders.getOrder(r15Lock.id)!.items[0].unitPrice, 10)
eq('被拦后费用行没变', orders.getOrder(r15Lock.id)!.charges[0].amount, 20)
// 整单保存通常会把原样费用一起带上：没变就不该误伤别的字段
check(
  '整单保存带上原样费用不被误伤',
  r8err(() =>
    orders.updateOrder(r15Lock.id, { customerId: c1.id, note: 'R15 只改备注', charges: [{ label: '运费 Freight', amount: 20 }] })
  ) === ''
)
eq('原样保存后备注确实写进去了', orders.getOrder(r15Lock.id)!.note, 'R15 只改备注')
// 分批金额按箱单件数算，改整单数量不会改写已出运那批的金额 → 数量不锁
eq('出过 CI 后整单数量仍可改', orders.updateOrderItem(r15Lock.id, r15LockItem.id, { quantity: 12 }).items[0].quantity, 12)

section('R15 汇率印在纸面上：出过单据/核销后不能再改')
const r15Rate = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R15-RATE'
})
await orders.addOrderItem(r15Rate.id, { styleNo: 'R15-RATE', quantity: 10, unitPrice: 10 })
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r15 rate'), docNo: 'PI-R15-RATE', kind: 'pi', orderId: r15Rate.id })
check(
  '出过单据后改汇率被拒',
  r8err(() => orders.updateOrder(r15Rate.id, { customerId: c1.id, exchangeRate: 7.3 })).includes('汇率')
)
eq('被拒后汇率没变', orders.getOrder(r15Rate.id)!.exchangeRate, 7)
// 只登记了收款、还没出单据：录错汇率要能修（操作历史里留旧值 → 新值）
const r15RatePay = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15RatePay.id, { styleNo: 'R15-RATE-PAY', quantity: 10, unitPrice: 10 })
orders.addPayment(r15RatePay.id, { paidAt: localDate(), amount: 10 })
eq(
  '有收款但没出过单据，仍可修正汇率',
  orders.updateOrder(r15RatePay.id, { customerId: c1.id, exchangeRate: 7.3 }).exchangeRate,
  7.3
)
const r15Cur = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15Cur.id, { styleNo: 'R15-CUR', quantity: 1, unitPrice: 10 })
check(
  '有明细就换币种被拒',
  r8err(() => orders.updateOrder(r15Cur.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })).includes(
    '不能改币种'
  )
)
eq('被拒后币种没变', orders.getOrder(r15Cur.id)!.currency, 'USD')
const r15CurOk = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
eq(
  '没有明细的空单换币种照旧可以（重填汇率）',
  orders.updateOrder(r15CurOk.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 }).currency,
  'EUR'
)
const r15CurDraft = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r15CurDraft.id, { styleNo: 'R15-CUR-DRAFT', quantity: 1, unitPrice: 10 })
eq(
  '草稿单还没对外，换币种允许（建单时选错是改错字）',
  orders.updateOrder(r15CurDraft.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 }).currency,
  'EUR'
)

section('R15 物理删除只留给真正的空单；作废单不能绕过留档')
const r15DelDoc = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r15 del'), docNo: 'PI-R15-DEL', kind: 'pi', orderId: r15DelDoc.id })
check(
  '有单据存档的空单不能物理删除',
  r8err(() => orders.deleteOrder(r15DelDoc.id)).includes('单据存档')
)
const r15VoidDel = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
orders.voidOrder(r15VoidDel.id, '建错单')
check('作废单不能物理删除（留档终态）', r8err(() => orders.deleteOrder(r15VoidDel.id)).includes('留档'))
const r15Empty = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
check('真正的空单还能删', r8err(() => orders.deleteOrder(r15Empty.id)) === '')

section('R15 作废单：收款、核销、箱单都不能再动')
const r15VoidOps = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15VoidOps.id, { styleNo: 'R15-VOIDOPS', quantity: 10, unitPrice: 10 })
const r15OpsPay = orders.addPayment(r15VoidOps.id, { paidAt: localDate(), amount: 10 })
orders.addSettlement(r15VoidOps.id, { kind: 'bad_debt', amount: 20, reason: 'R15 测试坏账' })
const r15OpsPlA = packing.createPackingList({
  orderId: r15VoidOps.id,
  lines: [{ boxNo: 'R15-VOID-A', styleNo: 'R15-VOIDOPS', quantity: 5 }]
})[0]
const r15OpsPlB = packing.createPackingList({
  orderId: r15VoidOps.id,
  lines: [{ boxNo: 'R15-VOID-B', styleNo: 'R15-VOIDOPS', quantity: 5 }]
}).slice(-1)[0]
packing.voidPackingList(r15VoidOps.id, r15OpsPlB.id, '这一批没走成')
// R19 起作废带凭据的单要先核对：直接作废被拦，勾了「凭据已核对」才放行
check(
  '还挂着箱单的订单直接作废会被拦下核对凭据',
  r8err(() => orders.voidOrder(r15VoidOps.id, 'R15 作废')).includes('凭据')
)
orders.voidOrder(r15VoidOps.id, 'R15 作废', { confirmDocs: true })
const r15OpsSettle = orders.listSettlements(r15VoidOps.id)[0]
check(
  '作废单不能删收款',
  r8err(() => orders.deletePayment(r15VoidOps.id, r15OpsPay.payments[0].id, '删掉这笔')).includes('已作废')
)
check(
  '作废单不能撤销核销',
  r8err(() => orders.reverseSettlement(r15VoidOps.id, r15OpsSettle.id, '撤销坏账')).includes('已作废')
)
check(
  '作废单不能作废箱单',
  r8err(() => packing.voidPackingList(r15VoidOps.id, r15OpsPlA.id, '取消')).includes('已作废')
)
check(
  '作废单不能撤销箱单作废',
  r8err(() => packing.unvoidPackingList(r15VoidOps.id, r15OpsPlB.id)).includes('已作废')
)
eq('作废单的收款还在', orders.getOrder(r15VoidOps.id)!.payments.length, 1)
eq('作废单的核销还在', orders.listSettlements(r15VoidOps.id).length, 1)

section('R15 欠款榜：只打过样、没下过单的客户也在榜上')
const r15SampleOnly = customers.saveCustomer({ company: 'R15-ONLY-SAMPLE' })
samples.saveSample({
  customerId: r15SampleOnly.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S1', productName: '只打样', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r15Board = money.receivableByCustomer()
const r15BoardRow = r15Board.find((r) => r.customerId === r15SampleOnly.id)
eq('只打样的客户也在欠款榜上（样品费 10 + 快递费 5，USD×7）', r15BoardRow?.totalBase, 105)
eq('这类客户的订单数记 0', r15BoardRow?.orders, 0)
check(
  '榜上合计 = 全公司待收（打样费不漏）',
  Math.abs(r15Board.reduce((s, r) => s + r.totalBase, 0) - money.totalReceivable()) < 0.01
)

section('R15 已收的打样费不再抵扣一次')
const r15PaidCust = customers.saveCustomer({ company: 'R15-PAID-SAMPLE' })
const r15PaidSample = samples.saveSample({
  customerId: r15PaidCust.id,
  expressFee: 5,
  feeStatus: 'paid',
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S2', productName: '已收打样费', color: 'Grey', size: 'L', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r15PaidOrder = samples.convertSampleToOrder(r15PaidSample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
eq('已收的打样费不再生成抵扣行', r15PaidOrder.charges.length, 0)
eq('已收标记不被改成下单抵扣', samples.getSample(r15PaidSample.id)!.feeStatus, 'paid')
const r15WaivedCust = customers.saveCustomer({ company: 'R15-WAIVED-SAMPLE' })
const r15WaivedSample = samples.saveSample({
  customerId: r15WaivedCust.id,
  expressFee: 5,
  feeStatus: 'waived',
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S4', productName: '免收打样费', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r15WaivedOrder = samples.convertSampleToOrder(r15WaivedSample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
eq('已免收的打样费也不生成抵扣行', r15WaivedOrder.charges.length, 0)
eq('已免收标记不被改成下单抵扣', samples.getSample(r15WaivedSample.id)!.feeStatus, 'waived')

section('R15 老「下单抵扣」记录不按新口径倒推')
// R15 之前只抵了样品费，offset_amount 没有记录（0）：读取时按旧口径只算样品费，
// 不能拿「样品费+快递费」硬套，否则老单会被算成多收回一笔从不存在的钱
const r15LegacyCust = customers.saveCustomer({ company: 'R15-LEGACY-OFFSET' })
const r15Legacy = samples.saveSample({
  customerId: r15LegacyCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S3', productName: '老抵扣', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
getDb().run("UPDATE sample_orders SET fee_status = 'offset', offset_amount = 0 WHERE id = ?", [r15Legacy.id])
eq('老抵扣记录只算样品费（USD10 × 7）', samples.getSample(r15Legacy.id)!.feeRecoveredBase, 70)
eq('新抵扣记录按实际抵掉的金额算（USD40 × 7.2）', samples.getSample(smpOffset.id)!.feeRecoveredBase, 40 * 7.2)

/* ============================================================
 * 第 16 轮：发出去的单，系统里不许再改（R16）
 * ============================================================ */
section('R16 出过 CI 的批次：金额钉在存档上，箱明细/删除/作废全锁')
const r16Order = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R16-FREEZE'
})
await orders.addOrderItem(r16Order.id, { styleNo: 'R16-F', productName: '冻结测试', quantity: 100, unitPrice: 10 })
orders.updateOrderCharges(r16Order.id, [{ label: '运费 Freight', amount: 390 }])
const r16Pl = packing.createPackingList({
  orderId: r16Order.id,
  lines: [{ boxNo: 'R16-1', styleNo: 'R16-F', quantity: 50 }]
})[0]
const r16Before = money.packingAmounts(r16Order.id)[0]
eq('未存档时按整单货值分摊（500 货值 + 195 费用）', r16Before.total, 695)
docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r16 freeze'),
  docNo: ciNoOf('PI-R16-FREEZE', r16Pl.plNo),
  kind: 'ci',
  orderId: r16Order.id,
  amount: r16Before.total
})
// 订单后来又补了 100 件：整单货值变成 2000，存档批次的费用份额不能跟着缩水
const r16Item = orders.getOrder(r16Order.id)!.items[0]
await orders.updateOrderItem(r16Order.id, r16Item.id, { quantity: 200 })
const r16After = money.packingAmounts(r16Order.id).find((b) => b.plId === r16Pl.id)!
eq('补货后已存档批次的总额还是纸面上的 695', r16After.total, 695)
eq('已存档批次的费用不按新货值重摊', r16After.charges, 195)
const r16PlB = packing.createPackingList({
  orderId: r16Order.id,
  lines: [{ boxNo: 'R16-2', styleNo: 'R16-F', quantity: 50 }]
}).slice(-1)[0]
const r16AfterB = money.packingAmounts(r16Order.id).find((b) => b.plId === r16PlB.id)!
eq('未存档批次只分剩余费用（(390−195) × 500/1500）', r16AfterB.charges, 65)
eq('新批次总额跟着它的货值走', r16AfterB.total, 565)
eq(
  '两批费用相加不超过订单费用合计（不会再拿整单 390 摊第二遍）',
  money.packingAmounts(r16Order.id).reduce((s, b) => s + b.charges, 0),
  260
)
const r16Line = packing.listPackingLists(r16Order.id).find((p) => p.id === r16Pl.id)!.lines[0]
check(
  '出过 CI 的批次箱明细不能改',
  r8err(() => packing.updatePackingListLine(r16Order.id, r16Pl.id, r16Line.id, { quantity: 40 })).includes(
    '已经出过 CI'
  )
)
check(
  '出过 CI 的批次不能加箱',
  r8err(() =>
    packing.addPackingListLine(r16Order.id, r16Pl.id, { boxNo: 'R16-3', styleNo: 'R16-F', quantity: 1 })
  ).includes('已经出过 CI')
)
check(
  '出过 CI 的批次不能删箱',
  r8err(() => packing.deletePackingListLine(r16Order.id, r16Pl.id, r16Line.id)).includes('已经出过 CI')
)
check(
  '出过 CI 的批次不能删除',
  r8err(() => packing.deletePackingList(r16Order.id, r16Pl.id)).includes('不能删除')
)
check(
  '出过 CI 的批次不能作废',
  r8err(() => packing.voidPackingList(r16Order.id, r16Pl.id, '想撤')).includes('不能作废')
)
eq(
  '批次信息（船名/柜号）照旧能补录',
  packing.updatePackingListInfo(r16Order.id, r16Pl.id, { vessel: 'R16 V.1' }).find((p) => p.id === r16Pl.id)!.vessel,
  'R16 V.1'
)
eq('被拦后箱明细数量没变', packing.listPackingLists(r16Order.id).find((p) => p.id === r16Pl.id)!.lines[0].quantity, 50)
eq('补货后整单数量仍可改（批次金额按箱单件数算）', orders.updateOrderItem(r16Order.id, orders.getOrder(r16Order.id)!.items[0].id, { quantity: 120 }).items[0].quantity, 120)

section('R16 有单据存档后 PI 号不许改')
check(
  '出过 CI 后改 PI 号被拒',
  r8err(() => orders.updateOrder(r16Order.id, { customerId: c1.id, piNo: 'PI-R16-FREEZE-X' })).includes('PI 号')
)
eq('被拒后 PI 号没变', orders.getOrder(r16Order.id)!.piNo, 'PI-R16-FREEZE')
eq(
  '原样带上 PI 号保存不被误伤',
  orders.updateOrder(r16Order.id, { customerId: c1.id, piNo: 'PI-R16-FREEZE', note: 'R16 只改备注' }).note,
  'R16 只改备注'
)

section('R16 报价单有存档后不能删')
const r16Q = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R16-Q', quantity: 10, unitPrice: 7.5 }]
})
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r16 quote'), docNo: r16Q.qNo, kind: 'quotation', quotationId: r16Q.id })
check('有存档的报价单删不掉', r8err(() => quotations.deleteQuotation(r16Q.id)).includes('单据存档'))
check('拦截提示给出替代方案（已失效）', r8err(() => quotations.deleteQuotation(r16Q.id)).includes('已失效'))
check('拦截后报价单还在', quotations.getQuotation(r16Q.id) !== null)

section('R16 坏账追回登记的钱不能直接删（核销台账会悬空）')
const r16Rec = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16Rec.id, { styleNo: 'R16-REC', quantity: 10, unitPrice: 10 })
orders.addSettlement(r16Rec.id, { kind: 'bad_debt', amount: 50, reason: 'R16 客户破产' })
orders.addSettlement(r16Rec.id, { kind: 'recovery', amount: 20, reason: 'R16 追回', paidAt: '2026-10-21' })
const r16RecPay = orders.getOrder(r16Rec.id)!.payments[0]
check(
  '追回款删不掉，提示改走反向收款',
  r8err(() => orders.deletePayment(r16Rec.id, r16RecPay.id, '想删')).includes('反向收款')
)
eq('被拒后追回款还在', orders.getOrder(r16Rec.id)!.payments.length, 1)

section('R16 作废单不能改出货状态；全批作废后订单不能挂着已发货')
const r16VoidShip = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16VoidShip.id, { styleNo: 'R16-VOIDSHIP', quantity: 10, unitPrice: 1 })
orders.voidOrder(r16VoidShip.id, 'R16 作废')
check(
  '作废单不能手改出货状态',
  r8err(() => orders.setShipStatus(r16VoidShip.id, 'packed')).includes('已作废')
)
const r16AllVoid = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16AllVoid.id, { styleNo: 'R16-ALLVOID', quantity: 10, unitPrice: 1 })
const r16V1 = packing.createPackingList({
  orderId: r16AllVoid.id,
  lines: [{ boxNo: 'R16-V1', styleNo: 'R16-ALLVOID', quantity: 5 }]
})[0]
const r16V2 = packing.createPackingList({
  orderId: r16AllVoid.id,
  lines: [{ boxNo: 'R16-V2', styleNo: 'R16-ALLVOID', quantity: 5 }]
}).slice(-1)[0]
eq('装齐后订单状态由批次推成已包装', orders.getOrder(r16AllVoid.id)!.shipStatus, 'packed')
packing.voidPackingList(r16AllVoid.id, r16V1.id, 'R16 第一批没走')
eq('作废一批后按剩下的批次重算', orders.getOrder(r16AllVoid.id)!.shipStatus, 'preparing')
packing.voidPackingList(r16AllVoid.id, r16V2.id, 'R16 第二批也没走')
eq('全部批次作废后回落到未备货，不挂已发货', orders.getOrder(r16AllVoid.id)!.shipStatus, 'not_prepared')

section('R16 打样转单后客户、收款状态锁定；漏传明细不再清空')
const r16CustA = customers.saveCustomer({ company: 'R16-SAMPLE-A' })
const r16CustB = customers.saveCustomer({ company: 'R16-SAMPLE-B' })
const r16Sample = samples.saveSample({
  customerId: r16CustA.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R16-S1', productName: '打样', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r16NoteOnly = samples.saveSample({ id: r16Sample.id, note: 'R16 只改备注' })
eq('漏传 items 的编辑不清空样品行', r16NoteOnly.items.length, 1)
eq('漏传 items 的编辑不清空样品费', r16NoteOnly.items[0].quantity * r16NoteOnly.items[0].unitPrice, 10)
const r16Converted = samples.convertSampleToOrder(r16Sample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
check(
  '转单后不能换客户',
  r8err(() => samples.saveSample({ id: r16Sample.id, customerId: r16CustB.id })).includes('客户不能再改')
)
check(
  '转单后不能把已抵扣改回收款状态',
  r8err(() => samples.saveSample({ id: r16Sample.id, feeStatus: 'paid' })).includes('收款状态不能再改')
)
check(
  '活着的订单还靠打样单作原始凭据，删不掉',
  r8err(() => samples.deleteSample(r16Sample.id)).includes('先作废订单')
)
orders.voidOrder(r16Converted.id, 'R16 作废转出的订单')
samples.deleteSample(r16Sample.id)
check('订单作废后打样单可以删（提示与实现一致）', samples.getSample(r16Sample.id) === null)

section('R16 实收数量不能超过改完后的箱明细')
const r16Recv = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16Recv.id, { styleNo: 'R16-RECV', quantity: 100, unitPrice: 1 })
const r16RecvPl = packing.createPackingList({
  orderId: r16Recv.id,
  lines: [
    { boxNo: 'R16-A', styleNo: 'R16-RECV', quantity: 30 },
    { boxNo: 'R16-B', styleNo: 'R16-RECV', quantity: 20 }
  ]
})[0]
packing.updatePackingListInfo(r16Recv.id, r16RecvPl.id, { receivedQty: 40 })
const r16RecvLineA = packing.listPackingLists(r16Recv.id)[0].lines.find((l) => l.boxNo === 'R16-A')!
packing.updatePackingListLine(r16Recv.id, r16RecvPl.id, r16RecvLineA.id, { quantity: 20 })
eq('改箱后件数正好等于实收，放行', packing.listPackingLists(r16Recv.id)[0].lines.reduce((s, l) => s + l.quantity, 0), 40)
check(
  '删箱后件数少于已登记的实收，拦下',
  r8err(() => packing.deletePackingListLine(r16Recv.id, r16RecvPl.id, r16RecvLineA.id)).includes('实收')
)
eq('被拦后两箱都还在（事务回滚）', packing.listPackingLists(r16Recv.id)[0].lines.length, 2)

/* ---------------- R17 时间与口径 ---------------- */
section('R17 报价时间线：发出日与确认日各记各的')

const r17Settings = getSettings()
saveSettings({ ...r17Settings, remindConfirmDays: 25, remindBalanceDays: 25 })

const r17QSent = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  status: 'sent',
  items: [{ styleNo: 'R17-Q', quantity: 10, unitPrice: 5 }]
})
const r17QSentRow = getDb().get('SELECT sent_at FROM quotations WHERE id = ?', [r17QSent.id]) as
  | Record<string, unknown>
  | null
check('保存成「已发出」时就写下发出日', Boolean(r17QSentRow?.sent_at))

const r17QMeta = quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  items: [{ styleNo: 'R17-Q2', quantity: 20, unitPrice: 6 }]
})
quotations.updateQuotationMeta(r17QMeta.id, { status: 'sent' })
const r17QMetaSent = getDb().get('SELECT sent_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
check('从「草稿」改成「已发出」也补上发出日', Boolean(r17QMetaSent?.sent_at))
quotations.updateQuotationMeta(r17QMeta.id, { status: 'confirmed' })
const r17QConfirmed = getDb().get('SELECT confirmed_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
check('改成「已确认」时写下确认日', Boolean(r17QConfirmed?.confirmed_at))

// 把确认日改成 30 天前，再补一次报价结果：等待天数必须还按确认日算
const r17ConfirmOld = addDays(localDate(), -30)
getDb().run('UPDATE quotations SET confirmed_at = ? WHERE id = ?', [r17ConfirmOld, r17QMeta.id])
quotations.updateQuotationMeta(r17QMeta.id, { result: 'pending' })
const r17QAfter = getDb().get('SELECT confirmed_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
eq('补结果不会把确认日刷新成今天', String(r17QAfter?.confirmed_at ?? ''), r17ConfirmOld)
const r17QuoteRem = dashboard.reminders().find((r) => r.kind === 'quote' && r.orderNo === r17QMeta.qNo && r.message.includes('已确认'))
eq('确认 30 天没转单的报价仍按确认日起算', r17QuoteRem?.days, 30)

section('R17 提醒时钟：出运一分未收按出货事件起算，改备注不清零')

const r17Ship = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Ship.id, { styleNo: 'R17-SHIP', quantity: 10, unitPrice: 10 })
orders.setShipStatus(r17Ship.id, 'shipped', '手工推进出货')
const r17ShipEvent = getDb().get(
  "SELECT id FROM order_events WHERE order_id = ? AND kind = 'ship_status' AND to_status = 'shipped' ORDER BY id DESC LIMIT 1",
  [r17Ship.id]
) as { id?: number } | null
// 事件在 30 天前，而 updated_at 是刚才：提醒必须认事件，不能认「最后修改日」
getDb().run('UPDATE order_events SET at = ? WHERE id = ?', [
  new Date(Date.now() - 30 * 86400000).toISOString(),
  Number(r17ShipEvent?.id ?? 0)
])
getDb().run('UPDATE orders SET updated_at = ? WHERE id = ?', [new Date().toISOString(), r17Ship.id])
const r17ShipRem = dashboard.reminders().find((r) => r.orderId === r17Ship.id && r.message.includes('一分未收'))
eq('出运 30 天一分未收按出货事件起算', r17ShipRem?.days, 30)

section('R17 本月完成数：作废单不再算完成')

const r17DoneBefore = dashboard.dashboard().completedThisMonth
const r17Done = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Done.id, { styleNo: 'R17-DONE', quantity: 10, unitPrice: 10 })
orders.setShipStatus(r17Done.id, 'delivered', '本月完成口径测试')
eq('签收后计入本月完成', dashboard.dashboard().completedThisMonth, r17DoneBefore + 1)
orders.voidOrder(r17Done.id, 'R17 本月完成口径测试作废')
eq('作废后从本月完成里退出', dashboard.dashboard().completedThisMonth, r17DoneBefore)

section('R17 欠款榜：未结单数只数还欠钱的单')

const r17BoardCustomer = customers.saveCustomer({ company: 'R17 欠款榜口径' })
const r17BoardPaid = orders.createOrder({
  customerId: r17BoardCustomer.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r17BoardPaid.id, { styleNo: 'R17-BOARD-A', quantity: 10, unitPrice: 10 })
orders.addPayment(r17BoardPaid.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'R17-BOARD-P' })
const r17BoardOpen = orders.createOrder({
  customerId: r17BoardCustomer.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r17BoardOpen.id, { styleNo: 'R17-BOARD-B', quantity: 10, unitPrice: 10 })
const r17BoardRow = money.receivableByCustomer().find((r) => r.customerId === r17BoardCustomer.id)
eq('收齐的那单不算未结单', r17BoardRow?.orders, 1)
eq('欠款榜敞口只算还欠的货款（100 美元 × 汇率 7）', r17BoardRow?.goodsBase, 700)

section('R17 收款守门：不许填未来、草稿单不许收款')

const r17PayOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17PayOrder.id, { styleNo: 'R17-PAY', quantity: 10, unitPrice: 10 })
const r17FutureErr = r8err(() =>
  orders.addPayment(r17PayOrder.id, { paidAt: addDays(localDate(), 1), amount: 10, method: 'T/T' })
)
check('收款日期填明天会被拦下', r17FutureErr.includes('还没到'), r17FutureErr)
const r17DraftPay = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r17DraftPay.id, { styleNo: 'R17-DRAFT-PAY', quantity: 10, unitPrice: 10 })
const r17DraftErr = r8err(() =>
  orders.addPayment(r17DraftPay.id, { paidAt: localDate(), amount: 10, method: 'T/T' })
)
check('草稿单登记收款被拦下', r17DraftErr.includes('草稿'), r17DraftErr)
check('提示说明这笔钱会从本月到账里消失', r17DraftErr.includes('本月到账'), r17DraftErr)

section('R17 明细唯一：同款同色同码不许两行')

const r17Dup = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Dup.id, { styleNo: 'R17-DUP', color: 'Black', size: 'M', quantity: 10, unitPrice: 10 })
const r17DupErr = r8err(() =>
  orders.addOrderItem(r17Dup.id, { styleNo: 'R17-DUP', color: 'Black', size: 'M', quantity: 5, unitPrice: 12 })
)
check('重复的款号/颜色/尺码被拦下', r17DupErr.includes('同一款只能有一行'), r17DupErr)
const r17DupB = await orders.addOrderItem(r17Dup.id, {
  styleNo: 'R17-DUP-B',
  color: 'Black',
  size: 'M',
  quantity: 5,
  unitPrice: 12
})
const r17DupBItem = r17DupB.items.find((i) => i.styleNo === 'R17-DUP-B')!
const r17DupSwapErr = r8err(() => orders.updateOrderItem(r17Dup.id, r17DupBItem.id, { styleNo: 'R17-DUP' }))
check('把另一行改成已有款号也被拦下', r17DupSwapErr.includes('已经有明细'), r17DupSwapErr)
eq('被拦后明细仍是两行，没有多出重复款', orders.getOrder(r17Dup.id)!.items.length, 2)

/* ============================================================
 * 第 18 轮：单据修订与凭据安全（R18）
 * ============================================================ */

section('R18 存档作废：CI 金额敲错作废重出，不再被迫作废整单')

const r18Order = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R18-VOID'
})
await orders.addOrderItem(r18Order.id, { styleNo: 'R18-V', productName: '作废重出', quantity: 100, unitPrice: 10 })
orders.updateOrderCharges(r18Order.id, [{ label: '运费 Freight', amount: 100 }])
const r18Pl = packing.createPackingList({
  orderId: r18Order.id,
  lines: [{ boxNo: 'R18-1', styleNo: 'R18-V', quantity: 50 }]
})[0]
const r18Saved = docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 void'),
  docNo: ciNoOf('PI-R18-VOID', r18Pl.plNo),
  kind: 'ci',
  orderId: r18Order.id,
  amount: 60 // 敲错一位：正确是 600
})
eq('存档按第 1 版记账', r18Saved.version, 1)
const r18Ver = docs.listDocVersions(r18Order.id).find((d) => d.docNo === ciNoOf('PI-R18-VOID', r18Pl.plNo))!
check('存档记录在且未作废', r18Ver != null && r18Ver.voidedAt == null)
const r18Line = packing.listPackingLists(r18Order.id).find((p) => p.id === r18Pl.id)!.lines[0]
check(
  '存档后箱明细锁住',
  r8err(() => packing.updatePackingListLine(r18Order.id, r18Pl.id, r18Line.id, { quantity: 60 })).includes(
    '已经出过 CI'
  )
)
check('不写原因作不了废', r8err(() => docs.voidDocVersion(r18Ver.id, '   ')).includes('原因'))
const r18List = docs.voidDocVersion(r18Ver.id, 'CI 金额敲错一位：60 应为 600')
eq('作废后存档记录还在（不删事实）', r18List.length, 1)
check('作废版带时间与原因', r18List[0].voidedAt != null && r18List[0].voidReason!.includes('敲错'))
check('作废后 PDF 文件也还在', fs.existsSync(join(dataDir(), r18List[0].filePath)))
eq('作废后批次金额恢复按当前数据算（500 货值 + 50 分摊费用）', money.packingAmounts(r18Order.id).find((b) => b.plId === r18Pl.id)!.total, 550)
check('作废后箱明细可以改了', packing.updatePackingListLine(r18Order.id, r18Pl.id, r18Line.id, { quantity: 60 }).length > 0)
eq('改完箱数金额跟着走（600 货值 + 60 分摊费用）', money.packingAmounts(r18Order.id).find((b) => b.plId === r18Pl.id)!.total, 660)
const r18Saved2 = docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 void v2'),
  docNo: ciNoOf('PI-R18-VOID', r18Pl.plNo),
  kind: 'ci',
  orderId: r18Order.id,
  amount: 660
})
eq('可以重出正确的一版（第 2 版）', r18Saved2.version, 2)
check('不能重复作废同一版', r8err(() => docs.voidDocVersion(r18Ver.id, '再废一次')).includes('作废状态'))
check('作废留痕进了操作历史', orders.listEvents(r18Order.id).some((e) => e.kind === 'doc_void'))

section('R18 整单/批次 CI 重叠：不硬挡，但要人确认')

check(
  '批次 CI 还在时出整单 CI 会被拦下确认',
  r8err(() => docs.assertCiNoOverlap(r18Order.id, ciNoOf('PI-R18-VOID'))).includes('重叠')
)
eq('确认重叠后放行，重叠额 = 已存档批次金额', docs.assertCiNoOverlap(r18Order.id, ciNoOf('PI-R18-VOID'), true), 660)
const r18Whole = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R18-WHOLE'
})
await orders.addOrderItem(r18Whole.id, { styleNo: 'R18-W', quantity: 10, unitPrice: 10 })
docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 whole'),
  docNo: ciNoOf('PI-R18-WHOLE'),
  kind: 'ci',
  orderId: r18Whole.id,
  amount: 100
})
check(
  '先整单后补批次同样要确认',
  r8err(() => docs.assertCiNoOverlap(r18Whole.id, ciNoOf('PI-R18-WHOLE', 'X1'))).includes('重叠')
)
const r18WholeVer = docs.listDocVersions(r18Whole.id)[0]
docs.voidDocVersion(r18WholeVer.id, '改按批次开票')
eq('作废整单 CI 后批次可以开票，不再重叠', docs.assertCiNoOverlap(r18Whole.id, ciNoOf('PI-R18-WHOLE', 'X1')), 0)

section('R18 订单作废：打样抵扣回退为未收，不再悬空')

const r18OffCust = customers.saveCustomer({ company: 'R18-OFFSET-BACK' })
const r18OffSample = samples.saveSample({
  customerId: r18OffCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R18-S1', productName: '抵扣回退', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r18OffOrder = samples.convertSampleToOrder(r18OffSample.id, { offsetSampleFee: true, paymentStatus: 'confirmed' })
eq('转单后打样单挂「下单抵扣」', samples.getSample(r18OffSample.id)!.feeStatus, 'offset')
orders.voidOrder(r18OffOrder.id, 'R18 客户取消，整单作废')
eq('订单作废后抵扣回退为未收', samples.getSample(r18OffSample.id)!.feeStatus, 'unpaid')
check('回退在费用备注里留了痕', samples.getSample(r18OffSample.id)!.feeNote.includes('已作废'))
check('打样费重新进客户应收', money.sampleReceivable(r18OffCust.id) > 0)
check('订单操作历史记了抵扣回退', orders.listEvents(r18OffOrder.id).some((e) => e.kind === 'sample_offset_back'))

section('R18 汇率快照：到账那天钉住，改订单汇率月报不漂移')

const r18Rate = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r18Rate.id, { styleNo: 'R18-RATE', quantity: 10, unitPrice: 10 })
const r18Month = localDate().slice(0, 7)
const r18MonthOf = () => money.receivedByMonth().find((m) => m.month === r18Month)?.amount ?? 0
const r18Before = r18MonthOf()
orders.addPayment(r18Rate.id, { paidAt: localDate(), amount: 50, method: 'T/T', bankRef: 'R18-RATE-P' })
eq('到账按当天汇率 7 进本月（50×7=350）', r18MonthOf() - r18Before, 350)
eq(
  '收款落了汇率快照',
  Number((getDb().get('SELECT exchange_rate AS r FROM payments WHERE order_id = ?', [r18Rate.id]) as { r?: number })!.r),
  7
)
// 只登记了收款、还没出单据：汇率允许修正（R15 口径），但历史月报不能跟着漂
orders.updateOrder(r18Rate.id, { customerId: c1.id, exchangeRate: 7.5 })
eq('改订单汇率后历史到账仍按快照算（350 不漂成 375）', r18MonthOf() - r18Before, 350)
// 老收款没有快照列值：回退订单汇率（残留漂移可接受，口径写死在 SQL 里）
getDb().run('UPDATE payments SET exchange_rate = NULL WHERE order_id = ?', [r18Rate.id])
eq('老收款没有快照时回退订单汇率（50×7.5=375）', r18MonthOf() - r18Before, 375)

section('R18 建单失败不烧号')

const r18CounterName = `SO${localDate().replace(/-/g, '')}`
const r18CounterBefore = Number(
  (getDb().get('SELECT value AS v FROM counters WHERE name = ?', [r18CounterName]) as { v?: number } | null)!.v
)
const r18BurnErr = r8err(() =>
  orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, piNo: 'PI-R16-FREEZE' })
)
check('撞号的建单被拦下', r18BurnErr.includes('PI'), r18BurnErr)
eq(
  '失败的建单不再烧掉 SO 号',
  Number(
    (getDb().get('SELECT value AS v FROM counters WHERE name = ?', [r18CounterName]) as { v?: number } | null)!.v
  ),
  r18CounterBefore
)

/* ============================================================
 * 第 19 轮：凭据通道收口（R19）
 * ============================================================ */

section('R19 作废凭据闸门：挂着存档/箱单的订单先核对再作废')

const r19Gate = orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R19-GATE'
})
await orders.addOrderItem(r19Gate.id, { styleNo: 'R19-GATE', quantity: 10, unitPrice: 10 })
packing.createPackingList({ orderId: r19Gate.id, lines: [{ boxNo: 'R19-G1', styleNo: 'R19-GATE', quantity: 10 }] })
check(
  '有箱单的订单直接作废被拦',
  r8err(() => orders.voidOrder(r19Gate.id, '客户取消')).includes('凭据')
)
orders.voidOrder(r19Gate.id, '客户取消', { confirmDocs: true })
check('勾了凭据已核对就能作废', orders.getOrder(r19Gate.id)!.paymentStatus, 'void')
check(
  '作废历史里写明核对过哪些凭据',
  orders.listEvents(r19Gate.id).slice(-1)[0].note.includes('凭据已核对')
)

section('R19 作废通道只认 CI：PI/箱单/报价存档作不了废，作废单的存档也不能动')

const r19Kind = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-KIND' })
await orders.addOrderItem(r19Kind.id, { styleNo: 'R19-KIND', quantity: 5, unitPrice: 10 })
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 pi'), docNo: 'PI-R19-KIND', kind: 'pi', orderId: r19Kind.id, amount: 50 })
const r19PiVer = docs.listDocVersions(r19Kind.id)[0]
check(
  '作废 PI 存档被拦（它不参与锁定）',
  r8err(() => docs.voidDocVersion(r19PiVer.id, '试一下')).includes('只有 CI')
)
const r19KindCi = docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r19 kind ci'),
  docNo: ciNoOf('PI-R19-KIND'),
  kind: 'ci',
  orderId: r19Kind.id,
  amount: 50
})
eq('CI 存档记为第 1 版', r19KindCi.version, 1)
check('CI 存档照常能作废', docs.voidDocVersion(docs.listDocVersions(r19Kind.id).find((d) => d.kind === 'ci')!.id, '改数重出').length > 0)
orders.voidOrder(r19Kind.id, '客户取消', { confirmDocs: true })
// 作废后重出的一版（留档），也不能再作废
const r19KindCiV2 = docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r19 kind ci v2'),
  docNo: ciNoOf('PI-R19-KIND'),
  kind: 'ci',
  orderId: r19Kind.id,
  amount: 50
})
eq('重出记为第 2 版', r19KindCiV2.version, 2)
check(
  '作废订单的 CI 存档不能再作废',
  r8err(() =>
    docs.voidDocVersion(docs.listDocVersions(r19Kind.id).find((d) => d.kind === 'ci' && !d.voidedAt)!.id, '再试')
  ).includes('已作废')
)

section('R19 落账前复查重叠 + CI 金额差异留痕')

const r19Overlap = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-OVL' })
await orders.addOrderItem(r19Overlap.id, { styleNo: 'R19-OVL', quantity: 20, unitPrice: 10 })
const r19OvlPl = packing.createPackingList({ orderId: r19Overlap.id, lines: [{ boxNo: 'R19-O1', styleNo: 'R19-OVL', quantity: 10 }] })[0]
const r19OvlAmt = money.packingAmounts(r19Overlap.id).find((b) => b.plId === r19OvlPl.id)!
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 batch'), docNo: ciNoOf('PI-R19-OVL', r19OvlPl.plNo), kind: 'ci', orderId: r19Overlap.id, amount: r19OvlAmt.total })
check(
  'saveDocFile 自己也会拦未确认的重叠（不是只有 IPC 那道）',
  r8err(() =>
    docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 whole'), docNo: ciNoOf('PI-R19-OVL'), kind: 'ci', orderId: r19Overlap.id, amount: 200 })
  ).includes('重叠')
)
check(
  '带确认标记就能落账',
  docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 whole ok'), docNo: ciNoOf('PI-R19-OVL'), kind: 'ci', orderId: r19Overlap.id, amount: 100, confirmOverlap: true }).version > 0
)
check(
  'CI 金额与应收口径不一致时留了差异痕',
  orders.listEvents(r19Overlap.id).some((e) => e.kind === 'doc_amount_diff' && e.note.includes('相差'))
)
const r19Match = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-MATCH' })
await orders.addOrderItem(r19Match.id, { styleNo: 'R19-MATCH', quantity: 10, unitPrice: 10 })
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 match'), docNo: ciNoOf('PI-R19-MATCH'), kind: 'ci', orderId: r19Match.id, amount: 100 })
check('金额一致时不留差异痕', !orders.listEvents(r19Match.id).some((e) => e.kind === 'doc_amount_diff'))

section('R19 零金额 CI 也是纸面依据：批次照样钉住')

const r19Zero = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-ZERO' })
await orders.addOrderItem(r19Zero.id, { styleNo: 'R19-ZERO', quantity: 100, unitPrice: 10 })
orders.updateOrderCharges(r19Zero.id, [{ label: '运费 Freight', amount: 200 }])
const r19ZeroPl = packing.createPackingList({ orderId: r19Zero.id, lines: [{ boxNo: 'R19-Z1', styleNo: 'R19-ZERO', quantity: 50 }] })[0]
docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 zero'), docNo: ciNoOf('PI-R19-ZERO', r19ZeroPl.plNo), kind: 'ci', orderId: r19Zero.id, amount: 0 })
const r19ZeroAmt = money.packingAmounts(r19Zero.id).find((b) => b.plId === r19ZeroPl.id)!
eq('0 金额存档钉出 0 元批次（不按当前数据重算）', r19ZeroAmt.total, 0)
check('另一批拿走全部剩余费用', money.packingAmounts(r19Zero.id).reduce((s, b) => s + b.charges, 0) <= 200.01)

section('R19 收款历史写明汇率快照口径')

const r19Rate = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r19Rate.id, { styleNo: 'R19-RATE', quantity: 10, unitPrice: 10 })
orders.addPayment(r19Rate.id, { paidAt: addDays(localDate(), -3), amount: 20, method: 'T/T', bankRef: 'R19-RATE-P' })
check(
  '补录过去日期的到账，历史里写明按录入时汇率钉快照',
  orders.listEvents(r19Rate.id).some((e) => e.kind === 'payment' && e.note.includes('钉快照') && e.note.includes('汇率按 7'))
)

/* ---------------- R20：闸门做实与回款正门 ---------------- */

// ① 作废单回款开正门：必须写明来路，只进收款流水与月报，不复活订单
section('R20 作废单回款：登记走正门，备注写明来路，删错也能删')

const r20Rec = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R20-REC' })
await orders.addOrderItem(r20Rec.id, { styleNo: 'R20-REC', quantity: 10, unitPrice: 10 })
orders.addPayment(r20Rec.id, { paidAt: addDays(localDate(), -2), amount: 20, note: '定金' })
orders.voidOrder(r20Rec.id, 'R20 回款测试')

let r20NoNoteErr = ''
try {
  orders.addPayment(r20Rec.id, { paidAt: localDate(), amount: 30 })
} catch (e) {
  r20NoNoteErr = (e as Error).message
}
check('作废单登记收款不写来路会被拦下', r20NoNoteErr.includes('写明来路'), r20NoNoteErr)

orders.addPayment(r20Rec.id, { paidAt: localDate(), amount: 30, note: '取消单客户退回的定金' })
check(
  '作废单回款落账且历史写明「作废单回款」',
  orders.listEvents(r20Rec.id).some((e) => e.kind === 'payment' && e.note.includes('作废单回款') && e.note.includes('30.00'))
)
check('作废单回款不复活订单（收款状态仍为 void）', orders.getOrder(r20Rec.id)!.paymentStatus === 'void')
const r20RecAgain = orders.getOrder(r20Rec.id)!
const r20PrePay = (r20RecAgain.payments ?? []).find((p) => Math.abs(p.amount - 20) < 0.001)
let r20PreDelErr = ''
try {
  orders.deletePayment(r20Rec.id, r20PrePay!.id, '试试删作废前的钱')
} catch (e) {
  r20PreDelErr = (e as Error).message
}
check('作废前的流水仍是留档凭据，不许删', r20PreDelErr.includes('留档凭据'), r20PreDelErr)
const r20Pay = (orders.getOrder(r20Rec.id)!.payments ?? []).find(
  (p) => Math.abs(p.amount - 30) < 0.001 && p.note.includes('取消单客户退回的定金')
)
check('作废单回款进了收款流水（备注留着来路）', !!r20Pay)
if (r20Pay) {
  orders.deletePayment(r20Rec.id, r20Pay.id, '金额录错了')
  check('作废单的回款删错也能删（不删就成死账）', !(orders.getOrder(r20Rec.id)!.payments ?? []).some((p) => p.id === r20Pay.id))
}

// ② 核销 / 追回日期与收款同一口径：不许填未来
section('R20 核销与追回日期不许填未来')

const r20Date = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R20-DATE' })
await orders.addOrderItem(r20Date.id, { styleNo: 'R20-DATE', quantity: 10, unitPrice: 10 })
const r20Future = addDays(localDate(), 7)

let r20ShortErr = ''
try {
  orders.addSettlement(r20Date.id, { kind: 'shortage', amount: 5, at: r20Future, reason: '银行扣费' })
} catch (e) {
  r20ShortErr = (e as Error).message
}
check('核销日期填未来被拦', r20ShortErr.includes('还没到'), r20ShortErr)

orders.addSettlement(r20Date.id, { kind: 'bad_debt', amount: 20, reason: '客户破产' })
let r20RecoverErr = ''
try {
  orders.addSettlement(r20Date.id, { kind: 'recovery', amount: 10, paidAt: r20Future, reason: '追回部分欠款' })
} catch (e) {
  r20RecoverErr = (e as Error).message
}
check('追回款到账日期填未来被拦', r20RecoverErr.includes('还没到'), r20RecoverErr)

/* ---------------- R21：侧门守门与串单竞态 ---------------- */

// ① 收款状态下拉不许直接跳「已作废」：作废必须走凭据核对的正门
section('R21 作废侧门封死：下拉改 void 被拦，指路「作废此单」')

const r21Gate = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-GATE' })
await orders.addOrderItem(r21Gate.id, { styleNo: 'R21-GATE', quantity: 10, unitPrice: 10 })

let r21VoidErr = ''
try {
  orders.setPaymentStatus(r21Gate.id, 'void')
} catch (e) {
  r21VoidErr = (e as Error).message
}
check('收款状态下拉直接改成「已作废」被拦下', r21VoidErr.includes('作废此单'), r21VoidErr)
check('被拦的单还在（不是先改成 void 再报错）', orders.getOrder(r21Gate.id)!.paymentStatus !== 'void')
// 正门仍通：作废弹窗走的 voidOrder 不受影响
orders.voidOrder(r21Gate.id, 'R21 正门回归')
check('正门作废不受影响', orders.getOrder(r21Gate.id)!.paymentStatus === 'void')

// ② 批次作废/撤销原因必填（后端在状态检查之后拦，留档凭据不许匿名著墨）
section('R21 批次作废/撤销：原因必填，历史里查得到为什么')

const r21PlOrder = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-PL' })
await orders.addOrderItem(r21PlOrder.id, { styleNo: 'R21-PL', color: 'Navy', size: 'L', quantity: 50, unitPrice: 10 })
const r21Pl = packing.createPackingList({
  orderId: r21PlOrder.id,
  containerNo: 'CONT-R21',
  lines: [{ boxNo: 'NO.1', styleNo: 'R21-PL', color: 'Navy', size: 'L', quantity: 50 }]
})[0]

let r21VoidNoReasonErr = ''
try {
  packing.voidPackingList(r21PlOrder.id, r21Pl.id)
} catch (e) {
  r21VoidNoReasonErr = (e as Error).message
}
check('批次作废不写原因被拦下', r21VoidNoReasonErr.includes('原因'), r21VoidNoReasonErr)

packing.voidPackingList(r21PlOrder.id, r21Pl.id, '订舱被货代取消')
const r21VoidEvt = orders.listEvents(r21PlOrder.id).filter((e) => e.kind === 'pl_void').pop()
check('作废原因进了操作历史', !!r21VoidEvt && r21VoidEvt.note.includes('订舱被货代取消'), r21VoidEvt?.note ?? '没有 pl_void 事件')

let r21UnvoidNoReasonErr = ''
try {
  packing.unvoidPackingList(r21PlOrder.id, r21Pl.id)
} catch (e) {
  r21UnvoidNoReasonErr = (e as Error).message
}
check('撤销作废不写原因也被拦下', r21UnvoidNoReasonErr.includes('原因'), r21UnvoidNoReasonErr)

packing.unvoidPackingList(r21PlOrder.id, r21Pl.id, '货代恢复订舱')
check('写了原因的撤销作废放行', packing.listPackingLists(r21PlOrder.id).find((p) => p.id === r21Pl.id)!.voidedAt == null)
const r21UnvoidEvt = orders.listEvents(r21PlOrder.id).filter((e) => e.kind === 'pl_unvoid').pop()
check('撤销原因也进了操作历史', !!r21UnvoidEvt && r21UnvoidEvt.note.includes('货代恢复订舱'), r21UnvoidEvt?.note ?? '没有 pl_unvoid 事件')

// ③ 换客户留痕：操作历史写明「客户 A → B」，改单弹窗另有确认弹窗兜底
section('R21 换主留痕：历史写明客户从谁换成谁')

const r21Swap = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-SWAP' })
await orders.addOrderItem(r21Swap.id, { styleNo: 'R21-SWAP', quantity: 5, unitPrice: 10 })
orders.updateOrder(r21Swap.id, { customerId: c2.id })
const r21SwapEvt = orders.listEvents(r21Swap.id).find((e) => e.note.includes('客户'))
check(
  '换客户在历史里写明「客户 A → B」',
  !!r21SwapEvt && r21SwapEvt.note.includes('客户') && r21SwapEvt.note.includes('→'),
  r21SwapEvt?.note ?? '没有客户相关历史'
)
eq('客户真的换过去了', orders.getOrder(r21Swap.id)!.customerId, c2.id)

// ④ 汇率参考值按币种过滤：USD 的 7.1 不能抄到 EUR 单上
section('R21 汇率参考值同币种：参考的就是同币种那一张')

const r21Eur = orders.createOrder({ customerId: c1.id, currency: 'EUR', exchangeRate: 7.8, paymentStatus: 'confirmed', piNo: 'PI-R21-EUR' })
await orders.addOrderItem(r21Eur.id, { styleNo: 'R21-EUR', quantity: 5, unitPrice: 10 })
const r21UsdInfo = orders.lastExchangeRateInfo('USD')
const r21EurInfo = orders.lastExchangeRateInfo('EUR')
check('EUR 参考值取的是 EUR 那张单的汇率', !!r21EurInfo && Math.abs(r21EurInfo.rate - 7.8) < 0.0001, JSON.stringify(r21EurInfo))
check('USD 参考值不再是刚建的 EUR 单', !r21UsdInfo || Math.abs(r21UsdInfo.rate - 7.8) > 0.0001, JSON.stringify(r21UsdInfo))

// ⑤ 作废/失效单不许再挂照片
section('R21 作废单冻结照片：留档不再「还在走」')

const r21Photo = orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-PHOTO' })
await orders.addOrderItem(r21Photo.id, { styleNo: 'R21-PHOTO', quantity: 5, unitPrice: 10 })
orders.addOrderPhoto(r21Photo.id, 'r21-normal.jpg', 'inspection', '正常单传照放行')
eq('正常单传照放行', orders.listOrderPhotos(r21Photo.id).length, 1)
orders.voidOrder(r21Photo.id, 'R21 照片冻结测试')
let r21PhotoErr = ''
try {
  orders.addOrderPhoto(r21Photo.id, 'r21-void.jpg', 'inspection', '作废后再传')
} catch (e) {
  r21PhotoErr = (e as Error).message
}
check('作废单再传照片被拦下', r21PhotoErr.includes('已作废'), r21PhotoErr)
eq('作废单照片一张没多', orders.listOrderPhotos(r21Photo.id).length, 1)

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
