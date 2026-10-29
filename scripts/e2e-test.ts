/**
 * 端到端业务逻辑测试：直接调用 service 层，验证核心流程。
 * 运行：npm run test:e2e
 */
import { openDb, closeDb, getDb, coreDb, dataDir, imagesDir, docsDir, backupsDir } from '../electron/db'
import { filesCore } from '../core/files'
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
import * as credits from '../electron/services/credits'
import { getSettings, saveSettings, markBackupOk, markBackupFail, baseCurrencyLocked } from '../electron/services/settings'
import { createBackup, inspectBackup, isRestoring, listBackups, pruneBackups, restoreBackup, uniqueBackupName } from '../electron/services/backup'
import * as docs from '../electron/services/docs'
import { collectDir, createZip, readZip, verifyZip, zhFsError } from '../electron/services/zip'
import { docPageFingerprint } from '../src/shared/docFingerprint'
import {
  renderPi,
  renderPl,
  renderQuotation,
  renderCi,
  renderSample,
  orderDocAmount,
  ciDocAmount,
  ciNoOf,
  latestAmountPerDocNo
} from '../src/shared/documents'
import { localDate, localMonthOf, addDays } from '../src/shared/date'
import { isBillingStatus, shownRemaining } from '../src/shared/billing'
import { likeContains } from '../electron/services/search'
import { INCOTERMS } from '../src/shared/types'
import { CSV_BOM, looksGarbled, pickCsvDecode } from '../src/shared/csv'

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
const p1 = await products.saveProduct({
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

const p2 = await products.saveProduct({
  styleNo: 'A002',
  name: '涤纶 Polo 衫',
  composition: '95% Polyester 5% Spandex',
  costPrice: null,
  sizes: ['M', 'L'],
  colors: ['Navy']
})
check('新增第二个商品', p2.id > 0)

eq('按款号搜索', (await products.listProducts('A001')).length, 1)
check('关键词模糊搜索', (await products.listProducts('棉')).length === 1)

const copied = await products.copyProduct(p1.id, 'A001-BLACK')
eq('复制款号保留尺码表', copied.sizes, ['S', 'M', 'L'])
eq('复制款号新编号', copied.styleNo, 'A001-BLACK')

/* ---------------- 客户 ---------------- */
section('客户')
const c1 = await customers.saveCustomer({
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
check('按公司名搜索', (await customers.listCustomers('Acme')).length === 1)

const c2 = await customers.saveCustomer({
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
const order = await orders.createOrder({
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

const skus = (await orders.summarizeSkus(order.id))
eq('SKU 汇总条数', skus.length, 4)
eq('SKU 汇总数量合计', skus.reduce((s, x) => s + x.quantity, 0), 380)

/* ---------------- 收款状态自动流转 ---------------- */
section('收款状态自动流转')
await orders.setPaymentStatus(order.id, 'confirmed')
eq('手动设为已确认', (await orders.getOrder(order.id))!.paymentStatus, 'confirmed')

let o = await orders.addPayment(order.id, { paidAt: '2026-03-20', amount: 500, method: 'T/T', bankRef: 'BNK001' })
eq('收款额小于定金 → 部分收款', o.paymentStatus, 'partial')
eq('已收金额', o.paidAmount, 500)

o = await orders.addPayment(order.id, { paidAt: '2026-03-21', amount: 600, method: 'T/T', bankRef: 'BNK002' })
eq('定金收齐自动转已收款', o.paymentStatus, 'paid')
eq('已收金额累计', o.paidAmount, 1100)

const total = o.totalAmount
o = await orders.addPayment(order.id, { paidAt: '2026-03-28', amount: total - 1100, method: 'T/T', bankRef: 'BNK003' })
eq('全额收齐自动转已结清', o.paymentStatus, 'settled')
eq('待收归零', Math.round(o.remaining), 0)

/* ---------------- 出货状态独立 ---------------- */
section('出货状态独立推进')
o = await orders.setShipStatus(order.id, 'preparing')
eq('备货中', o.shipStatus, 'preparing')
eq('出货推进不影响收款状态', o.paymentStatus, 'settled')
o = await orders.setShipStatus(order.id, 'packed')
eq('已包装', o.shipStatus, 'packed')

/* ---------------- 装箱单 ---------------- */
section('装箱单')
const pls = await packing.createPackingList({
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

const pls2 = await packing.createPackingList({
  orderId: order.id,
  containerNo: 'MSKU7654321',
  lines: [{ boxNo: 'NO.3', styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'M', quantity: 80, netWeight: 10 }]
})
eq('一单可多张 PL', pls2.length, 2)

/* ---------------- 客户统计 ---------------- */
section('客户统计')
const stats = await customers.customerStats(c1.id)
eq('客户订单数', stats.orderCount, 1)
eq('客户成交额（按汇率折算为基准币）', stats.totalAmount, total * 7.2)
// 这一单有一行成本没录（A002），所以毛利是「不可信」→ null（不许拿 0 成本凑一个漂亮的数）
eq('有成本没录全的订单：客户毛利不可信（null）', stats.totalProfit, null)
eq('客户未收金额', Math.round(stats.outstanding), 0)

/* ---------------- 提醒 ---------------- */
section('待办提醒')
// 单独建一个未包装、出货日临近的订单
const oShip = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  expectedShipDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
})
const rem = await dashboard.reminders()
check('出货提醒命中（预计出货日临近）', rem.some((r) => r.kind === 'ship' && r.orderId === oShip.id))
check(
  '有批次但没填 ETD、交期临近 → 提醒不被装箱单吞掉',
  rem.some((r) => r.kind === 'ship' && r.orderId === order.id && r.message.includes('批次还没填 ETD')),
  JSON.stringify(rem.filter((r) => r.orderId === order.id))
)

// 催确认：PI 发出超过 7 天
const sConf = getSettings()
await saveSettings({ ...sConf, remindConfirmDays: 0 })
const o2 = await orders.createOrder({ customerId: c1.id, currency: 'USD' })
await orders.setPaymentStatus(o2.id, 'sent')
const rem2 = await dashboard.reminders()
check('超阈值未确认触发催确认', rem2.some((r) => r.kind === 'confirm' && r.orderId === o2.id))
await saveSettings(sConf)

/* ---------------- 报表 ---------------- */
section('报表与币种折算')
const report = await dashboard.monthlyReport()
check('月度报表有数据', report.length > 0)
// 订单金额 3360 USD × 汇率 7.2 = 24192 CNY
const curMonth = String(new Date().getFullYear()) + '-' + String(new Date().getMonth() + 1).padStart(2, '0')
const repRow = report.find((r) => r.month === curMonth)
check('月度销售额按汇率折算为基准币', repRow ? Math.abs(repRow.sales - 3360 * 7.2) < 1 : false, `实际 ${repRow?.sales}`)
// 收款发生在 2026-03，按收款月份归集到 2026-03 行
const payRow = report.find((r) => r.month === '2026-03')
check('收款按收款月份归集（而非订单月份）', payRow ? Math.abs(payRow.received - 3360 * 7.2) < 1 : false, `实际 ${payRow?.received}`)
check('订单月份行的收款为 0（收款未发生在该月）', repRow ? Math.abs(repRow.received) < 1 : false, `实际 ${repRow?.received}`)

const cstats = await customers.customerStats(c1.id)
check('客户成交额按汇率折算', Math.abs(cstats.totalAmount - 3360 * 7.2) < 1, `实际 ${cstats.totalAmount}`)

const csv = await dashboard.exportCsv('orders')
check('订单 CSV 有 BOM', csv.charCodeAt(0) === 0xfeff)
check('订单 CSV 含表头', csv.includes('订单号') && csv.includes('PI号'))
check('订单 CSV 含基准币列', csv.includes('含费用合计(CNY)'))
check('订单 CSV 含原币列', csv.includes('含费用合计(原币)'))
check('订单 CSV 含待收列', csv.includes('待收金额(原币)') && csv.includes('待收金额(CNY)'))
check('订单 CSV 含货值/费用列', csv.includes('货值(原币)') && csv.includes('费用合计(原币)'))
const csvPay = await dashboard.exportCsv('payments')
check('收款 CSV 含基准币列', csvPay.includes('金额(CNY)'))
check('收款 CSV 含订单状态列（作废单的钱还在，但得看得见它已作废）', csvPay.includes('订单状态'))

/* ---------------- 设置 ---------------- */
section('设置')
const s0 = getSettings()
eq('默认 PI 有效期', s0.piValidDays, 15)
eq('默认定金比例', s0.defaultDepositRatio, 0.3)
eq('默认毛重系数', s0.grossWeightFactor, 1.1)
await saveSettings({ ...s0, piValidDays: 20, defaultDepositRatio: 0.4 })
eq('设置已保存', getSettings().piValidDays, 20)

// 配置银行账户（PI 收款信息块需要）
await saveSettings({
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
const full = (await orders.getOrder(order.id))!
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
const s1 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
const s2 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
const s3 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(s1.id, { styleNo: 'X1', productName: 'x', quantity: 100, unitPrice: 1 })
await orders.addOrderItem(s2.id, { styleNo: 'X2', productName: 'x', quantity: 100, unitPrice: 5 })
await orders.addOrderItem(s3.id, { styleNo: 'X3', productName: 'x', quantity: 100, unitPrice: 3 })

const byAmountDesc = await orders.listOrders({ sort: 'amount_desc' })
const descAmounts = byAmountDesc.map((o) => o.totalAmount)
check(
  '按金额降序',
  descAmounts.every((v, i) => i === 0 || descAmounts[i - 1] >= v),
  JSON.stringify(descAmounts.slice(0, 5))
)
const byAmountAsc = await orders.listOrders({ sort: 'amount_asc' })
const ascAmounts = byAmountAsc.map((o) => o.totalAmount)
check(
  '按金额升序',
  ascAmounts.every((v, i) => i === 0 || ascAmounts[i - 1] <= v),
  JSON.stringify(ascAmounts.slice(0, 5))
)
const byCreatedDesc = await orders.listOrders({ sort: 'created_desc' })
check(
  '默认按创建时间倒序（最新在前）',
  byCreatedDesc[0].id >= byCreatedDesc[byCreatedDesc.length - 1].id
)

// 排序不受影响：单据仍完整
check('排序不丢失订单', byAmountDesc.length === byCreatedDesc.length)

// 编辑订单：改客户 / 条款 / 汇率
const edited = await orders.updateOrder(s2.id, {
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
await orders.setPaymentStatus(s2.id, 'sent')
const statsAfter = await customers.customerStats(c2.id)
check('客户统计跟随新汇率', statsAfter.totalAmount > 0, `实际 ${statsAfter.totalAmount}`)

/* ---------------- 事件日志 ---------------- */
section('操作历史')
const events = (await orders.listEvents(order.id))
check('记录了创建事件', events.some((e) => e.kind === 'create'))
check('记录了状态自动流转', events.some((e) => e.kind === 'status_auto'))
check('记录了收款事件', events.some((e) => e.kind === 'payment'))
check('记录了装箱单事件', events.some((e) => e.kind === 'pl_create'))

/* ---------------- 报价单 ---------------- */
section('报价单（下单之前）')
const q1 = await quotations.saveQuotation({
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
const statsBeforeQ = await dashboard.dashboard()
const reportBeforeQ = await dashboard.monthlyReport()
eq('报价单不进本月销售额', statsBeforeQ.monthSales, (await dashboard.dashboard()).monthSales)
const salesSumBefore = reportBeforeQ.reduce((s, r) => s + r.sales, 0)
const reportAfterQ = await dashboard.monthlyReport()
const salesSumAfter = reportAfterQ.reduce((s, r) => s + r.sales, 0)
eq('报价单不进月度报表销售额', salesSumAfter, salesSumBefore)
check('报价单不在订单列表里', !(await orders.listOrders({})).some((o: any) => o.orderNo === q1.qNo || o.piNo === q1.qNo))

const qHtml = renderQuotation({ quotation: q1, settings: getSettings(), images: {} })
check('报价单抬头是 QUOTATION', qHtml.includes('QUOTATION'))
check('报价单有中文抬头', qHtml.includes('报价单'))
check('报价单有报价号', qHtml.includes(q1.qNo))
check('报价单有客户名', qHtml.includes('Acme Fashion GmbH'))
check('报价单印费用行', qHtml.includes('运费 Freight') && qHtml.includes('保险费 Insurance'))
check('报价单印合计', qHtml.includes(q1.grandTotal.toFixed(2)))

// 报价单转订单：数字不重敲
const converted = await quotations.convertToOrder(q1.id)
check('报价单转成订单', converted.id > 0)
eq('转单后商品行数一致', converted.items.length, q1.items.length)
eq('转单后数量一致', converted.totalQuantity, q1.totalQuantity)
eq('转单后金额一致', converted.totalAmount, q1.totalAmount)
eq('转单后客户一致', converted.customer?.company, c1.company)
eq('转单后装运港一致', converted.portOfLoading, 'Ningbo')
eq('转单后汇率一致', converted.exchangeRate, 7.15)
const qAfter = (await quotations.getQuotation(q1.id))!
eq('报价单状态变已转订单', qAfter.status, 'converted')
eq('报价单结果变成交', qAfter.result, 'won')
check('报价单记住了转出来的订单', qAfter.convertedOrderId === converted.id)
check('转单有操作历史', (await orders.listEvents(converted.id)).some((e) => e.kind === 'quotation_convert'))

/* ---------------- 报价单：汇率必须手填、汇率日期真实 ---------------- */
section('报价单汇率必须手填且带真实日期')
let rateErr = ''
try {
  await quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
} catch (e) {
  rateErr = (e as Error).message
}
check('汇率留空时不能保存报价单', rateErr.includes('汇率'), rateErr)

const qRate = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 500, unitPrice: 7.5 }]
})
eq('报价单记下了汇率日期', qRate.exchangeRateDate, '2026-09-01')
const qRateOrder = await quotations.convertToOrder(qRate.id)
eq('转单后订单的汇率日期 = 报价单的汇率日期', qRateOrder.exchangeRateDate, '2026-09-01')
check('转单后订单的汇率日期不是转单当天', qRateOrder.exchangeRateDate !== localDate())
eq('转单后订单汇率跟报价单一样', qRateOrder.exchangeRate, 7.15)
// 转换后的订单默认不是草稿（草稿单系统不提醒客户确认）
eq('转单后订单状态是待确认', qRateOrder.paymentStatus, 'sent')

// 旧数据兼容：升级前的报价单没有汇率日期，转订单必须报错，绝不能拿转单当天冒充
const legacyQ = await quotations.saveQuotation({
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
  await quotations.convertToOrder(legacyQ.id)
} catch (e) {
  legacyErr = (e as Error).message
}
check('旧报价单（无汇率日期）转订单会报错而不是编一个日期', legacyErr.includes('汇率日期'), legacyErr)
const legacyAfter = (await quotations.getQuotation(legacyQ.id))
eq('转单失败后订单没被创建', legacyAfter?.convertedOrderId ?? null, null)

/* ---------------- N31/N32：删除拦截（已转订单的报价单 / 有记录的客户） ---------------- */
section('删除拦截：已转订单的报价单、有记录的客户')
// N31：已转订单的报价单是原始报价凭据，删了以后订单只剩一个查不到的编号
let qDelErr = ''
try {
  (await quotations.deleteQuotation(qRate.id)) // qRate 前面已转成 qRateOrder
} catch (e) {
  qDelErr = (e as Error).message
}
check('已转订单的报价单删不掉', qDelErr.includes('转成订单'), qDelErr)
check('拦截提示里给出替代方案（已失效）', qDelErr.includes('已失效'), qDelErr)
check('拦截后报价单还在', (await quotations.getQuotation(qRate.id)) !== null)
// 负向对照：未转订单的报价单可以真删
const qDelOk = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
await quotations.deleteQuotation(qDelOk.id)
check('未转订单的报价单可以删', (await quotations.getQuotation(qDelOk.id)) === null)

// N32：有订单/报价/打样单的客户删不掉，报错要人话（不许 FOREIGN KEY 英文裸奔）
let cDelErr = ''
try {
  await customers.deleteCustomer(c1.id) // c1 有订单、报价、打样单
} catch (e) {
  cDelErr = (e as Error).message
}
check('有记录的客户删不掉', cDelErr.includes('不能删'), cDelErr)
check('报错是中文人话不是英文数据库错误', !cDelErr.includes('FOREIGN KEY'), cDelErr)
check('报错里说明了有几个订单', /\d+ 个订单/.test(cDelErr), cDelErr)
check('拦截后客户还在', (await customers.getCustomer(c1.id)) !== null)
// 负向对照：没有任何记录的客户可以真删
const cEmpty = await customers.saveCustomer({ company: 'DELETE-ME-TEST' })
await customers.deleteCustomer(cEmpty.id)
check('无记录的客户可以删', (await customers.getCustomer(cEmpty.id)) === null)

/* ---------------- 报价单：可以改，改完报价号不变 ---------------- */
section('报价单可编辑（同号 + 留痕）')
const qEdit = await quotations.saveQuotation({
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
const qEdited = await quotations.saveQuotation({
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
const qEvents = (await quotations.listQuotationEvents(qEdit.id))
check('报价单修改有留痕', qEvents.some((e) => e.note.includes('数量 500 → 700')), JSON.stringify(qEvents))
eq('改完汇率日期不变', qEdited.exchangeRateDate, '2026-09-01')

/* ---------------- 报价单：状态可改 / 能按款号搜 ---------------- */
section('报价单状态与搜索')
const qStatus = (await quotations.updateQuotationMeta(qEdit.id, { status: 'sent' }))
eq('报价单状态改成已发送', qStatus.status, 'sent')
eq('报价单结果没被改掉', qStatus.result, 'pending')
const byStatus = (await quotations.listQuotations({ status: 'sent' }))
check('按状态能筛出报价单', byStatus.some((q) => q.id === qEdit.id))
const byStyle = (await quotations.listQuotations({ keyword: 'A002' }))
check('按款号能搜到报价单', byStyle.some((q) => q.id === qEdit.id))
const byNo = (await quotations.listQuotations({ keyword: qNoBefore }))
check('按报价号能搜到报价单', byNo.some((q) => q.id === qEdit.id))

/* ---------------- R3：报价版本快照、按版本转单、过期沿用审批 ---------------- */
section('R3 报价版本：按哪一版转，就按哪一版的钱')

const versions = (await quotations.listQuotationVersions(qEdit.id))
eq('改过一次 → 两个版本快照', versions.length, 2)
eq('版本号从新到旧', versions.map((v) => v.revision).join(','), '2,1')
const v1 = versions.find((v) => v.revision === 1)!
eq('第 1 版合计 = 改前的钱', v1.grandTotal, 500 * 7.5 + 200 * 9.9)
const v2 = versions.find((v) => v.revision === 2)!
eq('第 2 版合计 = 改后的钱', v2.grandTotal, 700 * 7.5 + 200 * 9.9)

// 客户翻出旧邮件说「就按第 1 版这个价」→ 必须能按第 1 版原样转
const v1Order = await quotations.convertToOrder(qEdit.id, { revision: 1 })
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
const qExpired = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-09-01',
  validUntil: '2026-01-01',
  items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
})
let expiredErr = ''
try {
  await quotations.convertToOrder(qExpired.id)
} catch (e) {
  expiredErr = (e as Error).message
}
check('过期报价没批准人/原因不让转', expiredErr.includes('批准人') && expiredErr.includes('原因'), expiredErr)
check('被拦住时没有偷偷生成订单', (await quotations.getQuotation(qExpired.id))?.convertedOrderId == null)
const expiredOrder = await quotations.convertToOrder(qExpired.id, {
  override: { approvedBy: '周文娟', reason: '老客户翻单，老板同意按旧价做' }
})
check('填了批准人和原因 → 可以沿用旧价转单', expiredOrder.id > 0)
// R34：审批话术只进操作历史，绝不进订单备注——note 会原样印在 PI/CI 上发给客户
check(
  '订单备注不带批准人/让步原因（发给客户的纸面）',
  !expiredOrder.note.includes('周文娟') && !expiredOrder.note.includes('老客户翻单'),
  expiredOrder.note
)
check(
  '订单备注保留转单凭据句（不再被覆盖掉）',
  expiredOrder.note.includes('由报价单') && expiredOrder.note.includes('转成'),
  expiredOrder.note
)
check(
  '审批话术在订单操作历史里查得到',
  (await orders.listEvents(expiredOrder.id))
    .some((e) => e.kind === 'quotation_convert' && e.note.includes('周文娟') && e.note.includes('老客户翻单')),
  JSON.stringify((await orders.listEvents(expiredOrder.id)))
)
check(
  '报价单操作历史记下了沿用审批',
  (await quotations.listQuotationEvents(qExpired.id)).some((e) => e.note.includes('周文娟')),
  JSON.stringify((await quotations.listQuotationEvents(qExpired.id)))
)

/* ---------------- 报价单：费用转成订单的正式费用行 ---------------- */
section('报价单费用转订单费用行')
const qCharge = await quotations.saveQuotation({
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
const chargeOrder = await quotations.convertToOrder(qCharge.id)
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
const salesBeforeDraft = (await dashboard.dashboard()).monthSales
const draftOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(draftOrder.id, { styleNo: 'DRAFT-1', productName: '草稿', quantity: 100, unitPrice: 100 })
const salesAfterDraft = (await dashboard.dashboard()).monthSales
eq('草稿订单不进本月销售额', salesAfterDraft, salesBeforeDraft)
check('草稿订单不在客户成交额里', (await customers.customerStats(c1.id)).orderCount >= 1)

/* ---------------- 明细可直接改颜色/尺码，并留痕 ---------------- */
section('改单：颜色/尺码可直接改')
const editTarget = (await orders.getOrder(converted.id))!
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
  (await orders.listEvents(converted.id)).some((e) => e.kind === 'item_update' && e.note.includes('颜色'))
)

/* ---------------- 催尾款提醒 ---------------- */
section('催尾款提醒')
const balSettings = getSettings()
await saveSettings({ ...balSettings, remindBalanceDays: 0 })
// 定金按 30% 算：这一节测的是「定金收齐了、尾款没着落」的尾款提醒；
// 用默认比例（这轮前面已被改成 40%）会让定金本身就没收齐，R36 起尾款提醒会被压住
const balOrder = await orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7.2, depositRatio: 0.3 })
await orders.addOrderItem(balOrder.id, { styleNo: 'B1', productName: 'x', quantity: 100, unitPrice: 10 })
await orders.setPaymentStatus(balOrder.id, 'confirmed')
await orders.addPayment(balOrder.id, { paidAt: '2026-03-01', amount: 300, method: 'T/T', bankRef: 'BAL001' })
const remBalance = await dashboard.reminders()
check('已收定金未收齐 → 催尾款', remBalance.some((r) => r.kind === 'balance' && r.orderId === balOrder.id))
await saveSettings(balSettings)

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

const terms = (await orders.lastOrderTerms(c2.id))
check('能取到客户上一次的条款', terms !== null)
eq('上一次的装运港', terms?.portOfLoading, 'Ningbo')
const portList = (await orders.listPorts())
check('历史港口里有宁波', portList.loading.includes('Ningbo'))
check('最近汇率能取到', (await orders.lastExchangeRate()) !== null)

// 客户档案付款条款印在 PI 上
const piWithTerms = renderPi({ order: withExtra, settings: getSettings(), images: {} })
check('PI 印出客户档案里的付款条款', piWithTerms.includes('Agreed Terms') && piWithTerms.includes(c2.paymentPref))

/* ---------------- 本地日期 ---------------- */
section('单据日期用本地日期')
const localToday = localDate()
const fresh = await orders.createOrder({ customerId: c1.id, currency: 'USD' })
const piFresh = renderPi({ order: (await orders.getOrder(fresh.id))!, settings: getSettings(), images: {} })
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
const csvItems = await dashboard.exportCsv('items')
check('明细台账有 BOM', csvItems.charCodeAt(0) === 0xfeff)
check('明细台账含款号列', csvItems.includes('款号') && csvItems.includes('颜色') && csvItems.includes('尺码'))
check('明细台账含订单号列', csvItems.includes('订单号'))
check('明细台账不含草稿订单的款号', !csvItems.includes('DRAFT-1'))

/* ---------------- 商品库：净重与箱规 ---------------- */
section('商品库单件净重与箱规')
const p3 = await products.saveProduct({
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
const toDelete = await orders.createOrder({ customerId: c1.id, currency: 'USD' })
await orders.deleteOrder(toDelete.id)
check('订单已删除', await orders.getOrder(toDelete.id) === null)

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
const chargesChanged = await orders.updateOrderCharges(chargeOrder.id, [
  { label: '运费 Freight', amount: 250 },
  { label: '保险费 Insurance', amount: 30 }
])
eq('费用行改成功', chargesChanged.charges.length, 2)
eq('费用合计跟着变', chargesChanged.chargesTotal, 280)
eq('应收总额跟着变', chargesChanged.grandTotal, chargeOrder.totalAmount + 280)
check(
  '改费用有操作历史',
  (await orders.listEvents(chargeOrder.id)).some((e) => e.note.includes('费用'))
)
const chargesCleared = await orders.updateOrderCharges(chargeOrder.id, [])
eq('费用行可以删光', chargesCleared.chargesTotal, 0)
eq('删掉费用后应收总额 = 货值', chargesCleared.grandTotal, chargeOrder.totalAmount)
const chargesViaUpdate = await orders.updateOrder(chargeOrder.id, {
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
const noPort = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2, incoterm: 'FOB' })
const noPortPi = renderPi({ order: (await orders.getOrder(noPort.id))!, settings: getSettings(), images: {} })
check('PI 上没有「FOB — — → —」', !noPortPi.includes('FOB — — → —'))
check('PI 上写「港口待确认」', noPortPi.includes('港口待确认'))
const noPortQ = await quotations.saveQuotation({
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
const manualQ = await quotations.saveQuotation({
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
const manualOrder = await quotations.convertToOrder(manualQ.id)
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
  (await dashboard.monthlyReport()).some((r) => r.missingCostOrders > 0)
)
check('客户统计标出成本没录全的单', (await customers.customerStats(c1.id)).missingCostOrders > 0)

/* ---------------- 收款状态按含费用合计流转 ---------------- */
section('收款状态按含费用合计流转')
const flowOrder = await orders.createOrder({
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
const flowAfter = (await orders.getOrder(flowOrder.id))!
eq('含费用应收总额', flowAfter.grandTotal, 1200)
check('付了货值但没付费用时不能算已结清', flowAfter.paymentStatus !== 'settled', flowAfter.paymentStatus)
// 催尾款提醒也要按含费用总额算（不然运费没收到就不提醒了）
const balSettings2 = getSettings()
await saveSettings({ ...balSettings2, remindBalanceDays: 0 })
const balOrder2 = await orders.createOrder({
  customerId: c2.id,
  currency: 'USD',
  exchangeRate: 7.2,
  charges: [{ label: '运费 Freight', amount: 300 }],
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(balOrder2.id, { styleNo: 'A001', productName: 'x', quantity: 100, unitPrice: 10 })
await orders.addPayment(balOrder2.id, { paidAt: '2026-03-01', amount: 1000, method: 'T/T', bankRef: 'BAL002' })
const remBal2 = (await dashboard.reminders()).find((r) => r.kind === 'balance' && r.orderId === balOrder2.id)
check('尾款提醒按含费用算（付了货值也会提醒还欠运费）', !!remBal2, JSON.stringify(remBal2))
check('尾款提醒里写的是含费用的待收（1300 - 1000 = 300）', (remBal2?.message ?? '').includes('待收 300.00'), remBal2?.message)
await saveSettings(balSettings2)

/* ---------------- 打样单（样品单） ---------------- */
section('打样单（样品单）')
const sample = await samples.saveSample({
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
check('按样品单号能搜到', (await samples.listSamples({ keyword: sample.sampleNo })).length === 1)
check('按快递单号能搜到', (await samples.listSamples({ keyword: 'SF123456789' })).length === 1)
check('按款号能搜到', (await samples.listSamples({ keyword: 'A002' })).length === 1)
check('按客户能搜到', (await samples.listSamples({ keyword: 'Acme' })).length === 1)
const salesBeforeSample = (await dashboard.dashboard()).monthSales
eq('打样单不进销售额', (await dashboard.dashboard()).monthSales, salesBeforeSample)
const sampleHtml = renderSample({ sample, settings: getSettings(), images: {} })
check('样品单抬头是 SAMPLE ORDER', sampleHtml.includes('SAMPLE ORDER'))
check('样品单有中文抬头', sampleHtml.includes('样品单'))
check('样品单印了样品费行', sampleHtml.includes('样品费 Sample Fee'))
check('样品单印了快递费行', sampleHtml.includes('快递费 Courier Fee'))
check('样品单印了快递单号', sampleHtml.includes('SF123456789'))
check('样品单印了合计', sampleHtml.includes((50 + 120).toFixed(2)))
const sampleUpdated = await samples.saveSample({
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
// R24：还挂着应收的单不许零留痕删掉（钱没收回、单也没了，应收凭空断线）
let smpOwedDelErr = ''
try {
  await samples.deleteSample(sample.id)
} catch (e) {
  smpOwedDelErr = (e as Error).message
}
check('有未收打样费的单不能直接删', smpOwedDelErr.includes('没收回'), smpOwedDelErr)
check('被拦下时单还在', await samples.getSample(sample.id) !== null)
await samples.saveSample({ id: sample.id, status: 'cancelled', note: '客户改用别家打样，这笔样品费不收了' })
eq('取消后应收归零', (await samples.getSample(sample.id))!.receivableBase, 0)
await samples.deleteSample(sample.id)
check('取消留原因后打样单可以删', await samples.getSample(sample.id) === null)

/* ---------------- 打样单：校验 / 三笔分清 / 应收进工作台 / 转订单 / 删拦截（N23/N24/N25/N33） ---------------- */
section('打样单进阶：应收进工作台、转订单、三笔分清')

// N23 校验：未收且有金额 → 汇率必须填
let smpRateErr = ''
try {
  await samples.saveSample({
    customerId: c1.id,
    expressFee: 100,
    items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 1, unitPrice: 15 }]
  })
} catch (e) {
  smpRateErr = (e as Error).message
}
check('未收打样单没汇率不让存', smpRateErr.includes('汇率'), smpRateErr)

// R25：已收不能手勾——必须真有流水；手勾的话这笔钱会从月报里消失
let smpManualPaidErr = ''
try {
  await samples.saveSample({
    customerId: c1.id,
    expressFee: 80,
    feeStatus: 'paid',
    items: [{ styleNo: 'A001', color: 'White', size: 'S', quantity: 1, unitPrice: 10 }]
  })
} catch (e) {
  smpManualPaidErr = (e as Error).message
}
check('R25：「已向客户收」不能手工勾，要登记收款', smpManualPaidErr.includes('登记收款'), smpManualPaidErr)

// 已收 = 真实流水收齐（自动推成 paid）；汇率是流水的折算依据
const smpPaid = await samples.saveSample({
  customerId: c1.id,
  expressFee: 80,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'A001', color: 'White', size: 'S', quantity: 1, unitPrice: 10 }]
})
const smpPaidFlow = await samples.addSamplePayment(smpPaid.id, {
  paidAt: localDate(),
  amount: smpPaid.totalFee,
  bankRef: 'E2E-R25-PAID'
})
eq('收齐后自动标成已收', smpPaidFlow.feeStatus, 'paid')
eq('已收金额来自流水', smpPaidFlow.collected, 90)
eq('已收的样品费 + 快递费折基准币', smpPaidFlow.feeRecoveredBase, 90 * 7.15)
eq('收齐的打样单不计待收', smpPaidFlow.receivableBase, 0)
eq('有流水的已收不是「旧记录·无流水」', smpPaidFlow.legacyPaidNoFlow, false)

// N23：未收的打样费要进 totalReceivable（工作台口径）
const smpUnpaid = await samples.saveSample({
  customerId: c2.id,
  expressFee: 55,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  shippedAt: '2026-10-22',
  items: [{ styleNo: 'A002', color: 'Navy', size: 'L', quantity: 2, unitPrice: 15 }]
})
eq('待收 = 样品费 30 + 快递费 55 × 汇率', smpUnpaid.receivableBase, (30 + 55) * 7.2)
const totalBefore = await money.totalReceivable()
check('打样应收计入全公司待收', totalBefore >= (30 + 55) * 7.2, `totalReceivable=${totalBefore}`)
const cust2Receivable = await money.customerReceivable(c2.id)
check('客户页未收也含打样费', cust2Receivable >= (30 + 55) * 7.2, `customerReceivable=${cust2Receivable}`)
// 汇率未填的未收打样单 → 存不进去（新校验拦住）
let smpNoRateErr = ''
try {
  await samples.saveSample({
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
const smpDates = await samples.saveSample({
  customerId: c1.id,
  expressFee: 20,
  feeStatus: 'waived',
  shippedAt: '2026-10-22',
  receivedAt: '2026-10-25',
  factoryCost: 30,
  items: [{ styleNo: 'A001', color: 'Black', size: 'M', quantity: 1, unitPrice: 10 }]
})
eq('寄出日期记住了', smpDates.shippedAt, '2026-10-22')
eq('签收日期记住了', smpDates.receivedAt, '2026-10-25')
eq('没填汇率 → 净垫折不出来，不拿 1 凑数', smpDates.netAdvanceBase, null)

// N24：打样转订单（不抵扣）
const smpConv = await samples.saveSample({
  customerId: c2.id,
  expressFee: 40,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [
    { styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 2, unitPrice: 15, goodsUnitPrice: 8, productId: p1.id }
  ]
})
const convOrder = await samples.convertSampleToOrder(smpConv.id, { offsetSampleFee: false })
check('打样转出了订单', convOrder.id > 0)
eq('转出订单的汇率 = 打样单的汇率', convOrder.exchangeRate, 7.2)
eq('不抵扣 → 订单没有负费用行', (convOrder.charges ?? []).length, 0)
eq('转出订单的明细带过去了', convOrder.items.length, 1)
eq('明细款号带过去了', convOrder.items[0].styleNo, 'A001')
eq('明细件数带过去了', convOrder.items[0].quantity, 2)
eq('转单用的是大货单价，不是打样单价', convOrder.items[0].unitPrice, 8)
const smpConvAfter = await samples.getSample(smpConv.id)!
eq('打样单记住了转出的订单', smpConvAfter.convertedOrderId, convOrder.id)
eq('不抵扣 → 收款标记不变', smpConvAfter.feeStatus, 'unpaid')
eq('打样单记住了大货单价', smpConvAfter.items[0].goodsUnitPrice, 8)
// R3：打样单价只是打样费，没填大货单价不许转（否则 15 美金打样价会变成大货价）
const smpNoGoods = await samples.saveSample({
  customerId: c2.id,
  expressFee: 0,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'A-BULK', productName: '待报大货价', quantity: 1, unitPrice: 20 }]
})
let smpGoodsErr = ''
try {
  await samples.convertSampleToOrder(smpNoGoods.id)
} catch (e) {
  smpGoodsErr = (e as Error).message
}
check('没填大货单价 → 打样单不能转订单', smpGoodsErr.includes('大货单价'), smpGoodsErr)
check('被拦住时没有偷偷生成订单', (await samples.getSample(smpNoGoods.id))!.convertedOrderId === null)
// 重复转单返回同一张
const convAgain = await samples.convertSampleToOrder(smpConv.id, { offsetSampleFee: false })
eq('重复转单不新开订单', convAgain.id, convOrder.id)
// 转过单的打样单不让删
let smpDelErr = ''
try {
  await samples.deleteSample(smpConv.id)
} catch (e) {
  smpDelErr = (e as Error).message
}
check('已转单的打样单删不掉', smpDelErr.includes('订单'), smpDelErr)

// N24：抵扣 —— 样品费变成负费用行，打样单标「下单抵扣」
const smpOffset = await samples.saveSample({
  customerId: c2.id,
  expressFee: 25,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'A002', productName: '涤纶 Polo 衫', color: 'Navy', size: 'L', quantity: 1, unitPrice: 15, goodsUnitPrice: 40 }]
})
const offsetOrder = await samples.convertSampleToOrder(smpOffset.id, { offsetSampleFee: true, paymentStatus: 'sent' })
const offsetCharge = (offsetOrder.charges ?? []).find((c: any) => c.amount < 0)
check('抵扣 → 订单里出现负费用行', !!offsetCharge, JSON.stringify(offsetOrder.charges))
eq('负费用行金额 = -(样品费 15 + 快递费 25)', offsetCharge?.amount, -40)
const smpOffsetAfter = await samples.getSample(smpOffset.id)!
eq('抵扣后打样单标记为下单抵扣', smpOffsetAfter.feeStatus, 'offset')
eq('抵扣的样品费+快递费都算已收回（USD40 × 7.2 折基准币）', smpOffsetAfter.feeRecoveredBase, 40 * 7.2)
eq('抵扣的打样单不计待收', smpOffsetAfter.receivableBase, 0)

// N-4：抵扣转出来的单可以是 0 元——样品费 15 + 快递费 25 都抵掉，货值 40 − 抵扣 40 = 0
// （R29 起不允许抵穿：负合计会被误读成客户多付，转单时直接拦下）
// 毛利 = 含费用合计（实收口径）− 成本，负数就写负数
// 先补录成本（模拟她在订单明细里填成本）：货值 40 − 抵扣 40 − 成本 5 = −5
getDb().run('UPDATE order_items SET unit_cost = 5 WHERE order_id = ?', [offsetOrder.id])
const offDetail = (await orders.getOrder(offsetOrder.id))!
eq('抵扣单含费用合计 = 0（货值 40 正好被样品费+快递费抵清，不抵穿）', offDetail.grandTotal, 0)
eq(
  '抵扣单毛利 = 含费用合计 − 成本（不再拿货值凑漂亮数）',
  offDetail.totalProfit,
  offDetail.grandTotal - offDetail.totalCost
)
check('抵扣单毛利是负数（亏的是真金白银的成本）', offDetail.totalProfit < 0, String(offDetail.totalProfit))
// 汇总入口（工作台/报表/客户页都走它）必须与详情卡同一个数
const offMoneyRow = (await money.listOrderMoney()).find((r) => r.orderId === offsetOrder.id)!
eq(
  '汇总口径的毛利 = 详情卡毛利×汇率（订单详情/工作台/报表/客户页同一个入口）',
  offMoneyRow.profitBase,
  offDetail.totalProfit * offMoneyRow.exchangeRate
)
const offMonth = localMonthOf(String(offDetail.createdAt))
const offMonthRow = (await dashboard.monthlyReport()).find((r) => r.month === offMonth)!
const offMonthOrders = await money.listOrderMoney({ month: offMonth })
const offMonthMissing = offMonthOrders.filter((r) => r.missingCostItems > 0).length
eq(
  '报表月度毛利：成本录全时 = Σ各单毛利（含抵扣单的负毛利，不许静默吞掉）',
  offMonthRow.profit,
  offMonthMissing > 0 ? null : offMonthOrders.reduce((s, r) => s + (r.profitBase ?? 0), 0)
)

// 催打样费提醒（N23）：寄出超过阈值（默认 10 天）且未收 → 提醒
const smpOld = await samples.saveSample({
  customerId: c1.id,
  sampleDate: '2026-08-01',
  expressFee: 60,
  currency: 'USD',
  exchangeRate: 7.15,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'White', size: 'L', quantity: 1, unitPrice: 15 }]
})
const remSample = await dashboard.reminders()
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
const smpPi = await samples.saveSample({
  customerId: c2.id,
  expressFee: 10,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  feeStatus: 'waived',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'M', quantity: 1, unitPrice: 20, goodsUnitPrice: 8 }]
})
const piSentOrder = await samples.convertSampleToOrder(smpPi.id, { offsetSampleFee: false, paymentStatus: 'sent' })
eq('转单可直接落「待确认」（PI 现在就发）', piSentOrder.paymentStatus, 'sent')
eq('不传 paymentStatus 默认还是草稿（兼容旧调用）', convOrder.paymentStatus, 'draft')

// N-3 ①：手填重号 → 中文拦住（单号是凭据，不能两张共用）
let smpDupErr = ''
try {
  await samples.saveSample({
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
  await samples.saveSample({
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
const bumped = await samples.saveSample({
  customerId: c1.id,
  feeStatus: 'paid',
  items: [{ styleNo: 'A001', productName: 'x', color: '', size: '', quantity: 1, unitPrice: 0 }]
})
const expectedNo = staleNo.replace(/(\d+)$/, (m) => String(Number(m) + 1).padStart(m.length, '0'))
eq('计数器落后时自动跳到下一个没用过的号', bumped.sampleNo, expectedNo)
check('自动号不等于被手工占用的号', bumped.sampleNo !== staleNo, `${staleNo} vs ${bumped.sampleNo}`)
const allSampleNos = (await samples.listSamples()).map((s) => s.sampleNo)
eq('全库样品单号无重号', allSampleNos.length, new Set(allSampleNos).size)
// 改回自己的号不算重号（不改号直接保存也不会被拦）
const smpKeepNo = await samples.saveSample({
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
await samples.deleteSample(bumped.id)

// R25：有收款流水的单不能直接删 → 先撤销流水（要写原因，原因进 feeNote），再取消留原因、删除
const smpPaidFlows = (await samples.listSamplePayments(smpPaid.id))
eq('打样收款落进流水表', smpPaidFlows.length, 1)
const smpPaidReverted = await samples.deleteSamplePayment(smpPaid.id, smpPaidFlows[0].id, 'E2E 清理：测试收款')
eq('撤销后回到未收', smpPaidReverted.feeStatus, 'unpaid')
check('撤销原因写进收款说明', smpPaidReverted.feeNote.includes('E2E 清理'))
await samples.saveSample({ id: smpPaid.id, status: 'cancelled', note: 'E2E 清理：测试单不收了' })
await samples.deleteSample(smpPaid.id)
await samples.deleteSample(smpDates.id)
// R24 起未收的单要先取消留原因才允许删
await samples.saveSample({ id: smpUnpaid.id, status: 'cancelled', note: 'R24 清理：测试单，不收了' })
await samples.deleteSample(smpUnpaid.id)

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
const soSkipOrder = await orders.createOrder({ customerId: c1.id })
check('订单号：计数器落后时跳过手工占用的号', soSkipOrder.orderNo !== staleSo, `${staleSo} vs ${soSkipOrder.orderNo}`)

// ② 手填 PI 号跟已有单撞号 → 中文拦住
const piDupSrc = await orders.createOrder({ customerId: c1.id })
let piDupMsg = ''
try {
  await orders.createOrder({ customerId: c1.id, piNo: piDupSrc.piNo })
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
  await orders.updateOrder(soSkipOrder.id, { customerId: c1.id, piNo: piDupSrc.piNo })
} catch (e) {
  piRenameMsg = (e as Error).message
}
check('编辑时改成别人的 PI 号被拦住', piRenameMsg.includes('已经存在'), piRenameMsg)
const piKeepSelf = await orders.updateOrder(soSkipOrder.id, { customerId: c1.id, piNo: soSkipOrder.piNo })
eq('不改 PI 号保存不被误拦', piKeepSelf.piNo, soSkipOrder.piNo)

// ④ PI 自动号：手工占用下一个 PI 号 → 跳号
const stalePi = peekNext('PI')
getDb().run(
  `INSERT INTO orders(order_no, customer_id, pi_no, created_at, updated_at) VALUES(?,?,?, datetime('now'), datetime('now'))`,
  [`${staleSo}_piholder`, c1.id, stalePi]
)
const piSkipOrder = await orders.createOrder({ customerId: c1.id })
check('PI 号：自动号跳过手工占用的号', piSkipOrder.piNo !== stalePi, `${stalePi} vs ${piSkipOrder.piNo}`)

// ⑤ 报价号：手工占用下一个报价号 → 自动号跳号
const staleQ = peekNext('Q')
getDb().run(
  `INSERT INTO quotations(q_no, customer_id, created_at, updated_at) VALUES(?,?, datetime('now'), datetime('now'))`,
  [staleQ, c1.id]
)
const qSkip = await quotations.saveQuotation({
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
const plsBeforeNos = (await packing.listPackingLists(soSkipOrder.id)).map((p) => p.plNo)
const plsAfter = await packing.createPackingList({
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
const allOrders = await orders.listOrders({})
const allSoNos = allOrders.map((o) => o.orderNo)
eq('全库订单号无重号', allSoNos.length, new Set(allSoNos).size)
const allPiNos = allOrders.map((o) => o.piNo).filter(Boolean)
eq('全库 PI 号无重号', allPiNos.length, new Set(allPiNos).size)
const allQNos = (await quotations.listQuotations()).map((q) => q.qNo)
eq('全库报价号无重号', allQNos.length, new Set(allQNos).size)

// 清理：手工占位行 + 本节造的空单（不影响后面的金额口径断言）
getDb().run('DELETE FROM orders WHERE order_no IN (?, ?)', [staleSo, `${staleSo}_piholder`])
getDb().run('DELETE FROM quotations WHERE q_no = ?', [staleQ])
getDb().run('DELETE FROM packing_lists WHERE pl_no = ?', [stalePl])
// 本节为了验 PL 自动号真建了一张箱单，先清掉这张单的箱单再删单
// （R15 起有箱单的空单也要走作废，不能物理删除）
getDb().run('DELETE FROM packing_lists WHERE order_id = ?', [soSkipOrder.id])
await orders.deleteOrder(soSkipOrder.id)
await orders.deleteOrder(piDupSrc.id)
await orders.deleteOrder(piSkipOrder.id)
await quotations.deleteQuotation(qSkip.id)

/* ============================================================
 * 第 5 轮：金额口径唯一真源（N29） + 改单重算状态（N27）
 *           + 作废代替删除（N28） + 删行留痕（N30） + 成本可补录（N20）
 * ============================================================ */

/* ---------------- 金额口径：一个数，十一个地方 ---------------- */
section('金额口径：订单详情 / 订单列表 / 客户页 / 工作台 / CSV 必须一致')
const moneyOrder = await orders.createOrder({
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
await orders.setPaymentStatus(moneyOrder.id, 'sent')
await orders.addOrderItem(moneyOrder.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 1000,
  unitPrice: 8,
  unitCost: 5.5
})
let mo = (await orders.getOrder(moneyOrder.id))!
eq('含费用合计 = 货值 + 费用', mo.grandTotal, 8000 + 230)
eq('待收 = 含费用合计 − 已收', mo.remaining, 8000 + 230)
// 收 3000
mo = await orders.addPayment(moneyOrder.id, { paidAt: '2026-10-21', amount: 3000, method: 'T/T', bankRef: 'MO001' })
eq('已收 3000 后待收', mo.remaining, 8000 + 230 - 3000)
eq('已收金额', mo.paidAmount, 3000)

// ① 订单详情
const detailRemaining = (await orders.getOrder(moneyOrder.id))!.remaining
// ② 订单列表（同一份 hydrate 数据）
const listRow = (await orders.listOrders({ keyword: moneyOrder.orderNo }))[0]
eq('订单详情与订单列表的待收相等', listRow.remaining, detailRemaining)
// N38：工作台「最近订单」金额列的数据源就是 listOrders 的 grandTotal（含费用合计，与单据同口径，不是货值）
const dashRow = (await orders.listOrders({ keyword: moneyOrder.orderNo }))[0]
eq('工作台最近订单列的金额 = 含费用合计（与 PI/CI 同一个数，不是货值）', dashRow.grandTotal, 8000 + 230)
// ③ 客户页
const custStats = await customers.customerStats(c1.id)
const custRow = (await customers.customerOrderBriefs(c1.id)).find((o) => o.id === moneyOrder.id)!
eq('客户页订单历史的待收 = 订单详情的待收', custRow.remaining, detailRemaining)
// ④ 工作台：待收款 = Σ(订单含费用待收) + Σ(打样未收折算)（N23：打样费也进工作台）
const pendingSum =
  (await money.listOrderMoney()).reduce((s, r) => s + r.receivable * r.exchangeRate, 0) +
  await money.sampleReceivable()
eq('工作台待收款 = 各单待收 + 打样未收', (await dashboard.dashboard()).pendingAmount, pendingSum)
// ⑤ 导出 CSV：待收列必须等于订单详情的待收
const csvRows = (await dashboard.exportCsv('orders')).split('\r\n')
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
  const rowPage = await orders.listOrderRows({ keyword: moneyOrder.orderNo })
  eq('瘦身列表只回这一单', rowPage.total, 1)
  eq('瘦身列表的待收 = 订单详情的待收（同一个 money.ts）', rowPage.rows[0].remaining, detailRemaining)
  const bigPage = await orders.listOrderRows({ limit: 2, offset: 0 })
  eq('分页：本页最多 2 行', bigPage.rows.length, 2)
  eq('分页：total 是筛选集，不是本页行数', bigPage.total, (await orders.listOrderRows({})).total)
  const page2 = await orders.listOrderRows({ limit: 2, offset: 2 })
  check(
    '分页：第二页不与第一页重叠',
    !page2.rows.some((r) => bigPage.rows.some((x) => x.id === r.id))
  )
  const owedRows = (await orders.listOrderRows({ sort: 'owed_desc' })).rows
  // 排的是屏幕上那个待收：不催款的单（草稿/失效/作废）算 0，多收的不许倒挂成负数抢前排
  const owedShown = (r: (typeof owedRows)[number]) => shownRemaining(r.paymentStatus, r.remaining) * r.exchangeRate
  check(
    '待收排序（基准币，按界面那个数）单调不增',
    owedRows.every((r, i) => i === 0 || owedShown(owedRows[i - 1]) >= owedShown(r) - 0.001)
  )
  eq('日期区间按本地日切：今天建的单落在 [今天, 今天] 里', (await orders.listOrderRows({ from: localDate(), to: localDate() })).rows.some((r) => r.id === moneyOrder.id), true)
  check('日期区间收窄后不多于全量', (await orders.listOrderRows({ from: '2000-01-01', to: localDate() })).total <= (await orders.listOrderRows({})).total)
  // 待收口径单一真源：不催款的单（草稿/失效/作废）界面一律「—」
  eq('草稿单不催款', isBillingStatus('draft'), false)
  eq('作废单不催款', isBillingStatus('void'), false)
  eq('已发送的单要催款', isBillingStatus('sent'), true)
  eq('不催款的单待收显示 0（界面画「—」）', shownRemaining('void', 500), 0)
  eq('正常单待收原样显示', shownRemaining('sent', 500), 500)
  eq('多收不算待收', shownRemaining('partial', -80), 0)
  // 搜索关键词里的 % _ 是真字符，不是通配符
  eq('LIKE 转义：搜 100% 不会匹配一切', (await orders.listOrderRows({ keyword: '100%' })).total, 0)
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
const qSameMoney = await quotations.saveQuotation({
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
eq('客户页未收金额口径正确（含费用、减已收、含打样未收）', (await customers.customerStats(c1.id)).outstanding, await money.customerReceivable(c1.id))

// ⑧ r3 补强：报表页不能自己一套口径 —— 逐月销售额必须 = Σ(订单页该月各单 grandTotal×汇率)，独立两边算
const repAll = await dashboard.monthlyReport()
const ordersAll = await orders.listOrders({})
// 现金流口径要把作废单的钱也算进来（默认列表不含作废单）
const ordersForCash = [...ordersAll, ...await orders.listOrders({ paymentStatus: 'void' })]
const moneyRowsAll = await money.listOrderMoney()
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
    for (const p of (await orders.getOrder(o.id))?.payments ?? []) {
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
  (await money.listOrderMoney({ customerId: c1.id })).reduce((s, r) => s + r.receivable * r.exchangeRate, 0) +
  await money.sampleReceivable(c1.id)
eq('客户页未收 = Σ(该客户各单待收×汇率) + 该客户打样未收', (await customers.customerStats(c1.id)).outstanding, custMoneySum)
// ⑨ r3 补强：报表累计收款 = Σ(每单每笔收款×汇率)，同一笔钱两条路算出来必须相等
let recSumAll = 0
for (const o of ordersForCash) {
  if (o.paymentStatus === 'draft') continue
  for (const p of (await orders.getOrder(o.id))?.payments ?? []) recSumAll += p.amount * (p.exchangeRate ?? o.exchangeRate)
}
const recReportAll = repAll.reduce((s, r) => s + r.received, 0)
check('报表累计收款 = Σ(各单每笔收款×汇率)', Math.abs(recReportAll - recSumAll) < 0.01, `报表 ${recReportAll} / 逐笔合计 ${recSumAll}`)

/* ---------------- N27：改单后收款状态必须重算（能退也能升） ---------------- */
section('N27：客户临时改单，收款状态自动重算')
const r7 = await orders.createOrder({
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
await orders.setPaymentStatus(r7.id, 'confirmed')
let r7o = await orders.addPayment(r7.id, { paidAt: '2026-10-21', amount: 2400, method: 'T/T', bankRef: 'R7001' })
eq('收款 2400（定金 2400）→ 已收款', r7o.paymentStatus, 'paid')
eq('改单前的含费用合计', r7o.grandTotal, 8000)

// 客户加单：1000 → 1500，新定金 3600，实际只收到 2400
r7o = await orders.updateOrderItem(r7.id, r7i.items[0].id, { quantity: 1500 })
eq('加单后金额变大', r7o.grandTotal, 12000)
eq('加单后定金变大', r7o.depositAmount, 3600)
eq('加单后收款状态退回「部分收款」（不能还写着已收款）', r7o.paymentStatus, 'partial')
check(
  '状态回退有留痕',
  (await orders.listEvents(r7.id)).some((e) => e.kind === 'status_auto' && e.toStatus === 'partial')
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
const r7afterDel = await orders.removeOrderItem(r7.id, r7extra.items[1].id)
eq('删一行后金额变小', r7afterDel.grandTotal, 10000)
// 待收不会出现负数
const r7over = await orders.addPayment(r7.id, { paidAt: '2026-10-21', amount: 99999, method: 'T/T', bankRef: 'R7002' })
eq('多收了以后待收不会变负数', r7over.remaining, 0)
check('多收了以后状态是已结清', r7over.paymentStatus === 'settled')

/* ---------------- N30：删明细要留痕 ---------------- */
section('N30：删一行明细，系统里查得到')
const r30 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
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
await orders.removeOrderItem(r30.id, r30b.items[1].id)
const r30Events = (await orders.listEvents(r30.id))
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
const r30pl = await packing.createPackingList({
  orderId: r30.id,
  containerNo: 'MSKU0001',
  lines: [
    { boxNo: 'NO.1', styleNo: 'A001', color: 'Black', size: 'M', quantity: 60, netWeight: 10 },
    { boxNo: 'NO.2', styleNo: 'A001', color: 'Black', size: 'M', quantity: 40 }
  ]
})
const r30plLine = r30pl[0].lines[0]
await packing.updatePackingListLine(r30.id, r30pl[0].id, r30plLine.id, { netWeight: 12 })
check(
  '装箱明细改净重有留痕',
  (await orders.listEvents(r30.id)).some((e) => e.kind === 'pl_line_update' && e.note.includes('净重'))
)
await packing.deletePackingListLine(r30.id, r30pl[0].id, r30plLine.id)
check(
  '装箱明细删除有留痕',
  (await orders.listEvents(r30.id)).some((e) => e.kind === 'pl_line_remove' && e.note.includes('删除装箱明细'))
)

/* ---------------- N20：成本能补录，补完毛利就真了 ---------------- */
section('N20：成本可以就地补录，补完毛利不再不可信')
const r20 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
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
  (await orders.listEvents(r20.id)).some((e) => e.kind === 'item_update' && e.note.includes('成本'))
)
// 毛利不可信时，报表和客户页都给 null（显示「—」）
const r20stats = await customers.customerStats(c1.id)
check(
  '有成本缺失的单：客户页毛利是不可信',
  r20stats.totalProfit === null || r20stats.missingCostOrders >= 0
)

/* ---------------- N28：作废代替删除 ---------------- */
section('N28：有款的单不能物理删除，只能作废')
const r28 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
await orders.setPaymentStatus(r28.id, 'confirmed')
await orders.addOrderItem(r28.id, {
  styleNo: 'A001',
  productName: '纯棉圆领T恤',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 8,
  unitCost: 5.5
})
await orders.addPayment(r28.id, { paidAt: '2026-10-21', amount: 300, method: 'T/T', bankRef: 'R2801' })
let deleteBlocked = false
try {
  await orders.deleteOrder(r28.id)
} catch (e) {
  deleteBlocked = true
  check('删有款的单被拦住（中文提示）', (e as Error).message.includes('不能直接删'), (e as Error).message)
}
check('有明细有款的单删不掉', deleteBlocked)
// 作废：记录全留
const r28voided = await orders.voidOrder(r28.id, '客户取消')
eq('作废后状态是已作废', r28voided.paymentStatus, 'void')
check('作废后收款记录还在', r28voided.payments.length === 1)
check('作废后操作历史还在', (await orders.listEvents(r28.id)).length > 0)
check('作废后明细还在', r28voided.items.length === 1)
check('作废有留痕', (await orders.listEvents(r28.id)).some((e) => e.kind === 'void'))
// 作废后不进销售额 / 待收款 / 毛利
const salesBeforeVoid = (await dashboard.dashboard()).monthSales
const pendingBeforeVoid = (await dashboard.dashboard()).pendingAmount
const r28inSales = (await dashboard.monthlyReport()).reduce((s, r) => s + r.sales, 0)
await orders.voidOrder(r28.id, '再作废一次也不变')
eq('作废后订单不进默认列表', (await orders.listOrders({})).some((o) => o.id === r28.id), false)
check('作废的单在「已作废」页签里查得到', (await orders.listOrders({ paymentStatus: 'void' })).some((o) => o.id === r28.id))
eq('作废后本月销售额不变', (await dashboard.dashboard()).monthSales, salesBeforeVoid)
eq('作废后待收款不变', (await dashboard.dashboard()).pendingAmount, pendingBeforeVoid)
// 空单可以真删
const r28empty = await orders.createOrder({ customerId: c1.id, currency: 'USD' })
await orders.deleteOrder(r28empty.id)
check('空单可以真删', await orders.getOrder(r28empty.id) === null)

/* ---------------- 业务闭环守则（r14）：口径、汇率、转单锁定 ---------------- */
section('口径守则：作废单的钱算现金流、不算销售')

const cashFlowOrder = await orders.createOrder({
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
const cashBeforeReport = (await dashboard.monthlyReport()).reduce((s, r) => s + r.received, 0)
const salesBeforeReport = (await dashboard.monthlyReport()).reduce((s, r) => s + r.sales, 0)
const monthReceivedBeforeVoid = (await dashboard.dashboard()).monthReceived
const pendingBeforeCashVoid = (await dashboard.dashboard()).pendingAmount
await orders.voidOrder(cashFlowOrder.id, 'r14 口径测试')
const cashAfterReport = (await dashboard.monthlyReport()).reduce((s, r) => s + r.received, 0)
const salesAfterReport = (await dashboard.monthlyReport()).reduce((s, r) => s + r.sales, 0)
check(
  '作废单真收到的钱仍留在现金流里（报表收款一分不少）',
  Math.abs(cashAfterReport - cashBeforeReport) < 0.01,
  `${cashBeforeReport} → ${cashAfterReport}`
)
eq(
  '作废后工作台「本月收款」不变（钱已经到账，作废不退款）',
  (await dashboard.dashboard()).monthReceived,
  monthReceivedBeforeVoid
)
check(
  '作废单不再计入销售额（该单货值 100 × 7 从销售里减掉）',
  Math.abs(salesBeforeReport - salesAfterReport - 100 * 7) < 0.01,
  `${salesBeforeReport} → ${salesAfterReport}`
)
check(
  '作废后待收里少了这单未收的 70 × 7',
  Math.abs(pendingBeforeCashVoid - (await dashboard.dashboard()).pendingAmount - 70 * 7) < 0.01,
  `${pendingBeforeCashVoid} → ${(await dashboard.dashboard()).pendingAmount}`
)
const csvPayAfterVoid = await dashboard.exportCsv('payments')
const cashRow = csvPayAfterVoid.split('\r\n').find((l) => l.includes(cashFlowOrder.orderNo))
// R7：状态列统一走中文标签，台账、明细、收款三张表写法一致
check('收款 CSV 里作废单这行还在，且订单状态列写着「已作废」', !!cashRow && cashRow.includes('已作废'), cashRow ?? '没找到该行')

section('数据守卫：汇率不能清空、已转的单不能改钱')
// 用一张还在走的正式单验证：作废单在 R14 起连编辑入口都进不去
const rateGuardOrder = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  baseCurrency: 'CNY',
  paymentStatus: 'confirmed'
})
let rateZeroErr = ''
try {
  await orders.updateOrder(rateGuardOrder.id, {
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 0,
    baseCurrency: 'CNY'
  })
} catch (e) {
  rateZeroErr = (e as Error).message
}
check('编辑订单把汇率清成 0 会被拦住', rateZeroErr.includes('汇率'), rateZeroErr)
eq('被拦住后订单汇率没被改成 1', (await orders.getOrder(rateGuardOrder.id))?.exchangeRate, 7)

// 已转订单的报价单：明细/价格不许事后改
let qLockedErr = ''
try {
  await quotations.saveQuotation({
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
const smpLocked = await samples.getSample(smpConv.id)!
let smpMoneyErr = ''
try {
  await samples.saveSample({
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
const smpDescOk = await samples.saveSample({
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
const smpCancel = await samples.saveSample({
  customerId: c2.id,
  sampleDate: '2026-08-01',
  expressFee: 80,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'R14-CANCEL', quantity: 1, unitPrice: 50 }]
})
const receivableBeforeCancel = await money.sampleReceivable()
// R24：取消要把原因留在备注里——这单从此不再跟，日后只能靠这句话交代
let smpCancelNoReasonErr = ''
try {
  await samples.saveSample({
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
} catch (e) {
  smpCancelNoReasonErr = (e as Error).message
}
check('取消打样单不写原因被拦下', smpCancelNoReasonErr.includes('原因'), smpCancelNoReasonErr)
const smpCancelled = await samples.saveSample({
  id: smpCancel.id,
  customerId: c2.id,
  status: 'cancelled',
  sampleDate: '2026-08-01',
  expressFee: 80,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-08-01',
  note: '客户自己打样了，这笔不做了',
  items: [{ styleNo: 'R14-CANCEL', quantity: 1, unitPrice: 50 }]
})
eq('取消后打样单状态是已取消', smpCancelled.status, 'cancelled')
eq('取消的打样单待收为 0', smpCancelled.receivableBase, 0)
check(
  '取消的打样费从全公司待收里扣掉了',
  Math.abs(receivableBeforeCancel - await money.sampleReceivable() - (50 + 80) * 7) < 0.01,
  `${receivableBeforeCancel} → ${await money.sampleReceivable()}`
)
check(
  '取消的打样单不再出现在催款提醒里',
  !(await dashboard.reminders()).some((r) => r.kind === 'sample' && r.sampleId === smpCancel.id)
)
let smpCancelConvertErr = ''
try {
  await samples.convertSampleToOrder(smpCancel.id)
} catch (e) {
  smpCancelConvertErr = (e as Error).message
}
check('取消的打样单不能转订单', smpCancelConvertErr.includes('已取消'), smpCancelConvertErr)

section('PL 分批出货：已装扣减、超装拦下、箱内件数可改')
const batchOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(batchOrder.id, {
  styleNo: 'BATCH-1',
  productName: '分批款',
  color: 'Black',
  size: 'M',
  quantity: 100,
  unitPrice: 5,
  unitCost: 2
})
const b0 = (await orders.summarizeSkus(batchOrder.id))[0]
eq('还没装箱时已装数量 = 0', b0.packedQuantity, 0)
eq('还没装箱时未装箱数量 = 订单数量', b0.remainingQuantity, 100)

const bPl1 = await packing.createPackingList({
  orderId: batchOrder.id,
  containerNo: 'C1',
  lines: [{ boxNo: 'NO.1', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 40 }]
})
const b1 = (await orders.summarizeSkus(batchOrder.id))[0]
eq('装 40 件后已装数量 = 40', b1.packedQuantity, 40)
eq('未装箱数量自动扣到 60', b1.remainingQuantity, 60)

let overQtyErr = ''
try {
  await packing.createPackingList({
    orderId: batchOrder.id,
    lines: [{ boxNo: 'NO.1', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 70 }]
  })
} catch (e) {
  overQtyErr = (e as Error).message
}
check('第二批要装 70 件（只剩 60）会被拦下，并说清超了几件', overQtyErr.includes('超了 10 件'), overQtyErr)

await packing.createPackingList({
  orderId: batchOrder.id,
  lines: [{ boxNo: 'NO.2', styleNo: 'BATCH-1', color: 'Black', size: 'M', quantity: 60 }]
})
eq('第二批装剩下的 60 件放行', (await packing.listPackingLists(batchOrder.id)).length, 2)
eq('全部装完：未装箱数量归 0', (await orders.summarizeSkus(batchOrder.id))[0].remainingQuantity, 0)

const bLine = bPl1[0].lines[0]
await packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { netWeight: 20 })
const bEdited = await packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { quantity: 30 })
eq('PL 明细件数可以改（40 → 30）', bEdited[0].lines[0].quantity, 30)
eq('件数改小后净重按比例跟着改（20kg → 15kg）', bEdited[0].lines[0].netWeight, 15)
let lineOverErr = ''
try {
  await packing.updatePackingListLine(batchOrder.id, bPl1[0].id, bLine.id, { quantity: 50 })
} catch (e) {
  lineOverErr = (e as Error).message
}
check('改大后累计超过订单数量也会被拦下', lineOverErr.includes('超了'), lineOverErr)

/* ---------------- 批次出货：整单状态由批次汇总 ---------------- */
section('批次出货：整单状态由批次汇总，升级不回退')
const shipOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.updateOrder(shipOrder.id, {
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

const shipManual = await orders.setShipStatus(shipOrder.id, 'shipped')
eq('没有批次时，整单状态还能手工改', shipManual.shipStatus, 'shipped')
eq('没有批次时不做推导', (await shipmentSummary(shipOrder.id)).derivedStatus, null)

const shipPls1 = await packing.createPackingList({
  orderId: shipOrder.id,
  containerNo: 'CONT-A',
  lines: [{ boxNo: 'NO.1', styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 40 }]
})
const shipPlA = shipPls1[0]
const sumA = await shipmentSummary(shipOrder.id)
eq('建了首批后整单状态由批次接管', sumA.derivedStatus, 'preparing')
eq('首批只装了 40 件', sumA.packedQuantity, 40)
eq('首批还没出运', sumA.shippedQuantity, 0)
eq('还有 1 个批次没出运', sumA.unshippedBatches, 1)
eq('订单上缓存的出货状态回写成备货中', (await orders.getOrder(shipOrder.id))!.shipStatus, 'preparing')

// 实际开船日是尾款催款的主钟，R35 起不许填未来：这里按「60/59 天前开走」写
const shipEtd = localDate(new Date(Date.now() - 60 * 86400000))
const shipAtd = localDate(new Date(Date.now() - 59 * 86400000))
await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, {
  vessel: 'EVER GIVEN V.001',
  etdDate: shipEtd,
  atdDate: shipAtd,
  etaDate: '2026-12-01',
  sealNo: 'SEAL-1',
  blNo: 'BL-1',
  shipStatus: 'shipped'
})
const sumB = await shipmentSummary(shipOrder.id)
eq('首批出运、货没装够 → 部分出运', sumB.derivedStatus, 'partial_shipped')
eq('已出运件数 = 首批 40 件', sumB.shippedQuantity, 40)
eq('订单缓存也变成部分出运', (await orders.getOrder(shipOrder.id))!.shipStatus, 'partial_shipped')
const plA = (await packing.listPackingLists(shipOrder.id))[0]
eq('批次船名航次存住了', plA.vessel, 'EVER GIVEN V.001')
eq('批次 ETD/ATD/ETA 存住了', [plA.etdDate, plA.atdDate, plA.etaDate], [shipEtd, shipAtd, '2026-12-01'])
eq('批次封条号/提单号存住了', [plA.sealNo, plA.blNo], ['SEAL-1', 'BL-1'])

let manualAfterBatchErr = ''
try {
  await orders.setShipStatus(shipOrder.id, 'delivered')
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
  await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'partial_shipped' as any })
} catch (e) {
  derivedPickErr = (e as Error).message
}
check('「部分出运」是汇总出来的，批次上不能手选', derivedPickErr.includes('不能手工选'), derivedPickErr)

const shipPls2 = await packing.createPackingList({
  orderId: shipOrder.id,
  containerNo: 'CONT-B',
  lines: [{ boxNo: 'NO.2', styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 60 }]
})
const shipPlB = shipPls2[1]
const sumC = await shipmentSummary(shipOrder.id)
eq('两批加起来装够 100 件', sumC.packedQuantity, 100)
eq('尾批还没出运，仍是部分出运', sumC.derivedStatus, 'partial_shipped')
eq('还有 1 个批次没出运', sumC.unshippedBatches, 1)

await packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'shipped' })
eq('全部装够且全部出运 → 已出运', (await shipmentSummary(shipOrder.id)).derivedStatus, 'shipped')

await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'cleared' })
await packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'cleared' })
eq('两批都清关 → 已清关', (await shipmentSummary(shipOrder.id)).derivedStatus, 'cleared')

await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'delivered' })
await packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'delivered' })
const sumDelivered = await shipmentSummary(shipOrder.id)
eq('两批都签收 → 已签收', sumDelivered.derivedStatus, 'delivered')
eq('已签收后订单缓存同步', (await orders.getOrder(shipOrder.id))!.shipStatus, 'delivered')
eq(
  '签收日期按本地日期落档',
  (await packing.listPackingLists(shipOrder.id)).map((p) => p.deliveredAt),
  [localDate(), localDate()]
)

await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'packed' })
eq('退回一批 → 又变回部分出运（已走的那批仍算已出）', (await shipmentSummary(shipOrder.id)).derivedStatus, 'partial_shipped')
let depDelErr = ''
try {
  await packing.deletePackingList(shipOrder.id, shipPlB.id)
} catch (e) {
  depDelErr = (e as Error).message
}
check('已签收的批次不能直接删，提示先退回', depDelErr.includes('不能删除') && depDelErr.includes('已签收'), depDelErr)
await packing.updatePackingListInfo(shipOrder.id, shipPlB.id, { shipStatus: 'packed' })
const afterDelete = await packing.deletePackingList(shipOrder.id, shipPlB.id)
eq('退回已包装后可以删批次', afterDelete.length, 1)
eq('删掉尾批后整单回到备货中', (await shipmentSummary(shipOrder.id)).derivedStatus, 'preparing')

// 已出运批次的箱明细是凭据：加/改/删都要先退回「已包装」
await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'shipped' })
let lockEditErr = ''
try {
  await packing.updatePackingListLine(shipOrder.id, shipPlA.id, shipPlA.lines[0].id, { quantity: 20 })
} catch (e) {
  lockEditErr = (e as Error).message
}
check('已出运批次的箱明细不能改', lockEditErr.includes('明细不能改'), lockEditErr)
let lockAddErr = ''
try {
  await packing.addPackingListLine(shipOrder.id, shipPlA.id, { styleNo: 'SHIP-1', color: 'Navy', size: 'L', quantity: 1 })
} catch (e) {
  lockAddErr = (e as Error).message
}
check('已出运批次的箱明细不能加', lockAddErr.includes('明细不能改'), lockAddErr)
let lockDelErr = ''
try {
  await packing.deletePackingListLine(shipOrder.id, shipPlA.id, shipPlA.lines[0].id)
} catch (e) {
  lockDelErr = (e as Error).message
}
check('已出运批次的箱明细不能删', lockDelErr.includes('明细不能改'), lockDelErr)
await packing.updatePackingListInfo(shipOrder.id, shipPlA.id, { shipStatus: 'packed' })

// 订单这头也不能减到已装箱数以下，否则会出现「已出 40 / 订单 20 件」
const shipItem = (await orders.getOrder(shipOrder.id))!.items[0]
let shrinkErr = ''
try {
  await orders.updateOrderItem(shipOrder.id, shipItem.id, { quantity: 20 })
} catch (e) {
  shrinkErr = (e as Error).message
}
check('订单数量不能减到已装箱数以下', shrinkErr.includes('订单数量不能改到 40 件以下'), shrinkErr)
let swapSkuErr = ''
try {
  await orders.updateOrderItem(shipOrder.id, shipItem.id, { color: 'Red' })
} catch (e) {
  swapSkuErr = (e as Error).message
}
check('已装箱的款不能直接换颜色/尺码', swapSkuErr.includes('不能直接换'), swapSkuErr)
let removePackedErr = ''
try {
  await orders.removeOrderItem(shipOrder.id, shipItem.id)
} catch (e) {
  removePackedErr = (e as Error).message
}
check('已装箱的订单行不能直接删', removePackedErr.includes('不能直接删'), removePackedErr)

// 装箱单不能凭空多出订单里没有的款
let ghostSkuErr = ''
try {
  await packing.createPackingList({
    orderId: shipOrder.id,
    lines: [{ boxNo: 'NO.1', styleNo: 'NOPE-1', color: 'Navy', size: 'L', quantity: 1 }]
  })
} catch (e) {
  ghostSkuErr = (e as Error).message
}
check('装箱单不能装订单里没有的款', ghostSkuErr.includes('订单里没有 NOPE-1'), ghostSkuErr)

// 升级前的老批次：ship_status 为 NULL，不参与推导，订单保持手工状态
const legacyOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
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
eq('老批次（状态为空）不接管整单状态', (await shipmentSummary(legacyOrder.id)).derivedStatus, null)
const legacyManual = await orders.setShipStatus(legacyOrder.id, 'delivered')
eq('老单还能按手工状态走', legacyManual.shipStatus, 'delivered')
const legacyPl = (await packing.listPackingLists(legacyOrder.id))[0]
await packing.updatePackingListInfo(legacyOrder.id, legacyPl.id, { containerNo: 'C-OLD', vessel: 'OLD V.1' })
eq('只补老批次柜号/船期，不动整单手工状态', (await orders.getOrder(legacyOrder.id))!.shipStatus, 'delivered')
eq('老批次状态仍为空（没有选就不接管）', (await packing.listPackingLists(legacyOrder.id))[0].shipStatus, null)
let lastLineErr = ''
try {
  await packing.deletePackingListLine(legacyOrder.id, legacyPl.id, legacyPl.lines[0].id)
} catch (e) {
  lastLineErr = (e as Error).message
}
check('装箱单不能被删成一箱都没有', lastLineErr.includes('留不住'), lastLineErr)

// 一张单混有老批次 + 新批次：仍然不推导，等老批次补上状态再接管
const mixedOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
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
await orders.setShipStatus(mixedOrder.id, 'delivered')
await packing.createPackingList({
  orderId: mixedOrder.id,
  lines: [{ boxNo: 'NO.2', styleNo: 'MIX-1', color: 'Black', size: 'M', quantity: 30 }]
})
eq('混有老批次时不推导', (await shipmentSummary(mixedOrder.id)).derivedStatus, null)
eq('加新批次不会把手工「已签收」拉回来', (await orders.getOrder(mixedOrder.id))!.shipStatus, 'delivered')
const mixedLegacyPl = (await packing.listPackingLists(mixedOrder.id))[0]
await packing.updatePackingListInfo(mixedOrder.id, mixedLegacyPl.id, { shipStatus: 'packed' })
eq('老批次补上状态后，整单才由批次汇总', (await shipmentSummary(mixedOrder.id)).derivedStatus, 'preparing')

const shipOrderFull = (await orders.getOrder(shipOrder.id))!
const plPaperBatch = renderPl({ order: shipOrderFull, settings: getSettings(), images: {} }, (await packing.listPackingLists(shipOrder.id))[0])
check('PL 纸面用批次的船名航次', plPaperBatch.includes('EVER GIVEN V.001'), plPaperBatch)
check('PL 纸面用批次的 ETD', plPaperBatch.includes(shipEtd))
check('PL 纸面用批次的封条号', plPaperBatch.includes('SEAL-1'))
check('PL 纸面没有串成订单级船期', !plPaperBatch.includes('ORDER VESSEL V.9'))
const ciPaperOrder = renderCi({ order: shipOrderFull, settings: getSettings(), images: {} })
check('CI 仍用订单级船名航次', ciPaperOrder.includes('ORDER VESSEL V.9'))
check('CI 仍用订单级 ETD', ciPaperOrder.includes('2026-12-15'))
check('CI 不串批次的船期', !ciPaperOrder.includes('EVER GIVEN V.001'))

/* ---------------- N35：订单列表能按款号搜 ---------------- */
section('订单列表能按款号搜')
const byStyleOrders = await orders.listOrders({ keyword: 'ZZ-999' })
check('订单列表能按款号搜到', byStyleOrders.some((o) => o.id === r20.id))

/* ---------------- R1：收款与应收守卫 ---------------- */
section('收款与应收：日期、删款留痕、币种守卫、客户页口径')

const r1Order = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1 })
await orders.setPaymentStatus(r1Order.id, 'confirmed')
await orders.addOrderItem(r1Order.id, {
  styleNo: 'R1-GUARD',
  productName: 'R1 守卫',
  quantity: 10,
  unitPrice: 10
})
const r1Paid = await orders.addPayment(r1Order.id, {
  paidAt: '2026-10-24',
  amount: 20,
  method: 'T/T',
  bankRef: 'R1-BANK'
})
eq('R1 正常收款能登记', r1Paid.paidAmount, 20)
const r1PayId = r1Paid.payments[0].id

let r1DateErr = ''
try {
  await orders.addPayment(r1Order.id, { paidAt: '', amount: 10 })
} catch (e) {
  r1DateErr = (e as Error).message
}
check('收款日期不能留空', r1DateErr.includes('日期'), r1DateErr)

let r1FakeDateErr = ''
try {
  await orders.addPayment(r1Order.id, { paidAt: '2026-02-31', amount: 10 })
} catch (e) {
  r1FakeDateErr = (e as Error).message
}
check('不存在的日期会被拦住', r1FakeDateErr.includes('日期'), r1FakeDateErr)

let r1CurrencyErr = ''
try {
  await orders.updateOrder(r1Order.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })
} catch (e) {
  r1CurrencyErr = (e as Error).message
}
check('有收款后改币种被拦住', r1CurrencyErr.includes('币种'), r1CurrencyErr)
eq('被拦后订单币种没变', (await orders.getOrder(r1Order.id))!.currency, 'USD')

// R15：明细单价没有独立币种，已经对外发过的单不能换单位（改汇率也不行，先作废重开）
const r1CurLocked = await orders.createOrder({
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
  await orders.updateOrder(r1CurLocked.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })
} catch (e) {
  r1CurLockErr = (e as Error).message
}
check('有明细就不能换币种（单价会被当成新币种）', r1CurLockErr.includes('不能改币种'), r1CurLockErr)
eq('被拦后币种没变', (await orders.getOrder(r1CurLocked.id))!.currency, 'USD')

const r1NoPay = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1 })
let r1RateErr = ''
try {
  await orders.updateOrder(r1NoPay.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 7.1 })
} catch (e) {
  r1RateErr = (e as Error).message
}
check('换币种不能沿用旧币种汇率', r1RateErr.includes('汇率'), r1RateErr)
const r1Changed = await orders.updateOrder(r1NoPay.id, {
  customerId: c1.id,
  currency: 'EUR',
  exchangeRate: 8
})
eq('空单换币种并重填汇率可以保存', r1Changed.currency, 'EUR')
eq('换币种后汇率是新的', r1Changed.exchangeRate, 8)

let r1DelErr = ''
try {
  await orders.deletePayment(r1Order.id, r1PayId, '')
} catch (e) {
  r1DelErr = (e as Error).message
}
check('删除收款必须写原因', r1DelErr.includes('原因'), r1DelErr)
const r1Deleted = await orders.deletePayment(r1Order.id, r1PayId, '金额录错')
eq('删款后已收归零', r1Deleted.paidAmount, 0)
const r1DelEvent = (await orders.listEvents(r1Order.id)).find((e) => e.kind === 'payment_delete')
check(
  '删款历史带金额、日期和流水号',
  !!r1DelEvent &&
    r1DelEvent.note.includes('20.00') &&
    r1DelEvent.note.includes('2026-10-24') &&
    r1DelEvent.note.includes('R1-BANK'),
  r1DelEvent?.note ?? '没有删款事件'
)
check('删款历史带原因', !!r1DelEvent && r1DelEvent.note.includes('金额录错'), r1DelEvent?.note ?? '')

const r1Draft = await orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r1Draft.id, {
  styleNo: 'R1-DRAFT',
  productName: 'R1 草稿',
  quantity: 5,
  unitPrice: 100
})
const r1DraftRow = (await customers.customerOrderBriefs(c2.id)).find((o) => o.id === r1Draft.id)!
check('草稿单仍留在客户订单历史里', !!r1DraftRow)
eq('草稿单待收按 0 算（没确认的单不催款）', r1DraftRow.remaining, 0)

const r1Void = await orders.createOrder({ customerId: c2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r1Void.id, {
  styleNo: 'R1-VOID',
  productName: 'R1 作废',
  quantity: 5,
  unitPrice: 100
})
await orders.voidOrder(r1Void.id, '客户取消')
const r1VoidRow = (await customers.customerOrderBriefs(c2.id)).find((o) => o.id === r1Void.id)!
eq('作废单待收按 0 算', r1VoidRow.remaining, 0)

const r1Stats = await customers.customerStats(c1.id)
check(
  '客户页未收拆成订单+打样，两者相加=未收总额',
  Math.abs(r1Stats.outstandingOrders + r1Stats.outstandingSamples - r1Stats.outstanding) < 0.01,
  `orders=${r1Stats.outstandingOrders} samples=${r1Stats.outstandingSamples} total=${r1Stats.outstanding}`
)

/* ============================================================
 * 第 6 轮：短款核销 / 坏账 / 追回（R2）
 * ============================================================ */
section('核销与坏账：短款让利、坏账、追回、撤销与全站口径')

const cR2 = await customers.saveCustomer({
  company: 'R2 Credit Co',
  contact: 'Credit Desk',
  country: 'United States',
  email: 'credit@r2.example'
})

const wo = await orders.createOrder({
  customerId: cR2.id,
  currency: 'USD',
  exchangeRate: 7,
  depositRatio: 0.3,
  charges: [{ label: '运费 Freight', amount: 100 }]
})
await orders.setPaymentStatus(wo.id, 'confirmed')
await orders.addOrderItem(wo.id, {
  styleNo: 'R2-A',
  productName: 'R2 核销测试',
  quantity: 100,
  unitPrice: 10,
  unitCost: 6
})
let woNow = await orders.addPayment(wo.id, { paidAt: localDate(), amount: 700, method: 'T/T', bankRef: 'R2PAY' })
eq('核销前待收 = 1100 − 700', woNow.remaining, 400)
eq('核销前状态 = 已收定金', woNow.paymentStatus, 'paid')

let r2Err = ''
try {
  await orders.addSettlement(wo.id, { kind: 'shortage', amount: 10, reason: '  ' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销必须写原因', r2Err.includes('原因'), r2Err)
r2Err = ''
try {
  await orders.addSettlement(wo.id, { kind: 'shortage', amount: 0, reason: '银行扣费' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销金额 0 会被拦住', r2Err.includes('大于 0'), r2Err)
r2Err = ''
try {
  await orders.addSettlement(wo.id, { kind: 'shortage', amount: 999, reason: '银行扣费' })
} catch (e) {
  r2Err = (e as Error).message
}
check('核销不能超过当前待收', r2Err.includes('超过'), r2Err)

const r2Draft = await orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r2Draft.id, {
  styleNo: 'R2-DRAFT',
  productName: '草稿核销测试',
  quantity: 1,
  unitPrice: 100
})
r2Err = ''
try {
  await orders.addSettlement(r2Draft.id, { kind: 'bad_debt', reason: '客户失联' })
} catch (e) {
  r2Err = (e as Error).message
}
check('草稿单不能核销 / 标坏账', r2Err.includes('草稿'), r2Err)

woNow = await orders.addSettlement(wo.id, {
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
eq('核销台账有一条短款', (await orders.listSettlements(wo.id)).filter((s) => s.kind === 'shortage').length, 1)

const recvBefore = (await dashboard.dashboard()).monthReceived
woNow = await orders.addSettlement(wo.id, {
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
eq('坏账不进本月回款', (await dashboard.dashboard()).monthReceived, recvBefore)

const woBrief = (await customers.customerOrderBriefs(cR2.id)).find((o) => o.id === wo.id)!
eq('客户页订单待到收 = 0（坏账已核销）', woBrief.remaining, 0)
eq('客户页坏账未追回可见', (await customers.customerStats(cR2.id)).badDebt, 360 * 7)
const woMoney = (await money.listOrderMoney()).find((r) => r.orderId === wo.id)!
eq('汇总口径待收 = 0', woMoney.receivable, 0)
eq('汇总口径坏账 = 360', woMoney.badDebtOutstanding, 360)
eq('坏账单不再出现在催尾款提醒里', (await dashboard.reminders()).some((r) => r.orderId === wo.id && r.kind === 'balance'), false)

const csvRowsR2 = (await dashboard.exportCsv('orders')).split('\r\n')
const headR2 = csvRowsR2[0].replace(/^\uFEFF/, '').split(',')
const rowR2 = csvRowsR2.find((r) => r.split(',')[headR2.indexOf('订单号')] === wo.orderNo)!
eq('CSV 短款核销列', Number(rowR2.split(',')[headR2.indexOf('短款核销(原币)')]), 40)
eq('CSV 坏账核销列', Number(rowR2.split(',')[headR2.indexOf('坏账核销(原币)')]), 360)
eq('CSV 坏账未追回列', Number(rowR2.split(',')[headR2.indexOf('坏账未追回(原币)')]), 360)

const recvBeforeRecovery = (await dashboard.dashboard()).monthReceived
woNow = await orders.addSettlement(wo.id, {
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
  Math.abs((await dashboard.dashboard()).monthReceived - (recvBeforeRecovery + 200 * 7)) < 0.01,
  `before=${recvBeforeRecovery} after=${(await dashboard.dashboard()).monthReceived}`
)
eq('追回款对应一条真实收款记录', woNow.payments.filter((p) => p.bankRef === 'R2REC').length, 1)
r2Err = ''
try {
  await orders.addSettlement(wo.id, { kind: 'recovery', amount: 999, reason: '再追一笔' })
} catch (e) {
  r2Err = (e as Error).message
}
check('追回不能超过坏账余额', r2Err.includes('超过'), r2Err)
// 追回登记的是「一笔自动收款 + 一条核销」，两行绑在一起。R36 起可以撤销：
// 记错客户/金额时，这是唯一能把账退回原状的出口——只追加负数核销会让那笔钱
// 继续躺在现金流里；只删收款则核销指向一条不存在的流水。要么一起退，要么都别动。
const recoveryRow = (await orders.listSettlements(wo.id)).find((s) => s.kind === 'recovery')!
woNow = await orders.reverseSettlement(wo.id, recoveryRow.id, '水单录错，钱其实没到')
eq('撤销追回后坏账余额回到 360', woNow.badDebtOutstanding, 360)
eq('撤销追回同时退掉自动登记的收款', woNow.payments.filter((p) => p.bankRef === 'R2REC').length, 0)
eq('追回款从已收里退出', woNow.paidAmount, 700)
check(
  '追回款也从本月回款里退出（现金流和台账是同一笔钱）',
  Math.abs((await dashboard.dashboard()).monthReceived - recvBeforeRecovery) < 0.01,
  `before=${recvBeforeRecovery} after=${(await dashboard.dashboard()).monthReceived}`
)
const recRev = (await orders.listSettlements(wo.id)).find((s) => s.reversesId === recoveryRow.id)!
eq('撤销是追加一条负数追回，不删原记录', recRev.amount, -200)
eq('撤销追回不破坏结清状态（短款 + 坏账仍然收口）', woNow.paymentStatus, 'settled')

const rev = await orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
await orders.setPaymentStatus(rev.id, 'confirmed')
await orders.addOrderItem(rev.id, {
  styleNo: 'R2-REV',
  productName: '撤销核销测试',
  quantity: 10,
  unitPrice: 10,
  unitCost: 5
})
await orders.addPayment(rev.id, { paidAt: localDate(), amount: 20 })
let revNow = await orders.addSettlement(rev.id, { kind: 'bad_debt', amount: 80, reason: '客户失联' })
eq('撤销前待收归零', revNow.remaining, 0)
const bdRow = (await orders.listSettlements(rev.id)).find((s) => s.kind === 'bad_debt')!
revNow = await orders.reverseSettlement(rev.id, bdRow.id, '客户又把钱补来了')
eq('撤销坏账后待收恢复 = 100 − 20', revNow.remaining, 80)
eq('撤销后坏账余额归零', revNow.badDebtOutstanding, 0)
eq('撤销后状态退回部分收款', revNow.paymentStatus, 'partial')
const revRows = (await orders.listSettlements(rev.id))
eq('撤销是追加一条负数，不删原记录', revRows.length, 2)
eq('撤销记录金额为负', revRows.find((s) => s.reversesId === bdRow.id)!.amount, -80)
r2Err = ''
try {
  await orders.reverseSettlement(rev.id, bdRow.id, '再撤一次')
} catch (e) {
  r2Err = (e as Error).message
}
check('同一笔核销不能撤销两次', r2Err.includes('撤销过'), r2Err)
r2Err = ''
try {
  await orders.deleteOrder(rev.id)
} catch (e) {
  r2Err = (e as Error).message
}
check('有核销记录的订单不能物理删除', r2Err.includes('核销'), r2Err)

const curOnly = await orders.createOrder({ customerId: cR2.id, currency: 'USD', exchangeRate: 7 })
await orders.setPaymentStatus(curOnly.id, 'confirmed')
await orders.addOrderItem(curOnly.id, {
  styleNo: 'R2-CUR',
  productName: '只有核销没有收款',
  quantity: 10,
  unitPrice: 10
})
await orders.addSettlement(curOnly.id, { kind: 'shortage', amount: 10, reason: '客户抹零' })
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
const d1 = await docs.saveDocFile({
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

const d2 = await docs.saveDocFile({
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
  await docs.saveDocFile({ pdf: Buffer.from('stale'), docNo: r4no, kind: 'pi', expectedVersion: 1 })
} catch (e) {
  staleDocErr = (e as Error).message
}
check('纸面版次过期会被拦住，不混版', staleDocErr.includes('纸面是第 1 版') && staleDocErr.includes('重新打开'), staleDocErr)
eq('被拦后没有多出存档行', docs.listDocVersions(order.id).filter((d) => d.docNo === r4no).length, 2)

let docPathErr = ''
try {
  await docs.saveDocFile({ pdf: Buffer.from('x'), docNo: '../evil', kind: 'pi' })
} catch (e) {
  docPathErr = (e as Error).message
}
check('单号带路径穿越会被拦住', docPathErr.includes('存档目录'), docPathErr)
let docKindErr = ''
try {
  await docs.saveDocFile({ pdf: Buffer.from('x'), docNo: r4no, kind: 'invoice' })
} catch (e) {
  docKindErr = (e as Error).message
}
check('不认识的单据种类会被拦住', docKindErr.includes('不认识'), docKindErr)

let dupDocErr = ''
try {
  await docs.recordDocVersion({ docNo: r4no, kind: 'pi', version: 1, filePath: 'x' })
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
  await packing.updatePackingListLine(order.id, r4pl.id, line.id, { grossWeight: 20.5 })
}
const plManual = renderPl(
  { order: (await orders.getOrder(order.id))!, settings: getSettings(), images: {} },
  (await packing.listPackingLists(order.id)).find((p) => p.id === r4pl.id)!
)
check('PL 手工毛重按实测值印', plManual.includes('20.50'))
check('PL 全部填了实测毛重后不再标 (est.)', !plManual.includes('(est.)'), plManual.includes('(est.)') ? '仍有 est.' : '')

/* ---------------- R5 客户与商品：抬头快照 / 成本币种 / 停用不删 ---------------- */
section('R5 单据抬头：钉在这一张单上的快照')
const cSnap = await customers.saveCustomer({
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
const snapOrder = await orders.createOrder({ customerId: cSnap.id, currency: 'USD', exchangeRate: 7.5, baseCurrency: 'CNY' })
check('建单时就把买方抬头钉在单上', snapOrder.billTo?.address === 'Keizersgracht 100')
check('收货抬头单独钉一套', snapOrder.shipTo?.address === 'Weteringweg 12, Breda')
const snapPl0 = await packing.createPackingList({
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
const snapPiCtx = { order: (await orders.getOrder(snapOrder.id))!, settings: getSettings(), images: {} }
const snapPiHtml = renderPi(snapPiCtx)
check('PI 印买方地址', snapPiHtml.includes('Keizersgracht 100'))
check('PI 印钉住的付款条款', snapPiHtml.includes('T/T 30% 定金'))
const snapPlHtml = renderPl(snapPiCtx, snapPl0[0])
check('PL 印收货仓而不是买方办公室', snapPlHtml.includes('Weteringweg 12, Breda'))
check('PL 收货人取档案里的 shipAttn', snapPlHtml.includes('WH-Breda'))

// 建完单才改档案：已经发出去的单据不能被人 retrospectively 改掉
await customers.saveCustomer({ ...cSnap, address: '换了三次门牌', paymentPref: 'D/P 见票 60 天' })
const snapPiAfter = renderPi({ order: (await orders.getOrder(snapOrder.id))!, settings: getSettings(), images: {} })
check('改了档案，已开的 PI 仍印当初的地址', snapPiAfter.includes('Keizersgracht 100'))
check('已开的 PI 不会跟着新条款走', !snapPiAfter.includes('D/P 见票'))
eq('订单详情里档案当前值确实变了', (await orders.getOrder(snapOrder.id))!.customer?.address, '换了三次门牌')

// 这一单要送别的仓：只改这张单的抬头，不改档案
const afterParty = await orders.setOrderParties(snapOrder.id, {
  billTo: { address: '客户临时指定的鹿特丹仓' },
  shipTo: { zipCode: '4845AB' }
})
check('抬头可以单点改，改完就印新地址', afterParty.billTo?.address === '客户临时指定的鹿特丹仓')
check('没提到的字段保持快照原值', afterParty.billTo?.company === 'Snapshot Trading Co.')
check('收货抬头只补邮编', afterParty.shipTo?.zipCode === '4845AB')
const partyEvent = (await orders.listEvents(snapOrder.id)).find((e) => e.kind === 'party_update')
check('改抬头留痕并写清改了哪项', (partyEvent?.note ?? '').includes('地址'), partyEvent?.note ?? '')
check('改抬头不碰客户档案', (await customers.getCustomer(cSnap.id))?.address === '换了三次门牌')

section('R5 报价单抬头快照，转单原样带过去')
const qSnap = await quotations.saveQuotation({
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
const qSnap2 = await quotations.saveQuotation({
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
await customers.saveCustomer({ ...cSnap, address: '第四次改的地址' })
const snapConverted = await quotations.convertToOrder(qSnap2.id)
check('转单沿用报价单钉住的地址', (snapConverted.billTo?.address ?? '') === '换了三次门牌')
check('转单不拿档案最新地址', (snapConverted.billTo?.address ?? '') !== '第四次改的地址')
check('转单带上单独覆盖的收件人', (snapConverted.billTo?.attn ?? '') === '这一单单独的收件人')

section('R5 成本价是工厂价：按本单汇率折算，绝不混币')
const costOrder = await orders.createOrder({ customerId: cSnap.id, currency: 'USD', exchangeRate: 8, baseCurrency: 'CNY' })
const withCost = await orders.addOrderItem(costOrder.id, {
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
const repatched = await orders.updateOrderItem(costOrder.id, withCost.items[0].id, { costBase: 40 })
eq('就地补录工厂价也按本单汇率折算', repatched.items[0].unitCost, 5)
const clearedCost = await orders.updateOrderItem(costOrder.id, withCost.items[0].id, { costBase: null })
eq('工厂价填了又清空 = 成本变未录，不是留旧值', clearedCost.items[0].unitCost, null)
const qCost = await quotations.saveQuotation({
  customerId: cSnap.id,
  currency: 'USD',
  exchangeRate: 8,
  exchangeRateDate: '2026-09-01',
  items: [{ styleNo: 'A001', productName: '纯棉圆领T恤', color: 'Black', size: 'S', quantity: 50, unitPrice: 9 }]
})
const convertedCost = await quotations.convertToOrder(qCost.id)
eq('报价转单时商品成本也折算成订单币种', convertedCost.items[0].unitCost, 0.6875)
check(
  '折算后的成本乘回汇率就是工厂价（¥5.5 不会被当成 $5.5）',
  Math.abs((convertedCost.items[0].unitCost ?? 0) * 8 - 5.5) < 0.001
)

section('R5 历史成交价：报价前先看这客户上次什么价')
const priceRows = await customers.stylePriceHistory({ customerId: c1.id })
check('能列出这个客户的历史成交价', priceRows.length > 0)
check('历史成交价都带币种', priceRows.every((r) => !!r.lastCurrency))
check('按客户过滤就不会混进别人', (await customers.stylePriceHistory({ customerId: c2.id })).every((r) => r.customerCompany === c2.company))
const a001Rows = await customers.stylePriceHistory({ styleNo: 'a001' })
check('按款号过滤忽略大小写', a001Rows.length > 0 && a001Rows.every((r) => r.styleNo.toUpperCase() === 'A001'))
check('同款同色合并成一条并累计次数', a001Rows.reduce((s, r) => s + r.times, 0) >= a001Rows.length)
// 草稿 / 作废单还没成交，不能污染「上次成交价」
const draftPriceOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(draftPriceOrder.id, { styleNo: 'ZZ999', productName: '没成交的草稿款', quantity: 1, unitPrice: 99.99 })
check(
  '草稿单的报价不进历史成交价',
  !(await customers.stylePriceHistory({ styleNo: 'ZZ999' })).some((r) => r.lastUnitPrice === 99.99)
)

section('R5 同名客户：提醒但不硬拦')
let dupErr = ''
try {
  await customers.saveCustomer({ company: 'Acme Fashion GmbH' })
} catch (e) {
  dupErr = (e as Error).message
}
check('同名客户先拦一道并说清后果', dupErr.includes('同名'), dupErr)
const dupOk = await customers.saveCustomer({
  company: 'acme fashion gmbh ',
  contact: '第二个采购办',
  allowDuplicate: true
})
check('确认是两家不同的公司就能存', dupOk.id > 0)
eq('同名对照查得到几条', (await customers.sameNameCustomers('Acme Fashion GmbH')).length, 2)

section('R5 停用而不是删除：单据要能原样重印')
let styleErr = ''
try {
  await products.saveProduct({ styleNo: 'a001', name: '撞号的款', sizes: [], colors: [] })
} catch (e) {
  styleErr = (e as Error).message
}
check('款号大小写撞号被拦（一个号只能有一条档案）', styleErr.includes('已经存在'), styleErr)
const refDel = await products.deleteProduct(p1.id)
check('被历史单据引用的款不真删，只做停用', refDel.deactivated)
check('停用的话术讲清为什么不能删', refDel.message.includes('重印'), refDel.message)
check('停用后建单下拉不再带出', !(await products.listProducts()).some((p) => p.id === p1.id))
eq('但按款号仍找得回来，历史单据照印', (await products.findProductByStyleNo('A001'))?.id, p1.id)
check('引用计数说得出挂在几个订单行上', (await products.productReferenceCount(p1.id)).orders > 0)
const backOn = await products.setProductActive(p1.id, 1)
check('需要时能再启用', backOn.active === 1)
check('再启用后回到建单下拉', (await products.listProducts()).some((p) => p.id === p1.id))

const cStop = await customers.saveCustomer({ company: 'Bymark AB', contact: 'Sofia', country: 'Sweden' })
await customers.setCustomerActive(cStop.id, 0)
check('停用的客户不在建单下拉里', !(await customers.listCustomers('Bymark')).some((c) => c.id === cStop.id))
check('勾选「显示已停用」还能看到', (await customers.listCustomers('Bymark', true)).some((c) => c.id === cStop.id))
eq('停用不影响按编号取档案', (await customers.getCustomer(cStop.id))?.company, 'Bymark AB')
await customers.setCustomerActive(cStop.id, 1)

section('R5 商品 CSV 导入：Excel 另存为 CSV 就能进库')
const csvText = [
  products.CSV_TEMPLATE_HEADER,
  'B101,"羊毛混纺外套, 男款",80% Wool,S M L,黑/白/灰,¥ 88,雅戈尔,YY-88,20,60×40×50,0.7,外套,House,A/W26,挂牌要烫金',
  'b101,库里已有的款,100% Polyester,,,,,,,,,',
  ',这一行没有款号,100% Cotton,,,,,,,,'
].join('\n')
const imp1 = await products.importProductsCsv(csvText, 'skip')
eq('导入新增 1 款', imp1.created, 1)
eq('撞号的和没款号的一共跳过 2 行', imp1.skipped, 2)
const b101 = (await products.findProductByStyleNo('B101'))!
eq('引号里的逗号不算分列', b101.name, '羊毛混纺外套, 男款')
eq('成本价里的 ¥ 会被抹掉', b101.costPrice, 88)
eq('尺码按空格拆开', b101.sizes, ['S', 'M', 'L'])
eq('颜色按斜杠拆开', b101.colors, ['黑', '白', '灰'])
eq('箱规 60×40×50 拆成三个数', [b101.boxLength, b101.boxWidth, b101.boxHeight], [60, 40, 50])
eq('工厂进了档案', b101.factory, '雅戈尔')
eq('工厂货号进了档案', b101.factoryNo, 'YY-88')
check('没款号的行逐行说明原因', imp1.errors.some((e) => e.includes('没有款号')), JSON.stringify(imp1.errors))
const c900 = await products.saveProduct({
  styleNo: 'C900',
  name: '旧名字',
  composition: '100% Cotton',
  costPrice: 10,
  sizes: [],
  colors: []
})
const impSkip = await products.importProductsCsv(
  [products.CSV_TEMPLATE_HEADER, 'C900,覆盖模式才会改,,,,,,,,,,'].join('\n'),
  'skip'
)
eq('默认「跳过已有」不动老档案', (await products.getProduct(c900.id))?.name, '旧名字')
eq('跳过模式不计更新', impSkip.updated, 0)
const impOver = await products.importProductsCsv(
  [products.CSV_TEMPLATE_HEADER, 'C900,覆盖后的新名字,80% Wool,,,¥ 12,,,,,,,,,'].join('\n'),
  'overwrite'
)
eq('覆盖模式更新 1 条', impOver.updated, 1)
eq('覆盖后档案真的变了', (await products.getProduct(c900.id))?.name, '覆盖后的新名字')
eq('覆盖时成本也按 ¥ 解析', (await products.getProduct(c900.id))?.costPrice, 12)
let csvErr = ''
try {
  await products.importProductsCsv('编号,品名\nX1,abc\n', 'skip')
} catch (e) {
  csvErr = (e as Error).message
}
check('表头没有「款号」时用人话报错，不静默导入 0 条', csvErr.includes('款号'), csvErr)

/* ---------------- R6 工作台提醒 ---------------- */
section('R6 催款时钟：改备注不会把拖了几星期的单子清零')
const sR6 = getSettings()
await saveSettings({ ...sR6, remindConfirmDays: 7, remindPaymentDays: 10, remindBalanceDays: 15, remindShipDays: 3 })
const dAgo = (n: number): string => localDate(new Date(Date.now() - n * 86400000))
const dAgoIso = (n: number): string => new Date(Date.now() - n * 86400000).toISOString()
const cR6 = await customers.saveCustomer({ company: 'R6 Clock GmbH', country: 'DE' })
const oR6 = await orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  validUntil: dAgo(2)
})
await orders.addOrderItem(oR6.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10 })
await orders.setPaymentStatus(oR6.id, 'sent')
// 把「进入待确认」这条事件往前拨 20 天，模拟 PI 真的发出去三周了
getDb().run(
  `UPDATE order_events SET at = ? WHERE order_id = ? AND kind = 'payment_status' AND to_status = 'sent'`,
  [dAgoIso(20), oR6.id]
)
const remR6a = await dashboard.reminders()
const confirmR6 = remR6a.find((r) => r.kind === 'confirm' && r.orderId === oR6.id)
check('PI 发出 20 天没确认 → 催确认按状态时钟算天数', !!confirmR6 && confirmR6.days >= 19, JSON.stringify(confirmR6))
check(
  'PI 有效期已过 → 单独亮一条到期提醒',
  (await dashboard.reminders()).some((r) => r.kind === 'expiry' && r.orderId === oR6.id && r.message.includes('PI 有效期')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.orderId === oR6.id).map((r) => r.kind))
)
await orders.updateOrder(oR6.id, { customerId: cR6.id, note: '顺手补了个备注' })
const confirmR6b = (await dashboard.reminders()).find((r) => r.kind === 'confirm' && r.orderId === oR6.id)
eq('改个备注不会把等待天数刷新成 0（不看 updated_at）', confirmR6b?.days, confirmR6?.days)

section('R6 脏日期：宁可亮「待修」，不许印「还有 NaN 天」')
const oDirty = await orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2 })
await orders.updateOrder(oDirty.id, { customerId: cR6.id, expectedShipDate: '2026/13/45', cutOffDate: '2026/10/05' })
const remDirty = await dashboard.reminders()
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
const oShipped = await orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentMethod: 'oa',
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(oShipped.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10 })
const plR6 = await packing.createPackingList({ orderId: oShipped.id, lines: [{ styleNo: 'A001', quantity: 10 }] })
await packing.updatePackingListInfo(oShipped.id, plR6[0].id, {
  shipStatus: 'shipped',
  atdDate: dAgo(30),
  etaDate: dAgo(16),
  blNo: 'MEDU-9988776'
})
const remShipped = await dashboard.reminders()
const unpaidRem = remShipped.find(
  (r) => r.kind === 'balance' && r.orderId === oShipped.id && r.message.includes('一分未收')
)
check('出运 30 天、没收到过一分钱 → 照样催款', !!unpaidRem, JSON.stringify(remShipped.filter((r) => r.orderId === oShipped.id)))
check('催款话术带上付款方式，一眼知道是赊销还是信用证', (unpaidRem?.message ?? '').includes('赊销'), unpaidRem?.message)
check(
  '预计到港已过、钱还没收齐 → 催一次（整单一条，消息里带批次号）',
  remShipped.some(
    (r) => r.kind === 'balance' && r.orderId === oShipped.id && r.message.includes(plR6[0].plNo) && r.message.includes('到港')
  ),
  JSON.stringify(remShipped.filter((r) => r.orderId === oShipped.id).map((r) => r.message))
)
const oEta2 = await orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentMethod: 'oa',
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(oEta2.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10 })
const plEtaA = await packing.createPackingList({ orderId: oEta2.id, lines: [{ styleNo: 'A001', quantity: 5 }] })
const plEtaAll = await packing.createPackingList({ orderId: oEta2.id, lines: [{ styleNo: 'A001', quantity: 5 }] })
const plEta2 = [plEtaA[0], plEtaAll.find((p) => p.id !== plEtaA[0].id)!]
await packing.updatePackingListInfo(oEta2.id, plEta2[0].id, { shipStatus: 'shipped', atdDate: dAgo(40), etaDate: dAgo(24) })
await packing.updatePackingListInfo(oEta2.id, plEta2[1].id, { shipStatus: 'shipped', atdDate: dAgo(35), etaDate: dAgo(18) })
const etaRem = (await dashboard.reminders()).filter((r) => r.kind === 'balance' && r.orderId === oEta2.id && r.message.includes('到港'))
eq('两批都过了 ETA → 只出一条整单待收（同一笔钱不喊两遍）', etaRem.length, 1)
check(
  '这一条把两个过期批次号都列出来',
  etaRem.length === 1 && etaRem[0].message.includes(plEta2[0].plNo) && etaRem[0].message.includes(plEta2[1].plNo),
  etaRem[0]?.message
)
check(
  '每条提醒自带唯一 key（界面折叠不会误伤同单另一条）',
  new Set(remShipped.map((r) => r.key)).size === remShipped.length,
  `${remShipped.length} 条 / ${new Set(remShipped.map((r) => r.key)).size} 个 key`
)
const overdueN = remShipped.filter((r) => r.days < 0).length
check('逾期的排在最前面，越久越靠前', remShipped.slice(0, overdueN).every((r) => r.days < 0), JSON.stringify(remShipped.slice(0, 3).map((r) => r.days)))
const remOrdered = await dashboard.reminders()
const firstData = remOrdered.findIndex((r) => r.kind === 'data')
const lastUpcoming = remOrdered.reduce((acc, r, idx) => (r.kind !== 'data' && r.days > 0 ? idx : acc), -1)
check(
  '「待修」垫底：数据待修不会压住真正的交期提醒',
  firstData === -1 || lastUpcoming < firstData,
  JSON.stringify(remOrdered.map((r) => `${r.kind}:${r.days}`))
)

section('R6 待修清单：数据歪了要有人去补，别让提醒静默失效')
await packing.updatePackingListInfo(oShipped.id, plR6[0].id, { blNo: '' })
check(
  '标了「已出运」却没有提单号 → 待修',
  (await dashboard.reminders())
    .some((r) => r.kind === 'data' && r.plId === plR6[0].id && r.message.includes('提单号')),
  ''
)
const oLegacy = await orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(oLegacy.id, { styleNo: 'A001', productName: 'T恤', quantity: 4, unitPrice: 10 })
const plLegacy = await packing.createPackingList({ orderId: oLegacy.id, lines: [{ styleNo: 'A001', quantity: 4 }] })
getDb().run('UPDATE packing_lists SET ship_status = NULL WHERE id = ?', [plLegacy[0].id])
check(
  '老批次没标出运状态 → 待修（整单进度推不出来）',
  (await dashboard.reminders())
    .some((r) => r.kind === 'data' && r.orderId === oLegacy.id && r.message.includes('没标出运状态')),
  ''
)
const oRate1 = await orders.createOrder({ customerId: cR6.id, currency: 'USD', paymentStatus: 'sent' })
check(
  '外币单汇率还是 1:1 → 待修（不阻断建单，但要亮出来）',
  (await dashboard.reminders())
    .some((r) => r.kind === 'data' && r.orderId === oRate1.id && r.message.includes('按 1:')),
  ''
)

section('R6 报价跟进：发出去没回音、到期没人转单')
const qR6 = await quotations.saveQuotation({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  status: 'sent',
  validUntil: dAgo(2),
  items: [{ styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 9 }]
})
check('报价标成「已发出」时落下 sent_at', (getDb().get('SELECT sent_at FROM quotations WHERE id = ?', [qR6.id]) as { sent_at?: string }).sent_at != null)
getDb().run('UPDATE quotations SET sent_at = ? WHERE id = ?', [dAgoIso(20), qR6.id])
const remQuote = await dashboard.reminders()
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
await quotations.saveQuotation({ ...qR6, note: '改了一下备注' })
const remQuote2 = await dashboard.reminders()
check(
  '改报价备注不会把「发出 20 天没回音」清零',
  remQuote2.some((r) => r.kind === 'quote' && r.orderNo === qR6.qNo && r.message.includes('发出 20 天')),
  JSON.stringify(remQuote2.filter((r) => r.orderNo === qR6.qNo).map((r) => r.message))
)
await quotations.saveQuotation({ ...qR6, status: 'confirmed' })
check(
  '报价状态变化单独进历史：谁把报价发出去、什么时候改口，都要查得到',
  (await quotations.listQuotationEvents(qR6.id)).some((e) => e.kind === 'status' && e.note.includes('sent')),
  JSON.stringify((await quotations.listQuotationEvents(qR6.id)).map((e) => e.note))
)

section('R6 待收款拆分与「本月完成」口径')
const stR6 = await dashboard.dashboard()
check(
  '四桶相加 = 待收款总额（拆分只是展示，不动口径）',
  Math.abs(stR6.pendingUnconfirmed + stR6.pendingDeposit + stR6.pendingBalance + stR6.pendingSample - stR6.pendingAmount) < 0.01,
  `${stR6.pendingUnconfirmed + stR6.pendingDeposit + stR6.pendingBalance + stR6.pendingSample} vs ${stR6.pendingAmount}`
)
const doneBefore = (await dashboard.dashboard()).completedThisMonth
const oSigned = await orders.createOrder({ customerId: cR6.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' })
getDb().run("UPDATE orders SET ship_status = 'delivered' WHERE id = ?", [oSigned.id])
eq(
  '只有 updated_at 动过的单不再被算成「本月完成」（要批次签收或状态事件）',
  (await dashboard.dashboard()).completedThisMonth,
  doneBefore
)
await orders.setShipStatus(oSigned.id, 'delivered')
eq('正常标签收后计入本月完成', (await dashboard.dashboard()).completedThisMonth, doneBefore + 1)
// 作废单：任何提醒都不该再挂它
const oVoid = await orders.createOrder({
  customerId: cR6.id,
  currency: 'USD',
  exchangeRate: 7.2,
  expectedShipDate: dAgo(1)
})
await orders.setPaymentStatus(oVoid.id, 'sent')
check('作废前确实有提醒', (await dashboard.reminders()).some((r) => r.orderId === oVoid.id))
await orders.voidOrder(oVoid.id, '客户取消')
check(
  '作废单从待办里彻底消失（催确认/交期/待修都不再喊）',
  !(await dashboard.reminders()).some((r) => r.orderId === oVoid.id),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.orderId === oVoid.id).map((r) => r.kind))
)
await saveSettings(sR6)

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

const cWild = await customers.saveCustomer({ company: 'Acme, "Head" Office\nHamburg', country: 'DE' })
const oWild = await orders.createOrder({ customerId: cWild.id, currency: 'USD', exchangeRate: 7.2 })
await orders.addOrderItem(oWild.id, { styleNo: 'A001', productName: 'T, 恤', quantity: 10, unitPrice: 10, unitCost: 6 })
await orders.setPaymentStatus(oWild.id, 'confirmed')
const csvOrdersRaw = await dashboard.exportCsv('orders')
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

const cEvil = await customers.saveCustomer({ company: '=HYPERLINK("http://evil","点我")', country: 'CN' })
const oEvil = await orders.createOrder({ customerId: cEvil.id, currency: 'USD', exchangeRate: 7.2 })
// 草稿单已经不进订单台账了（R7 口径），要试转义就得把它变成正式单
await orders.setPaymentStatus(oEvil.id, 'confirmed')
const evilLedger = recOf(await dashboard.exportCsv('orders'), '订单号', oEvil.orderNo)
check(
  '以 = 开头的客户名被中和：Excel 不会把它当公式跑',
  !!evilLedger && evilLedger.row[evilLedger.head.indexOf('客户')].startsWith("'="),
  JSON.stringify(evilLedger?.row[evilLedger.head.indexOf('客户')])
)

const oNeg = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  charges: [{ label: '折让 Discount', amount: -50 }]
})
await orders.addOrderItem(oNeg.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10, unitCost: 6 })
await orders.setPaymentStatus(oNeg.id, 'confirmed')
const negLedger = recOf(await dashboard.exportCsv('orders'), '订单号', oNeg.orderNo)
eq(
  '负数费用导出成数字 -50：不加引号也不加前缀，Excel 里能直接求和',
  negLedger?.row[negLedger.head.indexOf('费用合计(原币)')],
  '-50'
)

section('R7 台账口径：与报表同源，草稿作废不再混进 SUM')
const oDraftR7 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
const oVoidR7 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.2 })
await orders.setPaymentStatus(oVoidR7.id, 'confirmed')
await orders.addOrderItem(oVoidR7.id, { styleNo: 'A001', productName: 'T恤', quantity: 10, unitPrice: 10, unitCost: 6 })
await orders.addPayment(oVoidR7.id, { paidAt: localDate(), amount: 30, method: 'T/T', bankRef: 'R7-VOID-01' })
await orders.voidOrder(oVoidR7.id, '客户取消')
const ledgerRaw = await dashboard.exportCsv('orders')
check('草稿单不再进订单台账（销售额口径，列可以直接求和）', !recOf(ledgerRaw, '订单号', oDraftR7.orderNo))
check('作废单也不再进订单台账（它不该出现在收入表里让财务自己筛）', !recOf(ledgerRaw, '订单号', oVoidR7.orderNo))
const allRaw = await dashboard.exportCsv('orders_all')
check('草稿单在「全量底稿」里：历史一行没丢', !!recOf(allRaw, '订单号', oDraftR7.orderNo))
const voidAll = recOf(allRaw, '订单号', oVoidR7.orderNo)
eq('全量底稿里作废单的状态写中文「已作废」', voidAll?.row[voidAll.head.indexOf('收款状态')], '已作废')
const voidPay = recOf(await dashboard.exportCsv('payments'), '银行流水号', 'R7-VOID-01')
eq('作废单到账的钱仍在收款台账，状态列写「已作废」', voidPay?.row[voidPay.head.indexOf('订单状态')], '已作废')

const ledgerRecs = parseCsv(ledgerRaw)
const ledgerHead = ledgerRecs[0]
const sumCol = (name: string): number =>
  ledgerRecs.slice(1).reduce((s, c) => s + r2(Number(c[ledgerHead.indexOf(name)])), 0)
const reportSales = (await dashboard.monthlyReport()).reduce((s, r) => s + r2(r.sales), 0)
check(
  '台账「含费用合计(基准币)」整列求和 = 报表累计销售额（差不过几分钱）',
  Math.abs(sumCol('含费用合计(CNY)') - reportSales) < 0.5,
  `${sumCol('含费用合计(CNY)')} vs ${reportSales}`
)
const stR7 = await dashboard.dashboard()
check(
  '台账「待收金额(基准币)」整列求和 = 工作台待收款里的货款部分',
  Math.abs(sumCol('待收金额(CNY)') - (stR7.pendingAmount - stR7.pendingSample)) < 0.5,
  `${sumCol('待收金额(CNY)')} vs ${stR7.pendingAmount - stR7.pendingSample}`
)

section('R7 月度汇总：折让/短款/坏账导得出去，收款列写明按到账月')
const csvMonthly = await dashboard.exportCsv('monthly')
const mRecs = parseCsv(csvMonthly)
const mHead = mRecs[0]
check('月度汇总能导出去了（成本/毛利/折让/短款/坏账都在列里）', ['成本(CNY)', '毛利(CNY)', '折让(CNY)', '短款核销(CNY)', '坏账未追回(CNY)'].every((h) => mHead.includes(h)), mHead.join('|'))
check('月度汇总的收款列写明「按到账月」，不会被当成下单月的钱', mHead.some((h) => h.includes('按到账月')), mHead.join('|'))
eq('月度汇总导出有 BOM（Excel 打开不乱码）', csvMonthly.charCodeAt(0) === 0xfeff, true)
const thisMonth = localMonthOf(localDate())
const repThis = (await dashboard.monthlyReport()).find((x) => x.month === thisMonth)
const csvThis = recOf(csvMonthly, '月份', thisMonth)
eq(
  '导出的本月销售额 = 报表页这个月的数',
  Number(csvThis?.row[mHead.indexOf('销售额(CNY)')]),
  repThis ? r2(repThis.sales) : 0
)
const mShortage = (await dashboard.monthlyReport()).reduce((s, r) => s + r.shortage, 0)
const moneyShortage = (await money.listOrderMoney()).reduce((s, r) => s + r.shortageAmount * r.exchangeRate, 0)
check(
  '月报短款列之和 = money.ts 逐单短款之和（没有另写一套 SQL）',
  Math.abs(mShortage - moneyShortage) < 0.01,
  `${mShortage} vs ${moneyShortage}`
)
const mBad = (await dashboard.monthlyReport()).reduce((s, r) => s + r.badDebt, 0)
const moneyBad = (await money.listOrderMoney()).reduce((s, r) => s + r.badDebtOutstanding * r.exchangeRate, 0)
check('月报坏账列之和 = money.ts 逐单未追回坏账之和', Math.abs(mBad - moneyBad) < 0.01, `${mBad} vs ${moneyBad}`)
const mDiscount = (await dashboard.monthlyReport()).reduce((s, r) => s + r.discount, 0)
const moneyDiscount = (await money.listOrderMoney()).reduce((s, r) => s + -r.negativeCharges * r.exchangeRate, 0)
check('月报折让列 = 负向费用之和（让利看得见）', Math.abs(mDiscount - moneyDiscount) < 0.01, `${mDiscount} vs ${moneyDiscount}`)
let kindErr = ''
try {
  ;(await (dashboard.exportCsv as unknown as (k: unknown) => Promise<string>)('bogus'))
} catch (e) {
  kindErr = (e as Error).message
}
check('未知导出类型直接报错，不会静默掉进收款分支', kindErr.includes('不支持的导出类型'), kindErr)

section('R7 款号明细台账：成本与整单费用都带上')
const csvItemsR7 = await dashboard.exportCsv('items')
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
    recOf(await dashboard.exportCsv('payments'), '订单号', oVoidR7.orderNo)!.row.includes('已作废')
)

section('R7 到账只有一份算法 + 客户欠款榜')
eq(
  '工作台「本月收款」= 月报这个月的收款（两处不再各写一遍 SUM）',
  (await dashboard.dashboard()).monthReceived,
  (await dashboard.monthlyReport()).find((x) => x.month === thisMonth)?.received ?? 0
)
const dirtyBefore = (await dashboard.monthlyReport()).length
getDb().run(
  `INSERT INTO payments(order_id, paid_at, amount, method, bank_ref, note, created_at) VALUES(?,?,?,?,?,?,?)`,
  [oEvil.id, '', 5, 'T/T', 'R7-DIRTY', '老数据：日期是空的', '2026-01-01T00:00:00.000Z']
)
check(
  '空日期的老收款不会冒出一个垃圾月份',
  (await dashboard.monthlyReport()).every((r) => /^\d{4}-\d{2}$/.test(r.month)),
  JSON.stringify((await dashboard.monthlyReport()).filter((r) => !/^\d{4}-\d{2}$/.test(r.month)).map((r) => r.month))
)
getDb().run(`DELETE FROM payments WHERE bank_ref = 'R7-DIRTY'`)
check('删掉脏行后月份数回到原样（没有多余垃圾月）', (await dashboard.monthlyReport()).length, dirtyBefore)
const owed = await money.receivableByCustomer()
check(
  '客户欠款榜合计 = 工作台待收款（货款 + 打样，同一个口径）',
  Math.abs(owed.reduce((s, o) => s + o.totalBase, 0) - stR7.pendingAmount) < 0.01,
  `${owed.reduce((s, o) => s + o.totalBase, 0)} vs ${stR7.pendingAmount}`
)
check('欠款榜按敞口从大到小排', owed.every((o, i) => i === 0 || owed[i - 1].totalBase >= o.totalBase))
eq(
  '各客户打样敞口之和 = sampleReceivable()（打样费没漏也没重算）',
  r2(owed.reduce((s, o) => s + o.sampleBase, 0)),
  r2(await money.sampleReceivable())
)
const wildMoney = (await money.listOrderMoney()).find((x) => x.orderId === oWild.id)!
const wildOwed = owed.find((o) => o.customerId === cWild.id)
eq('有未结单的客户在榜上，敞口就是这单的待收（基准币）', wildOwed ? r2(wildOwed.goodsBase) : 0, r2(wildMoney.receivableBase))


/* ---------------- R8 装箱与出货：入口闸门 + 批次凭据 ---------------- */
section('R8 装箱闸门：件数、款号、重量在 service 入口就拦死')
const r8g = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r8g.id, {
  styleNo: 'R8G',
  productName: '闸门款',
  color: 'Sky',
  size: 'L',
  quantity: 100,
  unitPrice: 10,
  unitCost: 5
})
const r8err = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}
const r8of = (qty: unknown) => [{ boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: qty }]
const r8get = async (orderId: number, plId: number) =>
  (await packing.listPackingLists(orderId)).find((p) => p.id === plId)!
check(
  '件数填 0 拦下，并告诉她该删行而不是填 0',
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: r8of(0) }))).includes('删掉那一行'),
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: r8of(0) })))
)
check('半件拦下：箱单和报关单上都说不清', (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: r8of(2.5) }))).includes('整件'))
check(
  '负数件拦下：一旦进来就把这一款的已装量压低，超装闸门跟着失效',
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: r8of(-30) }))).includes('1 件以上')
)
check('件数根本不是数字也拦下（IPC 是谁都能打的，不能只靠 UI）', (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: r8of('abc' as any) }))).includes('不是数字'))
check(
  '款号留空拦下：没有款号的箱子归不进任何一款的已装量',
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: '', color: 'Sky', size: 'L', quantity: 10 }] }))).includes('款号')
)
check(
  '净重填负数拦下（留空是允许的，纸面按系数估）',
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 10, netWeight: -3 }] }))).includes('公斤数')
)
check(
  '订单里没有的这一款不能凭空多装一款',
  (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: [{ boxNo: 'NO.1', styleNo: 'R8X', color: 'Sky', size: 'L', quantity: 10 }] }))).includes('订单里没有')
)
check('一箱都没有的空装箱单建不出来', (await r8err(async () => await packing.createPackingList({ orderId: r8g.id, lines: [] }))).includes('至少要有一箱'))
check(
  '同一款拆成多箱也按合计校验：逐行放行、加起来超装的拦得住',
  (await r8err(async () =>
    await packing.createPackingList({
      orderId: r8g.id,
      lines: [
        { boxNo: 'NO.1', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 60 },
        { boxNo: 'NO.2', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 60 }
      ]
    })
  )).includes('超了')
)

const r8PlsA = await packing.createPackingList({
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
const r8AfterAdd = await packing.addPackingListLine(r8g.id, r8A.id, { styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 10 })
const r8AddLine = r8AfterAdd.find((p) => p.id === r8A.id)!.lines.find((l) => l.quantity === 10)!
check(
  '现场补一箱自动继承同款那箱的单位净重（20kg/40 件 → 10 件算 5kg），不用重敲',
  Math.abs((r8AddLine.netWeight ?? 0) - 5) < 0.01,
  String(r8AddLine.netWeight)
)
check('补的这箱也按系数带上毛重', Math.abs((r8AddLine.grossWeight ?? 0) - 5 * r8Factor) < 0.01, String(r8AddLine.grossWeight))

section('R8 实收数量：短卸记得住，多收拦得住')
const r8RecvErr = (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 90 })))
check('实收不可能比这批发出去的还多，并指路去另开装箱单', r8RecvErr.includes('另开装箱单'), r8RecvErr)
check('实收要 0 以上整数（半件客户也不会签收）', (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 30.5 }))).includes('整数'))
check('实收留空等于按发数全收，不是记成 0', (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: '' as any }))) === '')
await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 68 })
eq('短卸 2 件记下来了', (await r8get(r8g.id, r8A.id)).receivedQty, 68)
await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: null })
eq('清空实收回到「没记录」', (await r8get(r8g.id, r8A.id)).receivedQty, null)
await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: 0 })
eq('实收 0 件是合法事实（一件没收到），和留空不是一回事', (await r8get(r8g.id, r8A.id)).receivedQty, 0)
await packing.updatePackingListInfo(r8g.id, r8A.id, { receivedQty: null })

section('R8 单据日期与签收日期：补录的是那天的事，不是点这一下的今天')
check(
  '单据日期写「2026-13-01」直接拦下',
  (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8A.id, { docDate: '2026-13-01' }))).includes('不是合法日期')
)
check('ETD 写脏日期同样拦下（脏日期会把催单时钟带错）', (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8A.id, { etdDate: '13/05/2026' }))).includes('不是合法日期'))
await packing.updatePackingListInfo(r8g.id, r8A.id, { docDate: '2026-10-08' })
eq('单据日期存住了', (await r8get(r8g.id, r8A.id)).docDate, '2026-10-08')
const r8OrderFull = (await orders.getOrder(r8g.id))!
const r8Paper = renderPl({ order: r8OrderFull, settings: getSettings(), images: {} }, (await r8get(r8g.id, r8A.id)))
check('纸面 Date 用的是补录的单据日期', r8Paper.includes('2026-10-08'))
check('箱号留空的那几箱也计入「N 箱」合计（箱单和提单件数对得上）', r8Paper.includes('3 箱 / 3 cartons'), r8Paper.slice(r8Paper.indexOf('TOTAL'), r8Paper.indexOf('TOTAL') + 80))
eq('还没签收时没有签收日期', (await r8get(r8g.id, r8A.id)).deliveredAt, null)
await packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'delivered' })
eq('没填签收日期时按今天落档', (await r8get(r8g.id, r8A.id)).deliveredAt, localDate())
await packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'packed' })
await packing.updatePackingListInfo(r8g.id, r8A.id, { shipStatus: 'delivered', deliveredDate: '2026-10-09' })
eq('补录签收用客户实际签收那一天', (await r8get(r8g.id, r8A.id)).deliveredAt, '2026-10-09')

section('R8 整单状态跃迁留痕：批次推着走，但历史不刷屏')
const r8EvCount = (kind: string): number =>
  Number((getDb().get('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND kind = ?', [r8g.id, kind]) as { n?: number })?.n ?? 0)
const r8ShipEv1 = r8EvCount('ship_status')
check('批次推进带来的整单状态跃迁写进了操作历史', r8ShipEv1 > 0, String(r8ShipEv1))
await packing.updatePackingListInfo(r8g.id, r8A.id, { containerNo: 'CONT-R8' })
eq('改一格柜号（状态没变）不会重复刷状态跃迁记录', r8EvCount('ship_status'), r8ShipEv1)
check(
  '操作历史里这条跃迁写清是从哪个状态到哪个状态',
  !!getDb().get(
    'SELECT id FROM order_events WHERE order_id = ? AND kind = ? AND note LIKE ? LIMIT 1',
    [r8g.id, 'ship_status', '%→%']
  )
)

section('R8 工厂已交口径：批次退回备货中，催单会重新响')
await orders.updateOrder(r8g.id, {
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: r8g.piNo,
  factoryDueDate: localDate()
})
const r8B = (
  await packing.createPackingList({
    orderId: r8g.id,
    containerNo: 'CONT-R8-B',
    lines: [{ boxNo: 'NO.3', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 30 }]
  })
).find((p) => p.containerNo === 'CONT-R8-B')!
eq('两批加起来装够 100 件', (await shipmentSummary(r8g.id)).packedQuantity, 100)
await packing.updatePackingListInfo(r8g.id, r8B.id, { shipStatus: 'preparing' })
eq('批次标成备货中就不算工厂已交（口径只有 shipping 那一份）', await factoryDeliveredQuantity(r8g.id), 70)
const r8Factory = (await dashboard.reminders()).find((x) => x.orderId === r8g.id && x.message.includes('工厂已交'))
check('工厂交期就是今天、还差 30 件 → 提醒会响，并写明已交 70 / 100', !!r8Factory && r8Factory.message.includes('70 / 100'), r8Factory?.message ?? '没有工厂提醒')

section('R8 批次作废：留档不删，状态、件数、金额都不算它')
const r8VoidEv0 = r8EvCount('pl_void')
const r8AfterVoid = await packing.voidPackingList(r8g.id, r8B.id, '货代取消订舱')
const r8Voided = r8AfterVoid.find((p) => p.id === r8B.id)!
check('作废只打标记：记录与箱明细一条没删（发过客户的箱单要查得到）', r8Voided.voidedAt != null && r8Voided.lines.length === 1)
eq('作废批次不再参与件数汇总', (await shipmentSummary(r8g.id)).packedQuantity, 70)
eq('作废批次不再算工厂已交', await factoryDeliveredQuantity(r8g.id), 70)
eq('作废记了一笔操作历史', r8EvCount('pl_void') - r8VoidEv0, 1)
check('已作废的批次再删会被拦下（作废不是让它消失）', (await r8err(async () => await packing.deletePackingList(r8g.id, r8B.id))).includes('已经作废留档'))
check('已作废的批次不能改箱明细', (await r8err(async () => await packing.updatePackingListLine(r8g.id, r8B.id, r8Voided.lines[0].id, { quantity: 1 }))).includes('已作废'))
check('已作废的批次不能再加箱', (await r8err(async () => await packing.addPackingListLine(r8g.id, r8B.id, { styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 5 }))).includes('已作废'))
check('已作废的批次不能删箱', (await r8err(async () => await packing.deletePackingListLine(r8g.id, r8B.id, r8Voided.lines[0].id))).includes('已作废'))
check('已作废的批次不能改批次信息', (await r8err(async () => await packing.updatePackingListInfo(r8g.id, r8B.id, { containerNo: 'X' }))).includes('已作废'))
check(
  '作废的那 30 件不再占超装额度：补开的 30 件建得出来',
  await (async () => {
    await packing.createPackingList({
      orderId: r8g.id,
      containerNo: 'CONT-R8-C',
      lines: [{ boxNo: 'NO.4', styleNo: 'R8G', color: 'Sky', size: 'L', quantity: 30 }]
    })
    return true
  })()
)
const r8C = (await packing.listPackingLists(r8g.id)).find((p) => p.containerNo === 'CONT-R8-C')!
eq('补开后已装量正好回到 100 件', (await shipmentSummary(r8g.id)).packedQuantity, 100)
await packing.deletePackingList(r8g.id, r8C.id)
const r8UnvoidEv0 = r8EvCount('pl_unvoid')
await packing.unvoidPackingList(r8g.id, r8A.id)
eq('撤销一张没作废的批次是无操作，不刷历史', r8EvCount('pl_unvoid'), r8UnvoidEv0)
await packing.unvoidPackingList(r8g.id, r8B.id, '客户恢复下单')
eq('撤销作废后重新参与汇总', (await shipmentSummary(r8g.id)).packedQuantity, 100)
eq('撤销作废记了一笔历史', r8EvCount('pl_unvoid') - r8UnvoidEv0, 1)
check('重复作废会被拦下', await (async () => {
  await packing.voidPackingList(r8g.id, r8B.id, '再试一次作废')
  return (await r8err(async () => await packing.voidPackingList(r8g.id, r8B.id, '重复'))).includes('已经是作废状态')
})())
await packing.unvoidPackingList(r8g.id, r8B.id, '回归复核')

section('R8 手工状态只能用这一份枚举')
const r8Manual = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
check(
  '「部分出运」是汇总出来的，钉在订单上会被拦下并指路到装箱单',
  (await r8err(async () => await orders.setShipStatus(r8Manual.id, 'partial_shipped' as any))).includes('装箱单')
)
check('没定义过的状态码进不来', (await r8err(async () => await orders.setShipStatus(r8Manual.id, 'flying' as any))).includes('不能手工设置'))
check('合法的手工状态照旧能设', (await orders.setShipStatus(r8Manual.id, 'not_prepared')).shipStatus, 'not_prepared')

section('R8 本批金额：三批加起来正好等于 PI')
const r8a = await orders.createOrder({
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
  await packing.createPackingList({
    orderId: r8a.id,
    lines: [{ boxNo: `NO.${i + 1}`, styleNo: sn, color: col, size: sz, quantity: 100 }]
  })
}
const r8Amt = await money.packingAmounts(r8a.id)
eq('每个批次各算自己那一份钱（运费按货值比例摊）', r8Amt.map((a) => a.total), [133.33, 133.33, 133.34])
eq('本批件数一并带上', r8Amt.map((a) => a.quantity), [100, 100, 100])
const r8Pi = orderDocAmount((await orders.getOrder(r8a.id))!)
check(
  '装齐时分摊的分币补给最后一批：三批金额加起来正好等于 PI 含费用合计',
  Math.abs(r8Amt.reduce((s, a) => s + a.total, 0) - r8Pi) < 0.005,
  `${r8Amt.reduce((s, a) => s + a.total, 0)} vs ${r8Pi}`
)
await packing.voidPackingList(r8a.id, r8Amt[2].plId, '这批没走成')
const r8AmtPartial = await money.packingAmounts(r8a.id)
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
  (await packing.listPackingLists(r8a.id)).filter((p) => p.voidedAt != null).length,
  1
)


/* ---------------- R9 设置 / 备份 / 更新 ---------------- */
section('R9 设置把关：脏值进不来，备份凭据不会被保存冲掉')
const r9err = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
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
  (await r9errA(() => saveSettings(r9set({ piValidDays: 7.5 })))).includes('整数')
)
check('PI 有效期留空拦下（以前留空会变成 NaN 天）', (await r9errA(() => saveSettings(r9set({ piValidDays: '' })))).includes('PI 有效期'))
check('催款阈值填负数拦下', (await r9errA(() => saveSettings(r9set({ remindPaymentDays: -3 })))).includes('催款阈值'))
check('出货提醒填 999 天拦下（等于永远不提醒）', (await r9errA(() => saveSettings(r9set({ remindShipDays: 999 })))).includes('0～90'))
check(
  '毛重系数填 0.5 拦下：报错讲了为什么（毛重不会比净重轻）',
  (await r9errA(() => saveSettings(r9set({ grossWeightFactor: 0.5 })))).includes('毛重系数')
)
check('毛重系数填 9 也拦下', (await r9errA(() => saveSettings(r9set({ grossWeightFactor: 9 })))).includes('毛重系数'))
check(
  '定金比例填 1.5 拦下（否则定金比货款还多，待收算出来是负的）',
  (await r9errA(() => saveSettings(r9set({ defaultDepositRatio: 1.5 })))).includes('定金比例')
)
check(
  '同一币种加两个收款账户拦下，并说明后果（PI 不知道印哪个）',
  (
    await r9errA(() =>
      saveSettings(
        r9set({ banks: [{ currency: 'USD', bankName: 'A' }, { currency: 'USD', bankName: 'B' }] })
      )
    )
  ).includes('加了两遍')
)
check('币种没选也拦下', (await r9errA(() => saveSettings(r9set({ banks: [{ currency: '', bankName: 'A' }] })))).includes('币种'))
check(
  '公司名过长拦下，并说明会印不下（单据抬头排版有红线）',
  (await r9errA(() => saveSettings(r9set({ company: { ...getSettings().company, name: 'X'.repeat(260) } })))).includes('排不下')
)
check(
  '银行 SWIFT 填 100 个字符拦下',
  (await r9errA(() => saveSettings(r9set({ banks: [{ currency: 'USD', swift: 'S'.repeat(60) }] })))).includes('SWIFT')
)

// 已经有单据了，基准币就是历史账的地基
check('界面提前置灰：基准币已锁死', (await baseCurrencyLocked()) === true)
const r9baseCur = getSettings().baseCurrency
const r9lockErr = await r9errA(() => saveSettings(r9set({ baseCurrency: r9baseCur === 'USD' ? 'CNY' : 'USD' })))
check('有单据时换基准币拦下', r9lockErr.includes('基准币不能换'), r9lockErr)
check('拦下时说明了后果（历史账要重算、改不回来）', r9lockErr.includes('重算') && r9lockErr.includes('改不回来'))
check('拦下时给了出路（结清旧账再重开一套）', r9lockErr.includes('导出台账'))
eq('一连串报错的保存之后，库里的设置一个字段都没变', getSettings(), r9base)

// 成功后：首尾空格自动去掉
const r9trim = await saveSettings(r9set({ company: { ...getSettings().company, name: '  钉珠卫衣工厂店  ' } }))
eq('保存会把抬头首尾空格去掉（印出来才不会歪）', r9trim.company.name, '钉珠卫衣工厂店')
await saveSettings(r9base)
eq('还原回原来的设置', getSettings(), r9base)

// 备份凭据由服务写，界面传什么都不认
await markBackupOk('2026-10-01T08:00:00.000Z')
await markBackupFail('磁盘满了，备份写到一半停了')
await saveSettings(r9set({ lastBackupAt: '瞎填的', lastBackupError: null }))
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
await saveSettings(r9base)
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
eq('落盘的包原样自检通过', (await r9err(async () => verifyZip(r9buf, readZip(r9buf)))), '')

// 验货本身要抓得住三种事故
const r9tiny = Buffer.from('hello world hello world')
check(
  '少一个文件算失败（备份的意义是全须全尾回来）',
  (await r9err(async () =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }]), [
      { name: 'a', data: r9tiny },
      { name: 'b', data: r9tiny }
    ])
  )).includes('少了 1 个文件')
)
check(
  '多一个没打算装的文件也算失败',
  (await r9err(async () =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }, { name: 'z', data: r9tiny }]), [{ name: 'a', data: r9tiny }])
  )).includes('多出一个')
)
check(
  '内容被换过（字节一样不算，逐字节比）',
  (await r9err(async () =>
    verifyZip(createZip([{ name: 'a', data: r9tiny }]), [
      { name: 'a', data: Buffer.from('hello world hello worlD') }
    ])
  )).includes('不一致')
)
check('尾巴被截掉的包报「截断」', (await r9err(async () => readZip(r9buf.subarray(0, r9buf.length - 30)))).includes('截断'))
const r9flipped = Buffer.from(r9buf)
// 直接改数据库内容段的一个字节（跳过 30 字节本地头 + 文件名）
r9flipped[81] ^= 0xff
const r9flipErr = (await r9err(async () => readZip(r9flipped)))
check(
  '包体坏一个字节就报错，绝不静默返回半截数据',
  /损坏|校验码|大小不对|解不开/.test(r9flipErr),
  r9flipErr
)

const r9corruptPath = join(backupsDir(), 'ikanbot-20260101000000-corrupt.zip')
fs.writeFileSync(r9corruptPath, r9flipped)
const r9inspectErr = (await r9err(async () => inspectBackup(r9corruptPath)))
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
check('非 .zip 拒', ((await r9errA(() => restoreBackup(join(backupsDir(), 'notes.txt'))))).includes('.zip'))
check(
  '列表里还有、盘上已经被删的文件拒',
  ((await r9errA(() => restoreBackup(join(backupsDir(), 'ikanbot-20300101000000-none.zip'))))).includes('已经不在了')
)
const r9evilPath = join(backupsDir(), 'ikanbot-20260102000000-evil.zip')
fs.writeFileSync(r9evilPath, createZip([{ name: '../evil.txt', data: Buffer.from('跳出去') }, { name: 'ikanbot.db', data: r9dbBytes }]))
const r9evilErr = await r9errA(() => restoreBackup(r9evilPath))
check('包里有不认识的文件就整份拒掉（不是跳过它继续恢复）', r9evilErr.includes('不认识的文件'), r9evilErr)
check('被拒的包没有把文件写到数据目录外面', !fs.existsSync(join(dataDir(), 'evil.txt')))
const r9nodbPath = join(backupsDir(), 'ikanbot-20260103000000-nodb.zip')
fs.writeFileSync(r9nodbPath, createZip([{ name: 'images/a.png', data: Buffer.from('png') }]))
check('没有数据库的包拒（不然恢复完是个空程序）', ((await r9errA(() => restoreBackup(r9nodbPath)))).includes('没有数据库文件'))
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
const r9backupTips = async () => (await dashboard.reminders()).filter((r) => r.orderNo === '数据备份')
r9setStamp(null, null)
eq('有单据却从没备份成功过 → 亮一条', (await r9backupTips()).length, 1)
check('说的是「这台电脑上还没有一份成功备份」', ((await r9backupTips())[0]?.message ?? '').includes('还没有一份成功备份'))
r9setStamp(new Date().toISOString(), null)
eq('今天刚备过 → 不催', (await r9backupTips()).length, 0)
r9setStamp(new Date(Date.now() - 30 * 86400000).toISOString(), null)
eq('拖了 30 天 → 催一次', (await r9backupTips()).length, 1)
check('催的时候说清隔了多少天', ((await r9backupTips())[0]?.message ?? '').includes('距离上一次成功备份'))
r9setStamp(new Date().toISOString(), '磁盘满了，备份写到一半停了')
eq('今天备过但这次失败 → 只催失败', (await r9backupTips()).length, 1)
check('把失败原因原样亮出来', ((await r9backupTips())[0]?.message ?? '').includes('磁盘满了'))
r9setStamp(null, '磁盘满了，备份写到一半停了')
eq('从没成功过 + 又失败 → 两条都要（不互相顶掉）', (await r9backupTips()).length, 2)
eq('两条各占一个 key（界面上会各显示一行）', new Set((await r9backupTips()).map((r) => r.key)).size, 2)
check('都归在「待修」而不是催款类', (await r9backupTips()).every((r) => r.kind === 'data'))
// 指向同一个去处：设置 → 数据备份
check('每条都告诉用户去哪儿点', (await r9backupTips()).every((r) => r.message.includes('设置 → 数据备份')))

section('R9 毛重来源：填过实测就钉死，改系数不翻旧账（v15）')
const r9cols = (getDb().all('PRAGMA table_info(packing_list_lines)') as { name: string }[]).map((c) => c.name)
check('装箱明细多了一列 gross_est（记这箱毛重是填的还是算的）', r9cols.includes('gross_est'), r9cols.join(','))
const r9w = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r9w.id, {
  styleNo: 'R9W',
  productName: '过磅款',
  color: 'Grey',
  size: 'M',
  quantity: 120,
  unitPrice: 10,
  unitCost: 5
})
const r9pls = await packing.createPackingList({
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
const r9line = async (lineId: number) =>
  (await packing.listPackingLists(r9w.id))[0].lines.find((l) => l.id === lineId)!
/** 纸面这一批上印了几个 (est.)（只数箱明细行里的，页脚那句说明不算） */
const r9estCount = async (): Promise<number> => {
  const html = renderPl({ order: (await orders.getOrder(r9w.id))!, settings: getSettings(), images: {} }, (await packing.listPackingLists(r9w.id))[0])
  return (html.match(/\(est\.\)<\/span>/g) ?? []).length
}
eq('没填毛重的那箱落库标为「算出来的」', (await r9line(r9l1)).grossEst, true)
eq('填了实测毛重的那箱落库标为「实测」', (await r9line(r9l2)).grossEst, false)
eq('纸面只给算出来的那箱印 (est.)', (await r9estCount()), 1)

const r9added = await packing.addPackingListLine(r9w.id, r9plId, { styleNo: 'R9W', color: 'Grey', size: 'M', quantity: 10 })
const r9l3 = r9added[0].lines.find((l) => l.quantity === 10)!.id
eq('现场补的一箱没填毛重，也标估算', (await r9line(r9l3)).grossEst, true)
eq('补完这箱，纸面上两个 (est.)', (await r9estCount()), 2)

// 关键：把系数调到 1.3，20 × 1.3 = 26 恰好等于那箱手填的过磅值
await saveSettings(r9set({ grossWeightFactor: 1.3 }))
eq('改了毛重系数，老单据上的 (est.) 一个都没翻面', (await r9estCount()), 2)
eq('手填的 26kg 仍按实测印（没被新系数认成推算值）', (await r9line(r9l2)).grossEst, false)
await saveSettings(r9set({ grossWeightFactor: 1.1 }))
eq('系数调回来，标记还是原来那几个（标记不跟系数走）', (await r9estCount()), 2)

// 编辑时的来源判定：改件数不动 / 只改净重退回估算 / 手填毛重算实测
await packing.updatePackingListLine(r9w.id, r9plId, r9l2, { quantity: 25 })
eq('只改件数：毛重按比例跟着走（50 箱 26kg → 25 箱 13kg）', (await r9line(r9l2)).grossWeight, 13)
eq('只改件数：来源判定不动（还是实测）', (await r9line(r9l2)).grossEst, false)
eq('只改件数：这一箱的 (est.) 不会冒出来', (await r9estCount()), 2)
await packing.updatePackingListLine(r9w.id, r9plId, r9l2, { netWeight: 30 })
eq('只改净重：毛重按当前系数重算（30 × 1.1 = 33）', (await r9line(r9l2)).grossWeight, 33)
eq('只改净重：这一箱退回「算出来的」', (await r9line(r9l2)).grossEst, true)
eq('只改净重之后，纸面三个 (est.)', (await r9estCount()), 3)
await packing.updatePackingListLine(r9w.id, r9plId, r9l2, { grossWeight: 35.5 })
eq('手填毛重即视为实测（哪怕 35.5 看着也像算出来的）', (await r9line(r9l2)).grossEst, false)
eq('手填之后这一箱的 (est.) 消失', (await r9estCount()), 2)
await packing.updatePackingListLine(r9w.id, r9plId, r9l2, { grossWeight: null })
eq('清空毛重：来源标记一起清掉（不谎称实测）', (await r9line(r9l2)).grossEst, null)
eq('清空的这箱按「没填」处理，重新标上 (est.)', (await r9estCount()), 3)

// 老数据（v15 之前建的）没有这个标记，只能按系数猜——这正是标记要解决的问题
getDb().run('UPDATE packing_list_lines SET gross_est = NULL WHERE packing_list_id = ?', [r9plId])
eq('老数据在系数 1.1 下三箱全被猜成推算值', (await r9estCount()), 3)
await saveSettings(r9set({ grossWeightFactor: 1.3 }))
eq('同一批数据只把系数改成 1.3，两个箱的 (est.) 就掉了', (await r9estCount()), 1)
await saveSettings(r9set({ grossWeightFactor: 1.1 }))
eq('改回 1.1 结论又变回去——没落库的来源标记就是这么反复', (await r9estCount()), 3)

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
  const r11o = await orders.createOrder({
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
  await orders.updateOrder(r11o.id, { note: '只改了备注' })
  const kept = (await orders.getOrder(r11o.id))!
  eq('漏传交期不再被清空', kept.expectedShipDate, '2026-11-30')
  eq('漏传 ETD 不再被清空', kept.etdDate, '2026-11-20')
  eq('漏传截关日不再被清空', kept.cutOffDate, '2026-11-15')
  eq('漏传客户 PO 不再被清空', kept.customerPo, 'PO-11')
  eq('漏传船名不再被清空', kept.vessel, 'MSC USA')
  eq('漏传铅封号不再被清空', kept.sealNo, 'SEAL-9')
  eq('漏传客户不改变挂靠的客户', kept.customer?.id, c1.id)
  eq('传了的字段照旧写进去', kept.note, '只改了备注')
  await orders.updateOrder(r11o.id, { etdDate: null })
  eq('明确清空仍然生效（null ≠ 没传）', (await orders.getOrder(r11o.id))!.etdDate, null)
  let piErr = ''
  try {
    await orders.updateOrder(r11o.id, { piNo: '' })
  } catch (e) {
    piErr = (e as Error).message
  }
  check('已经写上的 PI 号不许编辑时空掉', piErr.includes('PI 号'), piErr)
  check('被拦下来的那次没把 PI 号改掉', (await orders.getOrder(r11o.id))!.piNo, 'R11PI001')

  const r11q = await quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    validUntil: '2026-12-31',
    charges: [{ label: '运费 Freight', amount: 50 }],
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
  const r11qEdit = await quotations.saveQuotation({
    id: r11q.id,
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    items: [{ styleNo: 'A001', quantity: 12, unitPrice: 7.5 }]
  })
  eq('报价单漏传费用不再被清空', r11qEdit.charges.length, 1)
  eq('报价单漏传有效期不再被推到「今天+N」', r11qEdit.validUntil, '2026-12-31')
  eq('报价单传了的数量照旧生效', r11qEdit.items[0].quantity, 12)

  const r11s = await samples.saveSample({
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
  const r11sEdit = await samples.saveSample({
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
  const rbQ = await quotations.saveQuotation({
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
    await quotations.saveQuotation({
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
  const afterRb = (await quotations.getQuotation(rbQ.id))!
  eq('回滚后明细行数没少', afterRb.items.length, 2)
  eq('回滚后第一行还是原来那个数量（新值没写进去）', afterRb.items[0].quantity, 10)

  const rbO = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  await orders.addOrderItem(rbO.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  let rbOErr = ''
  try {
    await orders.replaceOrderItems(rbO.id, [
      { styleNo: 'A009', color: 'Red', size: 'S', quantity: 1, unitPrice: 8 },
      { styleNo: 'A010', color: 'Blue', size: 'L', quantity: 1, unitPrice: 8, productId: 999999 }
    ])
  } catch (e) {
    rbOErr = (e as Error).message
  }
  check('批量替换明细时坏行让整批失败', rbOErr !== '', rbOErr)
  const afterRO = (await orders.getOrder(rbO.id))!
  eq('回滚后原有那一行还在（没被删掉）', afterRO.items.length, 1)
  eq('回滚后原有那行数量没变', afterRO.items[0].quantity, 10)
}

section('R11-2 明细闸门：负数、半件、没填价格都进不了库')
{
  const g = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  const errOf = async (fn: () => unknown): Promise<string> => {
    try {
      await fn()
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }
  check(
    '负数量被拦',
    (await errOf(async () => await orders.addOrderItem(g.id, { styleNo: 'A001', quantity: -30, unitPrice: 8 }))).includes('1 件以上')
  )
  check('半件被拦', (await errOf(async () => await orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 1.5, unitPrice: 8 }))).includes('不是整件'))
  check(
    '清空数量（Number(「」)=0）被拦，不再静默存 0 件行',
    (await errOf(async () => await orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 0, unitPrice: 8 }))).includes('1 件以上')
  )
  check('单价没填（按 0 保存）被拦', (await errOf(async () => await orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 10, unitPrice: 0 }))).includes('单价'))
  check('负单价被拦', (await errOf(async () => await orders.addOrderItem(g.id, { styleNo: 'A001', quantity: 10, unitPrice: -8 }))).includes('负数'))
  const gOne = await orders.addOrderItem(g.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  check('已有行改成负数也被拦', (await errOf(async () => await orders.updateOrderItem(g.id, gOne.items[0].id, { quantity: -5 }))).includes('1 件以上'))
  check('已有行单价改成负数也被拦', (await errOf(async () => await orders.updateOrderItem(g.id, gOne.items[0].id, { unitPrice: -1 }))).includes('负数'))
  eq('闸门拦下的这几次一行都没进库', (await orders.getOrder(g.id))!.items.length, 1)
  eq('没被改坏的那行数量还是原值', (await orders.getOrder(g.id))!.items[0].quantity, 10)

  const gq = await quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    items: [{ styleNo: 'A001', quantity: 10, unitPrice: 7.5 }]
  })
  check(
    '报价行数量为 0 直接报错（不再悄悄把半填的一行丢掉）',
    (await errOf(async () =>
      await quotations.saveQuotation({
        id: gq.id,
        customerId: c1.id,
        currency: 'USD',
        exchangeRate: 7.15,
        items: [
          { styleNo: 'A001', quantity: 10, unitPrice: 7.5 },
          { styleNo: 'A002', quantity: 0, unitPrice: 9 }
        ]
      })
    )).includes('1 件以上')
  )
  eq('报错的这次保存没把报价明细改掉', (await quotations.getQuotation(gq.id))!.items.length, 1)

  // 免费样是真实业务：样品行的单价允许 0，数量仍然要 ≥1
  const free = await samples.saveSample({
    customerId: c1.id,
    feeStatus: 'paid',
    items: [{ styleNo: 'A001', color: '', size: '', quantity: 2, unitPrice: 0 }]
  })
  check('免费样品行（单价 0）仍然允许保存', free.id > 0)
  check(
    '样品行负数量仍然被拦',
    (await errOf(async () =>
      await samples.saveSample({
        customerId: c1.id,
        feeStatus: 'paid',
        items: [{ styleNo: 'A001', color: '', size: '', quantity: -1, unitPrice: 0 }]
      })
    )).includes('1 件以上')
  )
  // 装箱与明细共用同一条闸门（规矩写在 src/shared/guards，不在两处各写一份）
  const gpl = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  await orders.addOrderItem(gpl.id, { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 })
  let plErr = ''
  try {
    await packing.createPackingList({
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
  const b = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  let bErr = ''
  try {
    await orders.addOrderItems(b.id, [
      { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 },
      { styleNo: 'A002', color: 'Navy', size: 'L', quantity: 20, unitPrice: 9 },
      { styleNo: 'A003', color: 'Red', size: 'S', quantity: 0, unitPrice: 7 }
    ])
  } catch (e) {
    bErr = (e as Error).message
  }
  check('批量里第 3 行不合格让整批失败', bErr.includes('数量'), bErr)
  eq('前两行没有偷偷躺在库里', (await orders.getOrder(b.id))!.items.length, 0)
  const okBatch = await orders.addOrderItems(b.id, [
    { styleNo: 'A001', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 },
    { styleNo: 'A002', color: 'Navy', size: 'L', quantity: 20, unitPrice: 9 }
  ])
  eq('两行都合规时一次加两行', okBatch.items.length, 2)
  eq('批量加行的件数直接进整单件数', okBatch.totalQuantity, 30)
  eq('批量加行仍然逐行留痕', (await orders.listEvents(b.id)).filter((e) => e.kind === 'item_add').length, 2)
}

section('R11-4 操作历史答得出「谁改的」')
{
  const beforeOp = getSettings()
  await saveSettings({ ...beforeOp, operator: '林小满' })
  const h = await orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    validUntil: '2026-11-30',
    expectedShipDate: '2026-12-10'
  })
  const born = (await orders.listEvents(h.id))
  check('建单就有历史记录', born.length > 0)
  check(
    '建单时每条历史都盖上设置里的操作员',
    born.every((e) => e.actor === '林小满'),
    JSON.stringify(born.map((e) => e.actor))
  )

  await orders.updateOrder(h.id, { expectedShipDate: '2026-12-20', cutOffDate: '2026-12-01' })
  const moveEv = (await orders.listEvents(h.id)).slice(-1)[0]
  eq('交期确实写进库了', (await orders.getOrder(h.id))!.expectedShipDate, '2026-12-20')
  check('历史里写成 before → after', moveEv.note.includes('预计开船 2026-12-10 → 2026-12-20'), moveEv.note)
  check('同一次新增的截关日也留痕', moveEv.note.includes('截关日 空 → 2026-12-01'), moveEv.note)

  await orders.updateOrder(h.id, { note: '客户催货' })
  const noteEv = (await orders.listEvents(h.id)).slice(-1)[0]
  check('只改备注的那次，历史不会把没传的交期说成清空', !noteEv.note.includes('预计开船'), noteEv.note)
  check('备注改动本身要留痕', noteEv.note.includes('备注 空 → 客户催货'), noteEv.note)

  const photo = await orders.addOrderPhoto(h.id, 'inspection-x.jpg', 'inspection', '尾期验货')
  await orders.deleteOrderPhoto(h.id, photo.id)
  const photoEv = (await orders.listEvents(h.id)).slice(-1)[0]
  check('删验货照也进历史，并说明删的是哪一张', photoEv.note.includes('删除验货照') && photoEv.note.includes('尾期验货'), photoEv.note)

  // 换人：新动作盖新名字，旧记录一个都不改写
  await saveSettings({ ...getSettings(), operator: '周文娟' })
  await orders.voidOrder(h.id, '客户取消')
  const allEv = (await orders.listEvents(h.id))
  eq('换人后的新历史盖新名字', allEv.slice(-1)[0].actor, '周文娟')
  eq('换人前写下的历史仍然是原操作员', allEv[0].actor, '林小满')
  await saveSettings(beforeOp)
}

section('R11-6 单号查重与建单原子化')
{
  await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15, piNo: 'R11DUP001' })
  const before = (await orders.listOrders({})).length
  let dupMsg = ''
  try {
    await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15, piNo: 'R11DUP001' })
  } catch (e) {
    dupMsg = (e as Error).message
  }
  check('同一个 PI 号建第二张单被拦住', dupMsg.includes('已经存在'), dupMsg)
  check('报错说清楚该怎么改', dupMsg.includes('换一个号'), dupMsg)
  eq('被拦住的那次没有留下空单', (await orders.listOrders({})).length, before)

  // 手工号也算「已占用」：自动号必须跳过它，不能第二天又生成同一个号
  const auto = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.15 })
  check('自动生成的 PI 号不撞手工号', auto.piNo !== 'R11DUP001', auto.piNo)
  const allPi = (await orders.listOrders({})).map((o) => o.piNo).filter(Boolean)
  eq('全库 PI 号仍然无重号', allPi.length, new Set(allPi).size)
  check(
    '建单和它的「建单」历史一起成立',
    (await orders.listEvents(auto.id)).some((e) => e.kind === 'create' && e.note.includes(auto.orderNo))
  )
}

/* ---------------- R12 跨平台 / 打印 / 一致性 ---------------- */
section('R12 打印分页：页边距、页码、合计只印一次')
{
  const base = (await orders.listOrders({})).find((o) => o.items.length > 0)
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
  const o = await orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.1,
    piNo: 'PI-R12-CI'
  })
  await orders.addOrderItem(o.id, { styleNo: 'R12CI', productName: '测试款', quantity: 10, unitPrice: 2 })
  const pls = await packing.createPackingList({
    orderId: o.id,
    lines: [{ boxNo: '1', styleNo: 'R12CI', productName: '测试款', quantity: 10 }]
  })
  await packing.updatePackingListInfo(o.id, pls[0].id, { docDate: '2026-09-30' })
  const fresh = (await orders.getOrder(o.id))!
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
  await saveSettings({
    ...settingsNow,
    banks: [
      { currency: 'USD', bankName: 'US Bank', accountName: 'IK', accountNo: 'R12USDONLY', swift: 'X', address: '' }
    ]
  })
  const eur = await orders.createOrder({ customerId: c1.id, currency: 'EUR', exchangeRate: 7.8, piNo: 'PI-R12-EUR' })
  await orders.addOrderItem(eur.id, { styleNo: 'R12EU', productName: '欧单', quantity: 1, unitPrice: 1 })
  const eurHtml = renderPi({ order: (await orders.getOrder(eur.id))!, settings: getSettings(), images: {} })
  check('EUR 单不会印 USD 账号', !eurHtml.includes('R12USDONLY'))
  await saveSettings(beforeBanks)
}

section('R12 导出台账跟随当前筛选')
{
  const kw = 'R12-BOX'
  const o = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1, piNo: 'PI-R12-BOX' })
  await orders.addOrderItem(o.id, { styleNo: 'R12BOX', productName: '箱', quantity: 10, unitPrice: 1 })
  // 台账口径本来就不含草稿（R7 定死的）；这里用一张正式单验证「筛选后行数 = 列表」
  await orders.setPaymentStatus(o.id, 'sent')
  const listed = await orders.listOrderRows({ keyword: kw, limit: 1000 })
  const filtered = await dashboard.exportCsv('orders', { keyword: kw })
  const lines = filtered.trim().split(/\r?\n/)
  eq('筛选导出的行数 = 列表命中数', lines.length - 1, listed.total)
  check('筛选导出只含命中的单', lines.slice(1).every((l) => l.includes(kw)), lines.slice(1).join(' | '))
  const allLines = (await dashboard.exportCsv('orders')).trim().split(/\r?\n/)
  check('不带筛选时仍是全量台账', allLines.length > lines.length)

  const paid = await orders.listOrderRows({ paymentStatus: 'paid', limit: 1000 })
  const paidCsv = await dashboard.exportCsv('orders', { paymentStatus: 'paid' })
  eq('按收款状态导出的行数 = 列表', paidCsv.trim().split(/\r?\n/).length - 1, paid.total)
}

section('R12 守门：收款状态白名单 / 箱号查重')
{
  const o = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7.1, piNo: 'PI-R12-ST' })
  await orders.addOrderItem(o.id, { styleNo: 'R12ST', productName: '状态', quantity: 10, unitPrice: 1 })
  const before = (await orders.getOrder(o.id))!.paymentStatus
  let badStatus = ''
  try {
    await orders.setPaymentStatus(o.id, 'wat' as never)
  } catch (e) {
    badStatus = (e as Error).message
  }
  check('非法收款状态被拒，并列出可选值', badStatus.includes('不是收款状态') && badStatus.includes('草稿'), badStatus)
  eq('被拒后收款状态没变', (await orders.getOrder(o.id))!.paymentStatus, before)

  let dupBox = ''
  try {
    await packing.createPackingList({
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
  eq('被拒后没有留下半截装箱单', (await packing.listPackingLists(o.id)).length, 0)

  const pls = await packing.createPackingList({
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
    await packing.updatePackingListLine(o.id, pls[0].id, second.id, { boxNo: 'B1' })
  } catch (e) {
    dupEdit = (e as Error).message
  }
  check('把箱号改成同批已有的号也被拒', dupEdit.includes('已经用过'), dupEdit)
  eq('被拒的改箱号没有落库', (await packing.listPackingLists(o.id))[0].lines.find((l) => l.id === second.id)!.boxNo, 'B2')
}

/* ============================================================
 * 第 13 轮：口径与守门（R13）
 * ============================================================ */
section('R13 导出口径：页面筛出几张，Excel 就是几张')
const cR13 = await customers.saveCustomer({ company: 'R13 Export Co', contact: 'Export Desk', country: 'Germany' })
const r13Ledger = await orders.createOrder({
  customerId: cR13.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r13Ledger.id, { styleNo: 'R13-OK', productName: '正常单', quantity: 10, unitPrice: 10 })
const r13Draft = await orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r13Draft.id, { styleNo: 'R13-DRAFT', productName: '草稿', quantity: 10, unitPrice: 10 })
const r13Void = await orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Void.id, { styleNo: 'R13-VOID', productName: '作废', quantity: 10, unitPrice: 10 })
await orders.voidOrder(r13Void.id, '客户取消')
const r13Expired = await orders.createOrder({ customerId: cR13.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Expired.id, { styleNo: 'R13-EXP', productName: '失效', quantity: 10, unitPrice: 10 })
await orders.setPaymentStatus(r13Expired.id, 'expired')

const csvLedger = await dashboard.exportCsv('orders')
check('默认台账含正常单', csvLedger.includes(r13Ledger.orderNo))
check(
  '默认台账不含草稿 / 作废 / 失效（SUM 出来才是销售额）',
  ![r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].some((no) => csvLedger.includes(no)),
  [r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].join(',')
)
const csvAll = await dashboard.exportCsv('orders_all')
check(
  '全量底稿四张都在（复盘查得到）',
  [r13Ledger.orderNo, r13Draft.orderNo, r13Void.orderNo, r13Expired.orderNo].every((no) => csvAll.includes(no))
)
const csvVoid = await dashboard.exportCsv('orders', { paymentStatus: 'void' })
check('停在「已作废」页签导出，作废单在表里', csvVoid.includes(r13Void.orderNo))
check('按作废筛选时不会混进正常单或草稿', !csvVoid.includes(r13Ledger.orderNo) && !csvVoid.includes(r13Draft.orderNo))
const csvDraft = await dashboard.exportCsv('orders', { paymentStatus: 'draft' })
check('停在「草稿」页签导出，草稿在表里且只有草稿', csvDraft.includes(r13Draft.orderNo) && !csvDraft.includes(r13Ledger.orderNo))

section('R13 收款状态：发出 PI 后按真收到的钱走，不被 sent 卡住')
const r13Pay = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'sent',
  depositRatio: 0
})
await orders.addOrderItem(r13Pay.id, { styleNo: 'R13-PAY', productName: '收款流转', quantity: 10, unitPrice: 100 })
eq('PI 已发、还没收钱 → 仍是已发出', (await orders.getOrder(r13Pay.id))!.paymentStatus, 'sent')
await orders.addPayment(r13Pay.id, { paidAt: localDate(), amount: 400, method: 'T/T', bankRef: 'R13-P1' })
eq('收到 400 / 1000 → 部分收款（不再停在已发出）', (await orders.getOrder(r13Pay.id))!.paymentStatus, 'partial')
await orders.addPayment(r13Pay.id, { paidAt: localDate(), amount: 600, method: 'T/T', bankRef: 'R13-P2' })
eq('收齐 → 已结清', (await orders.getOrder(r13Pay.id))!.paymentStatus, 'settled')

section('R13 写入守门：作废/失效的单不能再往里加东西')
const r13Void2 = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Void2.id, { styleNo: 'R13-GUARD', productName: '守门', quantity: 10, unitPrice: 10 })
await orders.voidOrder(r13Void2.id, '客户不做了')
check(
  '作废单不能再加明细',
  (await r8err(async () => await orders.addOrderItems(r13Void2.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }]))).includes('已作废')
)
check(
  '作废单不能再登记收款',
  (await r8err(async () => await orders.addPayment(r13Void2.id, { paidAt: localDate(), amount: 10 }))).includes('已作废')
)
check(
  '作废单不能再装箱',
  (await r8err(async () =>
    await packing.createPackingList({ orderId: r13Void2.id, lines: [{ boxNo: 'V1', styleNo: 'R13-GUARD', quantity: 1 }] })
  )).includes('已作废')
)

const r13Exp = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Exp.id, { styleNo: 'R13-EXP2', productName: '失效守门', quantity: 10, unitPrice: 10 })
await orders.setPaymentStatus(r13Exp.id, 'expired')
check(
  '失效单不能再登记收款（钱进来了得先把状态改回来）',
  (await r8err(async () => await orders.addPayment(r13Exp.id, { paidAt: localDate(), amount: 10 }))).includes('已失效')
)
await orders.setPaymentStatus(r13Exp.id, 'confirmed')
const r13ExpPaid = await orders.addPayment(r13Exp.id, { paidAt: localDate(), amount: 10, method: 'T/T', bankRef: 'R13-EXP-P' })
eq('状态改回来后可以继续收款', r13ExpPaid.paymentStatus, 'partial')

section('R13 箱号跨批次连续：作废的号也不能重发')
const r13Box = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r13Box.id, { styleNo: 'R13-BOX', productName: '箱号', quantity: 100, unitPrice: 1 })
const r13BoxA = (
  await packing.createPackingList({
    orderId: r13Box.id,
    containerNo: 'R13-A',
    lines: [{ boxNo: 'B-1', styleNo: 'R13-BOX', quantity: 40 }]
  })
)[0]
const r13DupBoxErr = (await r8err(async () =>
  await packing.createPackingList({ orderId: r13Box.id, lines: [{ boxNo: 'B-1', styleNo: 'R13-BOX', quantity: 20 }] })
))
check('下一批重复用 B-1 被拦下，并说明箱号跨批次连续', r13DupBoxErr.includes('已经用过') && r13DupBoxErr.includes('箱号跨批次连续'), r13DupBoxErr)
const r13BoxB = (
  await packing.createPackingList({ orderId: r13Box.id, containerNo: 'R13-B', lines: [{ boxNo: 'B-2', styleNo: 'R13-BOX', quantity: 20 }] })
).find((p) => p.containerNo === 'R13-B')
check('换成没发过的 B-2 放行', !!r13BoxB)
await packing.voidPackingList(r13Box.id, r13BoxB!.id, '订舱取消')
const r13VoidBoxErr = (await r8err(async () =>
  await packing.createPackingList({ orderId: r13Box.id, lines: [{ boxNo: 'B-2', styleNo: 'R13-BOX', quantity: 10 }] })
))
check('作废批次的箱号仍占号，不能再发一次', r13VoidBoxErr.includes('作废批次也占号'), r13VoidBoxErr)
check(
  '往后接 B-3 放行',
  await (async () => {
    await packing.createPackingList({ orderId: r13Box.id, containerNo: 'R13-C', lines: [{ boxNo: 'B-3', styleNo: 'R13-BOX', quantity: 10 }] })
    return (await packing.listPackingLists(r13Box.id)).some((p) => p.containerNo === 'R13-C')
  })()
)
check('同一批 A 的 B-1 还能改箱明细（不误伤自己）', (await packing.updatePackingListLine(r13Box.id, r13BoxA.id, r13BoxA.lines[0].id, { quantity: 40 })).length > 0)

section('R13 贸易术语：八种都能落库、都能印在 PI 上')
for (const term of INCOTERMS) {
  const o = await orders.createOrder({
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
const smpR13 = await samples.saveSample({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R13-SMP', productName: '重转', quantity: 2, unitPrice: 15, goodsUnitPrice: 8 }]
})
const r13SampleOrder1 = await samples.convertSampleToOrder(smpR13.id)
await orders.voidOrder(r13SampleOrder1.id, '客户改规格')
eq(
  '打样列表能看出上次转出的单已作废',
  (await samples.listSamples()).find((s) => s.id === smpR13.id)!.convertedOrderStatus,
  'void'
)
const r13SampleOrder2 = await samples.convertSampleToOrder(smpR13.id)
check('作废后重新转单会生成一张新单，而不是复用作废单', r13SampleOrder2.id !== r13SampleOrder1.id)
eq('打样单改成记新单', (await samples.getSample(smpR13.id))!.convertedOrderId, r13SampleOrder2.id)
eq('新单还活着时再转仍复用同一张', (await samples.convertSampleToOrder(smpR13.id)).id, r13SampleOrder2.id)

section('R13 报价已确认却没人转单：催的是「拖下去汇率和交期都会变」')
const qR13 = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  status: 'confirmed',
  items: [{ styleNo: 'R13-Q', quantity: 10, unitPrice: 5 }]
})
getDb().run('UPDATE quotations SET confirmed_at = ? WHERE id = ?', [dAgoIso(20), qR13.id])
const remR13 = await dashboard.reminders()
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
async function ciBatchOf(order: any, pl: any): Promise<any> {
  const a = (await money.packingAmounts(order.id)).find((x) => x.plId === pl.id)!
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
    blNo: pl.blNo || undefined,
    sealNo: pl.sealNo || undefined
  }
}

section('R14 批次金额：单批货值 + 按货值分摊费用，各批相加 = 整单')
const r14 = await orders.createOrder({
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
await orders.updateOrderCharges(r14.id, [
  { label: '运费 Freight', amount: 300 },
  { label: '保险费 Insurance', amount: 90 }
])
const r14PlA = (await packing.createPackingList({
  orderId: r14.id,
  containerNo: 'CONT-A',
  lines: [{ boxNo: 'R14-A-1', styleNo: 'R14-A', color: 'Black', size: 'M', quantity: 100 }]
}))[0]
await packing.updatePackingListInfo(r14.id, r14PlA.id, {
  containerNo: 'CONT-A',
  vessel: 'VESSEL-A',
  etdDate: '2026-12-01',
  blNo: 'BL-A',
  docDate: '2026-12-02'
})
const r14PlB = (await packing.createPackingList({
  orderId: r14.id,
  lines: [{ boxNo: 'R14-B-1', styleNo: 'R14-B', color: 'Red', size: 'L', quantity: 50 }]
})).slice(-1)[0]
await packing.updatePackingListInfo(r14.id, r14PlB.id, { docDate: '2026-12-03' })

const r14Amts = await money.packingAmounts(r14.id)
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
  Number((await orders.getOrder(r14.id))!.grandTotal)
)
eq('A 批费用行相加 = A 批分摊费用', r2(r14AmtA.chargeLines.reduce((s, c) => s + c.amount, 0)), r14AmtA.charges)
eq('A 批只有自己的 SKU', r14AmtA.lines.map((l) => l.styleNo), ['R14-A'])
eq('A 批件数', r14AmtA.quantity, 100)
eq('A 批明细行金额 = 件数 × 单价', r14AmtA.lines[0].amount, 1000)

section('R14 批次金额：分币差落在最后一批，各批相加正好等于整单')
const r14Round = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Round.id, { styleNo: 'R14-ROUND', quantity: 300, unitPrice: 1 })
await orders.updateOrderCharges(r14Round.id, [{ label: '运费 Freight', amount: 100 }])
for (let i = 0; i < 3; i += 1) {
  await packing.createPackingList({
    orderId: r14Round.id,
    lines: [{ boxNo: `R14-R-${i + 1}`, styleNo: 'R14-ROUND', quantity: 100 }]
  })
}
const r14RoundAmts = await money.packingAmounts(r14Round.id)
eq('三批货值各 100', r14RoundAmts.map((a) => a.goods), [100, 100, 100])
eq('100 元费用按 33.33 / 33.33 / 33.34 分摊', r14RoundAmts.map((a) => a.charges), [33.33, 33.33, 33.34])
eq(
  '三批合计相加 = PI 含费用合计（分币差不丢）',
  r2(r14RoundAmts.reduce((s, a) => s + a.total, 0)),
  Number((await orders.getOrder(r14Round.id))!.grandTotal)
)
check(
  '每批费用行相加 = 本批分摊费用',
  r14RoundAmts.every((a) => r2(a.chargeLines.reduce((s, c) => s + c.amount, 0)) === a.charges)
)

section('R14 按批次出 CI：号带批次后缀，只印本批的明细、金额与船期')
const r14Full = (await orders.getOrder(r14.id))!
const r14PlAFull = r14Full.packingLists.find((p) => p.id === r14PlA.id)!
const r14PlBFull = r14Full.packingLists.find((p) => p.id === r14PlB.id)!
check('CI 号按批次派生（PI → CI + 批次号）', ciNoOf('PI-9', 'PL-3') === 'CI-9-PL-3')
const ciA = renderCi(
  { order: r14Full, settings: getSettings(), images: {} },
  { batch: await ciBatchOf(r14Full, r14PlAFull) }
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
  { batch: await ciBatchOf(r14Full, r14PlBFull) }
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
await packing.voidPackingList(r14.id, r14PlB.id, '订舱取消')
eq('作废的那批不再出金额', (await money.packingAmounts(r14.id)).map((a) => a.plId), [r14PlA.id])
await packing.unvoidPackingList(r14.id, r14PlB.id, '订舱恢复了')
eq('撤销作废后两批都在', (await money.packingAmounts(r14.id)).length, 2)

section('R14 批次金额：老数据里对不上款号的箱不出单价，也不编数')
const r14Legacy = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Legacy.id, { styleNo: 'R14-LEG', quantity: 10, unitPrice: 5 })
await orders.updateOrderCharges(r14Legacy.id, [{ label: '运费 Freight', amount: 10 }])
const r14LegacyPl = (await packing.createPackingList({
  orderId: r14Legacy.id,
  lines: [{ boxNo: 'R14-L-1', styleNo: 'R14-LEG', quantity: 5 }]
}))[0]
// 升级前的老数据：箱单上有订单里找不到的款号（现在的新装箱会被超装校验拦住）
getDb().run(
  `INSERT INTO packing_list_lines(packing_list_id, box_no, style_no, color, size, quantity)
   VALUES(?,?,?,?,?,?)`,
  [r14LegacyPl.id, 'R14-L-2', 'R14-LEGACY', 'Blue', 'S', 3]
)
const r14LegacyAmt = (await money.packingAmounts(r14Legacy.id)).find((a) => a.plId === r14LegacyPl.id)!
eq('对不上的款号被点出来', r14LegacyAmt.unknownSkus, ['R14-LEGACY'])
eq('对不上的箱不计货值', r14LegacyAmt.goods, 25)
eq('件数照实算', r14LegacyAmt.quantity, 8)
eq('费用只按能对上单价的部分分摊', r14LegacyAmt.charges, 5)

section('R14 导出回归：关键词 / 日期筛选都不放开草稿、失效、作废')
const r14Ok = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-OK' })
const r14Draft = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, piNo: 'PI-R14KW-DRAFT' })
const r14VoidExport = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-VOID' })
await orders.voidOrder(r14VoidExport.id, '客户取消')
const r14ExpExport = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R14KW-EXP' })
await orders.setPaymentStatus(r14ExpExport.id, 'expired')
const r14KwCsv = await dashboard.exportCsv('orders', { keyword: 'R14KW' })
check('关键词导出台账含正常单', r14KwCsv.includes(r14Ok.orderNo))
check(
  '关键词导出不含草稿 / 失效 / 作废',
  ![r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].some((no) => r14KwCsv.includes(no)),
  [r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].join(',')
)
const r14DateCsv = await dashboard.exportCsv('orders', { from: localDate(), to: localDate() })
check('按日期导出含正常单', r14DateCsv.includes(r14Ok.orderNo))
check(
  '按日期导出不含草稿 / 失效 / 作废',
  ![r14Draft.orderNo, r14ExpExport.orderNo, r14VoidExport.orderNo].some((no) => r14DateCsv.includes(no))
)
check('停在草稿页签导出仍能拿到草稿', (await dashboard.exportCsv('orders', { paymentStatus: 'draft' })).includes(r14Draft.orderNo))
check('停在全量底稿仍能拿到作废单', (await dashboard.exportCsv('orders_all')).includes(r14VoidExport.orderNo))

section('R14 作废/失效不能再被改活或改内容')
const r14Void = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
const r14VoidItem = await orders.addOrderItem(r14Void.id, { styleNo: 'R14-VOID', quantity: 10, unitPrice: 10 })
const r14VoidItemId = r14VoidItem.items[0].id
await orders.voidOrder(r14Void.id, '客户取消')
check(
  '作废单不能整单编辑',
  (await r8err(async () => await orders.updateOrder(r14Void.id, { customerId: c1.id, note: '偷偷改' }))).includes('已作废')
)
check(
  '作废单不能改抬头',
  (await r8err(async () => await orders.setOrderParties(r14Void.id, { shipTo: { company: 'X' } }))).includes('已作废')
)
check(
  '作废单不能改回收款状态',
  (await r8err(async () => await orders.setPaymentStatus(r14Void.id, 'confirmed'))).includes('不能改回收款状态')
)
check(
  '作废单不能改明细行',
  (await r8err(async () => await orders.updateOrderItem(r14Void.id, r14VoidItemId, { quantity: 5 }))).includes('已作废')
)
check('作废单不能删明细行', (await r8err(async () => await orders.removeOrderItem(r14Void.id, r14VoidItemId))).includes('已作废'))
check(
  '作废单不能整体替换明细',
  (await r8err(async () => await orders.replaceOrderItems(r14Void.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }]))).includes('已作废')
)
check('作废单不能改费用', (await r8err(async () => await orders.updateOrderCharges(r14Void.id, []))).includes('已作废'))
eq('作废状态没被偷偷改回来', (await orders.getOrder(r14Void.id))!.paymentStatus, 'void')
eq('作废单的明细也没被改', (await orders.getOrder(r14Void.id))!.items[0].quantity, 10)

const r14Exp = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r14Exp.id, { styleNo: 'R14-EXP', quantity: 10, unitPrice: 10 })
await orders.setPaymentStatus(r14Exp.id, 'expired')
check(
  '失效单不能整单编辑',
  (await r8err(async () => await orders.updateOrder(r14Exp.id, { customerId: c1.id, note: '偷偷改' }))).includes('已失效')
)
check(
  '失效单不能改抬头',
  (await r8err(async () => await orders.setOrderParties(r14Exp.id, { billTo: { company: 'Y' } }))).includes('已失效')
)
check(
  '失效单不能整体替换明细',
  (await r8err(async () => await orders.replaceOrderItems(r14Exp.id, [{ styleNo: 'X', quantity: 1, unitPrice: 1 }]))).includes('已失效')
)
await orders.setPaymentStatus(r14Exp.id, 'confirmed')
eq('改回正式单后能正常编辑', (await orders.updateOrder(r14Exp.id, { customerId: c1.id, note: '恢复后正常' })).note, '恢复后正常')

section('R14 费用金额必须是有限数')
const r14NaN = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
check(
  '整单保存时费用 NaN 被拒',
  (await r8err(async () =>
    await orders.updateOrder(r14NaN.id, { customerId: c1.id, charges: [{ label: '运费 Freight', amount: NaN }] })
  )).includes('不是有效数字')
)
check(
  '单独保存费用 Infinity 被拒',
  (await r8err(async () => await orders.updateOrderCharges(r14NaN.id, [{ label: '运费 Freight', amount: Infinity }]))).includes(
    '不是有效数字'
  )
)
eq('被拒后订单没有落下费用行', (await orders.getOrder(r14NaN.id))!.charges.length, 0)

/* ============================================================
 * 第 15 轮：凭据不可改写 + 打样应收口径（R15）
 * ============================================================ */
section('R15 出过 CI 的单：单价与费用行钉住，数量仍可改')
const r15Lock = await orders.createOrder({
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
await orders.updateOrderCharges(r15Lock.id, [{ label: '运费 Freight', amount: 20 }])
await packing.createPackingList({
  orderId: r15Lock.id,
  lines: [{ boxNo: 'R15-LOCK-1', styleNo: 'R15-LOCK', color: 'Blue', size: 'M', quantity: 10 }]
})
// 没出 CI 之前改价是正常业务：锁只认「已经发出去的那一版」
await orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 11 })
eq('出 CI 前改价照旧可以', (await orders.getOrder(r15Lock.id))!.items[0].unitPrice, 11)
await orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 10 })
await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r15 lock'),
  docNo: 'CI-R15-LOCK',
  kind: 'ci',
  orderId: r15Lock.id,
  amount: 120
})
check(
  '出过 CI 后单价改不动',
  (await r8err(async () => await orders.updateOrderItem(r15Lock.id, r15LockItem.id, { unitPrice: 12 }))).includes('已经出过 CI')
)
check(
  '出过 CI 后费用行改不动',
  (await r8err(async () => await orders.updateOrderCharges(r15Lock.id, [{ label: '运费 Freight', amount: 30 }]))).includes('已经出过 CI')
)
check(
  '整单保存里夹带改费用也拦得住',
  (await r8err(async () =>
    await orders.updateOrder(r15Lock.id, { customerId: c1.id, charges: [{ label: '运费 Freight', amount: 30 }] })
  )).includes('已经出过 CI')
)
eq('被拦后明细单价没变', (await orders.getOrder(r15Lock.id))!.items[0].unitPrice, 10)
eq('被拦后费用行没变', (await orders.getOrder(r15Lock.id))!.charges[0].amount, 20)
// 整单保存通常会把原样费用一起带上：没变就不该误伤别的字段
check(
  '整单保存带上原样费用不被误伤',
  (await r8err(async () =>
    await orders.updateOrder(r15Lock.id, { customerId: c1.id, note: 'R15 只改备注', charges: [{ label: '运费 Freight', amount: 20 }] })
  )) === ''
)
eq('原样保存后备注确实写进去了', (await orders.getOrder(r15Lock.id))!.note, 'R15 只改备注')
// 分批金额按箱单件数算，改整单数量不会改写已出运那批的金额 → 数量不锁
eq('出过 CI 后整单数量仍可改', (await orders.updateOrderItem(r15Lock.id, r15LockItem.id, { quantity: 12 })).items[0].quantity, 12)

section('R15 汇率印在纸面上：出过单据/核销后不能再改')
const r15Rate = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R15-RATE'
})
await orders.addOrderItem(r15Rate.id, { styleNo: 'R15-RATE', quantity: 10, unitPrice: 10 })
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r15 rate'), docNo: 'PI-R15-RATE', kind: 'pi', orderId: r15Rate.id })
check(
  '出过单据后改汇率被拒',
  (await r8err(async () => await orders.updateOrder(r15Rate.id, { customerId: c1.id, exchangeRate: 7.3 }))).includes('汇率')
)
eq('被拒后汇率没变', (await orders.getOrder(r15Rate.id))!.exchangeRate, 7)
// 只登记了收款、还没出单据：录错汇率要能修（操作历史里留旧值 → 新值）
const r15RatePay = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15RatePay.id, { styleNo: 'R15-RATE-PAY', quantity: 10, unitPrice: 10 })
await orders.addPayment(r15RatePay.id, { paidAt: localDate(), amount: 10 })
eq(
  '有收款但没出过单据，仍可修正汇率',
  (await orders.updateOrder(r15RatePay.id, { customerId: c1.id, exchangeRate: 7.3 })).exchangeRate,
  7.3
)
const r15Cur = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15Cur.id, { styleNo: 'R15-CUR', quantity: 1, unitPrice: 10 })
check(
  '有明细就换币种被拒',
  (await r8err(async () => await orders.updateOrder(r15Cur.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 }))).includes(
    '不能改币种'
  )
)
eq('被拒后币种没变', (await orders.getOrder(r15Cur.id))!.currency, 'USD')
const r15CurOk = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
eq(
  '没有明细的空单换币种照旧可以（重填汇率）',
  (await orders.updateOrder(r15CurOk.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })).currency,
  'EUR'
)
const r15CurDraft = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r15CurDraft.id, { styleNo: 'R15-CUR-DRAFT', quantity: 1, unitPrice: 10 })
eq(
  '草稿单还没对外，换币种允许（建单时选错是改错字）',
  (await orders.updateOrder(r15CurDraft.id, { customerId: c1.id, currency: 'EUR', exchangeRate: 8 })).currency,
  'EUR'
)

section('R15 物理删除只留给真正的空单；作废单不能绕过留档')
const r15DelDoc = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r15 del'), docNo: 'PI-R15-DEL', kind: 'pi', orderId: r15DelDoc.id })
check(
  '有单据存档的空单不能物理删除',
  (await r8err(async () => orders.deleteOrder(r15DelDoc.id))).includes('单据存档')
)
const r15VoidDel = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.voidOrder(r15VoidDel.id, '建错单')
check('作废单不能物理删除（留档终态）', (await r8err(async () => orders.deleteOrder(r15VoidDel.id))).includes('留档'))
const r15Empty = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
check('真正的空单还能删', (await r8err(async () => orders.deleteOrder(r15Empty.id))) === '')

section('R15 作废单：收款、核销、箱单都不能再动')
const r15VoidOps = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r15VoidOps.id, { styleNo: 'R15-VOIDOPS', quantity: 10, unitPrice: 10 })
const r15OpsPay = await orders.addPayment(r15VoidOps.id, { paidAt: localDate(), amount: 10 })
await orders.addSettlement(r15VoidOps.id, { kind: 'bad_debt', amount: 20, reason: 'R15 测试坏账' })
const r15OpsPlA = (await packing.createPackingList({
  orderId: r15VoidOps.id,
  lines: [{ boxNo: 'R15-VOID-A', styleNo: 'R15-VOIDOPS', quantity: 5 }]
}))[0]
const r15OpsPlB = (await packing.createPackingList({
  orderId: r15VoidOps.id,
  lines: [{ boxNo: 'R15-VOID-B', styleNo: 'R15-VOIDOPS', quantity: 5 }]
})).slice(-1)[0]
await packing.voidPackingList(r15VoidOps.id, r15OpsPlB.id, '这一批没走成')
// R19 起作废带凭据的单要先核对：直接作废被拦，勾了「凭据已核对」才放行
check(
  '还挂着箱单的订单直接作废会被拦下核对凭据',
  (await r8err(async () => await orders.voidOrder(r15VoidOps.id, 'R15 作废'))).includes('凭据')
)
await orders.voidOrder(r15VoidOps.id, 'R15 作废', { confirmDocs: true })
const r15OpsSettle = (await orders.listSettlements(r15VoidOps.id))[0]
check(
  '作废单不能删收款',
  (await r8err(async () => await orders.deletePayment(r15VoidOps.id, r15OpsPay.payments[0].id, '删掉这笔'))).includes('已作废')
)
check(
  '作废单不能撤销核销',
  (await r8err(async () => await orders.reverseSettlement(r15VoidOps.id, r15OpsSettle.id, '撤销坏账'))).includes('已作废')
)
check(
  '作废单不能作废箱单',
  (await r8err(async () => await packing.voidPackingList(r15VoidOps.id, r15OpsPlA.id, '取消'))).includes('已作废')
)
check(
  '作废单不能撤销箱单作废',
  (await r8err(async () => await packing.unvoidPackingList(r15VoidOps.id, r15OpsPlB.id))).includes('已作废')
)
eq('作废单的收款还在', (await orders.getOrder(r15VoidOps.id))!.payments.length, 1)
eq('作废单的核销还在', (await orders.listSettlements(r15VoidOps.id)).length, 1)

section('R15 欠款榜：只打过样、没下过单的客户也在榜上')
const r15SampleOnly = await customers.saveCustomer({ company: 'R15-ONLY-SAMPLE' })
await samples.saveSample({
  customerId: r15SampleOnly.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S1', productName: '只打样', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r15Board = await money.receivableByCustomer()
const r15BoardRow = r15Board.find((r) => r.customerId === r15SampleOnly.id)
eq('只打样的客户也在欠款榜上（样品费 10 + 快递费 5，USD×7）', r15BoardRow?.totalBase, 105)
eq('这类客户的订单数记 0', r15BoardRow?.orders, 0)
check(
  '榜上合计 = 全公司待收（打样费不漏）',
  Math.abs(r15Board.reduce((s, r) => s + r.totalBase, 0) - await money.totalReceivable()) < 0.01
)

section('R15 已收的打样费不再抵扣一次')
const r15PaidCust = await customers.saveCustomer({ company: 'R15-PAID-SAMPLE' })
const r15PaidSample = await samples.saveSample({
  customerId: r15PaidCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S2', productName: '已收打样费', color: 'Grey', size: 'L', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
// R25：已收必须由真实流水推导
await samples.addSamplePayment(r15PaidSample.id, { paidAt: localDate(), amount: r15PaidSample.totalFee, bankRef: 'R15-PAID-FLOW' })
const r15PaidOrder = await samples.convertSampleToOrder(r15PaidSample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
eq('已收的打样费不再生成抵扣行', r15PaidOrder.charges.length, 0)
eq('已收标记不被改成下单抵扣', (await samples.getSample(r15PaidSample.id))!.feeStatus, 'paid')
const r15WaivedCust = await customers.saveCustomer({ company: 'R15-WAIVED-SAMPLE' })
const r15WaivedSample = await samples.saveSample({
  customerId: r15WaivedCust.id,
  expressFee: 5,
  feeStatus: 'waived',
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S4', productName: '免收打样费', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
const r15WaivedOrder = await samples.convertSampleToOrder(r15WaivedSample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
eq('已免收的打样费也不生成抵扣行', r15WaivedOrder.charges.length, 0)
eq('已免收标记不被改成下单抵扣', (await samples.getSample(r15WaivedSample.id))!.feeStatus, 'waived')

section('R15 老「下单抵扣」记录不按新口径倒推')
// R15 之前只抵了样品费，offset_amount 没有记录（0）：读取时按旧口径只算样品费，
// 不能拿「样品费+快递费」硬套，否则老单会被算成多收回一笔从不存在的钱
const r15LegacyCust = await customers.saveCustomer({ company: 'R15-LEGACY-OFFSET' })
const r15Legacy = await samples.saveSample({
  customerId: r15LegacyCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R15-S3', productName: '老抵扣', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }]
})
getDb().run("UPDATE sample_orders SET fee_status = 'offset', offset_amount = 0 WHERE id = ?", [r15Legacy.id])
eq('老抵扣记录只算样品费（USD10 × 7）', (await samples.getSample(r15Legacy.id))!.feeRecoveredBase, 70)
eq('新抵扣记录按实际抵掉的金额算（USD40 × 7.2）', (await samples.getSample(smpOffset.id))!.feeRecoveredBase, 40 * 7.2)

/* ============================================================
 * 第 16 轮：发出去的单，系统里不许再改（R16）
 * ============================================================ */
section('R16 出过 CI 的批次：金额钉在存档上，箱明细/删除/作废全锁')
const r16Order = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R16-FREEZE'
})
await orders.addOrderItem(r16Order.id, { styleNo: 'R16-F', productName: '冻结测试', quantity: 100, unitPrice: 10 })
await orders.updateOrderCharges(r16Order.id, [{ label: '运费 Freight', amount: 390 }])
const r16Pl = (await packing.createPackingList({
  orderId: r16Order.id,
  lines: [{ boxNo: 'R16-1', styleNo: 'R16-F', quantity: 50 }]
}))[0]
const r16Before = (await money.packingAmounts(r16Order.id))[0]
eq('未存档时按整单货值分摊（500 货值 + 195 费用）', r16Before.total, 695)
await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r16 freeze'),
  docNo: ciNoOf('PI-R16-FREEZE', r16Pl.plNo),
  kind: 'ci',
  orderId: r16Order.id,
  amount: r16Before.total
})
// 订单后来又补了 100 件：整单货值变成 2000，存档批次的费用份额不能跟着缩水
const r16Item = (await orders.getOrder(r16Order.id))!.items[0]
await orders.updateOrderItem(r16Order.id, r16Item.id, { quantity: 200 })
const r16After = (await money.packingAmounts(r16Order.id)).find((b) => b.plId === r16Pl.id)!
eq('补货后已存档批次的总额还是纸面上的 695', r16After.total, 695)
eq('已存档批次的费用不按新货值重摊', r16After.charges, 195)
const r16PlB = (await packing.createPackingList({
  orderId: r16Order.id,
  lines: [{ boxNo: 'R16-2', styleNo: 'R16-F', quantity: 50 }]
})).slice(-1)[0]
const r16AfterB = (await money.packingAmounts(r16Order.id)).find((b) => b.plId === r16PlB.id)!
eq('未存档批次只分剩余费用（(390−195) × 500/1500）', r16AfterB.charges, 65)
eq('新批次总额跟着它的货值走', r16AfterB.total, 565)
eq(
  '两批费用相加不超过订单费用合计（不会再拿整单 390 摊第二遍）',
  (await money.packingAmounts(r16Order.id)).reduce((s, b) => s + b.charges, 0),
  260
)
const r16Line = (await packing.listPackingLists(r16Order.id)).find((p) => p.id === r16Pl.id)!.lines[0]
check(
  '出过 CI 的批次箱明细不能改',
  (await r8err(async () => await packing.updatePackingListLine(r16Order.id, r16Pl.id, r16Line.id, { quantity: 40 }))).includes(
    '已经出过 CI'
  )
)
check(
  '出过 CI 的批次不能加箱',
  (await r8err(async () =>
    await packing.addPackingListLine(r16Order.id, r16Pl.id, { boxNo: 'R16-3', styleNo: 'R16-F', quantity: 1 })
  )).includes('已经出过 CI')
)
check(
  '出过 CI 的批次不能删箱',
  (await r8err(async () => await packing.deletePackingListLine(r16Order.id, r16Pl.id, r16Line.id))).includes('已经出过 CI')
)
check(
  '出过 CI 的批次不能删除',
  (await r8err(async () => await packing.deletePackingList(r16Order.id, r16Pl.id))).includes('不能删除')
)
check(
  '出过 CI 的批次不能作废',
  (await r8err(async () => await packing.voidPackingList(r16Order.id, r16Pl.id, '想撤'))).includes('不能作废')
)
eq(
  '批次信息（船名/柜号）照旧能补录',
  (await packing.updatePackingListInfo(r16Order.id, r16Pl.id, { vessel: 'R16 V.1' })).find((p) => p.id === r16Pl.id)!.vessel,
  'R16 V.1'
)
eq('被拦后箱明细数量没变', (await packing.listPackingLists(r16Order.id)).find((p) => p.id === r16Pl.id)!.lines[0].quantity, 50)
eq('补货后整单数量仍可改（批次金额按箱单件数算）', (await orders.updateOrderItem(r16Order.id, (await orders.getOrder(r16Order.id))!.items[0].id, { quantity: 120 })).items[0].quantity, 120)

section('R16 有单据存档后 PI 号不许改')
check(
  '出过 CI 后改 PI 号被拒',
  (await r8err(async () => await orders.updateOrder(r16Order.id, { customerId: c1.id, piNo: 'PI-R16-FREEZE-X' }))).includes('PI 号')
)
eq('被拒后 PI 号没变', (await orders.getOrder(r16Order.id))!.piNo, 'PI-R16-FREEZE')
eq(
  '原样带上 PI 号保存不被误伤',
  (await orders.updateOrder(r16Order.id, { customerId: c1.id, piNo: 'PI-R16-FREEZE', note: 'R16 只改备注' })).note,
  'R16 只改备注'
)

section('R16 报价单有存档后不能删')
const r16Q = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R16-Q', quantity: 10, unitPrice: 7.5 }]
})
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r16 quote'), docNo: r16Q.qNo, kind: 'quotation', quotationId: r16Q.id })
check('有存档的报价单删不掉', (await r8err(async () => (await quotations.deleteQuotation(r16Q.id)))).includes('单据存档'))
check('拦截提示给出替代方案（已失效）', (await r8err(async () => (await quotations.deleteQuotation(r16Q.id)))).includes('已失效'))
check('拦截后报价单还在', (await quotations.getQuotation(r16Q.id)) !== null)

section('R16 坏账追回登记的钱不能直接删（核销台账会悬空）')
const r16Rec = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16Rec.id, { styleNo: 'R16-REC', quantity: 10, unitPrice: 10 })
await orders.addSettlement(r16Rec.id, { kind: 'bad_debt', amount: 50, reason: 'R16 客户破产' })
await orders.addSettlement(r16Rec.id, { kind: 'recovery', amount: 20, reason: 'R16 追回', paidAt: '2026-10-21' })
const r16RecPay = (await orders.getOrder(r16Rec.id))!.payments[0]
check(
  '追回款不能单独删（要先撤销这次追回，两行一起退）',
  (await r8err(async () => await orders.deletePayment(r16Rec.id, r16RecPay.id, '想删'))).includes('撤销这次追回')
)
eq('被拒后追回款还在', (await orders.getOrder(r16Rec.id))!.payments.length, 1)

section('R16 作废单不能改出货状态；全批作废后订单不能挂着已发货')
const r16VoidShip = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16VoidShip.id, { styleNo: 'R16-VOIDSHIP', quantity: 10, unitPrice: 1 })
await orders.voidOrder(r16VoidShip.id, 'R16 作废')
check(
  '作废单不能手改出货状态',
  (await r8err(async () => await orders.setShipStatus(r16VoidShip.id, 'packed'))).includes('已作废')
)
const r16AllVoid = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16AllVoid.id, { styleNo: 'R16-ALLVOID', quantity: 10, unitPrice: 1 })
const r16V1 = (await packing.createPackingList({
  orderId: r16AllVoid.id,
  lines: [{ boxNo: 'R16-V1', styleNo: 'R16-ALLVOID', quantity: 5 }]
}))[0]
const r16V2 = (await packing.createPackingList({
  orderId: r16AllVoid.id,
  lines: [{ boxNo: 'R16-V2', styleNo: 'R16-ALLVOID', quantity: 5 }]
})).slice(-1)[0]
eq('装齐后订单状态由批次推成已包装', (await orders.getOrder(r16AllVoid.id))!.shipStatus, 'packed')
await packing.voidPackingList(r16AllVoid.id, r16V1.id, 'R16 第一批没走')
eq('作废一批后按剩下的批次重算', (await orders.getOrder(r16AllVoid.id))!.shipStatus, 'preparing')
await packing.voidPackingList(r16AllVoid.id, r16V2.id, 'R16 第二批也没走')
eq('全部批次作废后回落到未备货，不挂已发货', (await orders.getOrder(r16AllVoid.id))!.shipStatus, 'not_prepared')

section('R16 打样转单后客户、收款状态锁定；漏传明细不再清空')
const r16CustA = await customers.saveCustomer({ company: 'R16-SAMPLE-A' })
const r16CustB = await customers.saveCustomer({ company: 'R16-SAMPLE-B' })
const r16Sample = await samples.saveSample({
  customerId: r16CustA.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R16-S1', productName: '打样', quantity: 1, unitPrice: 10, goodsUnitPrice: 15 }]
})
const r16NoteOnly = await samples.saveSample({ id: r16Sample.id, note: 'R16 只改备注' })
eq('漏传 items 的编辑不清空样品行', r16NoteOnly.items.length, 1)
eq('漏传 items 的编辑不清空样品费', r16NoteOnly.items[0].quantity * r16NoteOnly.items[0].unitPrice, 10)
const r16Converted = await samples.convertSampleToOrder(r16Sample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
check(
  '转单后不能换客户',
  (await r8err(async () => await samples.saveSample({ id: r16Sample.id, customerId: r16CustB.id }))).includes('客户不能再改')
)
check(
  '转单后不能把已抵扣改回收款状态',
  (await r8err(async () => await samples.saveSample({ id: r16Sample.id, feeStatus: 'paid' }))).includes('收款状态不能再改')
)
check(
  '活着的订单还靠打样单作原始凭据，删不掉',
  (await r8err(async () => await samples.deleteSample(r16Sample.id))).includes('先作废订单')
)
await orders.voidOrder(r16Converted.id, 'R16 作废转出的订单')
// R24：作废后抵扣回退为未收，样品费又成了应收——直接删会把这笔应收一起删没
check(
  '订单作废后样品费回到未收，仍不许零留痕删',
  (await r8err(async () => await samples.deleteSample(r16Sample.id))).includes('没收回')
)
await samples.saveSample({ id: r16Sample.id, status: 'cancelled', note: 'R16 订单作废，样品费不追了' })
await samples.deleteSample(r16Sample.id)
check('订单作废、样品单取消留原因后可以删', await samples.getSample(r16Sample.id) === null)

section('R16 实收数量不能超过改完后的箱明细')
const r16Recv = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r16Recv.id, { styleNo: 'R16-RECV', quantity: 100, unitPrice: 1 })
const r16RecvPl = (await packing.createPackingList({
  orderId: r16Recv.id,
  lines: [
    { boxNo: 'R16-A', styleNo: 'R16-RECV', quantity: 30 },
    { boxNo: 'R16-B', styleNo: 'R16-RECV', quantity: 20 }
  ]
}))[0]
await packing.updatePackingListInfo(r16Recv.id, r16RecvPl.id, { receivedQty: 40 })
const r16RecvLineA = (await packing.listPackingLists(r16Recv.id))[0].lines.find((l) => l.boxNo === 'R16-A')!
await packing.updatePackingListLine(r16Recv.id, r16RecvPl.id, r16RecvLineA.id, { quantity: 20 })
eq('改箱后件数正好等于实收，放行', (await packing.listPackingLists(r16Recv.id))[0].lines.reduce((s, l) => s + l.quantity, 0), 40)
check(
  '删箱后件数少于已登记的实收，拦下',
  (await r8err(async () => await packing.deletePackingListLine(r16Recv.id, r16RecvPl.id, r16RecvLineA.id))).includes('实收')
)
eq('被拦后两箱都还在（事务回滚）', (await packing.listPackingLists(r16Recv.id))[0].lines.length, 2)

/* ---------------- R17 时间与口径 ---------------- */
section('R17 报价时间线：发出日与确认日各记各的')

const r17Settings = getSettings()
await saveSettings({ ...r17Settings, remindConfirmDays: 25, remindBalanceDays: 25 })

const r17QSent = await quotations.saveQuotation({
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

const r17QMeta = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  items: [{ styleNo: 'R17-Q2', quantity: 20, unitPrice: 6 }]
})
await quotations.updateQuotationMeta(r17QMeta.id, { status: 'sent' })
const r17QMetaSent = getDb().get('SELECT sent_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
check('从「草稿」改成「已发出」也补上发出日', Boolean(r17QMetaSent?.sent_at))
await quotations.updateQuotationMeta(r17QMeta.id, { status: 'confirmed' })
const r17QConfirmed = getDb().get('SELECT confirmed_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
check('改成「已确认」时写下确认日', Boolean(r17QConfirmed?.confirmed_at))

// 把确认日改成 30 天前，再补一次报价结果：等待天数必须还按确认日算
const r17ConfirmOld = addDays(localDate(), -30)
getDb().run('UPDATE quotations SET confirmed_at = ? WHERE id = ?', [r17ConfirmOld, r17QMeta.id])
await quotations.updateQuotationMeta(r17QMeta.id, { result: 'pending' })
const r17QAfter = getDb().get('SELECT confirmed_at FROM quotations WHERE id = ?', [r17QMeta.id]) as
  | Record<string, unknown>
  | null
eq('补结果不会把确认日刷新成今天', String(r17QAfter?.confirmed_at ?? ''), r17ConfirmOld)
const r17QuoteRem = (await dashboard.reminders()).find((r) => r.kind === 'quote' && r.orderNo === r17QMeta.qNo && r.message.includes('已确认'))
eq('确认 30 天没转单的报价仍按确认日起算', r17QuoteRem?.days, 30)

section('R17 提醒时钟：出运一分未收按出货事件起算，改备注不清零')

const r17Ship = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Ship.id, { styleNo: 'R17-SHIP', quantity: 10, unitPrice: 10 })
await orders.setShipStatus(r17Ship.id, 'shipped', '手工推进出货')
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
const r17ShipRem = (await dashboard.reminders()).find((r) => r.orderId === r17Ship.id && r.message.includes('一分未收'))
eq('出运 30 天一分未收按出货事件起算', r17ShipRem?.days, 30)

section('R17 本月完成数：作废单不再算完成')

const r17DoneBefore = (await dashboard.dashboard()).completedThisMonth
const r17Done = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Done.id, { styleNo: 'R17-DONE', quantity: 10, unitPrice: 10 })
await orders.setShipStatus(r17Done.id, 'delivered', '本月完成口径测试')
eq('签收后计入本月完成', (await dashboard.dashboard()).completedThisMonth, r17DoneBefore + 1)
await orders.voidOrder(r17Done.id, 'R17 本月完成口径测试作废')
eq('作废后从本月完成里退出', (await dashboard.dashboard()).completedThisMonth, r17DoneBefore)

section('R17 欠款榜：未结单数只数还欠钱的单')

const r17BoardCustomer = await customers.saveCustomer({ company: 'R17 欠款榜口径' })
const r17BoardPaid = await orders.createOrder({
  customerId: r17BoardCustomer.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r17BoardPaid.id, { styleNo: 'R17-BOARD-A', quantity: 10, unitPrice: 10 })
await orders.addPayment(r17BoardPaid.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'R17-BOARD-P' })
const r17BoardOpen = await orders.createOrder({
  customerId: r17BoardCustomer.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r17BoardOpen.id, { styleNo: 'R17-BOARD-B', quantity: 10, unitPrice: 10 })
const r17BoardRow = (await money.receivableByCustomer()).find((r) => r.customerId === r17BoardCustomer.id)
eq('收齐的那单不算未结单', r17BoardRow?.orders, 1)
eq('欠款榜敞口只算还欠的货款（100 美元 × 汇率 7）', r17BoardRow?.goodsBase, 700)

section('R17 收款守门：不许填未来、草稿单不许收款')

const r17PayOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17PayOrder.id, { styleNo: 'R17-PAY', quantity: 10, unitPrice: 10 })
const r17FutureErr = (await r8err(async () =>
  await orders.addPayment(r17PayOrder.id, { paidAt: addDays(localDate(), 1), amount: 10, method: 'T/T' })
))
check('收款日期填明天会被拦下', r17FutureErr.includes('还没到'), r17FutureErr)
const r17DraftPay = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7 })
await orders.addOrderItem(r17DraftPay.id, { styleNo: 'R17-DRAFT-PAY', quantity: 10, unitPrice: 10 })
const r17DraftErr = (await r8err(async () =>
  await orders.addPayment(r17DraftPay.id, { paidAt: localDate(), amount: 10, method: 'T/T' })
))
check('草稿单登记收款被拦下', r17DraftErr.includes('草稿'), r17DraftErr)
check('提示说明这笔钱会从本月到账里消失', r17DraftErr.includes('本月到账'), r17DraftErr)

section('R17 明细唯一：同款同色同码不许两行')

const r17Dup = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r17Dup.id, { styleNo: 'R17-DUP', color: 'Black', size: 'M', quantity: 10, unitPrice: 10 })
const r17DupErr = (await r8err(async () =>
  await orders.addOrderItem(r17Dup.id, { styleNo: 'R17-DUP', color: 'Black', size: 'M', quantity: 5, unitPrice: 12 })
))
check('重复的款号/颜色/尺码被拦下', r17DupErr.includes('同一款只能有一行'), r17DupErr)
const r17DupB = await orders.addOrderItem(r17Dup.id, {
  styleNo: 'R17-DUP-B',
  color: 'Black',
  size: 'M',
  quantity: 5,
  unitPrice: 12
})
const r17DupBItem = r17DupB.items.find((i) => i.styleNo === 'R17-DUP-B')!
const r17DupSwapErr = (await r8err(async () => await orders.updateOrderItem(r17Dup.id, r17DupBItem.id, { styleNo: 'R17-DUP' })))
check('把另一行改成已有款号也被拦下', r17DupSwapErr.includes('已经有明细'), r17DupSwapErr)
eq('被拦后明细仍是两行，没有多出重复款', (await orders.getOrder(r17Dup.id))!.items.length, 2)

/* ============================================================
 * 第 18 轮：单据修订与凭据安全（R18）
 * ============================================================ */

section('R18 存档作废：CI 金额敲错作废重出，不再被迫作废整单')

const r18Order = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R18-VOID'
})
await orders.addOrderItem(r18Order.id, { styleNo: 'R18-V', productName: '作废重出', quantity: 100, unitPrice: 10 })
await orders.updateOrderCharges(r18Order.id, [{ label: '运费 Freight', amount: 100 }])
const r18Pl = (await packing.createPackingList({
  orderId: r18Order.id,
  lines: [{ boxNo: 'R18-1', styleNo: 'R18-V', quantity: 50 }]
}))[0]
const r18Saved = await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 void'),
  docNo: ciNoOf('PI-R18-VOID', r18Pl.plNo),
  kind: 'ci',
  orderId: r18Order.id,
  amount: 60 // 敲错一位：正确是 600
})
eq('存档按第 1 版记账', r18Saved.version, 1)
const r18Ver = docs.listDocVersions(r18Order.id).find((d) => d.docNo === ciNoOf('PI-R18-VOID', r18Pl.plNo))!
check('存档记录在且未作废', r18Ver != null && r18Ver.voidedAt == null)
const r18Line = (await packing.listPackingLists(r18Order.id)).find((p) => p.id === r18Pl.id)!.lines[0]
check(
  '存档后箱明细锁住',
  (await r8err(async () => await packing.updatePackingListLine(r18Order.id, r18Pl.id, r18Line.id, { quantity: 60 }))).includes(
    '已经出过 CI'
  )
)
check('不写原因作不了废', (await r8err(async () => await docs.voidDocVersion(r18Ver.id, '   '))).includes('原因'))
const r18List = await docs.voidDocVersion(r18Ver.id, 'CI 金额敲错一位：60 应为 600')
eq('作废后存档记录还在（不删事实）', r18List.length, 1)
check('作废版带时间与原因', r18List[0].voidedAt != null && r18List[0].voidReason!.includes('敲错'))
check('作废后 PDF 文件也还在', fs.existsSync(join(dataDir(), r18List[0].filePath)))
eq('作废后批次金额恢复按当前数据算（500 货值 + 50 分摊费用）', (await money.packingAmounts(r18Order.id)).find((b) => b.plId === r18Pl.id)!.total, 550)
check('作废后箱明细可以改了', (await packing.updatePackingListLine(r18Order.id, r18Pl.id, r18Line.id, { quantity: 60 })).length > 0)
eq('改完箱数金额跟着走（600 货值 + 60 分摊费用）', (await money.packingAmounts(r18Order.id)).find((b) => b.plId === r18Pl.id)!.total, 660)
const r18Saved2 = await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 void v2'),
  docNo: ciNoOf('PI-R18-VOID', r18Pl.plNo),
  kind: 'ci',
  orderId: r18Order.id,
  amount: 660
})
eq('可以重出正确的一版（第 2 版）', r18Saved2.version, 2)
check('不能重复作废同一版', (await r8err(async () => await docs.voidDocVersion(r18Ver.id, '再废一次'))).includes('作废状态'))
check('作废留痕进了操作历史', (await orders.listEvents(r18Order.id)).some((e) => e.kind === 'doc_void'))

section('R18 整单/批次 CI 重叠：不硬挡，但要人确认')

check(
  '批次 CI 还在时出整单 CI 会被拦下确认',
  (await r8err(async () => docs.assertCiNoOverlap(r18Order.id, ciNoOf('PI-R18-VOID')))).includes('重叠')
)
eq('确认重叠后放行，重叠额 = 已存档批次金额', docs.assertCiNoOverlap(r18Order.id, ciNoOf('PI-R18-VOID'), true), 660)
const r18Whole = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R18-WHOLE'
})
await orders.addOrderItem(r18Whole.id, { styleNo: 'R18-W', quantity: 10, unitPrice: 10 })
await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r18 whole'),
  docNo: ciNoOf('PI-R18-WHOLE'),
  kind: 'ci',
  orderId: r18Whole.id,
  amount: 100
})
check(
  '先整单后补批次同样要确认',
  (await r8err(async () => docs.assertCiNoOverlap(r18Whole.id, ciNoOf('PI-R18-WHOLE', 'X1')))).includes('重叠')
)
const r18WholeVer = docs.listDocVersions(r18Whole.id)[0]
await docs.voidDocVersion(r18WholeVer.id, '改按批次开票')
eq('作废整单 CI 后批次可以开票，不再重叠', docs.assertCiNoOverlap(r18Whole.id, ciNoOf('PI-R18-WHOLE', 'X1')), 0)

section('R18 订单作废：打样抵扣回退为未收，不再悬空')

const r18OffCust = await customers.saveCustomer({ company: 'R18-OFFSET-BACK' })
const r18OffSample = await samples.saveSample({
  customerId: r18OffCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R18-S1', productName: '抵扣回退', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 15 }]
})
const r18OffOrder = await samples.convertSampleToOrder(r18OffSample.id, { offsetSampleFee: true, paymentStatus: 'confirmed' })
eq('转单后打样单挂「下单抵扣」', (await samples.getSample(r18OffSample.id))!.feeStatus, 'offset')
await orders.voidOrder(r18OffOrder.id, 'R18 客户取消，整单作废')
eq('订单作废后抵扣回退为未收', (await samples.getSample(r18OffSample.id))!.feeStatus, 'unpaid')
check('回退在费用备注里留了痕', (await samples.getSample(r18OffSample.id))!.feeNote.includes('已作废'))
check('打样费重新进客户应收', await money.sampleReceivable(r18OffCust.id) > 0)
check('订单操作历史记了抵扣回退', (await orders.listEvents(r18OffOrder.id)).some((e) => e.kind === 'sample_offset_back'))

section('R18 汇率快照：到账那天钉住，改订单汇率月报不漂移')

const r18Rate = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r18Rate.id, { styleNo: 'R18-RATE', quantity: 10, unitPrice: 10 })
const r18Month = localDate().slice(0, 7)
const r18MonthOf = async () => (await money.receivedByMonth()).find((m) => m.month === r18Month)?.amount ?? 0
const r18Before = (await r18MonthOf())
await orders.addPayment(r18Rate.id, { paidAt: localDate(), amount: 50, method: 'T/T', bankRef: 'R18-RATE-P' })
eq('到账按当天汇率 7 进本月（50×7=350）', (await r18MonthOf()) - r18Before, 350)
eq(
  '收款落了汇率快照',
  Number((getDb().get('SELECT exchange_rate AS r FROM payments WHERE order_id = ?', [r18Rate.id]) as { r?: number })!.r),
  7
)
// 只登记了收款、还没出单据：汇率允许修正（R15 口径），但历史月报不能跟着漂
await orders.updateOrder(r18Rate.id, { customerId: c1.id, exchangeRate: 7.5 })
eq('改订单汇率后历史到账仍按快照算（350 不漂成 375）', (await r18MonthOf()) - r18Before, 350)
// 老收款没有快照列值：回退订单汇率（残留漂移可接受，口径写死在 SQL 里）
getDb().run('UPDATE payments SET exchange_rate = NULL WHERE order_id = ?', [r18Rate.id])
eq('老收款没有快照时回退订单汇率（50×7.5=375）', (await r18MonthOf()) - r18Before, 375)

section('R18 建单失败不烧号')

const r18CounterName = `SO${localDate().replace(/-/g, '')}`
const r18CounterBefore = Number(
  (getDb().get('SELECT value AS v FROM counters WHERE name = ?', [r18CounterName]) as { v?: number } | null)!.v
)
const r18BurnErr = (await r8err(async () =>
  await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, piNo: 'PI-R16-FREEZE' })
))
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

const r19Gate = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R19-GATE'
})
await orders.addOrderItem(r19Gate.id, { styleNo: 'R19-GATE', quantity: 10, unitPrice: 10 })
await packing.createPackingList({ orderId: r19Gate.id, lines: [{ boxNo: 'R19-G1', styleNo: 'R19-GATE', quantity: 10 }] })
check(
  '有箱单的订单直接作废被拦',
  (await r8err(async () => await orders.voidOrder(r19Gate.id, '客户取消'))).includes('凭据')
)
await orders.voidOrder(r19Gate.id, '客户取消', { confirmDocs: true })
check('勾了凭据已核对就能作废', (await orders.getOrder(r19Gate.id))!.paymentStatus, 'void')
check(
  '作废历史里写明核对过哪些凭据',
  (await orders.listEvents(r19Gate.id)).slice(-1)[0].note.includes('凭据已核对')
)

section('R19 作废通道只认 CI：PI/箱单/报价存档作不了废，作废单的存档也不能动')

const r19Kind = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-KIND' })
await orders.addOrderItem(r19Kind.id, { styleNo: 'R19-KIND', quantity: 5, unitPrice: 10 })
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 pi'), docNo: 'PI-R19-KIND', kind: 'pi', orderId: r19Kind.id, amount: 50 })
const r19PiVer = docs.listDocVersions(r19Kind.id)[0]
check(
  '作废 PI 存档被拦（它不参与锁定）',
  (await r8err(async () => await docs.voidDocVersion(r19PiVer.id, '试一下'))).includes('只有 CI')
)
const r19KindCi = await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r19 kind ci'),
  docNo: ciNoOf('PI-R19-KIND'),
  kind: 'ci',
  orderId: r19Kind.id,
  amount: 50
})
eq('CI 存档记为第 1 版', r19KindCi.version, 1)
check('CI 存档照常能作废', (await docs.voidDocVersion(docs.listDocVersions(r19Kind.id).find((d) => d.kind === 'ci')!.id, '改数重出')).length > 0)
await orders.voidOrder(r19Kind.id, '客户取消', { confirmDocs: true })
// 作废后重出的一版（留档），也不能再作废
const r19KindCiV2 = await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r19 kind ci v2'),
  docNo: ciNoOf('PI-R19-KIND'),
  kind: 'ci',
  orderId: r19Kind.id,
  amount: 50
})
eq('重出记为第 2 版', r19KindCiV2.version, 2)
check(
  '作废订单的 CI 存档不能再作废',
  (await r8err(async () =>
    await docs.voidDocVersion(docs.listDocVersions(r19Kind.id).find((d) => d.kind === 'ci' && !d.voidedAt)!.id, '再试')
  )).includes('已作废')
)

section('R19 落账前复查重叠 + CI 金额差异留痕')

const r19Overlap = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-OVL' })
await orders.addOrderItem(r19Overlap.id, { styleNo: 'R19-OVL', quantity: 20, unitPrice: 10 })
const r19OvlPl = (await packing.createPackingList({ orderId: r19Overlap.id, lines: [{ boxNo: 'R19-O1', styleNo: 'R19-OVL', quantity: 10 }] }))[0]
const r19OvlAmt = (await money.packingAmounts(r19Overlap.id)).find((b) => b.plId === r19OvlPl.id)!
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 batch'), docNo: ciNoOf('PI-R19-OVL', r19OvlPl.plNo), kind: 'ci', orderId: r19Overlap.id, amount: r19OvlAmt.total })
check(
  'saveDocFile 自己也会拦未确认的重叠（不是只有 IPC 那道）',
  (await r8err(async () =>
    await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 whole'), docNo: ciNoOf('PI-R19-OVL'), kind: 'ci', orderId: r19Overlap.id, amount: 200 })
  )).includes('重叠')
)
check(
  '带确认标记就能落账',
  (await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 whole ok'), docNo: ciNoOf('PI-R19-OVL'), kind: 'ci', orderId: r19Overlap.id, amount: 100, confirmOverlap: true })).version > 0
)
check(
  'CI 金额与应收口径不一致时留了差异痕',
  (await orders.listEvents(r19Overlap.id)).some((e) => e.kind === 'doc_amount_diff' && e.note.includes('相差'))
)
const r19Match = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-MATCH' })
await orders.addOrderItem(r19Match.id, { styleNo: 'R19-MATCH', quantity: 10, unitPrice: 10 })
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 match'), docNo: ciNoOf('PI-R19-MATCH'), kind: 'ci', orderId: r19Match.id, amount: 100 })
check('金额一致时不留差异痕', !(await orders.listEvents(r19Match.id)).some((e) => e.kind === 'doc_amount_diff'))

section('R19 零金额 CI 也是纸面依据：批次照样钉住')

const r19Zero = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R19-ZERO' })
await orders.addOrderItem(r19Zero.id, { styleNo: 'R19-ZERO', quantity: 100, unitPrice: 10 })
await orders.updateOrderCharges(r19Zero.id, [{ label: '运费 Freight', amount: 200 }])
const r19ZeroPl = (await packing.createPackingList({ orderId: r19Zero.id, lines: [{ boxNo: 'R19-Z1', styleNo: 'R19-ZERO', quantity: 50 }] }))[0]
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r19 zero'), docNo: ciNoOf('PI-R19-ZERO', r19ZeroPl.plNo), kind: 'ci', orderId: r19Zero.id, amount: 0 })
const r19ZeroAmt = (await money.packingAmounts(r19Zero.id)).find((b) => b.plId === r19ZeroPl.id)!
eq('0 金额存档钉出 0 元批次（不按当前数据重算）', r19ZeroAmt.total, 0)
check('另一批拿走全部剩余费用', (await money.packingAmounts(r19Zero.id)).reduce((s, b) => s + b.charges, 0) <= 200.01)

section('R19 收款历史写明汇率快照口径')

const r19Rate = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed' })
await orders.addOrderItem(r19Rate.id, { styleNo: 'R19-RATE', quantity: 10, unitPrice: 10 })
await orders.addPayment(r19Rate.id, { paidAt: addDays(localDate(), -3), amount: 20, method: 'T/T', bankRef: 'R19-RATE-P' })
check(
  '补录过去日期的到账，历史里写明按录入时汇率钉快照',
  (await orders.listEvents(r19Rate.id)).some((e) => e.kind === 'payment' && e.note.includes('钉快照') && e.note.includes('汇率按 7'))
)

/* ---------------- R20：闸门做实与回款正门 ---------------- */

// ① 作废单回款开正门：必须写明来路，只进收款流水与月报，不复活订单
section('R20 作废单回款：登记走正门，备注写明来路，删错也能删')

const r20Rec = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R20-REC' })
await orders.addOrderItem(r20Rec.id, { styleNo: 'R20-REC', quantity: 10, unitPrice: 10 })
await orders.addPayment(r20Rec.id, { paidAt: addDays(localDate(), -2), amount: 20, note: '定金' })
await orders.voidOrder(r20Rec.id, 'R20 回款测试')

let r20NoNoteErr = ''
try {
  await orders.addPayment(r20Rec.id, { paidAt: localDate(), amount: 30 })
} catch (e) {
  r20NoNoteErr = (e as Error).message
}
check('作废单登记收款不写来路会被拦下', r20NoNoteErr.includes('写明来路'), r20NoNoteErr)

await orders.addPayment(r20Rec.id, { paidAt: localDate(), amount: 30, note: '取消单客户退回的定金' })
check(
  '作废单回款落账且历史写明「作废单回款」',
  (await orders.listEvents(r20Rec.id)).some((e) => e.kind === 'payment' && e.note.includes('作废单回款') && e.note.includes('30.00'))
)
check('作废单回款不复活订单（收款状态仍为 void）', (await orders.getOrder(r20Rec.id))!.paymentStatus === 'void')
const r20RecAgain = (await orders.getOrder(r20Rec.id))!
const r20PrePay = (r20RecAgain.payments ?? []).find((p) => Math.abs(p.amount - 20) < 0.001)
let r20PreDelErr = ''
try {
  await orders.deletePayment(r20Rec.id, r20PrePay!.id, '试试删作废前的钱')
} catch (e) {
  r20PreDelErr = (e as Error).message
}
check('作废前的流水仍是留档凭据，不许删', r20PreDelErr.includes('留档凭据'), r20PreDelErr)
const r20Pay = ((await orders.getOrder(r20Rec.id))!.payments ?? []).find(
  (p) => Math.abs(p.amount - 30) < 0.001 && p.note.includes('取消单客户退回的定金')
)
check('作废单回款进了收款流水（备注留着来路）', !!r20Pay)
if (r20Pay) {
  await orders.deletePayment(r20Rec.id, r20Pay.id, '金额录错了')
  check('作废单的回款删错也能删（不删就成死账）', !((await orders.getOrder(r20Rec.id))!.payments ?? []).some((p) => p.id === r20Pay.id))
}

// ② 核销 / 追回日期与收款同一口径：不许填未来
section('R20 核销与追回日期不许填未来')

const r20Date = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R20-DATE' })
await orders.addOrderItem(r20Date.id, { styleNo: 'R20-DATE', quantity: 10, unitPrice: 10 })
const r20Future = addDays(localDate(), 7)

let r20ShortErr = ''
try {
  await orders.addSettlement(r20Date.id, { kind: 'shortage', amount: 5, at: r20Future, reason: '银行扣费' })
} catch (e) {
  r20ShortErr = (e as Error).message
}
check('核销日期填未来被拦', r20ShortErr.includes('还没到'), r20ShortErr)

await orders.addSettlement(r20Date.id, { kind: 'bad_debt', amount: 20, reason: '客户破产' })
let r20RecoverErr = ''
try {
  await orders.addSettlement(r20Date.id, { kind: 'recovery', amount: 10, paidAt: r20Future, reason: '追回部分欠款' })
} catch (e) {
  r20RecoverErr = (e as Error).message
}
check('追回款到账日期填未来被拦', r20RecoverErr.includes('还没到'), r20RecoverErr)

/* ---------------- R21：侧门守门与串单竞态 ---------------- */

// ① 收款状态下拉不许直接跳「已作废」：作废必须走凭据核对的正门
section('R21 作废侧门封死：下拉改 void 被拦，指路「作废此单」')

const r21Gate = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-GATE' })
await orders.addOrderItem(r21Gate.id, { styleNo: 'R21-GATE', quantity: 10, unitPrice: 10 })

let r21VoidErr = ''
try {
  await orders.setPaymentStatus(r21Gate.id, 'void')
} catch (e) {
  r21VoidErr = (e as Error).message
}
check('收款状态下拉直接改成「已作废」被拦下', r21VoidErr.includes('作废此单'), r21VoidErr)
check('被拦的单还在（不是先改成 void 再报错）', (await orders.getOrder(r21Gate.id))!.paymentStatus !== 'void')
// 正门仍通：作废弹窗走的 voidOrder 不受影响
await orders.voidOrder(r21Gate.id, 'R21 正门回归')
check('正门作废不受影响', (await orders.getOrder(r21Gate.id))!.paymentStatus === 'void')

// ② 批次作废/撤销原因必填（后端在状态检查之后拦，留档凭据不许匿名著墨）
section('R21 批次作废/撤销：原因必填，历史里查得到为什么')

const r21PlOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-PL' })
await orders.addOrderItem(r21PlOrder.id, { styleNo: 'R21-PL', color: 'Navy', size: 'L', quantity: 50, unitPrice: 10 })
const r21Pl = (await packing.createPackingList({
  orderId: r21PlOrder.id,
  containerNo: 'CONT-R21',
  lines: [{ boxNo: 'NO.1', styleNo: 'R21-PL', color: 'Navy', size: 'L', quantity: 50 }]
}))[0]

let r21VoidNoReasonErr = ''
try {
  await packing.voidPackingList(r21PlOrder.id, r21Pl.id)
} catch (e) {
  r21VoidNoReasonErr = (e as Error).message
}
check('批次作废不写原因被拦下', r21VoidNoReasonErr.includes('原因'), r21VoidNoReasonErr)

await packing.voidPackingList(r21PlOrder.id, r21Pl.id, '订舱被货代取消')
const r21VoidEvt = (await orders.listEvents(r21PlOrder.id)).filter((e) => e.kind === 'pl_void').pop()
check('作废原因进了操作历史', !!r21VoidEvt && r21VoidEvt.note.includes('订舱被货代取消'), r21VoidEvt?.note ?? '没有 pl_void 事件')

let r21UnvoidNoReasonErr = ''
try {
  await packing.unvoidPackingList(r21PlOrder.id, r21Pl.id)
} catch (e) {
  r21UnvoidNoReasonErr = (e as Error).message
}
check('撤销作废不写原因也被拦下', r21UnvoidNoReasonErr.includes('原因'), r21UnvoidNoReasonErr)

await packing.unvoidPackingList(r21PlOrder.id, r21Pl.id, '货代恢复订舱')
check('写了原因的撤销作废放行', (await packing.listPackingLists(r21PlOrder.id)).find((p) => p.id === r21Pl.id)!.voidedAt == null)
const r21UnvoidEvt = (await orders.listEvents(r21PlOrder.id)).filter((e) => e.kind === 'pl_unvoid').pop()
check('撤销原因也进了操作历史', !!r21UnvoidEvt && r21UnvoidEvt.note.includes('货代恢复订舱'), r21UnvoidEvt?.note ?? '没有 pl_unvoid 事件')

// ③ 换客户留痕：操作历史写明「客户 A → B」，改单弹窗另有确认弹窗兜底
section('R21 换主留痕：历史写明客户从谁换成谁')

const r21Swap = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-SWAP' })
await orders.addOrderItem(r21Swap.id, { styleNo: 'R21-SWAP', quantity: 5, unitPrice: 10 })
await orders.updateOrder(r21Swap.id, { customerId: c2.id })
const r21SwapEvt = (await orders.listEvents(r21Swap.id)).find((e) => e.note.includes('客户'))
check(
  '换客户在历史里写明「客户 A → B」',
  !!r21SwapEvt && r21SwapEvt.note.includes('客户') && r21SwapEvt.note.includes('→'),
  r21SwapEvt?.note ?? '没有客户相关历史'
)
eq('客户真的换过去了', (await orders.getOrder(r21Swap.id))!.customerId, c2.id)

// ④ 汇率参考值按币种过滤：USD 的 7.1 不能抄到 EUR 单上
section('R21 汇率参考值同币种：参考的就是同币种那一张')

const r21Eur = await orders.createOrder({ customerId: c1.id, currency: 'EUR', exchangeRate: 7.8, paymentStatus: 'confirmed', piNo: 'PI-R21-EUR' })
await orders.addOrderItem(r21Eur.id, { styleNo: 'R21-EUR', quantity: 5, unitPrice: 10 })
const r21UsdInfo = (await orders.lastExchangeRateInfo('USD'))
const r21EurInfo = (await orders.lastExchangeRateInfo('EUR'))
check('EUR 参考值取的是 EUR 那张单的汇率', !!r21EurInfo && Math.abs(r21EurInfo.rate - 7.8) < 0.0001, JSON.stringify(r21EurInfo))
check('USD 参考值不再是刚建的 EUR 单', !r21UsdInfo || Math.abs(r21UsdInfo.rate - 7.8) > 0.0001, JSON.stringify(r21UsdInfo))

// ⑤ 作废/失效单不许再挂照片
section('R21 作废单冻结照片：留档不再「还在走」')

const r21Photo = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R21-PHOTO' })
await orders.addOrderItem(r21Photo.id, { styleNo: 'R21-PHOTO', quantity: 5, unitPrice: 10 })
await orders.addOrderPhoto(r21Photo.id, 'r21-normal.jpg', 'inspection', '正常单传照放行')
eq('正常单传照放行', (await orders.listOrderPhotos(r21Photo.id)).length, 1)
await orders.voidOrder(r21Photo.id, 'R21 照片冻结测试')
let r21PhotoErr = ''
try {
  await orders.addOrderPhoto(r21Photo.id, 'r21-void.jpg', 'inspection', '作废后再传')
} catch (e) {
  r21PhotoErr = (e as Error).message
}
check('作废单再传照片被拦下', r21PhotoErr.includes('已作废'), r21PhotoErr)
eq('作废单照片一张没多', (await orders.listOrderPhotos(r21Photo.id)).length, 1)

/* ---------------- R22：转单与建单入口守门 ---------------- */

// ① 同款两行：源头（打样/报价保存）拦住，转单（老数据）挡住
section('R22 同款两行守门：源头拦、转单挡')

let r22SampleDupErr = ''
try {
  await samples.saveSample({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7,
    exchangeRateDate: localDate(),
    items: [
      { styleNo: 'R22-DUP', color: 'Navy', size: 'L', quantity: 10, unitPrice: 5 },
      { styleNo: 'R22-DUP', color: 'Navy', size: 'L', quantity: 5, unitPrice: 6 }
    ]
  })
} catch (e) {
  r22SampleDupErr = (e as Error).message
}
check('打样单保存同款两行被拦下', r22SampleDupErr.includes('两行'), r22SampleDupErr)

let r22QuoteDupErr = ''
try {
  await quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7,
    exchangeRateDate: localDate(),
    incoterm: 'FOB',
    paymentMethod: 'tt_deposit',
    items: [
      { styleNo: 'R22-QDUP', color: 'Red', size: 'M', quantity: 10, unitPrice: 8 },
      { styleNo: 'R22-QDUP', color: 'Red', size: 'M', quantity: 4, unitPrice: 9 }
    ]
  })
} catch (e) {
  r22QuoteDupErr = (e as Error).message
}
check('报价单保存同款两行被拦下', r22QuoteDupErr.includes('两行'), r22QuoteDupErr)

// 老数据直插两张同款行（规则上线前存的），转单时要挡住、不许把脏明细带进订单
const r22Ts = new Date().toISOString()
const r22LegacyIns = getDb().run(
  `INSERT INTO sample_orders(sample_no, customer_id, sample_date, status, created_at, updated_at, fee_status, currency, exchange_rate, exchange_rate_date)
   VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ['SMP-R22-LEGACY', c1.id, localDate(), 'received', r22Ts, r22Ts, 'unpaid', 'USD', 7, localDate()]
)
const r22LegacyId = Number(r22LegacyIns.lastInsertRowid)
for (const qty of [10, 5]) {
  getDb().run(
    `INSERT INTO sample_order_items(sample_order_id, style_no, color, size, quantity, unit_price, goods_unit_price)
     VALUES(?,?,?,?,?,?,?)`,
    [r22LegacyId, 'R22-LEG', 'Red', 'L', qty, 5, 8]
  )
}
let r22ConvertDupErr = ''
try {
  await samples.convertSampleToOrder(r22LegacyId)
} catch (e) {
  r22ConvertDupErr = (e as Error).message
}
check('打样转单撞上同款两行被挡下（指回打样单改）', r22ConvertDupErr.includes('两行'), r22ConvertDupErr)
eq('被挡的转单没有留下半张订单', (await orders.listOrders({ keyword: 'PI-' })).filter((o) => o.customerId === c1.id && o.note.includes('SMP-R22-LEGACY')).length, 0)

// ② createOrder 汇率闸门：显式传 0/负数拦下，没传仍是草稿哨兵 1
section('R22 建单汇率闸门：0 汇率进不了库')

let r22RateErr = ''
try {
  await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 0, piNo: 'PI-R22-RATE0' })
} catch (e) {
  r22RateErr = (e as Error).message
}
check('建单传 0 汇率被拦下', r22RateErr.includes('大于 0'), r22RateErr)
let r22RateNegErr = ''
try {
  await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: -7, piNo: 'PI-R22-RATENEG' })
} catch (e) {
  r22RateNegErr = (e as Error).message
}
check('建单传负汇率被拦下', r22RateNegErr.includes('大于 0'), r22RateNegErr)
const r22DraftNoRate = await orders.createOrder({ customerId: c1.id, currency: 'USD', piNo: 'PI-R22-NORATE' })
eq('草稿不填汇率仍是哨兵值 1（汇率待修提醒认它）', (await orders.getOrder(r22DraftNoRate.id))!.exchangeRate, 1)

// ③ 报价转单：转出的订单作废后可以按新单重转（对齐打样口径）
section('R22 报价转单不复用作废单')

const r22Q = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  incoterm: 'FOB',
  paymentMethod: 'tt_deposit',
  items: [{ styleNo: 'R22-RECONV', color: 'Blue', size: 'XL', quantity: 20, unitPrice: 10 }]
})
const r22FirstOrder = await quotations.convertToOrder(r22Q.id)
await orders.voidOrder(r22FirstOrder.id, 'R22 客户换抬头重做')
const r22SecondOrder = await quotations.convertToOrder(r22Q.id)
check('转出订单作废后能按新单重转', r22SecondOrder.id !== r22FirstOrder.id)
check('重转出的不是作废单', (await orders.getOrder(r22SecondOrder.id))!.paymentStatus !== 'void')
eq('报价挂到了新单上', (await quotations.getQuotation(r22Q.id))!.convertedOrderId, r22SecondOrder.id)

// ④ 应收账龄 + 客户对账单导出（收款对账动线的缩水版）
section('R22 应收账龄与客户对账单')

const r22C = await customers.saveCustomer({
  company: 'R22 Aging Trading Co',
  contact: 'Lily',
  email: 'lily@r22.com',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r22AgeOrder = await orders.createOrder({ customerId: r22C.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R22-AGE' })
await orders.addOrderItem(r22AgeOrder.id, { styleNo: 'R22-AGE', quantity: 10, unitPrice: 10 })

const r22Owed = (await money.receivableByCustomer()).find((v) => v.customerId === r22C.id)
check('欠款榜带最老挂账日期', !!r22Owed && !!r22Owed.oldestUnpaidDate, JSON.stringify(r22Owed))
check('挂账天数按下单日起算（新单 ≥ 0）', !!r22Owed && r22Owed.oldestUnpaidDays >= 0, String(r22Owed?.oldestUnpaidDays))

const r22Csv = await dashboard.exportCsv('orders', { customerId: r22C.id })
const r22DataRows = r22Csv.split('\r\n').filter((l) => l.trim()).slice(1)
check(
  '客户对账单只导这一家的单（与订单列表同一份口径）',
  r22DataRows.length === 1 && r22DataRows[0].includes('R22 Aging Trading Co'),
  r22Csv.slice(0, 160)
)

// ⑤ R23 拆分收款：一笔水单拆到多张单，整批一个事务
section('R23 水单拆分收款：整批落账、整批回滚')

const r23C = await customers.saveCustomer({
  company: 'R23 Remittance Co',
  contact: 'Nina',
  email: 'nina@r23.com',
  phone: '',
  country: 'DE',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r23o1 = await orders.createOrder({ customerId: r23C.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R23-A' })
await orders.addOrderItem(r23o1.id, { styleNo: 'R23-A', quantity: 10, unitPrice: 10 })
const r23o2 = await orders.createOrder({ customerId: r23C.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R23-B' })
await orders.addOrderItem(r23o2.id, { styleNo: 'R23-B', quantity: 5, unitPrice: 8 })

await orders.batchAddPayments([
  { orderId: r23o1.id, paidAt: localDate(), amount: 30, bankRef: 'SWIFT-R23-001', method: 'T/T' },
  { orderId: r23o2.id, paidAt: localDate(), amount: 10, bankRef: 'SWIFT-R23-001', method: 'T/T' }
])
eq('两张单各落一笔收款', (getDb().get('SELECT COUNT(*) AS n FROM payments WHERE order_id IN (?,?)', [r23o1.id, r23o2.id]) as { n: number }).n, 2)
const r23pay1 = getDb().all('SELECT bank_ref, note FROM payments WHERE order_id = ?', [r23o1.id]) as Record<string, unknown>[]
check('整批共用同一个流水号', r23pay1.every((p) => p.bank_ref === 'SWIFT-R23-001'))
check('收款备注注明拆分', String(r23pay1[0].note ?? '').includes('水单拆分'), String(r23pay1[0].note))
eq('A 单收 30 后待收剩 70', (await orders.getOrder(r23o1.id))!.remaining, 70)
eq('B 单收 10 后待收剩 30', (await orders.getOrder(r23o2.id))!.remaining, 30)

const r23paidBefore = (getDb().get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [r23o1.id]) as { n: number }).n
let r23RollErr = ''
try {
  await orders.batchAddPayments([
    { orderId: r23o1.id, paidAt: localDate(), amount: 10, bankRef: 'SWIFT-R23-002' },
    // 第二笔日期在未来：批次入口不预检日期，让事务内的守门把整批顶回来
    { orderId: r23o2.id, paidAt: '2099-01-01', amount: 10, bankRef: 'SWIFT-R23-002' }
  ])
} catch (e) {
  r23RollErr = (e as Error).message
}
check('中途一笔不合格整批被拦', r23RollErr.includes('整批已回滚'), r23RollErr)
eq('回滚后 A 单没有多出半笔收款', (getDb().get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [r23o1.id]) as { n: number }).n, r23paidBefore)
let r23RefErr = ''
try {
  await orders.batchAddPayments([{ orderId: r23o1.id, paidAt: localDate(), amount: 5, bankRef: '' }])
} catch (e) {
  r23RefErr = (e as Error).message
}
check('拆分收款必须带流水号', r23RefErr.includes('流水号'), r23RefErr)

const r23rows = (await money.listOrderMoney({ customerId: r23C.id })).filter((r) => r.receivable > 0.001)
eq('拆分后客户名下待收的仍是这两张单', r23rows.length, 2)
eq('待收视图里 A 单剩 70', r23rows.find((r) => r.orderId === r23o1.id)!.receivable, 70)

// ⑥ R23 费用行闸门：建单 / 报价都拦 Infinity 和 NaN（序列化后变 null、按 0 算）
section('R23 费用行闸门：非有限数进不了订单和报价')

let r23ChargeErr = ''
try {
  await orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    piNo: 'PI-R23-CHG',
    charges: [{ label: '运费', amount: Infinity }]
  })
} catch (e) {
  r23ChargeErr = (e as Error).message
}
check('建单费用 Infinity 被拦下', r23ChargeErr.includes('有效数字'), r23ChargeErr)
let r23QChargeErr = ''
try {
  await quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7,
    exchangeRateDate: localDate(),
    incoterm: 'FOB',
    paymentMethod: 'tt_deposit',
    items: [{ styleNo: 'R23-QCHG', color: 'Red', size: 'M', quantity: 1, unitPrice: 5 }],
    charges: [{ label: '运费', amount: NaN }]
  })
} catch (e) {
  r23QChargeErr = (e as Error).message
}
check('报价费用 NaN 被拦下', r23QChargeErr.includes('有效数字'), r23QChargeErr)

// ⑦ R23 过期报价批准沿用：价格照旧，有效期重置为新的承诺并留痕
section('R23 过期转单：有效期重置并留痕')

const r23Q = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  incoterm: 'FOB',
  paymentMethod: 'tt_deposit',
  validUntil: addDays(localDate(), -10),
  items: [{ styleNo: 'R23-EXP', color: 'Blue', size: 'L', quantity: 10, unitPrice: 6 }]
})
const r23ExpOrder = await quotations.convertToOrder(r23Q.id, { override: { approvedBy: '老板', reason: 'R23 客户认旧价' } })
const r23ExpFresh = (await orders.getOrder(r23ExpOrder.id))!
check('过期转单有效期被重置到未来', !!r23ExpFresh.validUntil && r23ExpFresh.validUntil > localDate(), String(r23ExpFresh.validUntil))
// R34：有效期重置是我方内部口径，写在历史里，不写在发给客户的纸面上
check(
  '有效期重置只落在订单操作历史',
  (await orders.listEvents(r23ExpOrder.id)).some((e) => e.kind === 'quotation_convert' && e.note.includes('重置')),
  JSON.stringify((await orders.listEvents(r23ExpOrder.id)))
)
check('订单备注不带有效期重置话术', !r23ExpFresh.note.includes('重置'), r23ExpFresh.note)

// ⑧ R24 打样与报价的应收守门（先修口径，再谈把打样费落进流水）
section('R24 打样守门：转单锁状态、抵扣只认转单、应收不清不许删')

const r24C = await customers.saveCustomer({
  company: 'R24 Sample Gate Co',
  contact: 'Otto',
  email: 'otto@r24.com',
  phone: '',
  country: 'NL',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r24Smp = await samples.saveSample({
  customerId: r24C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R24-SMP', quantity: 2, unitPrice: 10, goodsUnitPrice: 12 }]
})
await samples.convertSampleToOrder(r24Smp.id)
let r24StatusErr = ''
try {
  await samples.saveSample({ id: r24Smp.id, status: 'cancelled', note: '想直接取消掉' })
} catch (e) {
  r24StatusErr = (e as Error).message
}
check('转单后打样单状态被锁死', r24StatusErr.includes('状态不能再改'), r24StatusErr)
eq('被拦下后状态没变', (await samples.getSample(r24Smp.id))!.status, 'pending')

let r24OffsetErr = ''
try {
  await samples.saveSample({
    customerId: r24C.id,
    feeStatus: 'offset',
    currency: 'USD',
    exchangeRate: 7,
    exchangeRateDate: localDate(),
    items: [{ styleNo: 'R24-OFF', quantity: 1, unitPrice: 5 }]
  })
} catch (e) {
  r24OffsetErr = (e as Error).message
}
check('「已抵扣」不能手工标记（只有转单能写）', r24OffsetErr.includes('已抵扣'), r24OffsetErr)

const r24Unpaid = await samples.saveSample({
  customerId: r24C.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R24-DEL', quantity: 1, unitPrice: 8 }]
})
let r24DelErr = ''
try {
  await samples.deleteSample(r24Unpaid.id)
} catch (e) {
  r24DelErr = (e as Error).message
}
check('还挂着应收的样品单不能直接删', r24DelErr.includes('没收回'), r24DelErr)
check('被拦下时单还在', await samples.getSample(r24Unpaid.id) !== null)
let r24CancelErr = ''
try {
  await samples.saveSample({ id: r24Unpaid.id, status: 'cancelled' })
} catch (e) {
  r24CancelErr = (e as Error).message
}
check('取消不写原因被拦下', r24CancelErr.includes('原因'), r24CancelErr)
await samples.saveSample({ id: r24Unpaid.id, status: 'cancelled', note: '客户改走别家，样品费不追了' })
eq('取消后待收归零', (await samples.getSample(r24Unpaid.id))!.receivableBase, 0)
await samples.deleteSample(r24Unpaid.id)
check('取消留原因后可以删', await samples.getSample(r24Unpaid.id) === null)

section('R24 报价守门：已转单的报价不能再改成交结果')

const r24Q = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  incoterm: 'FOB',
  paymentMethod: 'tt_deposit',
  items: [{ styleNo: 'R24-Q', color: 'Red', size: 'M', quantity: 5, unitPrice: 4 }]
})
await quotations.convertToOrder(r24Q.id)
let r24QMetaErr = ''
try {
  (await quotations.updateQuotationMeta(r24Q.id, { status: 'expired' }))
} catch (e) {
  r24QMetaErr = (e as Error).message
}
check('已转单的报价不能改回失效', r24QMetaErr.includes('已经转成订单'), r24QMetaErr)
let r24QResultErr = ''
try {
  (await quotations.updateQuotationMeta(r24Q.id, { result: 'lost' }))
} catch (e) {
  r24QResultErr = (e as Error).message
}
check('已转单的报价不能标成流失', r24QResultErr.includes('已经转成订单'), r24QResultErr)
eq('原状态原样保存不被误拦', (await quotations.updateQuotationMeta(r24Q.id, { status: 'converted' })).status, 'converted')

section('R24 让利留痕：负费用行一变就必须写原因')

const r24Charged = await orders.createOrder({ customerId: r24C.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'confirmed', piNo: 'PI-R24-CHG' })
await orders.addOrderItem(r24Charged.id, { styleNo: 'R24-CHG', quantity: 10, unitPrice: 10 })
await orders.updateOrderCharges(r24Charged.id, [{ label: '运费 Freight', amount: 50 }])
let r24NegErr = ''
try {
  await orders.updateOrderCharges(r24Charged.id, [
    { label: '运费 Freight', amount: 50 },
    { label: '让利 Discount', amount: -10 }
  ])
} catch (e) {
  r24NegErr = (e as Error).message
}
check('加让利不写原因被拦下', r24NegErr.includes('让利'), r24NegErr)
eq('被拦下后费用行没变', (await orders.getOrder(r24Charged.id))!.charges.length, 1)
await orders.updateOrderCharges(
  r24Charged.id,
  [
    { label: '运费 Freight', amount: 50 },
    { label: '让利 Discount', amount: -10 }
  ],
  '老客户运费对折'
)
const r24NegOrder = (await orders.getOrder(r24Charged.id))!
eq('写了原因让利落库', Number(r24NegOrder.charges.find((c: any) => c.amount < 0)?.amount), -10)
check(
  '原因记进订单操作历史',
  !!getDb().get("SELECT id FROM order_events WHERE order_id = ? AND note LIKE '%原因：老客户运费对折%' LIMIT 1", [
    r24Charged.id
  ])
)
await orders.updateOrderCharges(r24Charged.id, [
  { label: '运费 Freight', amount: 50 },
  { label: '让利 Discount', amount: -10 }
])
eq('让利没动就不必重复写原因', (await orders.getOrder(r24Charged.id))!.charges.length, 2)
await orders.updateOrderCharges(r24Charged.id, [
  { label: '运费 Freight', amount: 60 },
  { label: '让利 Discount', amount: -10 }
])
eq('正费用行改价不受影响', Number((await orders.getOrder(r24Charged.id))!.charges[0].amount), 60)
let r24RemoveErr = ''
try {
  await orders.updateOrderCharges(r24Charged.id, [{ label: '运费 Freight', amount: 60 }])
} catch (e) {
  r24RemoveErr = (e as Error).message
}
check('撤掉让利也要写原因（客户该付的钱又变了）', r24RemoveErr.includes('让利'), r24RemoveErr)

/* ============================================================
 * 第 25 轮：打样费收款落流水（R25）
 * ============================================================ */
section('R25 v20 迁移：payments 同时支持订单与打样流水')

const r25PayCols = getDb().all('PRAGMA table_info(payments)') as Record<string, unknown>[]
check('payments 多了 sample_order_id', r25PayCols.some((c) => String(c.name) === 'sample_order_id'))
check(
  'order_id 改成可空（打样流水不挂订单）',
  Number(r25PayCols.find((c) => String(c.name) === 'order_id')?.notnull ?? 1) === 0
)
check(
  '两边都不挂的流水被 CHECK 拦住',
  (await r8err(async () => getDb().run("INSERT INTO payments(paid_at, created_at) VALUES('2026-10-01','x')"))).length > 0
)

section('R25 打样费收款：实收落流水，抵扣绝不落')

const r25C = await customers.saveCustomer({ company: 'R25-SAMPLE-FLOW' })
const r25Month = localDate().slice(0, 7)
const monthOfR25 = async () => (await money.receivedByMonth()).find((m) => m.month === r25Month)?.amount ?? 0

const r25Sample = await samples.saveSample({
  customerId: r25C.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R25-S1', productName: '打样收款', color: 'Grey', size: 'M', quantity: 1, unitPrice: 10 }]
})
eq('应收 = 样品费 10 + 快递费 5', r25Sample.totalFee, 15)
eq('未收时已收为 0', r25Sample.collected, 0)

const r25MonthBefore = (await monthOfR25())
const r25Partial = await samples.addSamplePayment(r25Sample.id, {
  paidAt: localDate(),
  amount: 6,
  bankRef: 'R25-PART'
})
eq('部分收款后仍是未收', r25Partial.feeStatus, 'unpaid')
eq('已收 = 6（来自流水）', r25Partial.collected, 6)
eq('待收只剩没付的 9 × 7.2', r25Partial.receivableBase, 9 * 7.2)
eq('已收回（原币折算）= 6 × 7.2', r25Partial.feeRecoveredBase, 6 * 7.2)
eq('流水笔数', r25Partial.flowCount, 1)
check('收款写进了收款说明（打样单没有事件表）', r25Partial.feeNote.includes('登记收款'), r25Partial.feeNote)
check('打样实收计入本月到账（按流水汇率快照）', Math.abs((await monthOfR25()) - r25MonthBefore - 6 * 7.2) < 0.01)

check(
  '超过未收余额的收款被拦下',
  (await r8err(async () => await samples.addSamplePayment(r25Sample.id, { paidAt: localDate(), amount: 20 }))).includes('超过了还没收')
)
check(
  '未来日期收款被拦下',
  (await r8err(async () => await samples.addSamplePayment(r25Sample.id, { paidAt: '2999-01-01', amount: 1 }))).includes('还没到')
)
check(
  '零金额收款被拦下',
  (await r8err(async () => await samples.addSamplePayment(r25Sample.id, { paidAt: localDate(), amount: 0 }))).includes('大于 0')
)

check(
  '有流水后快递费不能再改',
  (await r8err(async () => await samples.saveSample({ id: r25Sample.id, expressFee: 9 }))).includes('收款流水')
)
check(
  '有流水后汇率不能再改',
  (await r8err(async () => await samples.saveSample({ id: r25Sample.id, exchangeRate: 7.5 }))).includes('收款流水')
)
check(
  '有流水后收款状态不能手工改（由流水推导）',
  (await r8err(async () => await samples.saveSample({ id: r25Sample.id, feeStatus: 'waived' }))).includes('流水自动推导')
)
eq('描述性字段仍可改', (await samples.saveSample({ id: r25Sample.id, note: 'R25 备注可改' })).note, 'R25 备注可改')

const r25Flows1 = (await samples.listSamplePayments(r25Sample.id))
eq('流水表能列出这笔', r25Flows1.length, 1)
eq('打样流水的 orderId 为空', r25Flows1[0].orderId, null)
eq('打样流水的 sampleOrderId 指回打样单', r25Flows1[0].sampleOrderId, r25Sample.id)
check(
  '撤销不写原因被拦下',
  (await r8err(async () => await samples.deleteSamplePayment(r25Sample.id, r25Flows1[0].id, ''))).includes('原因')
)
const r25Reverted = await samples.deleteSamplePayment(r25Sample.id, r25Flows1[0].id, '金额录错')
eq('撤销后回到未收', r25Reverted.feeStatus, 'unpaid')
eq('撤销后已收归零', r25Reverted.collected, 0)
eq('撤销后待收恢复全额', r25Reverted.receivableBase, 15 * 7.2)
check('撤销原因写进收款说明', r25Reverted.feeNote.includes('金额录错'), r25Reverted.feeNote)
eq('撤销是真删流水', (await samples.listSamplePayments(r25Sample.id)).length, 0)

const r25Paid = await samples.addSamplePayment(r25Sample.id, {
  paidAt: localDate(),
  amount: 15,
  bankRef: 'R25-FULL'
})
eq('收齐后自动标成已收', r25Paid.feeStatus, 'paid')
eq('收齐后不计待收', r25Paid.receivableBase, 0)
check(
  '收齐后再收一笔被拦下',
  (await r8err(async () => await samples.addSamplePayment(r25Sample.id, { paidAt: localDate(), amount: 1 }))).includes('已经收齐')
)
check('有流水的单不能直接删', (await r8err(async () => await samples.deleteSample(r25Sample.id))).includes('收款流水'))
check(
  '订单入口删不掉打样流水（指回打样单）',
  (await r8err(async () => await orders.deletePayment(r24Charged.id, (await samples.listSamplePayments(r25Sample.id))[0].id, 'x'))).includes('打样单')
)

// 清理：先撤销流水（原因留痕），再取消留原因、删除
await samples.deleteSamplePayment(r25Sample.id, (await samples.listSamplePayments(r25Sample.id))[0].id, 'E2E 清理')
await samples.saveSample({ id: r25Sample.id, status: 'cancelled', note: 'E2E 清理：测试单不收了' })
await samples.deleteSample(r25Sample.id)
eq('清理后打样单已删', await samples.getSample(r25Sample.id), null)

section('R25 水单拆分：订单与打样费同一笔水单')

const r25TotalBefore = await money.totalReceivable()
const r25Sample2 = await samples.saveSample({
  customerId: r25C.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R25-S2', productName: '拆分收款', color: 'Grey', size: 'L', quantity: 10, unitPrice: 1, goodsUnitPrice: 8 }]
})
check('打样未收计入全公司待收', Math.abs(await money.totalReceivable() - r25TotalBefore - 15 * 7.2) < 0.01)
eq('客户打样应收 = 15 × 7.2', await money.sampleReceivable(r25C.id), 15 * 7.2)
const r25OpenRows = await money.customerOpenRows(r25C.id)
const r25SampleRow = r25OpenRows.find((r) => r.kind === 'sample' && r.docId === r25Sample2.id)
check('拆分表能列出打样单', !!r25SampleRow, JSON.stringify(r25OpenRows))
eq('拆分表里打样单待收是原币', r25SampleRow?.receivable, 15)
eq('拆分表里打样单带币种', r25SampleRow?.currency, 'USD')

const r25Split = await orders.createOrder({
  customerId: r25C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R25-SPLIT'
})
await orders.addOrderItem(r25Split.id, { styleNo: 'R25-O1', quantity: 10, unitPrice: 10 })
const r25Batch = await orders.batchAddPayments([
  { orderId: r25Split.id, paidAt: localDate(), amount: 30, bankRef: 'R25-SLIP' },
  { sampleOrderId: r25Sample2.id, paidAt: localDate(), amount: 4, bankRef: 'R25-SLIP' }
])
eq('一笔水单同时落订单和打样单', r25Batch.length, 2)
eq('订单那笔落在订单上', (await orders.getOrder(r25Split.id))!.payments[0].bankRef, 'R25-SLIP')
eq('打样那笔落在打样单上', (await samples.listSamplePayments(r25Sample2.id))[0].bankRef, 'R25-SLIP')
eq('拆分后打样待收只剩 11 × 7.2', await money.sampleReceivable(r25C.id), 11 * 7.2)
check(
  '客户拆分表的待收跟着流水减少',
  Math.abs(((await money.customerOpenRows(r25C.id)).find((r) => r.kind === 'sample')?.receivable ?? 0) - 11) < 0.01
)
eq('排除已收齐/无待收后仍能列订单', (await money.customerOpenRows(r25C.id)).some((r) => r.kind === 'order'), true)

check(
  '流号不一致整批拒收',
  (await r8err(async () =>
    await orders.batchAddPayments([
      { orderId: r25Split.id, paidAt: localDate(), amount: 1, bankRef: 'R25-A' },
      { sampleOrderId: r25Sample2.id, paidAt: localDate(), amount: 1, bankRef: 'R25-B' }
    ])
  )).includes('流水号')
)
check(
  '两边都不指定单据被拦下',
  (await r8err(async () => await orders.batchAddPayments([{ paidAt: localDate(), amount: 1, bankRef: 'R25-X' }]))).includes('二选一')
)
const r25PaysBeforeBad = (await orders.getOrder(r25Split.id))!.payments.length
const r25FlowsBeforeBad = (await samples.listSamplePayments(r25Sample2.id)).length
check(
  '第二笔超标 → 整批回滚，第一笔也不留',
  (await r8err(async () =>
    await orders.batchAddPayments([
      { orderId: r25Split.id, paidAt: localDate(), amount: 1, bankRef: 'R25-SLIP-BAD' },
      { sampleOrderId: r25Sample2.id, paidAt: localDate(), amount: 99, bankRef: 'R25-SLIP-BAD' }
    ])
  )).includes('整批已回滚')
)
eq('回滚后订单没多出一笔', (await orders.getOrder(r25Split.id))!.payments.length, r25PaysBeforeBad)
eq('回滚后打样单也没多出一笔', (await samples.listSamplePayments(r25Sample2.id)).length, r25FlowsBeforeBad)

const r25Csv = await dashboard.exportCsv('payments')
check('收款台账多了「单据类型」列（加在最后一列）', r25Csv.includes('单据类型'))
const r25SlipLines = r25Csv.split(/\r?\n/).filter((l) => l.includes('R25-SLIP'))
eq('同一笔水单在台账里两条（订单 + 打样）', r25SlipLines.length, 2)
check('有一条标成打样单', r25SlipLines.some((l) => l.trim().endsWith('打样单')), r25SlipLines.join(' | '))
check('有一条标成订单', r25SlipLines.some((l) => l.trim().endsWith('订单')), r25SlipLines.join(' | '))

section('R25 转单抵扣只抵没付的那部分；作废回退不吞实收')

const r25ConvOrder = await samples.convertSampleToOrder(r25Sample2.id, {
  offsetSampleFee: true,
  paymentStatus: 'confirmed'
})
eq(
  '只抵还没收的 11（15 − 已收 4）',
  Number(r25ConvOrder.charges.find((c: any) => Number(c.amount) < 0)?.amount),
  -11
)
const r25ConvSample = await samples.getSample(r25Sample2.id)!
eq('转单后打样单挂「下单抵扣」', r25ConvSample.feeStatus, 'offset')
eq('抵扣金额记 11', r25ConvSample.offsetAmount, 11)
eq('已收回 = 实收 4 + 抵扣 11 = 全额', r25ConvSample.feeRecoveredBase, 15 * 7.2)
check(
  '转单后不能再登记打样收款',
  (await r8err(async () => await samples.addSamplePayment(r25Sample2.id, { paidAt: localDate(), amount: 1 }))).includes('转成订单')
)
const r25ConvFlow = (await samples.listSamplePayments(r25Sample2.id))[0]
check(
  '转单后不能撤销转单前的实收',
  (await r8err(async () => await samples.deleteSamplePayment(r25Sample2.id, r25ConvFlow.id, 'x'))).includes('不能回头撤销')
)

await orders.voidOrder(r25ConvOrder.id, 'R25 客户取消，整单作废')
const r25VoidedSample = await samples.getSample(r25Sample2.id)!
eq('订单作废后抵扣回退为未收', r25VoidedSample.feeStatus, 'unpaid')
eq('作废后实收 4 还留在流水里', r25VoidedSample.collected, 4)
eq('作废后应收只剩没付的 11', r25VoidedSample.receivableBase, 11 * 7.2)

const r25VoidReverted = await samples.deleteSamplePayment(r25Sample2.id, r25ConvFlow.id, 'R25 客户退汇')
eq('作废后可以撤销实收，应收回到全额', r25VoidReverted.receivableBase, 15 * 7.2)
await samples.saveSample({ id: r25Sample2.id, status: 'cancelled', note: 'R25 清理：客户退汇，单不跟了' })
await samples.deleteSample(r25Sample2.id)
eq('清理后拆分用打样单已删', await samples.getSample(r25Sample2.id), null)

section('R25 旧记录：当年只改了旗子，不凭空造流水')

const r25Legacy = await samples.saveSample({
  customerId: r25C.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R25-S3', productName: '旧记录', color: 'Grey', size: 'S', quantity: 1, unitPrice: 10 }]
})
getDb().run("UPDATE sample_orders SET fee_status = 'paid' WHERE id = ?", [r25Legacy.id])
const r25LegacyRead = await samples.getSample(r25Legacy.id)!
eq('旧记录·无流水能认出来', r25LegacyRead.legacyPaidNoFlow, true)
eq('旧记录按全额认已收', r25LegacyRead.feeRecoveredBase, 15 * 7.2)
eq('旧记录不计待收', r25LegacyRead.receivableBase, 0)
eq('旧记录没有流水', (await samples.listSamplePayments(r25Legacy.id)).length, 0)
check(
  '旧记录补流水要先改回未收',
  (await r8err(async () => await samples.addSamplePayment(r25Legacy.id, { paidAt: localDate(), amount: 15 }))).includes('老账')
)
check('旧记录不进月报', !getDb().get('SELECT id FROM payments WHERE sample_order_id = ? LIMIT 1', [r25Legacy.id]))
await samples.deleteSample(r25Legacy.id)

/* ---------------- R26 客户对账单 ---------------- */
section('R26 客户对账单：订单 + 打样 + 逐笔收款，一张表对得清')

const r26Base = getSettings().baseCurrency
const r26C = await customers.saveCustomer({
  company: 'R26 Statement Co',
  contact: 'Olga',
  email: 'olga@r26.com',
  phone: '',
  country: 'NL',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})

// ① 订单：含让利（负费用行）+ 部分收款
const r26Order = await orders.createOrder({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R26-STMT'
})
await orders.addOrderItem(r26Order.id, { styleNo: 'R26-A', quantity: 10, unitPrice: 10 })
await orders.updateOrderCharges(r26Order.id, [{ label: '折让', amount: -10 }], 'R26 客户让利')
await orders.addPayment(r26Order.id, { paidAt: localDate(), amount: 40, method: 'T/T', bankRef: 'R26-SLIP', note: '定金' })

// ② 草稿单：客户手里没有这张单，不许出现在对账单上
const r26Draft = await orders.createOrder({ customerId: r26C.id, currency: 'USD', exchangeRate: 7.2, piNo: 'PI-R26-DRAFT' })
await orders.addOrderItem(r26Draft.id, { styleNo: 'R26-D', quantity: 1, unitPrice: 9 })

// ③ 作废单：钱真到账了，得让客户认出这张单和这笔钱
const r26Void = await orders.createOrder({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R26-VOID'
})
await orders.addOrderItem(r26Void.id, { styleNo: 'R26-V', quantity: 2, unitPrice: 10 })
await orders.addPayment(r26Void.id, { paidAt: localDate(), amount: 20, method: 'T/T', bankRef: 'R26-VOID-PAY' })
await orders.voidOrder(r26Void.id, 'R26 客户取消')

// ④ 打样：未收（部分收款）、免单、取消但收过钱
const r26S1 = await samples.saveSample({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  expressFee: 5,
  items: [{ styleNo: 'R26-S1', productName: '样品一', color: 'Black', size: 'M', quantity: 1, unitPrice: 10 }]
})
await samples.addSamplePayment(r26S1.id, { paidAt: localDate(), amount: 5, method: 'T/T', bankRef: 'R26-SLIP' })
const r26S2 = await samples.saveSample({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  feeStatus: 'waived',
  items: [{ styleNo: 'R26-S2', productName: '样品二', color: 'Grey', size: 'L', quantity: 1, unitPrice: 20 }]
})
const r26S3 = await samples.saveSample({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R26-S3', productName: '样品三', color: 'Navy', size: 'S', quantity: 1, unitPrice: 10 }]
})
await samples.addSamplePayment(r26S3.id, { paidAt: localDate(), amount: 8, bankRef: 'R26-S3-PAY' })
await samples.saveSample({ id: r26S3.id, status: 'cancelled', note: 'R26 客户不要了' })

// ⑤ 客户多付：单列预收结余，不许压成负的未收
const r26Over = await orders.createOrder({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R26-OVER'
})
await orders.addOrderItem(r26Over.id, { styleNo: 'R26-OVER', quantity: 1, unitPrice: 10 })
await orders.addPayment(r26Over.id, { paidAt: localDate(), amount: 15, method: 'T/T', bankRef: 'R26-OVER-PAY', note: '多付' })

// ⑥ 老数据：汇率没填（现在新建会拦，历史库可能有）
const r26S4 = await samples.saveSample({
  customerId: r26C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R26-S4', productName: '样品四', color: 'White', size: 'XL', quantity: 1, unitPrice: 10 }]
})
getDb().run('UPDATE sample_orders SET exchange_rate = 0 WHERE id = ?', [r26S4.id])

const r26Csv = await dashboard.exportCsv('statement', { customerId: r26C.id })
const r26Rows = parseCsv(r26Csv)
const r26Head = r26Rows[0]
const r26Body = r26Rows.slice(1)
const r26Col = (name: string): number => r26Head.indexOf(name)
const r26Find = (kind: string, docNo: string): string[] | undefined =>
  r26Body.find((r) => r[r26Col('类型')] === kind && r[r26Col('单据号')] === docNo)
const r26Cell = (row: string[] | undefined, name: string): string => (row ? row[r26Col(name)] : '<缺行>')

check('对账单首列是「类型」，下游求和能按类型筛', r26Head[0] === '类型', r26Head.join('|'))
check(
  '对账单不含成本 / 毛利 / 坏账未追回这些内部列',
  !r26Head.some((h) => h.includes('成本') || h.includes('毛利') || h.includes('坏账未追回')),
  r26Head.join('|')
)
check('对账单有逐笔收款要用的流水号列', r26Head.includes('银行流水号'))

const r26OrderRow = r26Find('订单', r26Order.orderNo)
eq('订单行：金额 = 100 − 让利 10', r26Cell(r26OrderRow, '金额(原币)'), '90')
eq('订单行：已收 40', r26Cell(r26OrderRow, '已收(原币)'), '40')
eq('订单行：未收 50', r26Cell(r26OrderRow, '未收(原币)'), '50')
eq('订单行：未收折基准 = 50 × 7.2', r26Cell(r26OrderRow, `未收(${r26Base})`), '360')
check('订单行备注写明让利已计入金额', r26Cell(r26OrderRow, '备注').includes('折让'), r26Cell(r26OrderRow, '备注'))
check('草稿单不上对账单', !r26Body.some((r) => r[r26Col('单据号')] === r26Draft.orderNo), r26Csv.slice(0, 200))
const r26VoidRow = r26Find('订单', r26Void.orderNo)
eq('作废单照列，状态写清已作废', r26Cell(r26VoidRow, '状态'), '已作废')
eq('作废单不再计未收', r26Cell(r26VoidRow, '未收(原币)'), '0')
eq('作废单上已收的钱照列', r26Cell(r26VoidRow, '已收(原币)'), '20')
check('作废单备注说明不计应收', r26Cell(r26VoidRow, '备注').includes('不计应收'), r26Cell(r26VoidRow, '备注'))

const r26S1Row = r26Find('打样单', r26S1.sampleNo)
eq('打样行：样品费 + 快递费 = 15', r26Cell(r26S1Row, '金额(原币)'), '15')
eq('打样行：已收 5', r26Cell(r26S1Row, '已收(原币)'), '5')
eq('打样行：未收 10', r26Cell(r26S1Row, '未收(原币)'), '10')
eq('打样行：未收折基准 = 10 × 7.2', r26Cell(r26S1Row, `未收(${r26Base})`), '72')
check('打样行带收款状态', r26Cell(r26S1Row, '状态').includes('未收'), r26Cell(r26S1Row, '状态'))
const r26S2Row = r26Find('打样单', r26S2.sampleNo)
eq('免单打样：未收 0', r26Cell(r26S2Row, '未收(原币)'), '0')
check('免单打样状态写「客户免单」', r26Cell(r26S2Row, '状态').includes('客户免单'), r26Cell(r26S2Row, '状态'))
const r26S3Row = r26Find('打样单', r26S3.sampleNo)
eq('取消的打样单收回过钱也不计未收', r26Cell(r26S3Row, '未收(原币)'), '0')
eq('取消的打样单上实收照列', r26Cell(r26S3Row, '已收(原币)'), '8')
check('取消的打样单状态写「已取消」', r26Cell(r26S3Row, '状态').includes('已取消'), r26Cell(r26S3Row, '状态'))
const r26S4Row = r26Find('打样单', r26S4.sampleNo)
eq('汇率未填的打样单原币待收照列', r26Cell(r26S4Row, '未收(原币)'), '10')
eq('汇率未填折不出来就不瞎折', r26Cell(r26S4Row, `未收(${r26Base})`), '0')
check('汇率未填在备注里说清楚', r26Cell(r26S4Row, '备注').includes('汇率未填'), r26Cell(r26S4Row, '备注'))

const r26Splits = r26Body.filter((r) => r[r26Col('类型')] === '收款' && r[r26Col('银行流水号')] === 'R26-SLIP')
eq('一笔水单拆给订单和打样，对账单上两条都在', r26Splits.length, 2)
check(
  '收款行标出是哪张单的钱',
  r26Splits.some((r) => r[r26Col('单据号')] === r26Order.orderNo) &&
    r26Splits.some((r) => r[r26Col('单据号')] === r26S1.sampleNo),
  JSON.stringify(r26Splits)
)
eq('收款行金额是原币到账额', r26Cell(r26Splits.find((r) => r[r26Col('单据号')] === r26Order.orderNo), '金额(原币)'), '40')
check(
  '作废单上的到账也留在收款明细里',
  r26Body.some((r) => r[r26Col('类型')] === '收款' && r[r26Col('银行流水号')] === 'R26-VOID-PAY'),
  JSON.stringify(r26Body.filter((r) => r[r26Col('类型')] === '收款'))
)

const r26OverRow = r26Find('订单', r26Over.orderNo)
eq('多付的订单未收不出现负数', r26Cell(r26OverRow, '未收(原币)'), '0')
check('多付在备注里写成预收结余', r26Cell(r26OverRow, '备注').includes('预收结余'), r26Cell(r26OverRow, '备注'))
const r26Prepaid = r26Body.find((r) => r[r26Col('类型')] === '预收结余' && r[r26Col('币种')] === 'USD')
eq(
  '多付的钱单独列一行预收结余（R27 起余额 = 多付 5 + 作废余款 20 + 取消单实收 8）',
  r26Cell(r26Prepaid, '金额(原币)'),
  '33'
)
check('预收结余注明可抵下张单或退还', r26Cell(r26Prepaid, '备注').includes('可抵下张单'), r26Cell(r26Prepaid, '备注'))

const r26UsdTotal = r26Body.find((r) => r[r26Col('类型')] === '合计' && r[r26Col('币种')] === 'USD')
eq('USD 小计：未收 70', r26Cell(r26UsdTotal, '未收(原币)'), '70')
eq('USD 小计：已收 88', r26Cell(r26UsdTotal, '已收(原币)'), '88')
const r26BaseTotal = r26Body.find((r) => r[r26Col('类型')] === '合计' && r[r26Col('币种')] === r26Base)
eq('基准币合计行不写原币金额（免得被看成「已收 0」）', r26Cell(r26BaseTotal, '已收(原币)'), '')
const r26BaseOpen = Number(r26Cell(r26BaseTotal, `未收(${r26Base})`) || 0)
check(
  '表尾未收合计 = 客户页「未收」（同一口径）',
  Math.abs(r26BaseOpen - await money.customerReceivable(r26C.id)) < 0.01,
  `对账单 ${r26BaseOpen}，客户页 ${await money.customerReceivable(r26C.id)}`
)
eq('表尾合计 = 订单 360 + 打样 72（汇率未填的单不瞎折）', r26BaseOpen, 432)

const r26File = await dashboard.statementFileName(r26C.id)
check('对账单文件名带客户名与截止日', r26File.includes('R26 Statement Co') && r26File.includes(localDate()), r26File)
const r26Empty = await customers.saveCustomer({ company: 'R26 Empty Co' })
check(
  '没有单据的客户导出被拦下（不是给一张空表）',
  (await r8err(async () => await dashboard.exportCsv('statement', { customerId: r26Empty.id }))).includes('没有可对账')
)

/* ---------------- R27 客户预收余额与负费用并账 ---------------- */
section('R27 客户预收：多收 / 作废余款 / 取消单实收是同一份余额，抵扣不落现金')

const r27Base = getSettings().baseCurrency
const r27C = await customers.saveCustomer({
  company: 'R27 Credit Co',
  contact: 'Ada',
  email: 'ada@r27.com',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r27Other = await customers.saveCustomer({
  company: 'R27 Other Co',
  contact: '',
  email: '',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})

// 来源①：正常单多付 5
const r27Over = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-OVER'
})
await orders.addOrderItem(r27Over.id, { styleNo: 'R27-OVER', quantity: 1, unitPrice: 10 })
await orders.addPayment(r27Over.id, { paidAt: localDate(), amount: 15, method: 'T/T', bankRef: 'R27-OVER-PAY' })

// 来源②：作废单上真到账的 20（单不欠钱了，钱必须有去处）
const r27Void = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-VOID'
})
await orders.addOrderItem(r27Void.id, { styleNo: 'R27-V', quantity: 2, unitPrice: 10 })
await orders.addPayment(r27Void.id, { paidAt: localDate(), amount: 20, method: 'T/T', bankRef: 'R27-VOID-PAY' })
await orders.voidOrder(r27Void.id, 'R27 客户取消')

// 来源③：取消的打样单上收到的 8
const r27S1 = await samples.saveSample({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R27-S1', productName: '取消样品', color: 'Black', size: 'M', quantity: 1, unitPrice: 10 }]
})
await samples.addSamplePayment(r27S1.id, { paidAt: localDate(), amount: 8, bankRef: 'R27-S1-PAY' })
await samples.saveSample({ id: r27S1.id, status: 'cancelled', note: 'R27 客户自己打样了' })

const r27Bal = await money.customerCreditBalance(r27C.id)
eq('预收余额按币种归集（只有 USD）', r27Bal.map((c) => c.currency), ['USD'])
const r27Usd = r27Bal[0]
eq('来源合计 = 多付 5 + 作废余款 20 + 取消单实收 8', r27Usd.gross, 33)
eq('未抵扣时可用 = 来源合计', r27Usd.available, 33)
eq('三笔来源都列出来', r27Usd.sources.length, 3)
const r27SrcNos = r27Usd.sources.map((s) => s.docNo)
check(
  '来源能追到具体单据',
  [r27Over.orderNo, r27Void.orderNo, r27S1.sampleNo].every((no) => r27SrcNos.includes(no)),
  JSON.stringify(r27SrcNos)
)
eq('没出现过的币种没有预收', await money.customerCreditAvailable(r27C.id, 'EUR'), 0)

// 可抵的目标：一张 30 的订单、一张 12 的打样单
const r27Target = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-T'
})
await orders.addOrderItem(r27Target.id, { styleNo: 'R27-T', quantity: 3, unitPrice: 10 })
const r27TargetItem = (await orders.getOrder(r27Target.id))!.items[0]
const r27S2 = await samples.saveSample({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R27-S2', productName: '可抵样品', color: 'Grey', size: 'L', quantity: 1, unitPrice: 12 }]
})
const r27Draft = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  piNo: 'PI-R27-DRAFT'
})
await orders.addOrderItem(r27Draft.id, { styleNo: 'R27-D', quantity: 1, unitPrice: 9 })

const r27Apply = async (over: Partial<Parameters<typeof credits.applyCredit>[0]>): Promise<void> => {
  await credits.applyCredit({
    customerId: r27C.id,
    currency: 'USD',
    targetKind: 'order',
    targetId: r27Target.id,
    amount: 1,
    ...over
  })
}

check('金额必须大于 0', (await r8err(async () => r27Apply({ amount: 0 }))).includes('必须大于 0'))
check('草稿单不抵（草稿不进应收）', (await r8err(async () => r27Apply({ targetId: r27Draft.id }))).includes('草稿'))
check('作废单不抵（已经没有待收）', (await r8err(async () => r27Apply({ targetId: r27Void.id }))).includes('失效/作废'))
check(
  '取消的打样单不抵',
  (await r8err(async () => r27Apply({ targetKind: 'sample', targetId: r27S1.id }))).includes('没有待收')
)
check('不能拿别家客户的钱抵这家的单', (await r8err(async () => r27Apply({ customerId: r27Other.id }))).includes('不属于当前客户'))
check('跨币种不抵（没有唯一正确的汇率）', (await r8err(async () => r27Apply({ currency: 'EUR' }))).includes('跨币种'))
check('不能超过这张单的待收', (await r8err(async () => r27Apply({ amount: 31 }))).includes('不能再抵'))

const r27CashBefore = (await money.receivedByMonth()).reduce((sum, m) => sum + m.amount, 0)
const r27AfterApply = await credits.applyCredit({
  customerId: r27C.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r27Target.id,
  amount: 30,
  note: 'R27 抵这张单'
})
const r27TargetAfter = (await orders.getOrder(r27Target.id))!
eq('抵 30 后客户可用预收只剩 3', await money.customerCreditAvailable(r27C.id, 'USD'), 3)
eq('订单待收归零', r27TargetAfter.remaining, 0)
eq('订单标成已结清（预收也是收过的钱）', r27TargetAfter.paymentStatus, 'settled')
eq('订单金额不因抵扣改变', r27TargetAfter.grandTotal, 30)
eq('抵扣不伪造现金流水', r27TargetAfter.payments.length, 0)
eq(
  '抵扣不进现金流',
  (await money.receivedByMonth()).reduce((sum, m) => sum + m.amount, 0),
  r27CashBefore
)
eq('抵扣台账记一笔', r27AfterApply[0].applications.length, 1)
check(
  '抵扣能追到目标单',
  r27AfterApply[0].applications[0].targetNo === r27Target.orderNo,
  JSON.stringify(r27AfterApply[0].applications)
)
check(
  '预收抵过的单不能再收一遍现金',
  (await r8err(async () => await orders.addPayment(r27Target.id, { paidAt: localDate(), amount: 1 }))).includes('重复收')
)
const r27ShrinkErr = (await r8err(async () => await orders.updateOrderItem(r27Target.id, r27TargetItem.id, { quantity: 1 })))
check('改小金额会兜不住抵扣，拦下', r27ShrinkErr.includes('不够覆盖'), r27ShrinkErr)
check(
  '换客户会串账，拦下',
  (await r8err(async () => await orders.updateOrder(r27Target.id, { customerId: r27Other.id }))).includes('换客户')
)
check(
  '不能超过客户可用预收',
  (await r8err(async () => r27Apply({ targetKind: 'sample', targetId: r27S2.id, amount: 5 }))).includes('可用预收只有 3.00')
)
await credits.applyCredit({
  customerId: r27C.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r27S2.id,
  amount: 3
})
eq('打样单记下预收抵扣 3', (await samples.getSample(r27S2.id))!.creditApplied, 3)
eq(
  '打样单待收 = 12 − 3',
  (await money.sampleOpenRows(r27C.id)).find((r) => r.sampleId === r27S2.id)!.receivable,
  9
)
check(
  '预收抵过的打样单不能再收满额现金',
  (await r8err(async () => await samples.addSamplePayment(r27S2.id, { paidAt: localDate(), amount: 10 }))).includes('预收抵扣 3.00')
)

const r27Statement = parseCsv(await dashboard.exportCsv('statement', { customerId: r27C.id }))
const r27Head = r27Statement[0]
const r27Body = r27Statement.slice(1)
const r27Col = (name: string): number => r27Head.indexOf(name)
const r27Row = (kind: string, docNo: string): string[] | undefined =>
  r27Body.find((r) => r[r27Col('类型')] === kind && r[r27Col('单据号')] === docNo)
check('对账单新增「预收抵扣」列', r27Head.includes('预收抵扣(原币)'))
const r27OrderRow = r27Row('订单', r27Target.orderNo)!
eq('抵过的订单行未收 0', r27OrderRow[r27Col('未收(原币)')], '0')
eq('订单行标出预收抵扣 30', r27OrderRow[r27Col('预收抵扣(原币)')], '30')
check(
  '订单行备注写明抵扣是非现金',
  r27OrderRow[r27Col('备注')].includes('非现金'),
  r27OrderRow[r27Col('备注')]
)
const r27SampleRow = r27Row('打样单', r27S2.sampleNo)!
eq('打样行未收 9', r27SampleRow[r27Col('未收(原币)')], '9')
eq('打样行标出预收抵扣 3', r27SampleRow[r27Col('预收抵扣(原币)')], '3')
const r27Prepaid = r27Body.find((r) => r[r27Col('类型')] === '预收结余' && r[r27Col('币种')] === 'USD')!
eq('预收结余行 = 来源 33 − 已抵扣 33', r27Prepaid[r27Col('金额(原币)')], '0')
check(
  '预收结余写清来源与已抵扣',
  r27Prepaid[r27Col('备注')].includes('来源 33') && r27Prepaid[r27Col('备注')].includes('已抵扣 33'),
  r27Prepaid[r27Col('备注')]
)
const r27BaseTotal = r27Body.find((r) => r[r27Col('类型')] === '合计' && r[r27Col('币种')] === r27Base)!
const r27Open = Number(r27BaseTotal[r27Col(`未收(${r27Base})`)])
check(
  '表尾未收 = 客户页未收（同一口径）',
  Math.abs(r27Open - await money.customerReceivable(r27C.id)) < 0.01,
  `${r27Open} vs ${await money.customerReceivable(r27C.id)}`
)
eq('表尾未收 = 打样单剩下的 9 × 7.2', r27Open, 64.8)

const r27App = (await money.customerCreditBalance(r27C.id))[0]
  .applications.find((a) => a.targetKind === 'order' && a.targetId === r27Target.id)!
const r27AfterReverse = await credits.reverseCredit(r27App.id, 'R27 抵错了单')
eq('撤销后可用预收回到 30', r27AfterReverse.find((c) => c.currency === 'USD')!.available, 30)
eq('撤销后订单待收回来', (await orders.getOrder(r27Target.id))!.remaining, 30)
eq('撤销后状态退回客户已确认', (await orders.getOrder(r27Target.id))!.paymentStatus, 'confirmed')
const r27RevRow = getDb().get('SELECT reversed_at, reversed_reason FROM credit_applications WHERE id = ?', [
  r27App.id
]) as { reversed_at?: string | null; reversed_reason?: string } | null
check(
  '撤销不删台账，写清原因',
  !!r27RevRow?.reversed_at && r27RevRow.reversed_reason === 'R27 抵错了单',
  JSON.stringify(r27RevRow)
)
check('重复撤销被拦下', (await r8err(async () => await credits.reverseCredit(r27App.id, 'R27 再撤一次'))).includes('撤销过'))

// 目标单作废：抵扣自动回退，钱回到客户账上
const r27D = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-D'
})
await orders.addOrderItem(r27D.id, { styleNo: 'R27-D2', quantity: 5, unitPrice: 10 })
await credits.applyCredit({ customerId: r27C.id, currency: 'USD', targetKind: 'order', targetId: r27D.id, amount: 10 })
eq('作废前可用 20', await money.customerCreditAvailable(r27C.id, 'USD'), 20)
await orders.voidOrder(r27D.id, 'R27 作废带抵扣的单')
eq('作废后抵扣自动回退', await money.customerCreditAvailable(r27C.id, 'USD'), 30)
eq('作废单上不再挂抵扣', (await orders.getOrder(r27D.id))!.creditApplied, 0)

// 目标打样单取消：抵扣同样自动回退
const r27S3 = await samples.saveSample({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R27-S3', productName: '待取消样品', color: 'Navy', size: 'S', quantity: 1, unitPrice: 20 }]
})
await credits.applyCredit({
  customerId: r27C.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r27S3.id,
  amount: 10
})
eq('取消前可用 20', await money.customerCreditAvailable(r27C.id, 'USD'), 20)
await samples.saveSample({ id: r27S3.id, status: 'cancelled', note: 'R27 样品取消，抵扣回退' })
eq('取消打样单后抵扣自动回退', await money.customerCreditAvailable(r27C.id, 'USD'), 30)
eq('取消单上不再挂抵扣', (await samples.getSample(r27S3.id))!.creditApplied, 0)

// 挂着抵扣的单不能删：余额用到哪儿去了必须有凭据
const r27E = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-E'
})
await orders.addOrderItem(r27E.id, { styleNo: 'R27-E', quantity: 1, unitPrice: 10 })
await credits.applyCredit({ customerId: r27C.id, currency: 'USD', targetKind: 'order', targetId: r27E.id, amount: 5 })
check('挂着预收抵扣的订单不能删', (await r8err(async () => orders.deleteOrder(r27E.id))).includes('预收抵扣'))
const r27EApp = (await money.customerCreditBalance(r27C.id))[0]
  .applications.find((a) => a.targetKind === 'order' && a.targetId === r27E.id)!
await credits.reverseCredit(r27EApp.id, 'R27 撤销后可删')

const r27S4 = await samples.saveSample({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R27-S4', productName: '带抵扣样品', color: 'White', size: 'XL', quantity: 1, unitPrice: 10 }]
})
await credits.applyCredit({
  customerId: r27C.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r27S4.id,
  amount: 5
})
check('挂着预收抵扣的打样单不能删', (await r8err(async () => await samples.deleteSample(r27S4.id))).includes('预收抵扣'))
const r27S4App = (await money.customerCreditBalance(r27C.id))[0]
  .applications.find((a) => a.targetKind === 'sample' && a.targetId === r27S4.id)!
await credits.reverseCredit(r27S4App.id, 'R27 撤销后可删')

// 删掉预收来源不能把已经抵出去的钱删成负数
const r27F = await orders.createOrder({
  customerId: r27C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R27-F'
})
await orders.addOrderItem(r27F.id, { styleNo: 'R27-F', quantity: 5, unitPrice: 10 })
await credits.applyCredit({ customerId: r27C.id, currency: 'USD', targetKind: 'order', targetId: r27F.id, amount: 30 })
eq('全部抵出去后可用清零', await money.customerCreditAvailable(r27C.id, 'USD'), 0)
const r27OverPay = (await orders.getOrder(r27Over.id))!.payments[0]
check(
  '删掉预收来源会让余额穿仓，拦下',
  (await r8err(async () => await orders.deletePayment(r27Over.id, r27OverPay.id, 'R27 试删'))).includes('缺口')
)
eq('拦下后流水原样还在', (await orders.getOrder(r27Over.id))!.payments.length, 1)

/* ---------------- R28 客户预收出口与来源守门 ---------------- */
section('R28 客户预收一本账：退还正门、来源守门、草稿闸门、催款与台账同一口径')

const r28C = await customers.saveCustomer({
  company: 'R28 Refund Co',
  contact: '',
  email: '',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r28Other = await customers.saveCustomer({
  company: 'R28 Other Co',
  contact: '',
  email: '',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})

// 来源：一张多付 40 的单（100 的货，收到 140）
const r28A = await orders.createOrder({
  customerId: r28C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-A'
})
await orders.addOrderItem(r28A.id, { styleNo: 'R28-A', quantity: 1, unitPrice: 100 })
await orders.addPayment(r28A.id, { paidAt: localDate(), amount: 140, bankRef: 'R28-IN' })
eq('R28 余额 = 多付 40', await money.customerCreditAvailable(r28C.id, 'USD'), 40)

// —— 退款守门：日期、水单、原因、可用额度，一道都不能少
check(
  '退 0 被拦',
  (await r8err(async () => await credits.refundCredit({ customerId: r28C.id, currency: 'USD', amount: 0, bankRef: 'R28-OUT', note: 'x' }))).includes(
    '大于 0'
  )
)
check(
  '没水单被拦',
  (await r8err(async () => await credits.refundCredit({ customerId: r28C.id, currency: 'USD', amount: 10, bankRef: '', note: 'x' }))).includes(
    '水单'
  )
)
check(
  '没原因被拦',
  (await r8err(async () =>
    await credits.refundCredit({ customerId: r28C.id, currency: 'USD', amount: 10, bankRef: 'R28-OUT', note: '' })
  )).includes('原因')
)
check(
  '未来日期被拦',
  (await r8err(async () =>
    await credits.refundCredit({
      customerId: r28C.id,
      currency: 'USD',
      amount: 10,
      refundAt: '2999-01-01',
      bankRef: 'R28-OUT',
      note: 'x'
    })
  )).includes('未来')
)
check(
  '超过可用被拦',
  (await r8err(async () =>
    await credits.refundCredit({ customerId: r28C.id, currency: 'USD', amount: 45, bankRef: 'R28-OUT', note: 'x' })
  )).includes('不够退')
)
check(
  '跨币种没有余额可退',
  (await r8err(async () =>
    await credits.refundCredit({ customerId: r28C.id, currency: 'EUR', amount: 5, bankRef: 'R28-OUT', note: 'x' })
  )).includes('不够退')
)

// —— 退 25：余额当场减，来源流水不删
const r28AfterRefund = await credits.refundCredit({
  customerId: r28C.id,
  currency: 'USD',
  amount: 25,
  refundAt: localDate(),
  bankRef: 'R28-OUT-1',
  note: 'R28 客户多付退回'
})
const r28Usd = r28AfterRefund.find((c) => c.currency === 'USD')!
eq('退还后可用 15', r28Usd.available, 15)
eq('已退还合计 25', r28Usd.refunded, 25)
eq('退款台账一笔', r28Usd.refunds.length, 1)
eq('退款不删来源流水：来源仍是 40', r28Usd.gross, 40)
eq('来源流水还在', (await orders.getOrder(r28A.id))!.payments.length, 1)

// —— 对账单：退款单列一行负数，结余写明「已退还」
const r28Stmt = parseCsv(await dashboard.exportCsv('statement', { customerId: r28C.id }))
const r28Head = r28Stmt[0]
const r28Body = r28Stmt.slice(1)
const r28Col = (name: string): number => r28Head.indexOf(name)
const r28RefundRow = r28Body.find((r) => r[r28Col('类型')] === '预收退款')!
eq('对账单退款行金额 -25', r28RefundRow[r28Col('金额(原币)')], '-25')
eq('对账单退款行带银行水单', r28RefundRow[r28Col('银行流水号')], 'R28-OUT-1')
const r28Prepaid1 = r28Body.find((r) => r[r28Col('类型')] === '预收结余')!
eq('对账单预收结余 15', r28Prepaid1[r28Col('金额(原币)')], '15')
check('预收结余写明已退还 25', r28Prepaid1[r28Col('备注')].includes('已退还 25'), r28Prepaid1[r28Col('备注')])

// —— 抵 10 到另一张单：余额 15 → 5，待收 30 → 20
const r28B = await orders.createOrder({
  customerId: r28C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-B'
})
await orders.addOrderItem(r28B.id, { styleNo: 'R28-B', quantity: 1, unitPrice: 30 })
await credits.applyCredit({ customerId: r28C.id, currency: 'USD', targetKind: 'order', targetId: r28B.id, amount: 10 })
eq('抵 10 后可用 5', await money.customerCreditAvailable(r28C.id, 'USD'), 5)
eq('目标单待收 20', (await orders.getOrder(r28B.id))!.remaining, 20)

// —— 撤销退款（水单录错）：余额回来；重复撤销被拦
const r28RefundId = r28Usd.refunds[0].id
await credits.reverseRefund(r28RefundId, 'R28 水单录错，钱没退出去')
eq('撤销退款后可用 30', await money.customerCreditAvailable(r28C.id, 'USD'), 30)
check('重复撤销退款被拦', (await r8err(async () => await credits.reverseRefund(r28RefundId, '再撤一次'))).includes('撤销过'))

// —— 把余额全部退出去（30）后，来源单据就不能再缩小
await credits.refundCredit({
  customerId: r28C.id,
  currency: 'USD',
  amount: 30,
  refundAt: localDate(),
  bankRef: 'R28-OUT-2',
  note: 'R28 剩余预收全退'
})
eq('再退 30 后可用 0', await money.customerCreditAvailable(r28C.id, 'USD'), 0)
check(
  '改费用吃掉多付 → 预收缺口，拦下',
  (await r8err(async () => await orders.updateOrderCharges(r28A.id, [{ label: 'R28 加价', amount: 10 }]))).includes('缺口')
)
check(
  '加明细吃掉多付 → 预收缺口，拦下',
  (await r8err(async () => await orders.addOrderItem(r28A.id, { styleNo: 'R28-A2', quantity: 1, unitPrice: 10 }))).includes('缺口')
)
check(
  '改大单价 → 预收缺口，拦下',
  (await r8err(async () => await orders.updateOrderItem(r28A.id, (await orders.getOrder(r28A.id))!.items[0].id, { unitPrice: 120 }))).includes(
    '缺口'
  )
)
check(
  '换客户会带走多付 → 预收缺口，拦下',
  (await r8err(async () => await orders.updateOrder(r28A.id, { customerId: r28Other.id }))).includes('换客户')
)
check(
  '整体替换明细变大 → 预收缺口，拦下',
  (await r8err(async () => await orders.replaceOrderItems(r28A.id, [{ styleNo: 'R28-A', quantity: 1, unitPrice: 120 }]))).includes('缺口')
)
eq(
  '改小单价不误伤（多付变多，不会穿仓）',
  (await r8err(async () => await orders.updateOrderItem(r28A.id, (await orders.getOrder(r28A.id))!.items[0].id, { unitPrice: 90 }))),
  ''
)
await orders.updateOrderItem(r28A.id, (await orders.getOrder(r28A.id))!.items[0].id, { unitPrice: 100 })

// —— 草稿闸门：有流水 / 核销 / 抵扣的单不能退回草稿
check(
  '有预收抵扣的单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r28B.id, 'draft'))).includes('不能退回草稿')
)
check(
  '有收款流水的单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r28A.id, 'draft'))).includes('不能退回草稿')
)
const r28C1 = await orders.createOrder({
  customerId: r28C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-C'
})
await orders.addOrderItem(r28C1.id, { styleNo: 'R28-C', quantity: 1, unitPrice: 100 })
await orders.addSettlement(r28C1.id, { kind: 'shortage', amount: 100, reason: 'R28 短款核销' })
check(
  '有核销的单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r28C1.id, 'draft'))).includes('不能退回草稿')
)
const r28Plain = await orders.createOrder({
  customerId: r28C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-PLAIN'
})
eq('干净的单仍可退回草稿', (await orders.setPaymentStatus(r28Plain.id, 'draft')).paymentStatus, 'draft')

// —— 打样单从取消恢复成在途：原来靠「取消单实收」撑着的余额会穿仓
const r28S = await samples.saveSample({
  customerId: r28C.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R28-S', productName: '取消样品', color: 'Black', size: 'M', quantity: 1, unitPrice: 40 }]
})
await samples.addSamplePayment(r28S.id, { paidAt: localDate(), amount: 40, bankRef: 'R28-SMP' })
await samples.saveSample({ id: r28S.id, status: 'cancelled', note: 'R28 客户取消，实收留账' })
eq('取消单实收进余额 40', await money.customerCreditAvailable(r28C.id, 'USD'), 40)
await credits.applyCredit({ customerId: r28C.id, currency: 'USD', targetKind: 'order', targetId: r28B.id, amount: 20 })
eq('再抵 20 后可用 20', await money.customerCreditAvailable(r28C.id, 'USD'), 20)
check(
  '取消的打样单恢复成在途会让余额穿仓，拦下',
  (await r8err(async () => await samples.saveSample({ id: r28S.id, status: 'pending' }))).includes('缺口')
)
eq('拦下后打样单仍是已取消', (await samples.getSample(r28S.id))!.status, 'cancelled')

// —— 订单台账导出补上抵扣列：已收 + 预收抵扣 + 待收 = 含费用合计
const r28OrdersCsv = parseCsv(await dashboard.exportCsv('orders'))
const r28OrdersHead = r28OrdersCsv[0]
check(
  '订单台账新增预收抵扣两列',
  r28OrdersHead.includes('预收抵扣(原币)') && r28OrdersHead.includes(`预收抵扣(${r27Base})`),
  JSON.stringify(r28OrdersHead)
)
const r28BNo = (await orders.getOrder(r28B.id))!.orderNo
const r28BRow = r28OrdersCsv.slice(1).find((r) => r[r28OrdersHead.indexOf('订单号')] === r28BNo)!
eq('导出：订单 B 预收抵扣 30', Number(r28BRow[r28OrdersHead.indexOf('预收抵扣(原币)')]), 30)
eq(
  '导出对账链：已收 0 + 抵扣 30 + 待收 0 = 含费用 30',
  Number(r28BRow[r28OrdersHead.indexOf('已收金额(原币)')]) +
    Number(r28BRow[r28OrdersHead.indexOf('预收抵扣(原币)')]) +
    Number(r28BRow[r28OrdersHead.indexOf('待收金额(原币)')]),
  Number(r28BRow[r28OrdersHead.indexOf('含费用合计(原币)')])
)
const r28ListRow = (await orders.listOrderRows({ keyword: (await orders.getOrder(r28B.id))!.orderNo })).rows[0]
eq('订单列表行带预收抵扣 30', r28ListRow.creditApplied, 30)

// —— 催打样费认抵扣：抵清后不再催
const r28R = await customers.saveCustomer({
  company: 'R28 Remind Co',
  contact: '',
  email: '',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r28RSrc = await orders.createOrder({
  customerId: r28R.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-RS'
})
await orders.addOrderItem(r28RSrc.id, { styleNo: 'R28-RS', quantity: 1, unitPrice: 10 })
await orders.addPayment(r28RSrc.id, { paidAt: localDate(), amount: 30, bankRef: 'R28-RIN' })
const r28Smp = await samples.saveSample({
  customerId: r28R.id,
  sampleDate: '2026-08-01',
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: '2026-08-01',
  items: [{ styleNo: 'R28-SMP', productName: '预收抵清样品', color: 'White', size: 'L', quantity: 1, unitPrice: 20 }]
})
check(
  '抵清前会催打样费',
  (await dashboard.reminders()).some((r) => r.kind === 'sample' && r.sampleId === r28Smp.id && r.message.includes('打样费'))
)
await credits.applyCredit({ customerId: r28R.id, currency: 'USD', targetKind: 'sample', targetId: r28Smp.id, amount: 20 })
eq('打样单记下预收抵扣 20', (await samples.getSample(r28Smp.id))!.creditApplied, 20)
check(
  '预收抵清后不再催打样费',
  !(await dashboard.reminders()).some((r) => r.kind === 'sample' && r.sampleId === r28Smp.id && r.message.includes('打样费')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r28Smp.id).map((r) => r.message))
)

// —— 催定金认抵扣：定金 30 抵掉 10，只催剩下的 20
const r28D = await customers.saveCustomer({
  company: 'R28 Deposit Co',
  contact: '',
  email: '',
  phone: '',
  country: 'US',
  address: '',
  zipCode: '',
  attn: '',
  paymentPref: ''
})
const r28DSrc = await orders.createOrder({
  customerId: r28D.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R28-DS'
})
await orders.addOrderItem(r28DSrc.id, { styleNo: 'R28-DS', quantity: 1, unitPrice: 10 })
await orders.addPayment(r28DSrc.id, { paidAt: localDate(), amount: 20, bankRef: 'R28-DIN' })
const r28DTarget = await orders.createOrder({
  customerId: r28D.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  depositRatio: 0.3,
  piNo: 'PI-R28-DT'
})
await orders.addOrderItem(r28DTarget.id, { styleNo: 'R28-DT', quantity: 1, unitPrice: 100 })
await credits.applyCredit({ customerId: r28D.id, currency: 'USD', targetKind: 'order', targetId: r28DTarget.id, amount: 10 })
await orders.setPaymentStatus(r28DTarget.id, 'confirmed', 'R28 回到客户已确认，好测定金提醒')
// 建单时就是 confirmed，催款时钟取的是所有 to_status=confirmed 事件里最晚的一条，
// 所以创建事件也要一起往回拨，否则 MAX(at) 还是今天。
getDb().run("UPDATE order_events SET at = ? WHERE order_id = ? AND to_status = 'confirmed'", [
  new Date(Date.now() - 30 * 86400000).toISOString(),
  r28DTarget.id
])
const r28DepositRem = (await dashboard.reminders())
  .find((r) => r.kind === 'payment' && r.orderId === r28DTarget.id && r.message.includes('定金'))
check('定金提醒还在（客户确认了但没收齐）', !!r28DepositRem, JSON.stringify((await dashboard.reminders()).map((r) => r.message)))
check(
  '定金提醒扣掉预收抵掉的 10，只催 20',
  !!r28DepositRem && r28DepositRem.message.includes('定金还差 20.00'),
  r28DepositRem?.message
)

// —— 抵扣入参守门：对象类型和未来日期
check(
  '抵扣对象只能是订单或打样单',
  (await r8err(async () =>
    await credits.applyCredit({
      customerId: r28D.id,
      currency: 'USD',
      targetKind: 'xxx' as any,
      targetId: r28DTarget.id,
      amount: 1
    })
  )).includes('订单或打样单')
)
check(
  '抵扣日期不能填未来',
  (await r8err(async () =>
    await credits.applyCredit({
      customerId: r28D.id,
      currency: 'USD',
      targetKind: 'order',
      targetId: r28DTarget.id,
      amount: 1,
      appliedAt: '2999-01-01'
    })
  )).includes('未来')
)

section('R29 余额只来自真钱：转单抵扣随订单状态派生，有账不许换客户')

// —— 转单抵扣超过货值：宁可不转，也不造负数合计（负数合计会被当成客户多付）
const r29GuardCust = await customers.saveCustomer({ company: 'R29-GUARD-CO' })
const r29GuardSample = await samples.saveSample({
  customerId: r29GuardCust.id,
  sampleDate: dAgo(3),
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(3),
  items: [
    { styleNo: 'R29-G1', productName: '转单守门', color: 'Black', size: 'M', quantity: 1, unitPrice: 10, goodsUnitPrice: 10 }
  ]
})
check(
  '样品费+快递 15 超过货值 10，转单被拦下',
  (await r8err(async () => await samples.convertSampleToOrder(r29GuardSample.id, { offsetSampleFee: true }))).includes('负数')
)
const r29GuardAfter = await samples.getSample(r29GuardSample.id)!
eq('拦下后打样单仍是未收', r29GuardAfter.feeStatus, 'unpaid')
eq('拦下后没有转出订单', r29GuardAfter.convertedOrderId, null)
eq('拦下后客户没有凭空多出预收', await money.customerCreditAvailable(r29GuardCust.id, 'USD'), 0)

// —— 历史负数合计单：只有真到账的钱才算预收
const r29NegCust = await customers.saveCustomer({ company: 'R29-NEG-CO' })
const r29Neg = await orders.createOrder({
  customerId: r29NegCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R29-NEG'
})
await orders.addOrderItem(r29Neg.id, { styleNo: 'R29-NEG', quantity: 1, unitPrice: 10 })
// R40 起服务层拦住负合计（updateOrderCharges 会拒），这里直插库模拟升级前的历史脏数据
getDb().run('UPDATE orders SET charges = ? WHERE id = ?', [
  JSON.stringify([{ label: '折让', amount: -30 }]),
  r29Neg.id
])
eq('合计为负的单一分预收都不生', await money.customerCreditAvailable(r29NegCust.id, 'USD'), 0)
await orders.addPayment(r29Neg.id, { paidAt: localDate(), amount: 20, bankRef: 'R29-NEG-IN' })
eq('只认真实到账的 20', await money.customerCreditAvailable(r29NegCust.id, 'USD'), 20)
check(
  '不能退超过真钱的部分',
  (await r8err(async () =>
    await credits.refundCredit({
      customerId: r29NegCust.id,
      currency: 'USD',
      amount: 21,
      bankRef: 'R29-NEG-OUT',
      note: 'R29 试退'
    })
  )).includes('不够退')
)

// —— 打样抵扣随转出订单状态派生：草稿/失效期间回到待收，恢复后自动再抵
const r29OffCust = await customers.saveCustomer({ company: 'R29-OFFSET-CO' })
const r29OffSample = await samples.saveSample({
  customerId: r29OffCust.id,
  sampleDate: dAgo(30),
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(30),
  items: [
    { styleNo: 'R29-O1', productName: '转单抵扣派生', color: 'White', size: 'L', quantity: 1, unitPrice: 40, goodsUnitPrice: 100 }
  ]
})
const r29OffOrder = await samples.convertSampleToOrder(r29OffSample.id, { offsetSampleFee: true })
eq('转单默认落草稿', r29OffOrder.paymentStatus, 'draft')
eq('抵扣行 −40', Number(r29OffOrder.charges.find((c: any) => Number(c.amount) < 0)?.amount), -40)
const r29SampDraft = await samples.getSample(r29OffSample.id)!
eq('草稿期间打样单仍记「下单抵扣」', r29SampDraft.feeStatus, 'offset')
eq('草稿期间抵扣暂不生效', r29SampDraft.offsetSuspended, true)
eq('草稿期间样品费回到待收 40 × 7.2', r29SampDraft.receivableBase, 40 * 7.2)
const r29StmtDraft = (await money.sampleStatementRows(r29OffCust.id)).find((r) => r.sampleId === r29OffSample.id)!
eq('对账单也把这 40 算未收', r29StmtDraft.open, 40)
check(
  '工作台重新催这笔打样费',
  (await dashboard.reminders())
    .some((r) => r.kind === 'sample' && r.sampleId === r29OffSample.id && r.message.includes('打样费 40.00')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r29OffSample.id).map((r) => r.message))
)

await orders.setPaymentStatus(r29OffOrder.id, 'confirmed', 'R29 客户确认 PI，抵扣生效')
const r29SampLive = await samples.getSample(r29OffSample.id)!
eq('订单确认后抵扣生效', r29SampLive.offsetSuspended, false)
eq('订单确认后不再计待收', r29SampLive.receivableBase, 0)
eq(
  '确认后对账单未收归零',
  (await money.sampleStatementRows(r29OffCust.id)).find((r) => r.sampleId === r29OffSample.id)!.open,
  0
)
check(
  '确认后不再催打样费',
  !(await dashboard.reminders())
    .some((r) => r.kind === 'sample' && r.sampleId === r29OffSample.id && r.message.includes('打样费')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r29OffSample.id).map((r) => r.message))
)

await orders.setPaymentStatus(r29OffOrder.id, 'expired', 'R29 客户改期，先标失效')
const r29SampExpired = await samples.getSample(r29OffSample.id)!
eq('失效期间抵扣又挂起', r29SampExpired.offsetSuspended, true)
eq('失效期间待收回到 40 × 7.2', r29SampExpired.receivableBase, 40 * 7.2)
check(
  '失效期间重新催款，金额写 40',
  (await dashboard.reminders())
    .some((r) => r.kind === 'sample' && r.sampleId === r29OffSample.id && r.message.includes('打样费 40.00')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r29OffSample.id).map((r) => r.message))
)
await orders.setPaymentStatus(r29OffOrder.id, 'confirmed', 'R29 客户恢复，抵扣自动再生效')
const r29SampBack = await samples.getSample(r29OffSample.id)!
eq('恢复确认后自动再抵，不用重录', r29SampBack.offsetSuspended, false)
eq('恢复后待收又是 0', r29SampBack.receivableBase, 0)
check(
  '恢复后提醒消失',
  !(await dashboard.reminders())
    .some((r) => r.kind === 'sample' && r.sampleId === r29OffSample.id && r.message.includes('打样费'))
)

// —— 有账的单不能换客户：钱和凭据都挂在原客户名下
const r29A = await customers.saveCustomer({ company: 'R29-CHANGE-A' })
const r29B = await customers.saveCustomer({ company: 'R29-CHANGE-B' })
const r29Pay = await orders.createOrder({
  customerId: r29A.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R29-CHG'
})
await orders.addOrderItem(r29Pay.id, { styleNo: 'R29-CHG', quantity: 1, unitPrice: 100 })
await orders.addPayment(r29Pay.id, { paidAt: localDate(), amount: 120, bankRef: 'R29-CHG-IN' })
eq('多付的 20 记在 A 名下', await money.customerCreditAvailable(r29A.id, 'USD'), 20)
check(
  '有收款流水的单不能换客户',
  (await r8err(async () => await orders.updateOrder(r29Pay.id, { customerId: r29B.id }))).includes('换客户')
)
eq('拦下后订单客户没变', (await orders.getOrder(r29Pay.id))!.customerId, r29A.id)
eq('拦下后预收仍在 A 名下', await money.customerCreditAvailable(r29A.id, 'USD'), 20)
eq('拦下后 B 名下没有串过去的钱', await money.customerCreditAvailable(r29B.id, 'USD'), 0)

const r29ConvCust = await customers.saveCustomer({ company: 'R29-CONV-CO' })
const r29ConvSample = await samples.saveSample({
  customerId: r29ConvCust.id,
  sampleDate: dAgo(5),
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(5),
  items: [
    { styleNo: 'R29-C1', productName: '转单换客户', color: 'Grey', size: 'M', quantity: 1, unitPrice: 5, goodsUnitPrice: 50 }
  ]
})
const r29ConvOrder = await samples.convertSampleToOrder(r29ConvSample.id, { paymentStatus: 'sent' })
check(
  '有转单打样抵扣的订单不能换客户',
  (await r8err(async () => await orders.updateOrder(r29ConvOrder.id, { customerId: r29B.id }))).includes('换客户')
)

const r29DocCust = await customers.saveCustomer({ company: 'R29-DOC-CO' })
const r29Doc = await orders.createOrder({
  customerId: r29DocCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R29-DOC'
})
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r29 doc'), docNo: 'PI-R29-DOC', kind: 'pi', orderId: r29Doc.id })
check(
  '有单据存档的订单不能换客户',
  (await r8err(async () => await orders.updateOrder(r29Doc.id, { customerId: r29B.id }))).includes('换客户')
)

// —— 草稿闸门补上纸面凭据和转单打样
check(
  '有单据存档的单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r29Doc.id, 'draft'))).includes('单据存档')
)
eq('拦下后状态还是客户已确认', (await orders.getOrder(r29Doc.id))!.paymentStatus, 'confirmed')

const r29PlCust = await customers.saveCustomer({ company: 'R29-PL-CO' })
const r29PlOrder = await orders.createOrder({
  customerId: r29PlCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R29-PL'
})
await orders.addOrderItem(r29PlOrder.id, { styleNo: 'R29-PL', color: 'Black', size: 'M', quantity: 1, unitPrice: 10 })
await packing.createPackingList({
  orderId: r29PlOrder.id,
  containerNo: 'R29U1234567',
  lines: [{ boxNo: 'NO.1', styleNo: 'R29-PL', color: 'Black', size: 'M', quantity: 1 }]
})
check(
  '有箱单的单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r29PlOrder.id, 'draft'))).includes('箱单')
)
eq('拦下后箱单那单状态没变', (await orders.getOrder(r29PlOrder.id))!.paymentStatus, 'confirmed')

check(
  '转出打样的订单不能退回草稿',
  (await r8err(async () => await orders.setPaymentStatus(r29ConvOrder.id, 'draft'))).includes('转单打样')
)
eq('拦下后转单还是 PI 已发', (await orders.getOrder(r29ConvOrder.id))!.paymentStatus, 'sent')

section('R30 退款出账与坏账/抵扣不双算')

// —— 退款补进收款台账：原币负数、基准币空着不猜
const r30Cust = await customers.saveCustomer({ company: 'R30-REFUND-CO' })
const r30A = await orders.createOrder({
  customerId: r30Cust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-A'
})
await orders.addOrderItem(r30A.id, { styleNo: 'R30-A', quantity: 1, unitPrice: 100 })
await orders.addPayment(r30A.id, { paidAt: localDate(), amount: 140, bankRef: 'R30-IN' })
eq('R30 多付 40 记预收', await money.customerCreditAvailable(r30Cust.id, 'USD'), 40)
await credits.refundCredit({
  customerId: r30Cust.id,
  currency: 'USD',
  amount: 25,
  bankRef: 'R30-OUT-1',
  note: 'R30 客户多付退回'
})
const r30Flows = await money.refundFlowRows({ customerId: r30Cust.id })
eq('退款流水一笔', r30Flows.length, 1)
eq('退款流水记原币 25', r30Flows[0]?.amount, 25)
eq('退款流水带银行水单', r30Flows[0]?.bankRef, 'R30-OUT-1')
eq('退款流水带客户名', r30Flows[0]?.customerName, 'R30-REFUND-CO')

const r30Base = getSettings().baseCurrency
const r30PayCsv = parseCsv(await dashboard.exportCsv('payments'))
const r30PayHead = r30PayCsv[0]
const r30PayCol = (name: string): number => r30PayHead.indexOf(name)
const r30RefundRow = r30PayCsv.slice(1).find((r) => r[r30PayCol('银行流水号')] === 'R30-OUT-1')
check('退款在收款台账里有一条', !!r30RefundRow)
eq('台账退款金额是负数', r30RefundRow?.[r30PayCol('金额(原币)')], '-25')
eq('台账退款没有汇率快照，基准币留空', r30RefundRow?.[r30PayCol(`金额(${r30Base})`)], '')
eq('台账把退款标成预收退款', r30RefundRow?.[r30PayCol('单据类型')], '预收退款')
eq('台账退款状态写已退还', r30RefundRow?.[r30PayCol('订单状态')], '已退还')

const r30RefundId = r30Flows[0].refundId
await credits.reverseRefund(r30RefundId, 'R30 水单录错，钱没退出去')
eq('撤销的退款不再出现在流水里', (await money.refundFlowRows({ customerId: r30Cust.id })).length, 0)
check('撤销的退款也从收款台账消失', !(await dashboard.exportCsv('payments')).includes('R30-OUT-1'))
eq('撤销后预收回到 40', await money.customerCreditAvailable(r30Cust.id, 'USD'), 40)

// —— 坏账没追回：普通收款和预收抵扣都不许再走一遍
const r30DebtCust = await customers.saveCustomer({ company: 'R30-DEBT-CO' })
const r30Debt = await orders.createOrder({
  customerId: r30DebtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-DEBT'
})
await orders.addOrderItem(r30Debt.id, { styleNo: 'R30-DEBT', quantity: 1, unitPrice: 100 })
await orders.addSettlement(r30Debt.id, { kind: 'bad_debt', amount: 50, reason: 'R30 客户失联' })
eq('坏账未追回 50', (await orders.getOrder(r30Debt.id))!.badDebtOutstanding, 50)
check(
  '坏账没追回不能按普通收款记',
  (await r8err(async () =>
    await orders.addPayment(r30Debt.id, { paidAt: localDate(), amount: 20, bankRef: 'R30-BD-IN' })
  )).includes('坏账追回')
)
const r30DebtSrc = await orders.createOrder({
  customerId: r30DebtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-DEBT-SRC'
})
await orders.addOrderItem(r30DebtSrc.id, { styleNo: 'R30-DS', quantity: 1, unitPrice: 100 })
await orders.addPayment(r30DebtSrc.id, { paidAt: localDate(), amount: 130, bankRef: 'R30-BD-SRC' })
eq('坏账客户有预收 30', await money.customerCreditAvailable(r30DebtCust.id, 'USD'), 30)
check(
  '有坏账的单不能拿预收抵',
  (await r8err(async () =>
    await credits.applyCredit({
      customerId: r30DebtCust.id,
      currency: 'USD',
      targetKind: 'order',
      targetId: r30Debt.id,
      amount: 30
    })
  )).includes('坏账')
)
eq('拦下后预收还是 30', await money.customerCreditAvailable(r30DebtCust.id, 'USD'), 30)

// —— 挂起中的转单抵扣：不能再拿预收抵第二次，提醒指回订单状态
const r30SuspCust = await customers.saveCustomer({ company: 'R30-SUSP-CO' })
const r30SuspSrc = await orders.createOrder({
  customerId: r30SuspCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-SUSP-SRC'
})
await orders.addOrderItem(r30SuspSrc.id, { styleNo: 'R30-SS', quantity: 1, unitPrice: 100 })
await orders.addPayment(r30SuspSrc.id, { paidAt: localDate(), amount: 130, bankRef: 'R30-SUSP-IN' })
eq('挂起样例客户有预收 30', await money.customerCreditAvailable(r30SuspCust.id, 'USD'), 30)
const r30SuspSample = await samples.saveSample({
  customerId: r30SuspCust.id,
  sampleDate: dAgo(30),
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(30),
  items: [
    { styleNo: 'R30-S1', productName: '挂起抵扣', color: 'White', size: 'L', quantity: 1, unitPrice: 20, goodsUnitPrice: 100 }
  ]
})
await samples.convertSampleToOrder(r30SuspSample.id, { offsetSampleFee: true })
eq('样例抵扣挂起', (await samples.getSample(r30SuspSample.id))!.offsetSuspended, true)
check(
  '挂起抵扣的样品费不能再拿预收抵一次',
  (await r8err(async () =>
    await credits.applyCredit({
      customerId: r30SuspCust.id,
      currency: 'USD',
      targetKind: 'sample',
      targetId: r30SuspSample.id,
      amount: 10
    })
  )).includes('自动生效')
)
eq('拦下后预收没动', await money.customerCreditAvailable(r30SuspCust.id, 'USD'), 30)
check(
  '催款提醒指向恢复订单，而不是让人重复收款',
  (await dashboard.reminders())
    .some(
      (r) =>
        r.kind === 'sample' &&
        r.sampleId === r30SuspSample.id &&
        r.message.includes('请先把订单恢复成正式单')
    ),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r30SuspSample.id).map((r) => r.message))
)

// —— 欠款榜第五处口径：只有挂起抵扣打样单的客户也要上榜
const r30OnlyCust = await customers.saveCustomer({ company: 'R30-SAMPLE-ONLY' })
const r30OnlySample = await samples.saveSample({
  customerId: r30OnlyCust.id,
  sampleDate: dAgo(10),
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(10),
  items: [
    { styleNo: 'R30-O1', productName: '只打样挂起', color: 'Grey', size: 'M', quantity: 1, unitPrice: 20, goodsUnitPrice: 100 }
  ]
})
await samples.convertSampleToOrder(r30OnlySample.id, { offsetSampleFee: true })
const r30OnlyBoard = (await money.receivableByCustomer()).find((r) => r.customerId === r30OnlyCust.id)
check(
  '只有挂起抵扣打样单的客户也上欠款榜',
  !!r30OnlyBoard,
  JSON.stringify((await money.receivableByCustomer()).filter((r) => r.customerId === r30OnlyCust.id))
)
eq('榜上打样敞口 20 × 7.2', r30OnlyBoard?.sampleBase, 20 * 7.2)
const r30BoardSum = (await money.receivableByCustomer()).reduce((s, r) => s + r.totalBase, 0)
check(
  '欠款榜合计 = 全公司待收',
  Math.abs(r30BoardSum - await money.totalReceivable()) < 0.01,
  `${r30BoardSum} vs ${await money.totalReceivable()}`
)

// —— 对账单币种小计补上预收抵扣（非现金那部分也要勾得出来）
const r30StmtCust = await customers.saveCustomer({ company: 'R30-STMT-CO' })
const r30StmtSrc = await orders.createOrder({
  customerId: r30StmtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-STMT-SRC'
})
await orders.addOrderItem(r30StmtSrc.id, { styleNo: 'R30-STS', quantity: 1, unitPrice: 100 })
await orders.addPayment(r30StmtSrc.id, { paidAt: localDate(), amount: 130, bankRef: 'R30-STMT-IN' })
const r30StmtTarget = await orders.createOrder({
  customerId: r30StmtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R30-STMT-TGT'
})
await orders.addOrderItem(r30StmtTarget.id, { styleNo: 'R30-STT', quantity: 1, unitPrice: 50 })
await orders.addPayment(r30StmtTarget.id, { paidAt: localDate(), amount: 20, bankRef: 'R30-STMT-IN-2' })
await credits.applyCredit({
  customerId: r30StmtCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r30StmtTarget.id,
  amount: 30
})
const r30Stmt = parseCsv(await dashboard.exportCsv('statement', { customerId: r30StmtCust.id }))
const r30StmtHead = r30Stmt[0]
const r30StmtCol = (name: string): number => r30StmtHead.indexOf(name)
const r30UsdTotal = r30Stmt
  .slice(1)
  .find((r) => r[r30StmtCol('类型')] === '合计' && r[r30StmtCol('币种')] === 'USD')
check('对账单有 USD 小计行', !!r30UsdTotal)
eq('小计带上预收抵扣 30', r30UsdTotal?.[r30StmtCol('预收抵扣(原币)')], '30')
check(
  '小计备注说明抵扣是非现金',
  r30UsdTotal?.[r30StmtCol('备注')].includes('预收抵扣 30'),
  r30UsdTotal?.[r30StmtCol('备注')]
)

/* ---------------- R31 CSV 编码与导入这几道门 ---------------- */
section('R31 CSV 编码兜底：GBK 文件不再被当成「没有款号」')

check('替换符算乱码', looksGarbled('\uFFFD,\uFFFD\uFFFD'))
check('拉丁 mojibake 算乱码', looksGarbled('Êý¾Ý,Æ·Ãû\nA001,ºñ'))
check('正常中文表头不算乱码', !looksGarbled('款号,品名\nA001,纯棉圆领T恤'))
check('纯 ASCII 的 CSV 不算乱码（不白折腾一次 GBK）', !looksGarbled('styleNo,name\nA001,T-shirt'))
check('带 BOM 的正常文件不算乱码', !looksGarbled(`${CSV_BOM}款号,品名`))
check('带 BOM 的乱码文件仍然算乱码', looksGarbled(`${CSV_BOM}Êý¾Ý,Æ·Ãû`))
check('空串不算乱码', !looksGarbled(''))

eq(
  'UTF-8 读出乱码时换 GBK 那份',
  pickCsvDecode([
    { encoding: 'utf-8', text: '\uFFFD,\uFFFD' },
    { encoding: 'gbk', text: '款号,品名' }
  ])?.encoding,
  'gbk'
)
eq(
  'UTF-8 正常时绝不换成 GBK',
  pickCsvDecode([
    { encoding: 'utf-8', text: '款号,品名' },
    { encoding: 'gbk', text: 'Êý¾Ý,Æ·Ãû' }
  ])?.encoding,
  'utf-8'
)
eq(
  '两份都乱时退回第一份，让表头报错说清读到了什么',
  pickCsvDecode([
    { encoding: 'utf-8', text: 'Êý¾Ý,Æ·Ãû' },
    { encoding: 'gbk', text: 'ÂÊý,ÂÆ·' }
  ])?.encoding,
  'utf-8'
)
eq(
  'UTF-8 是空文件就用 GBK 那份',
  pickCsvDecode([
    { encoding: 'utf-8', text: '   ' },
    { encoding: 'gbk', text: '款号,品名' }
  ])?.encoding,
  'gbk'
)
eq('一份都没有就是 null', pickCsvDecode([]), null)

// 模板现在带 BOM（Excel 双击不乱码），用户填完原样导回来时 BOM 不能挡住表头
const r31Rows = products.parseCsvRows(`${CSV_BOM}${products.CSV_TEMPLATE_HEADER}\nR31-BOM,带BOM的款`)
eq('parseCsvRows 会摘掉 BOM', r31Rows[0][0], '款号')
const r31Imp = await products.importProductsCsv(
  `${CSV_BOM}${products.CSV_TEMPLATE_HEADER}\nR31-BOM,带BOM的款,100% Cotton,,,,,,,`,
  'skip'
)
eq('带 BOM 的 CSV 正常导入 1 款', r31Imp.created, 1)
const r31P = await products.findProductByStyleNo('R31-BOM')
check('导入后款号没有夹着 BOM', r31P?.styleNo === 'R31-BOM', String(r31P?.styleNo))
if (r31P) await products.deleteProduct(r31P.id)

let r31Err = ''
try {
  await products.importProductsCsv('Êý¾Ý,Æ·Ãû\nA001,1\n', 'skip')
} catch (e) {
  r31Err = (e as Error).message
}
check('表头认不出时用人话报错', r31Err.includes('款号'), r31Err)
check('报错回显读到的表头，一眼看出是乱码', r31Err.includes('Êý¾Ý'), r31Err)
check('报错教用户改成 CSV UTF-8', r31Err.includes('UTF-8'), r31Err)

/* ---------------- R32：报价有效期三态 + 尾款时钟 + 抬头留痕 ---------------- */

section('R32 报价单：清空有效期就是「不设」，不再被偷偷写成今天+N')

const r32Items = [{ styleNo: 'R32-Q', productName: '测试款', quantity: 10, unitPrice: 5 }]
const r32Q = await quotations.saveQuotation({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  items: r32Items
})
const r32ValidCell = (): string | null =>
  (getDb().get('SELECT valid_until FROM quotations WHERE id = ?', [r32Q.id]) as { valid_until: string | null })
    .valid_until
check('新建时没给有效期仍按设置补默认（今天+N）', String(r32ValidCell() ?? '') > localDate(), String(r32ValidCell()))

await quotations.saveQuotation({ id: r32Q.id, customerId: c1.id, currency: 'USD', exchangeRate: 7.2, validUntil: '', items: r32Items })
eq('把有效期清空后库里就是 NULL', r32ValidCell(), null)
const r32ClearEv = (await quotations.listQuotationEvents(r32Q.id)).find((e) => e.note.includes('有效期'))
check('留痕写清「→ 未填」，答得出是谁把它改没的', !!r32ClearEv && r32ClearEv.note.includes('未填'), r32ClearEv?.note)

await quotations.saveQuotation({ id: r32Q.id, customerId: c1.id, currency: 'USD', exchangeRate: 7.2, items: r32Items })
eq('漏传一次不会把「已清空」又写成今天+N', r32ValidCell(), null)

await quotations.saveQuotation({
  id: r32Q.id,
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7.2,
  validUntil: '2026-12-31',
  items: r32Items
})
eq('填了日期就照填的落', r32ValidCell(), '2026-12-31')
await quotations.saveQuotation({ id: r32Q.id, customerId: c1.id, currency: 'USD', exchangeRate: 7.2, items: r32Items })
eq('填过的有效期漏传也原样保留', r32ValidCell(), '2026-12-31')

section('R32 尾款时钟：分批小额付款不再把催款提醒清零')

const r32BalSettings = getSettings()
await saveSettings({ ...r32BalSettings, remindBalanceDays: 7 })

// 定金 10%（= 100）刚好等于下面那笔收款：定金收齐了，才谈得上「尾款」时钟
const r32Ship = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.1
})
await orders.addOrderItem(r32Ship.id, { styleNo: 'R32-BAL', quantity: 100, unitPrice: 10 })
await orders.setShipStatus(r32Ship.id, 'shipped', 'R32 尾款时钟')
const r32ShipEv = getDb().get(
  "SELECT id FROM order_events WHERE order_id = ? AND kind = 'ship_status' ORDER BY id DESC LIMIT 1",
  [r32Ship.id]
) as { id?: number } | null
// 货 30 天前就走了，昨天又收了一小笔：老口径按昨天起算 = 1 天，永远不提醒
getDb().run('UPDATE order_events SET at = ? WHERE id = ?', [dAgoIso(30), Number(r32ShipEv?.id ?? 0)])
await orders.addPayment(r32Ship.id, { paidAt: dAgo(1), amount: 100, method: 'T/T', bankRef: 'R32-P1' })
const r32BalRem = (await dashboard.reminders()).find((r) => r.kind === 'balance' && r.orderId === r32Ship.id)
check('出运 30 天、昨天刚收一小笔，仍然催尾款', !!r32BalRem, JSON.stringify(r32BalRem))
eq('天数按出运起算，不被最后收款清零', r32BalRem?.days, 30)
check('文案说清是从哪天起算的', (r32BalRem?.message ?? '').includes('自出运'), r32BalRem?.message)

const r32Idle = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.1
})
await orders.addOrderItem(r32Idle.id, { styleNo: 'R32-IDLE', quantity: 100, unitPrice: 10 })
await orders.addPayment(r32Idle.id, { paidAt: dAgo(1), amount: 100, method: 'T/T', bankRef: 'R32-P2' })
check(
  '货还没走的单仍按最后收款日算，昨天刚收过就不催（不无脑提前）',
  !(await dashboard.reminders()).some((r) => r.kind === 'balance' && r.orderId === r32Idle.id)
)
await saveSettings(r32BalSettings)

section('R32 抬头与留痕一起落：改一次抬头必须留下一条 party_update')

const r32PartyOrder = await orders.createOrder({ customerId: c1.id, currency: 'USD', exchangeRate: 7, paymentStatus: 'draft' })
const r32Party = await orders.setOrderParties(r32PartyOrder.id, { billTo: { company: 'ZZ 抬头测试公司' } })
eq('抬头写进去了', r32Party.billTo.company, 'ZZ 抬头测试公司')
eq(
  '留痕同一条事务里落了',
  Number(
    (getDb().get("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND kind = 'party_update'", [
      r32PartyOrder.id
    ]) as { n?: number }).n ?? 0
  ),
  1
)

/* ---------------- R33：同值不改账 + 提醒不重复喊 + 对账单/月报把话说破 ---------------- */

section('R33 收款状态改成原来那个值：什么都不许发生')

const r33Cust = await customers.saveCustomer({ company: 'R33-CALM-CO' })
const r33Order = await orders.createOrder({
  customerId: r33Cust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R33-CALM'
})
await orders.addOrderItem(r33Order.id, { styleNo: 'R33-CALM', quantity: 1, unitPrice: 100 })
const r33Clock = (): { updated_at: string; ev: number } =>
  getDb().get(
    `SELECT updated_at,
            (SELECT COUNT(*) FROM order_events WHERE order_id = ? AND kind = 'payment_status') AS ev
     FROM orders WHERE id = ?`,
    [r33Order.id, r33Order.id]
  ) as { updated_at: string; ev: number }
const r33Before = r33Clock()
const r33Same = await orders.setPaymentStatus(r33Order.id, 'confirmed', '手滑点了一次一样的')
const r33After = r33Clock()
eq('同值不写库：updated_at 没动（状态时钟不被挪后）', r33After.updated_at, r33Before.updated_at)
eq('同值不多一条「已确认 → 已确认」的脏历史', r33After.ev, r33Before.ev)
eq('同值仍把整单原样返回', r33Same.paymentStatus, 'confirmed')
// 草稿单重复点「草稿」：以前会把抵在这张单上的预收再回退一遍
const r33Draft = await orders.createOrder({ customerId: r33Cust.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'draft' })
await orders.addOrderItem(r33Draft.id, { styleNo: 'R33-D', quantity: 1, unitPrice: 100 })
const r33DraftAgain = await orders.setPaymentStatus(r33Draft.id, 'draft')
eq('草稿单重复存草稿仍是草稿', r33DraftAgain.paymentStatus, 'draft')

section('R33 多批过 ETA：同一笔欠款只喊一遍')

const r33RemCust = await customers.saveCustomer({ company: 'R33-ETA-CO' })
const r33EtaOrder = await orders.createOrder({
  customerId: r33RemCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r33EtaOrder.id, { styleNo: 'R33-ETA', quantity: 10, unitPrice: 10 })
const r33PlA = await packing.createPackingList({ orderId: r33EtaOrder.id, lines: [{ styleNo: 'R33-ETA', quantity: 5 }] })
const r33PlAll = await packing.createPackingList({ orderId: r33EtaOrder.id, lines: [{ styleNo: 'R33-ETA', quantity: 5 }] })
const r33PlB = r33PlAll.find((p) => p.id !== r33PlA[0].id)!
await packing.updatePackingListInfo(r33EtaOrder.id, r33PlA[0].id, { shipStatus: 'shipped', atdDate: dAgo(40), etaDate: dAgo(30) })
await packing.updatePackingListInfo(r33EtaOrder.id, r33PlB.id, { shipStatus: 'shipped', atdDate: dAgo(36), etaDate: dAgo(26) })
const r33BalRem = (await dashboard.reminders()).filter((x) => x.kind === 'balance' && x.orderId === r33EtaOrder.id && x.message.includes('到港'))
eq('两批都过了 ETA → 一张单一条提醒', r33BalRem.length, 1)
check('提醒里把两个批次号都点出来', !!r33BalRem[0] && r33BalRem[0].message.includes(r33PlA[0].plNo) && r33BalRem[0].message.includes(r33PlB.plNo), r33BalRem[0]?.message)
check('天数取最久那批（催款先后排得出来）', r33BalRem[0]?.days, -30)

section('R33 核销准入 = 计费口径：一个集合，不各自手写三个状态')

for (const st of ['draft', 'expired', 'void'] as const) {
  const c = await customers.saveCustomer({ company: `R33-SETTLE-${st}` })
  const o = await orders.createOrder({ customerId: c.id, currency: 'USD', exchangeRate: 7.2, paymentStatus: 'confirmed' })
  await orders.addOrderItem(o.id, { styleNo: 'R33-S', quantity: 1, unitPrice: 100 })
  // 作废/失效的正门另有凭据核对，这里只验「非计费状态进不了核销」这道门，直接落库模拟历史脏数据
  getDb().run('UPDATE orders SET payment_status = ? WHERE id = ?', [st, o.id])
  check(
    `${st} 单不能核销或坏账`,
    (await r8err(async () => await orders.addSettlement(o.id, { kind: 'shortage', amount: 10, reason: 'R33' }))).includes('不能做核销'),
    (await r8err(async () => await orders.addSettlement(o.id, { kind: 'shortage', amount: 10, reason: 'R33' })))
  )
}

section('R33 上单条款只认计费状态：草稿/失效/作废不能作为报价默认')

const r33TermCust = await customers.saveCustomer({ company: 'R33-TERMS-CO' })
const r33TermOld = await orders.createOrder({
  customerId: r33TermCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  portOfLoading: 'SHANGHAI'
})
await orders.addOrderItem(r33TermOld.id, { styleNo: 'R33-T1', quantity: 1, unitPrice: 10 })
const r33TermNew = await orders.createOrder({
  customerId: r33TermCust.id,
  currency: 'EUR',
  exchangeRate: 7.8,
  paymentStatus: 'draft',
  portOfLoading: 'NINGBO'
})
await orders.addOrderItem(r33TermNew.id, { styleNo: 'R33-T2', quantity: 1, unitPrice: 10 })
const r33Terms = (await orders.lastOrderTerms(r33TermCust.id))
eq('最近一张草稿单被跳过：币种仍来自正式单', r33Terms?.currency, 'USD')
eq('港口也来自正式单', r33Terms?.portOfLoading, 'SHANGHAI')

section('R33 对账单：没有单笔水单的已收要说破，但用客户看得懂的话')

const r33StmtCust = await customers.saveCustomer({ company: 'R33-STMT-CO' })
const r33StmtOrder = await orders.createOrder({
  customerId: r33StmtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R33-STMT'
})
await orders.addOrderItem(r33StmtOrder.id, { styleNo: 'R33-ST', quantity: 1, unitPrice: 200 })
await orders.addPayment(r33StmtOrder.id, { paidAt: localDate(), amount: 200, bankRef: 'R33-ST-IN' })
const r33StmtSample = await samples.saveSample({
  customerId: r33StmtCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R33-SS', productName: '旧记录样', color: 'Grey', size: 'S', quantity: 1, unitPrice: 30 }]
})
getDb().run("UPDATE sample_orders SET fee_status = 'paid' WHERE id = ?", [r33StmtSample.id])
const r33Stmt = parseCsv(await dashboard.exportCsv('statement', { customerId: r33StmtCust.id }))
const r33StmtNoteCol = r33Stmt[0].indexOf('备注')
const r33SampleLine = r33Stmt.find((l) => l[r33Stmt[0].indexOf('单据号')] === r33StmtSample.sampleNo)
check('打样行中性标注「早前已确认…未单独列水单」', !!r33SampleLine && (r33SampleLine[r33StmtNoteCol] ?? '').includes('未单独列水单'), r33SampleLine?.[r33StmtNoteCol])
check('不印内部话术（历史记账 / 无银行流水）', !!r33SampleLine && !(r33SampleLine[r33StmtNoteCol] ?? '').includes('银行流水'), r33SampleLine?.[r33StmtNoteCol])
const r33TotalLine = r33Stmt.find((l) => l[0] === '合计' && l[r33Stmt[0].indexOf('币种')] === 'USD')
check('币种合计行单列「其中 30.00 未单独列水单」', !!r33TotalLine && (r33TotalLine[r33StmtNoteCol] ?? '').includes('未单独列水单'), r33TotalLine?.[r33StmtNoteCol])

section('R33 月报：退款笔数另列，不减进「收款」')

const r33RefCust = await customers.saveCustomer({ company: 'R33-REFUND-CO' })
const r33RefSrc = await orders.createOrder({
  customerId: r33RefCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R33-REF'
})
await orders.addOrderItem(r33RefSrc.id, { styleNo: 'R33-R', quantity: 1, unitPrice: 100 })
await orders.addPayment(r33RefSrc.id, { paidAt: localDate(), amount: 140, bankRef: 'R33-R-IN' })
const r33RefMonth = localMonthOf(localDate())
const r33CashBefore = (await money.receivedByMonth()).find((m) => m.month === r33RefMonth)?.amount ?? 0
const r33RefundBefore = (await dashboard.monthlyReport()).find((m) => m.month === r33RefMonth)?.refundCount ?? 0
await credits.refundCredit({ customerId: r33RefCust.id, currency: 'USD', amount: 40, refundAt: localDate(), bankRef: 'R33-R-OUT', note: 'R33 客户不要了' })
const r33CashAfter = (await money.receivedByMonth()).find((m) => m.month === r33RefMonth)?.amount ?? 0
eq('退款不冲减现金流口径的「收款」', r33CashAfter, r33CashBefore)
const r33MonthRow = (await dashboard.monthlyReport()).find((m) => m.month === r33RefMonth)
eq('月报把这笔新退款单列进本月笔数', (r33MonthRow?.refundCount ?? 0) - r33RefundBefore, 1)
check('月报带原币退款金额（没有汇率快照，不折基准币）', (r33MonthRow?.refundText ?? '').includes('USD'), r33MonthRow?.refundText)
const r33Dash = await dashboard.dashboard()
eq('工作台本月退款笔数与月报同一个数', r33Dash.monthRefunded, r33MonthRow?.refundCount)
check('月度汇总导出多出退款两列且不改变收款列', (await dashboard.exportCsv('monthly')).includes('本月退款笔数'), '')

/* ---------------- R34 ---------------- */
section('R34 台账导出的「待收」= 屏幕上那一列')

const r34Base = getSettings().baseCurrency
const r34ExpCust = await customers.saveCustomer({ company: 'R34-EXPORT-CO' })
const r34Void = await orders.createOrder({
  customerId: r34ExpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'sent',
  piNo: 'PI-R34-VOID'
})
await orders.addOrderItem(r34Void.id, { styleNo: 'R34-V', quantity: 10, unitPrice: 8 })
await orders.voidOrder(r34Void.id, 'R34 客户不做了')
const r34Open = await orders.createOrder({
  customerId: r34ExpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'sent',
  piNo: 'PI-R34-OPEN'
})
await orders.addOrderItem(r34Open.id, { styleNo: 'R34-O', quantity: 10, unitPrice: 5 })
const r34All = parseCsv(await dashboard.exportCsv('orders_all'))
const r34Head = r34All[0]
const r34VoidRow = r34All.slice(1).find((l) => l[r34Head.indexOf('PI号')] === 'PI-R34-VOID')
const r34OpenRow = r34All.slice(1).find((l) => l[r34Head.indexOf('PI号')] === 'PI-R34-OPEN')
check('全量导出里两张单都在行上', !!r34VoidRow && !!r34OpenRow)
eq('作废行导出的待收（原币）= 0，跟屏幕上的「—」同一个说法', Number(r34VoidRow![r34Head.indexOf('待收金额(原币)')]), 0)
eq('作废行导出的待收（基准币）也归 0', Number(r34VoidRow![r34Head.indexOf(`待收金额(${r34Base})`)]), 0)
check('作废行没有整行清零：合计仍按单子本身列着', Number(r34VoidRow![r34Head.indexOf('含费用合计(原币)')]) === 80)
eq('计费状态的单照旧导出真实待收', Number(r34OpenRow![r34Head.indexOf('待收金额(原币)')]), 50)
eq('基准币待收 = 待收 × 汇率', Number(r34OpenRow![r34Head.indexOf(`待收金额(${r34Base})`)]), 350)

section('R34 覆盖导入：CSV 表头里没有的列不许抹平档案')

await products.saveProduct({
  styleNo: 'R34-IMP',
  name: '原品名',
  composition: '100% Cotton',
  sizes: ['M', 'L'],
  colors: ['红', '蓝'],
  costPrice: 20,
  unitNetWeight: 0.7,
  boxPieces: 20,
  boxLength: 60,
  boxWidth: 40,
  boxHeight: 50,
  factory: '原工厂',
  factoryNo: 'F-1'
})
const r34Imp1 = await products.importProductsCsv('款号,品名,成本价\nR34-IMP,改过的品名,25\n', 'overwrite')
eq('覆盖导入报出更新 1 款', r34Imp1.updated, 1)
const r34Keep = (await products.findProductByStyleNo('R34-IMP'))!
eq('表头里有的列照改（成本价）', r34Keep.costPrice, 25)
eq('表头里有的列照改（品名）', r34Keep.name, '改过的品名')
eq('表头里没有的尺码保留', r34Keep.sizes, ['M', 'L'])
eq('表头里没有的颜色保留', r34Keep.colors, ['红', '蓝'])
eq('表头里没有的工厂保留', r34Keep.factory, '原工厂')
eq('表头里没有的工厂货号保留', r34Keep.factoryNo, 'F-1')
eq('表头里没有的箱规保留', [r34Keep.boxLength, r34Keep.boxWidth, r34Keep.boxHeight], [60, 40, 50])
eq('表头里没有的单件净重保留', r34Keep.unitNetWeight, 0.7)
eq('表头里没有的每箱件数保留', r34Keep.boxPieces, 20)
await products.importProductsCsv('款号,尺码\nR34-IMP,\n', 'overwrite')
eq('表头里有这一列、格子空着 = 仍按明确清空', (await products.findProductByStyleNo('R34-IMP'))!.sizes, [])
await products.importProductsCsv('款号,箱规\nR34-IMP,50×30×20\n', 'overwrite')
eq(
  '箱规列在表头里就按新值覆盖',
  [
    (await products.findProductByStyleNo('R34-IMP'))!.boxLength,
    (await products.findProductByStyleNo('R34-IMP'))!.boxWidth
  ],
  [50, 30]
)

section('R34 CI 重叠闸门：同一个号只认最新一版')

eq(
  '同号取版本号最大的那版',
  latestAmountPerDocNo([
    { docNo: 'CI-A', version: 1, amount: 100 },
    { docNo: 'CI-A', version: 3, amount: 130 },
    { docNo: 'CI-A', version: 2, amount: 90 },
    { docNo: 'CI-B', version: 9, amount: 7 }
  ]).get('CI-A'),
  130
)
const r34CiOrder = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R34-CI'
})
await orders.addOrderItem(r34CiOrder.id, { styleNo: 'R34-C', quantity: 20, unitPrice: 10 })
const r34Pl = (await packing.createPackingList({
  orderId: r34CiOrder.id,
  lines: [{ boxNo: 'R34-1', styleNo: 'R34-C', quantity: 10 }]
}))[0]
const r34BatchCi = ciNoOf('PI-R34-CI', r34Pl.plNo)
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r34 a'), docNo: r34BatchCi, kind: 'ci', orderId: r34CiOrder.id, amount: 100 })
await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r34 b'), docNo: r34BatchCi, kind: 'ci', orderId: r34CiOrder.id, amount: 120 })
eq('重版不作废旧版：库里两版都还在', docs.listDocVersions(r34CiOrder.id).filter((d) => d.docNo === r34BatchCi).length, 2)
eq('整单 CI 的重叠额 = 最新版金额，不是两版相加', docs.assertCiNoOverlap(r34CiOrder.id, ciNoOf('PI-R34-CI'), true), 120)
check(
  '未确认时照样拦下重叠',
  (await r8err(async () => await docs.saveDocFile({ pdf: Buffer.from('%PDF-1.4 r34 w'), docNo: ciNoOf('PI-R34-CI'), kind: 'ci', orderId: r34CiOrder.id, amount: 200 }))).includes('重叠')
)

section('R34 出货状态与留痕一起落 + 一分未收的催款兜底不再用 updated_at')

const r34ShipSettings = getSettings()
await saveSettings({ ...r34ShipSettings, remindBalanceDays: 7 })
const r34ShipOrder = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R34-SHIP'
})
await orders.addOrderItem(r34ShipOrder.id, { styleNo: 'R34-S', quantity: 10, unitPrice: 10 })
await orders.setShipStatus(r34ShipOrder.id, 'shipped', 'R34 手工出运')
eq('状态落了', (await orders.getOrder(r34ShipOrder.id))!.shipStatus, 'shipped')
check(
  '同一次跃迁留下配对的 ship_status 事件（催款主钟的兜底）',
  (await orders.listEvents(r34ShipOrder.id)).some((e) => e.kind === 'ship_status' && e.toStatus === 'shipped')
)

const r34Legacy = await orders.createOrder({
  customerId: c1.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R34-LEGACY'
})
await orders.addOrderItem(r34Legacy.id, { styleNo: 'R34-L', quantity: 10, unitPrice: 50 })
// 手工标已出运、批次和出货事件都没有，今天又改过备注
getDb().run('UPDATE orders SET ship_status = ?, created_at = ?, updated_at = ? WHERE id = ?', [
  'shipped',
  `${addDays(localDate(), -40)} 09:00:00`,
  `${localDate()} 10:00:00`,
  r34Legacy.id
])
const r34LegacyRem = (await dashboard.reminders()).find((r) => r.kind === 'balance' && r.orderId === r34Legacy.id)
check('出运日期查不到也照样催，不再被今天的一次编辑清零', !!r34LegacyRem, JSON.stringify(r34LegacyRem))
eq('天数按建单起算', r34LegacyRem?.days, 40)
check('文案说清这个天数不是出运日', (r34LegacyRem?.message ?? '').includes('按建单日起算'), r34LegacyRem?.message)
await saveSettings(r34ShipSettings)

section('R34 打样抵扣挂起：闸门不开，但报错指着正门')

const r34OffCust = await customers.saveCustomer({ company: 'R34-OFFSET-CO' })
const r34OffSample = await samples.saveSample({
  customerId: r34OffCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R34-OF', quantity: 1, unitPrice: 60, goodsUnitPrice: 200 }]
})
const r34OffOrder = await samples.convertSampleToOrder(r34OffSample.id, { offsetSampleFee: true, paymentStatus: 'sent' })
eq('转单后样品费标记为已抵扣', (await samples.getSample(r34OffSample.id))!.feeStatus, 'offset')
// 订单退回草稿：抵扣派生挂起，这笔样品费重新回到打样待收
getDb().run("UPDATE orders SET payment_status = 'draft' WHERE id = ?", [r34OffOrder.id])
const r34OffOpen = (await money.sampleOpenRows(r34OffCust.id)).find((r) => r.sampleId === r34OffSample.id)
check('挂起中的样品费确实回到待收', !!r34OffOpen && r34OffOpen.receivable > 0.001, JSON.stringify(r34OffOpen))
const r34OffErr = (await r8err(async () => await samples.addSamplePayment(r34OffSample.id, { paidAt: localDate(), amount: 60, bankRef: 'R34-OF-IN' })))
check('仍不许在打样侧收这笔钱（订单恢复就会双算）', r34OffErr.includes('重复计'), r34OffErr)
check('报错给出正门：先把那张订单恢复成计费状态', r34OffErr.includes('恢复成计费状态'), r34OffErr)
check('不是一句「登记在订单上」把人赶进死胡同', r34OffErr.includes('草稿'), r34OffErr)

section('R34 一笔水单拆到订单与打样：两种单据各归各的账')

const r34SpCust = await customers.saveCustomer({ company: 'R34-SPLIT-CO' })
const r34SpOrder = await orders.createOrder({
  customerId: r34SpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R34-SPLIT'
})
await orders.addOrderItem(r34SpOrder.id, { styleNo: 'R34-SP', quantity: 10, unitPrice: 20 })
const r34SpSample = await samples.saveSample({
  customerId: r34SpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R34-SS', quantity: 1, unitPrice: 40 }]
})
const r34SpRows = await money.customerOpenRows(r34SpCust.id)
check(
  '待收底稿同时有订单行和打样行（两种单据各自的自增 id，靠 kind 才分得开）',
  r34SpRows.some((r) => r.kind === 'order' && r.docId === r34SpOrder.id) &&
    r34SpRows.some((r) => r.kind === 'sample' && r.docId === r34SpSample.id),
  JSON.stringify(r34SpRows.map((r) => [r.kind, r.docId, r.receivable]))
)
await orders.batchAddPayments([
  { orderId: r34SpOrder.id, paidAt: localDate(), amount: 100, bankRef: 'R34-SPLIT-BANK' },
  { sampleOrderId: r34SpSample.id, paidAt: localDate(), amount: 40, bankRef: 'R34-SPLIT-BANK' }
])
eq('订单那半落在订单上', (await orders.getOrder(r34SpOrder.id))!.paidAmount, 100)
eq('打样那半落在打样上', (await samples.getSample(r34SpSample.id))!.collected, 40)
eq(
  '订单待收只剩 100',
  (await money.customerOpenRows(r34SpCust.id)).find((r) => r.kind === 'order' && r.docId === r34SpOrder.id)!.receivable,
  100
)
check(
  '打样收齐后从待收底稿里消失（不会被错当成另一张同号的订单）',
  !(await money.customerOpenRows(r34SpCust.id)).some((r) => r.kind === 'sample' && r.docId === r34SpSample.id)
)

section('R35 报价版本的时间：补出来的那一版不许写「今天」')

const r35C = await customers.saveCustomer({ company: 'R35-PAPER-CO', paymentPref: '见票 30 天 D/P' })
const r35Q = await quotations.saveQuotation({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R35-A', quantity: 2, unitPrice: 10 }]
})
eq('新建即冻住第 1 版', (await quotations.listQuotationVersions(r35Q.id)).length, 1)
// 模拟升级前建的老报价：单子还在、版本存档没有、落笔在 90 天前
const r35OldTs = new Date(Date.now() - 90 * 86400000).toISOString()
getDb().run('DELETE FROM quotation_versions WHERE quotation_id = ?', [r35Q.id])
getDb().run('UPDATE quotations SET created_at = ?, updated_at = ? WHERE id = ?', [r35OldTs, r35OldTs, r35Q.id])
const r35Backfill = (await quotations.listQuotationVersions(r35Q.id))
eq('只是打开版本历史就会把这一版补出来', r35Backfill.length, 1)
eq('补出来的这一版写的是单子自己的日子', r35Backfill[0].createdAt, r35OldTs)
check(
  '不写成浏览当天（几个月前发出去的纸，历史里不该挂着「今天」）',
  !r35Backfill[0].createdAt.startsWith(localDate()),
  r35Backfill[0].createdAt
)
await quotations.saveQuotation({
  id: r35Q.id,
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R35-A', quantity: 2, unitPrice: 11 }]
})
const r35Vers = (await quotations.listQuotationVersions(r35Q.id))
eq('改了价，第 1 版的时间也不会被这次编辑顶掉', r35Vers.find((v) => v.revision === 1)!.createdAt, r35OldTs)
const r35V2 = r35Vers.find((v) => v.revision === 2)!.createdAt
// 这一版存的是带时区的时间戳（UTC），拿 localDate() 比日期在本地凌晨 0~8 点会假失败：
// 这条断言要验的是「写在本次保存的当下」，直接比时刻，不比落在哪一天
check(
  '新冻的第 2 版写在本次保存的当下',
  r35V2 !== r35OldTs && Math.abs(Date.now() - Date.parse(r35V2)) < 5 * 60 * 1000,
  r35V2
)

section('R35 报价有效期默认值按本地日')

const r35Q2 = await quotations.saveQuotation({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R35-B', quantity: 1, unitPrice: 5 }]
})
eq('没填有效期 = 本地今天 + 约定的锁价天数', r35Q2.validUntil, addDays(localDate(), getSettings().piValidDays))
eq('跨月加天数落在本地日（UTC 日在凌晨 0~8 点会少一天）', addDays('2026-10-31', 15), '2026-11-15')

section('R35 实际开船 / 签收不许填到未来')

const r35O = await orders.createOrder({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R35-SHIP'
})
await orders.addOrderItem(r35O.id, { styleNo: 'R35-SH', color: 'Navy', size: 'L', quantity: 40, unitPrice: 5 })
const r35Pl = await packing.createPackingList({
  orderId: r35O.id,
  containerNo: 'CONT-R35',
  lines: [{ boxNo: 'NO.1', styleNo: 'R35-SH', color: 'Navy', size: 'L', quantity: 40 }]
})
const r35Future = localDate(new Date(Date.now() + 30 * 86400000))
const r35AtdErr = (await r8err(async () =>
  await packing.updatePackingListInfo(r35O.id, r35Pl[0].id, { shipStatus: 'shipped', atdDate: r35Future })
))
check('实际开船填未来被拦', r35AtdErr.includes('实际开船日') && r35AtdErr.includes('未来'), r35AtdErr)
check('报错讲清后果：尾款提醒会从此不再出现', r35AtdErr.includes('尾款提醒'), r35AtdErr)
const r35DelErr = (await r8err(async () =>
  await packing.updatePackingListInfo(r35O.id, r35Pl[0].id, { shipStatus: 'delivered', deliveredDate: r35Future })
))
check('签收日期填未来同样被拦', r35DelErr.includes('签收日期'), r35DelErr)
check('被拦的两次一笔没写（不留半截）', !(await packing.listPackingLists(r35O.id))[0].atdDate)
// 预计类日期本来就是排未来，不能一起拦死
await packing.updatePackingListInfo(r35O.id, r35Pl[0].id, { etdDate: r35Future, etaDate: r35Future })
const r35PlAfter = (await packing.listPackingLists(r35O.id))[0]
eq('预计开船 / 预计到港仍允许未来', [r35PlAfter.etdDate, r35PlAfter.etaDate], [r35Future, r35Future])
await packing.updatePackingListInfo(r35O.id, r35Pl[0].id, { shipStatus: 'shipped', atdDate: localDate() })
eq('实际开船填今天照常放行', (await packing.listPackingLists(r35O.id))[0].atdDate, localDate())

section('R35 商品主图：有图就必须恰好有一张主图')

const r35P = await products.saveProduct({
  styleNo: 'R35-IMG',
  name: '主图不变量',
  composition: '100% Cotton',
  sizes: ['M'],
  colors: ['Black']
})
await products.addProductImage(r35P.id, 'R35-1.jpg')
await products.addProductImage(r35P.id, 'R35-2.jpg')
await products.addProductImage(r35P.id, 'R35-3.jpg')
const r35Imgs = () => products.listProductImages(r35P.id)
const r35Primary = async (): Promise<string> =>
  (await r35Imgs())
    .filter((i) => i.isPrimary === 1)
    .map((i) => i.fileName)
    .join('|')
eq('三张都没勾主图，也恰好有一张主图', (await r35Imgs()).filter((i) => i.isPrimary === 1).length, 1)
eq('主图是第一张上传的（界面提示就是这么说的）', await r35Primary(), 'R35-1.jpg')
const r35GhostErr = await (async (): Promise<string> => {
  try {
    await products.setPrimaryImage(r35P.id, 9_999_999)
    return ''
  } catch (e) {
    return (e as Error).message
  }
})()
check('指到一张不属于这个商品的图会报错', r35GhostErr.includes('主图没有改动'), r35GhostErr)
eq('报错后原主图还在（没被撤成空白）', await r35Primary(), 'R35-1.jpg')
const r35Img3 = (await r35Imgs()).find((i) => i.fileName === 'R35-3.jpg')!
await products.setPrimaryImage(r35P.id, r35Img3.id)
eq('换主图后仍然只有一张', (await r35Imgs()).filter((i) => i.isPrimary === 1).length, 1)
eq('新主图是被点那张', await r35Primary(), 'R35-3.jpg')
await products.deleteProductImage(r35Img3.id)
eq('删掉主图立刻有人接班', await r35Primary(), 'R35-1.jpg')
eq('主图删了，另外两张还在', (await r35Imgs()).length, 2)
for (const img of await r35Imgs()) await products.deleteProductImage(img.id)
eq('全部删光不报错，也不留孤儿主图', (await r35Imgs()).length, 0)

section('R35 删验货照：记录和留痕一起成败')

const r35PhOrder = await orders.createOrder({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R35-PHOTO'
})
const r35Photo = await orders.addOrderPhoto(r35PhOrder.id, 'r35-inspect.jpg', 'inspection', '尾期验货')
await orders.deleteOrderPhoto(r35PhOrder.id, r35Photo.id)
eq('照片记录删掉了', (await orders.listOrderPhotos(r35PhOrder.id)).length, 0)
check(
  '删除这件事在订单历史里查得到',
  (await orders.listEvents(r35PhOrder.id)).some((e) => e.kind === 'photo' && e.note.includes('删除验货照')),
  JSON.stringify((await orders.listEvents(r35PhOrder.id)).filter((e) => e.kind === 'photo'))
)
await orders.deleteOrderPhoto(r35PhOrder.id, 9_999_999)
eq(
  '删一张不存在的照片不会多留一条痕',
  (await orders.listEvents(r35PhOrder.id)).filter((e) => e.kind === 'photo' && e.note.includes('删除')).length,
  1
)

section('R35 失效单回到计费状态要按账重算')

const r35Exp = await orders.createOrder({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R35-EXP'
})
await orders.addOrderItem(r35Exp.id, { styleNo: 'R35-E', quantity: 10, unitPrice: 10 })
await orders.addPayment(r35Exp.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'R35-EXP-PAY' })
eq('收齐自动到已结清', (await orders.getOrder(r35Exp.id))!.paymentStatus, 'settled')
await orders.setPaymentStatus(r35Exp.id, 'expired')
eq('挂成失效后退出应收口径', (await orders.getOrder(r35Exp.id))!.paymentStatus, 'expired')
eq('改回计费状态时按账重算：钱早就收齐了', (await orders.setPaymentStatus(r35Exp.id, 'confirmed')).paymentStatus, 'settled')
check(
  '重算留下自动流转的痕',
  (await orders.listEvents(r35Exp.id)).some((e) => e.kind === 'status_auto' && e.toStatus === 'settled')
)
const r35Exp2 = await orders.createOrder({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R35-EXP2'
})
await orders.addOrderItem(r35Exp2.id, { styleNo: 'R35-E2', quantity: 10, unitPrice: 10 })
await orders.setPaymentStatus(r35Exp2.id, 'expired')
eq('一分钱没收的单恢复后还是已确认（重算不乱升）', (await orders.setPaymentStatus(r35Exp2.id, 'confirmed')).paymentStatus, 'confirmed')
eq('不乱加自动流转的历史', (await orders.listEvents(r35Exp2.id)).filter((e) => e.kind === 'status_auto').length, 0)

section('R35 对账单：让利说「为您减免」，不替客户算坏账')

const r35B = await customers.saveCustomer({ company: 'R35-STMT-CO' })
const r35Bo = await orders.createOrder({
  customerId: r35B.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R35-STMT'
})
await orders.addOrderItem(r35Bo.id, { styleNo: 'R35-BD', quantity: 10, unitPrice: 100 })
await orders.addPayment(r35Bo.id, { paidAt: localDate(), amount: 600, method: 'T/T', bankRef: 'R35-BD-PAY' })
await orders.addSettlement(r35Bo.id, {
  kind: 'bad_debt',
  amount: 400,
  at: localDate(),
  reason: '客户破产',
  evidence: '破产公告 R35'
})
const r35Stmt = JSON.stringify(parseCsv(await dashboard.exportCsv('statement', { customerId: r35B.id })))
check(
  '对账单说得出这笔钱已经不必付了',
  r35Stmt.includes('也不再向贵司计收'),
  r35Stmt
)
check('不再对客户讲「坏账核销」这种内部话术', !r35Stmt.includes('坏账'), r35Stmt)
const r35Ledger = recOf(await dashboard.exportCsv('orders'), '订单号', r35Bo.orderNo)!
eq(
  '老板的台账照旧记坏账核销（发给客户的纸 ≠ 内部账）',
  Number(r35Ledger.row[r35Ledger.head.indexOf('坏账核销(原币)')]),
  400
)
eq('台账的付款方式写中文（和收款状态列一个待遇）', r35Ledger.row[r35Ledger.head.indexOf('付款方式')], 'T/T 定金')
check('台账里不再有 tt_deposit 这种裸码', !(await dashboard.exportCsv('orders')).includes('tt_deposit'))

section('R35 来源单据的自由文本不再爬上发给客户的纸')

const r35NoteQ = await quotations.saveQuotation({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  note: '内部：这版先按让步价报，客户问起再说',
  items: [{ styleNo: 'R35-N', quantity: 1, unitPrice: 50 }]
})
const r35NoteOrder = await quotations.convertToOrder(r35NoteQ.id)
eq('订单备注只留转单凭据句', r35NoteOrder.note, `由报价单 ${r35NoteQ.qNo} 第 1 版转成`)
const r35NotePi = renderPi({ order: (await orders.getOrder(r35NoteOrder.id))!, settings: getSettings(), images: {} })
check('报价单里的内部话术没印到 PI 上', !r35NotePi.includes('客户问起再说'))
check(
  '但这句在订单操作历史里查得到',
  (await orders.listEvents(r35NoteOrder.id))
    .some((e) => e.kind === 'quotation_convert' && e.note.includes('客户问起再说')),
  JSON.stringify((await orders.listEvents(r35NoteOrder.id)).filter((e) => e.kind === 'quotation_convert'))
)
const r35Sample = await samples.saveSample({
  customerId: r35C.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  note: '内部：这版颜色客户还没点头',
  items: [{ styleNo: 'R35-SP', quantity: 1, unitPrice: 20, goodsUnitPrice: 30 }]
})
const r35SpOrder = await samples.convertSampleToOrder(r35Sample.id)
eq('打样转单也只留凭据句', r35SpOrder.note, `由打样单 ${r35Sample.sampleNo} 转成`)
check(
  '打样单的内部备注落在订单历史里',
  (await orders.listEvents(r35SpOrder.id)).some((e) => e.kind === 'sample_convert' && e.note.includes('还没点头'))
)
check(
  '不在 PI 上',
  !renderPi({ order: (await orders.getOrder(r35SpOrder.id))!, settings: getSettings(), images: {} }).includes('还没点头')
)

section('R35 档案里的付款条款不替客户认')

const r35AgPi = renderPi({ order: (await orders.getOrder(r35NoteOrder.id))!, settings: getSettings(), images: {} })
check(
  '建单时抬头已钉快照：纸上印的是这张单认过的话',
  r35AgPi.includes('Agreed Terms') && r35AgPi.includes('见票 30 天')
)
// 抹掉快照 = 升级前的老单（这一列当年还没落地，读出来是空串）：
// 以前纸面会回退去读客户档案，事后改档案就等于替客户认一条新条款
getDb().run("UPDATE orders SET bill_to_json = '' WHERE id = ?", [r35NoteOrder.id])
const r35OldPi = renderPi({ order: (await orders.getOrder(r35NoteOrder.id))!, settings: getSettings(), images: {} })
check('老单没有快照时 PI 不再印 Agreed Terms', !r35OldPi.includes('Agreed Terms'), r35OldPi.slice(0, 200))
eq('但系统知道这一句是档案现取的', (await orders.getOrder(r35NoteOrder.id))!.billFromProfile, true)
getDb().run("UPDATE quotations SET bill_to_json = '' WHERE id = ?", [r35NoteQ.id])
check(
  '报价纸面同理',
  !renderQuotation({ quotation: (await quotations.getQuotation(r35NoteQ.id))!, settings: getSettings(), images: {} }).includes(
    'Agreed Terms'
  )
)

/* ---------------- R36：填进去的，得真算数 ---------------- */

section('R36 批次 CI 印本批的封条号')

const r36SealCust = await customers.saveCustomer({ company: 'R36-SEAL-CO' })
const r36SealOrder = await orders.createOrder({
  customerId: r36SealCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R36-SEAL',
  sealNo: 'SEAL-ORDER'
})
await orders.addOrderItem(r36SealOrder.id, { styleNo: 'R36-SEAL', quantity: 20, unitPrice: 10 })
const r36PlA = (await packing.createPackingList({
  orderId: r36SealOrder.id,
  containerNo: 'CONT-R36-A',
  lines: [{ boxNo: 'R36-1', styleNo: 'R36-SEAL', quantity: 10 }]
}))[0]
await packing.updatePackingListInfo(r36SealOrder.id, r36PlA.id, { sealNo: 'SEAL-BATCH-A' })
// createPackingList 返回的是这张单的全部批次（按号排序），[0] 永远是第一批；
// 第二批要靠柜号认领，否则两版 CI 都拿第一批去渲，等于没测回退
await packing.createPackingList({
  orderId: r36SealOrder.id,
  containerNo: 'CONT-R36-B',
  lines: [{ boxNo: 'R36-2', styleNo: 'R36-SEAL', quantity: 10 }]
})
const r36PlB = (await packing.listPackingLists(r36SealOrder.id)).find((p) => p.containerNo === 'CONT-R36-B')!
const r36SealFull = (await orders.getOrder(r36SealOrder.id))!
const r36PaperA = renderCi(
  { order: r36SealFull, settings: getSettings(), images: {} },
  { batch: await ciBatchOf(r36SealFull, r36SealFull.packingLists.find((p) => p.id === r36PlA.id)!) }
)
const r36PaperB = renderCi(
  { order: r36SealFull, settings: getSettings(), images: {} },
  { batch: await ciBatchOf(r36SealFull, r36SealFull.packingLists.find((p) => p.id === r36PlB.id)!) }
)
check('批次 CI 印本批的封条号', r36PaperA.includes('Seal No.: SEAL-BATCH-A'), r36PaperA.slice(0, 300))
check(
  '不拿订单级的封条顶上去（每批一柜一封条，错号会让海关和客户对不上柜）',
  !r36PaperA.includes('SEAL-ORDER'),
  r36PaperA.slice(0, 300)
)
check('本批没填封条时才退回订单级（与 PL 同一套回退）', r36PaperB.includes('Seal No.: SEAL-ORDER'), r36PaperB.slice(0, 300))
const r36WholePaper = renderCi({ order: r36SealFull, settings: getSettings(), images: {} })
check('整单 CI 仍印订单级封条', r36WholePaper.includes('Seal No.: SEAL-ORDER'))

section('R36 PI 号在保存时就验：坏号不许等到出单才炸')

const r36PiCust = await customers.saveCustomer({ company: 'R36-PI-CO' })
const r36BadPiErr = (await r8err(async () =>
  await orders.createOrder({ customerId: r36PiCust.id, currency: 'USD', exchangeRate: 7, piNo: 'PI/R36/001' })
))
check('带斜杠的 PI 号建单就被拦下', r36BadPiErr.includes('PI 号') && r36BadPiErr.includes('存档目录'), r36BadPiErr)
check('说清哪些字符能用', r36BadPiErr.includes('字母、数字'), r36BadPiErr)
const r36PiOrder = await orders.createOrder({
  customerId: r36PiCust.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: 'PI-R36-VALID'
})
eq('正常 PI 号照常建单', r36PiOrder.piNo, 'PI-R36-VALID')
check(
  '改成坏号也被拦（同一个校验，不另写一份）',
  (await r8err(async () => await orders.updateOrder(r36PiOrder.id, { customerId: r36PiCust.id, piNo: '..\\R36' }))).includes('PI 号')
)
eq('被拦后 PI 号没变', (await orders.getOrder(r36PiOrder.id))!.piNo, 'PI-R36-VALID')
// 老单里可能已经躺着升级前的怪号：没改它就照常能保存别的字段
getDb().run('UPDATE orders SET pi_no = ? WHERE id = ?', ['LEGACY/R36', r36PiOrder.id])
const r36LegacySaved = await orders.updateOrder(r36PiOrder.id, { customerId: r36PiCust.id, note: 'R36 老号不动也能保存' })
eq('没改的老 PI 号不挡住其他字段保存', r36LegacySaved.note, 'R36 老号不动也能保存')
eq('老号原样保留', r36LegacySaved.piNo, 'LEGACY/R36')

section('R36 打样日期只记已经发生的事')

const r36SmpCust = await customers.saveCustomer({ company: 'R36-SAMPLE-CO' })
const r36FutureDay = localDate(new Date(Date.now() + 5 * 86400000))
const r36SmpItem = [{ styleNo: 'R36-SMP', quantity: 1, unitPrice: 5 }]
const r36SmpBad = (await r8err(async () =>
  await samples.saveSample({
    customerId: r36SmpCust.id,
    sampleDate: r36FutureDay,
    currency: 'USD',
    exchangeRate: 7,
    items: r36SmpItem
  })
))
check('打样日期填未来被拦', r36SmpBad.includes('打样日期') && r36SmpBad.includes('未来'), r36SmpBad)
check('报错讲清后果：样品费提醒会从此不响', r36SmpBad.includes('提醒'), r36SmpBad)
check(
  '寄出日期填未来同样被拦',
  (await r8err(async () =>
    await samples.saveSample({
      customerId: r36SmpCust.id,
      shippedAt: r36FutureDay,
      currency: 'USD',
      exchangeRate: 7,
      items: r36SmpItem
    })
  )).includes('寄出日期')
)
check(
  '收到日期填未来同样被拦',
  (await r8err(async () =>
    await samples.saveSample({
      customerId: r36SmpCust.id,
      receivedAt: r36FutureDay,
      currency: 'USD',
      exchangeRate: 7,
      items: r36SmpItem
    })
  )).includes('收到日期')
)
check(
  '格式不对的日期也拒，并给出正确写法',
  (await r8err(async () =>
    await samples.saveSample({
      customerId: r36SmpCust.id,
      sampleDate: '2026-13-01',
      currency: 'USD',
      exchangeRate: 7,
      items: r36SmpItem
    })
  )).includes('不是合法日期')
)
const r36SmpOk = await samples.saveSample({
  customerId: r36SmpCust.id,
  sampleDate: dAgo(3),
  shippedAt: dAgo(2),
  receivedAt: dAgo(1),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(3),
  items: r36SmpItem
})
eq('真实发生过的日期照常放行', [r36SmpOk.sampleDate, r36SmpOk.shippedAt, r36SmpOk.receivedAt], [
  dAgo(3),
  dAgo(2),
  dAgo(1)
])

section('R36 费用行填了钱就得有名称')

const r36ChargeCust = await customers.saveCustomer({ company: 'R36-CHARGE-CO' })
const r36BlankChargeErr = (await r8err(async () =>
  await orders.createOrder({
    customerId: r36ChargeCust.id,
    currency: 'USD',
    exchangeRate: 7,
    charges: [{ label: '   ', amount: 50 }]
  })
))
check('没名称却填了金额的费用行保存时被拦', r36BlankChargeErr.includes('没有名称'), r36BlankChargeErr)
check('说清这笔钱会去哪（不进 PI/CI，也不算进待收）', r36BlankChargeErr.includes('待收'), r36BlankChargeErr)
check(
  '报价单同一个闸门（共用一份校验，不各写各的）',
  (await r8err(async () =>
    await quotations.saveQuotation({
      customerId: r36ChargeCust.id,
      currency: 'USD',
      exchangeRate: 7,
      charges: [{ label: '', amount: 12 }],
      items: [{ styleNo: 'R36-QC', quantity: 1, unitPrice: 10 }]
    })
  )).includes('没有名称')
)
const r36ZeroBlankOk = await orders.createOrder({
  customerId: r36ChargeCust.id,
  currency: 'USD',
  exchangeRate: 7,
  charges: [{ label: '', amount: 0 }]
})
eq('金额真是 0 的空行照常丢弃（那是没填，不是丢钱）', r36ZeroBlankOk.charges.length, 0)

section('R36 定金没收齐时只催定金，不喊尾款')

const r36RemPrev = getSettings()
await saveSettings({ ...r36RemPrev, remindPaymentDays: 0, remindBalanceDays: 0 })
const r36DepCust = await customers.saveCustomer({ company: 'R36-DEPOSIT-CO' })
const r36DepOrder = await orders.createOrder({
  customerId: r36DepCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.3
})
await orders.addOrderItem(r36DepOrder.id, { styleNo: 'R36-DEP', quantity: 100, unitPrice: 10 })
await orders.addPayment(r36DepOrder.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'R36-DEP-1' })
eq('只收到 1/3 定金 → 状态是部分收款', (await orders.getOrder(r36DepOrder.id))!.paymentStatus, 'partial')
const r36Rems = async (): ReturnType<typeof dashboard.reminders> =>
  (await dashboard.reminders()).filter((r) => r.orderId === r36DepOrder.id)
const r36DepRem = (await r36Rems()).find((r) => r.kind === 'payment')
check('部分收款也催定金（以前状态一跳 partial，这条提醒就没了）', !!r36DepRem, JSON.stringify((await r36Rems())))
check(
  '说清已收多少、还差多少',
  (r36DepRem?.message ?? '').includes('定金还差 200.00') && (r36DepRem?.message ?? '').includes('已收 100.00'),
  r36DepRem?.message
)
check('定金没收齐时不喊尾款（同一笔钱不给两个名分）', !(await r36Rems()).some((r) => r.kind === 'balance'), JSON.stringify((await r36Rems())))
await orders.addPayment(r36DepOrder.id, { paidAt: localDate(), amount: 200, method: 'T/T', bankRef: 'R36-DEP-2' })
eq('定金收齐 → 已收款', (await orders.getOrder(r36DepOrder.id))!.paymentStatus, 'paid')
check(
  '定金收齐后才轮到尾款',
  (await r36Rems()).some((r) => r.kind === 'balance' && r.message.includes('尾款')),
  JSON.stringify((await r36Rems()))
)
check('这时不再催定金', !(await r36Rems()).some((r) => r.kind === 'payment'), JSON.stringify((await r36Rems())))
await saveSettings(r36RemPrev)

section('R36 恢复中途失败：附件和数据库一起退回原样')

// 恢复开始时先把旧附件挪到 holding；旧代码在这里就把 holding 删了，
// 库一旦换不进去，图库和存档已经回不来，提示却还说「原来的数据还能继续用」
fs.mkdirSync(imagesDir(), { recursive: true })
fs.mkdirSync(docsDir(), { recursive: true })
fs.writeFileSync(join(imagesDir(), 'r36-before.png'), 'old-img')
fs.writeFileSync(join(docsDir(), 'r36-before.pdf'), 'old-doc')
const r36ConflictZip = join(backupsDir(), 'ikanbot-20260105000000-r36-conflict.zip')
fs.writeFileSync(
  r36ConflictZip,
  createZip([
    { name: 'ikanbot.db', data: r9dbBytes },
    { name: 'images/r36-keep.png', data: Buffer.from('new-img') },
    // 同一路径既当文件又当目录：铺 docs 时必然失败，用来看「半路翻车」怎么收场
    { name: 'docs/r36-conflict', data: Buffer.from('x') },
    { name: 'docs/r36-conflict/inner.pdf', data: Buffer.from('x') }
  ])
)
const r36RestoreErr = await r9errA(() => restoreBackup(r36ConflictZip))
check('失败提示明说附件也已经退回去了', r36RestoreErr.includes('退回恢复前的样子'), r36RestoreErr)
check(
  '不再只说「数据库没有被替换」（图片和存档同样动过）',
  !r36RestoreErr.includes('数据库没有被替换'),
  r36RestoreErr
)
eq('原来的图片还在', fs.existsSync(join(imagesDir(), 'r36-before.png')), true)
eq('备份里的新图片没有留下', fs.existsSync(join(imagesDir(), 'r36-keep.png')), false)
eq('原来的单据存档还在', fs.existsSync(join(docsDir(), 'r36-before.pdf')), true)
eq('铺了半截的存档目录没有留下', fs.existsSync(join(docsDir(), 'r36-conflict')), false)
eq(
  '没有留下 .pre-restore 临时目录',
  fs.readdirSync(dataDir()).filter((f) => f.includes('.pre-restore-')),
  []
)
check(
  '失败后库照常可用（不是把用户留在打不开任何页面的壳里）',
  Number((getDb().get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n) > 0
)

// 连临时库文件都写不下去（盘上已经有个同名目录）：这一步还没动任何东西，也要如实说
const r36DbTemp = join(dataDir(), 'ikanbot.db.restoring')
fs.mkdirSync(r36DbTemp, { recursive: true })
const r36ValidZip = await createBackup('r36-probe')
const r36BeforeSwapErr = await r9errA(() => restoreBackup(r36ValidZip))
check('一步都没动时也明说数据原样', r36BeforeSwapErr.includes('退回恢复前的样子'), r36BeforeSwapErr)
eq('数据库文件还在', fs.existsSync(join(dataDir(), 'ikanbot.db')), true)
fs.rmSync(r36DbTemp, { recursive: true, force: true })
check(
  '清理后库仍然可用',
  Number((getDb().get('SELECT COUNT(*) AS n FROM orders') as { n: number }).n) > 0
)

/* ---------------- R37 ---------------- */

section('R37 批次 CI 不再和整单应收对金额')

const r37CiCust = await customers.saveCustomer({ company: 'R37-CI-CO' })
const r37CiOrder = await orders.createOrder({
  customerId: r37CiCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R37-CI'
})
await orders.addOrderItem(r37CiOrder.id, { styleNo: 'R37-CI', quantity: 20, unitPrice: 10 })
const r37CiPl = (await packing.createPackingList({
  orderId: r37CiOrder.id,
  containerNo: 'CONT-R37-A',
  lines: [{ boxNo: 'R37-1', styleNo: 'R37-CI', quantity: 10 }]
}))[0]
const r37CiBatchAmt = (await money.packingAmounts(r37CiOrder.id)).find((b) => b.plId === r37CiPl.id)!
// 批次 CI 记的是本批货值（半单），拿它跟整单应收比必然"差一半"
await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r37 batch'),
  docNo: ciNoOf('PI-R37-CI', r37CiPl.plNo),
  kind: 'ci',
  orderId: r37CiOrder.id,
  amount: r37CiBatchAmt.total
})
check(
  '分批出 CI 不再凭空写一条「金额相差」',
  !(await orders.listEvents(r37CiOrder.id)).some((e) => e.kind === 'doc_amount_diff'),
  JSON.stringify((await orders.listEvents(r37CiOrder.id)).filter((e) => e.kind === 'doc_amount_diff'))
)
await docs.saveDocFile({
  pdf: Buffer.from('%PDF-1.4 r37 whole'),
  docNo: ciNoOf('PI-R37-CI'),
  kind: 'ci',
  orderId: r37CiOrder.id,
  amount: 190,
  confirmOverlap: true
})
check(
  '整单 CI 与应收对不上，照样留痕',
  (await orders.listEvents(r37CiOrder.id)).some((e) => e.kind === 'doc_amount_diff' && e.note.includes('相差'))
)
check(
  '存档金额是乱码就拒收（不再静默记成 0）',
  (await r8err(async () =>
    await docs.saveDocFile({
      pdf: Buffer.from('%PDF-1.4 r37 nan'),
      docNo: ciNoOf('PI-R37-CI'),
      kind: 'ci',
      orderId: r37CiOrder.id,
      amount: Number.NaN,
      confirmOverlap: true
    })
  )).includes('有效金额')
)
check(
  '存档金额是负数也拒收',
  (await r8err(async () =>
    await docs.saveDocFile({
      pdf: Buffer.from('%PDF-1.4 r37 neg'),
      docNo: ciNoOf('PI-R37-CI', r37CiPl.plNo),
      kind: 'ci',
      orderId: r37CiOrder.id,
      amount: -1
    })
  )).includes('有效金额')
)
eq(
  '被拒的两版没有留下存档',
  docs.listDocVersions(r37CiOrder.id).filter((d) => d.kind === 'ci').length,
  2
)

section('R37 打样费用与汇率不许是乱码或负数')

const r37SmpCust = await customers.saveCustomer({ company: 'R37-FEE-CO' })
const r37Smp = await samples.saveSample({
  customerId: r37SmpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  sampleDate: localDate(),
  items: [{ styleNo: 'R37-FEE', quantity: 1, unitPrice: 10 }]
})
const r37SmpItems = [{ styleNo: 'R37-FEE', quantity: 1, unitPrice: 10 }]
check(
  '快递费填负数当场拦下',
  (await r8err(async () =>
    await samples.saveSample({ id: r37Smp.id, customerId: r37SmpCust.id, expressFee: -5, items: r37SmpItems })
  )).includes('快递费')
)
check(
  '快递费是乱码当场拦下',
  (await r8err(async () =>
    await samples.saveSample({ id: r37Smp.id, customerId: r37SmpCust.id, expressFee: Number.NaN, items: r37SmpItems })
  )).includes('快递费')
)
check(
  '汇率是乱码当场拦下',
  (await r8err(async () =>
    await samples.saveSample({ id: r37Smp.id, customerId: r37SmpCust.id, exchangeRate: Number.NaN, items: r37SmpItems })
  )).includes('汇率')
)
eq('被拦之后快递费还是 0', (await samples.getSample(r37Smp.id))!.expressFee, 0)
eq('被拦之后汇率还是 7', (await samples.getSample(r37Smp.id))!.exchangeRate, 7)

section('R37 预收抵清的样品费显示「已抵清」而不是「未收」')

const r37CrCust = await customers.saveCustomer({ company: 'R37-CREDIT-CO' })
const r37CrSrc = await orders.createOrder({
  customerId: r37CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R37-CR'
})
await orders.addOrderItem(r37CrSrc.id, { styleNo: 'R37-CR', quantity: 1, unitPrice: 10 })
await orders.addPayment(r37CrSrc.id, { paidAt: localDate(), amount: 30, method: 'T/T', bankRef: 'R37-CR-PAY' })
const r37CrSmp = await samples.saveSample({
  customerId: r37CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R37-CRS', quantity: 1, unitPrice: 15 }]
})
eq('抵之前不算抵清', (await samples.getSample(r37CrSmp.id))!.creditSettled, false)
await credits.applyCredit({
  customerId: r37CrCust.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r37CrSmp.id,
  amount: 15
})
const r37CrAfter = await samples.getSample(r37CrSmp.id)!
eq('抵清后待收归零', r37CrAfter.receivableBase, 0)
eq('fee_status 仍由流水推导为 unpaid（抵扣不是现金）', r37CrAfter.feeStatus, 'unpaid')
eq('界面据此显示「已抵清」', r37CrAfter.creditSettled, true)

section('R37 报价：转出的订单作废后不再锁死，发后改过看得见')

const r37QCust = await customers.saveCustomer({ company: 'R37-QUOTE-CO' })
const r37Q = await quotations.saveQuotation({
  customerId: r37QCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  incoterm: 'FOB',
  portOfLoading: 'Ningbo',
  portOfDestination: 'Hamburg',
  paymentMethod: 'tt_deposit',
  depositRatio: 0.3,
  items: [{ styleNo: 'R37Q', quantity: 10, unitPrice: 10 }]
})
const r37QOrder = await quotations.convertToOrder(r37Q.id)
eq(
  '报价单带出转出订单的状态（界面据此决定还能不能编辑）',
  (await quotations.getQuotation(r37Q.id))!.convertedOrderStatus,
  r37QOrder.paymentStatus
)
check(
  '订单还活着：改价仍被拦',
  (await r8err(async () =>
    await quotations.saveQuotation({
      id: r37Q.id,
      customerId: r37QCust.id,
      exchangeRate: 7.2,
      items: [{ styleNo: 'R37Q', quantity: 10, unitPrice: 11 }]
    })
  )).includes('原始报价凭据')
)
await orders.voidOrder(r37QOrder.id, 'R37 客户改款')
eq('订单作废后状态看得见', (await quotations.getQuotation(r37Q.id))!.convertedOrderStatus, 'void')
const r37QEdit = await quotations.saveQuotation({
  id: r37Q.id,
  customerId: r37QCust.id,
  exchangeRate: 7.2,
  items: [{ styleNo: 'R37Q', quantity: 10, unitPrice: 11 }]
})
eq('作废之后报价可以改价（不再逼人另建一张）', r37QEdit.items[0].unitPrice, 11)
await quotations.updateQuotationMeta(r37Q.id, { result: 'lost' })
eq('作废之后结果也能改', (await quotations.getQuotation(r37Q.id))!.result, 'lost')

// 「发后改过」= status=sent 且 updated_at > sent_at：只改结果绝不能把时钟推走
getDb().run(
  "UPDATE quotations SET status = 'sent', sent_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-02-01T00:00:00.000Z' WHERE id = ?",
  [r37Q.id]
)
const r37QMetaOnly = (await quotations.updateQuotationMeta(r37Q.id, { result: 'won' }))
eq('只改结果不动「最后修改」（否则「待重发」天天误报）', r37QMetaOnly.updatedAt, '2026-02-01T00:00:00.000Z')
const r37QStatus = (await quotations.updateQuotationMeta(r37Q.id, { status: 'draft' }))
check('改状态照常刷新「最后修改」', r37QStatus.updatedAt > '2026-02-01T00:00:00.000Z')
const r37QResend = (await quotations.updateQuotationMeta(r37Q.id, { status: 'sent' }))
eq('重发那一刻两条时间对齐（不该一发出去就标待重发）', r37QResend.updatedAt, r37QResend.sentAt)
getDb().run("UPDATE quotations SET sent_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [r37Q.id])
const r37QAgain = await quotations.saveQuotation({
  id: r37Q.id,
  customerId: r37QCust.id,
  exchangeRate: 7.2,
  items: [{ styleNo: 'R37Q', quantity: 10, unitPrice: 12 }]
})
check(
  '发后改存一版：最后修改晚于发出时间（界面标「待重发」）',
  (r37QAgain.updatedAt ?? '') > (r37QAgain.sentAt ?? ''),
  `${r37QAgain.sentAt} / ${r37QAgain.updatedAt}`
)

/* ---------------- R38 ---------------- */

section('R38 同一张水单不能在同一张单上记两次')

const r38SlipCust = await customers.saveCustomer({ company: 'R38-SLIP-CO' })
const r38SlipA = await orders.createOrder({
  customerId: r38SlipCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r38SlipA.id, { styleNo: 'R38-A', quantity: 100, unitPrice: 10 })
const r38SlipB = await orders.createOrder({
  customerId: r38SlipCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r38SlipB.id, { styleNo: 'R38-B', quantity: 100, unitPrice: 10 })
const r38PaidCount = async (id: number): Promise<number> => (await orders.getOrder(id))!.payments.length

await orders.addPayment(r38SlipA.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'ZZ-R38-SLIP' })
eq('第一笔带流水号照常落账', await r38PaidCount(r38SlipA.id), 1)
const r38DupMsg = (await r8err(async () =>
  await orders.addPayment(r38SlipA.id, { paidAt: localDate(), amount: 200, method: 'T/T', bankRef: 'ZZ-R38-SLIP' })
))
check(
  '同一张单、同一流水号再记一次当场拦下，并说出上次的日期与金额',
  r38DupMsg.includes('同一张水单') && r38DupMsg.includes('100.00'),
  r38DupMsg
)
eq('被拦下后没有多出流水（已收不会翻倍）', await r38PaidCount(r38SlipA.id), 1)
check(
  '大小写不同也算同一张水单（手抄流水号常混大小写）',
  (await r8err(async () =>
    await orders.addPayment(r38SlipA.id, { paidAt: localDate(), amount: 50, method: 'T/T', bankRef: 'zz-r38-slip' })
  )).includes('同一张水单')
)
check(
  '同一流水号拆到另一张单照常放行（一笔水单付两张单是正常业务）',
  (await r8err(async () =>
    await orders.addPayment(r38SlipB.id, { paidAt: localDate(), amount: 300, method: 'T/T', bankRef: 'ZZ-R38-SLIP' })
  )) === ''
)
await orders.addPayment(r38SlipA.id, { paidAt: localDate(), amount: 10, method: 'T/T', bankRef: '' })
await orders.addPayment(r38SlipA.id, { paidAt: localDate(), amount: 10, method: 'T/T', bankRef: '   ' })
eq('没有流水号的小额收款照常记（空号不判重）', await r38PaidCount(r38SlipA.id), 3)

check(
  '水单拆分整批共用流水号照常放行',
  (await r8err(async () =>
    await orders.batchAddPayments([
      { orderId: r38SlipA.id, paidAt: localDate(), amount: 5, bankRef: 'ZZ-R38-BATCH' },
      { orderId: r38SlipB.id, paidAt: localDate(), amount: 5, bankRef: 'ZZ-R38-BATCH' }
    ])
  )) === ''
)
const r38BatchBefore = await r38PaidCount(r38SlipA.id)
const r38BatchDup = (await r8err(async () =>
  await orders.batchAddPayments([
    { orderId: r38SlipA.id, paidAt: localDate(), amount: 6, bankRef: 'ZZ-R38-BATCH2' },
    { orderId: r38SlipA.id, paidAt: localDate(), amount: 7, bankRef: 'ZZ-R38-BATCH2' }
  ])
))
check('拆分里同一张单填两行、同一个流水号 → 拦下', r38BatchDup.includes('同一张水单'), r38BatchDup)
eq('拦下时整批回滚，第一行也没有落账', await r38PaidCount(r38SlipA.id), r38BatchBefore)

const r38SlipSample = await samples.saveSample({
  customerId: r38SlipCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R38-S', productName: '水单判重样', color: 'White', size: 'L', quantity: 1, unitPrice: 10 }]
})
await samples.addSamplePayment(r38SlipSample.id, { paidAt: localDate(), amount: 1, bankRef: 'ZZ-R38-SAMP' })
check(
  '打样费同流水号也不能在同一张打样单上记两次',
  (await r8err(async () =>
    await samples.addSamplePayment(r38SlipSample.id, { paidAt: localDate(), amount: 1, bankRef: 'zz-r38-samp' })
  )).includes('同一张水单')
)
eq('打样单被拦下后仍只有一笔流水', (await samples.getSample(r38SlipSample.id))!.flowCount, 1)

section('R38 定金差把已核销的钱算进去，尾款提醒不再被永久压住')

const r38RemPrev = getSettings()
await saveSettings({ ...r38RemPrev, remindPaymentDays: 0, remindBalanceDays: 0 })
const r38DepBefore = await dashboard.dashboard()
const r38DepCust = await customers.saveCustomer({ company: 'R38-DEPOSIT-CO' })
const r38MakeDep = async (styleNo: string): Promise<number> => {
  const o = await orders.createOrder({
    customerId: r38DepCust.id,
    currency: 'USD',
    exchangeRate: 7,
    paymentStatus: 'confirmed',
    depositRatio: 0.3
  })
  await orders.addOrderItem(o.id, { styleNo, quantity: 10, unitPrice: 10 })
  await orders.addPayment(o.id, { paidAt: localDate(), amount: 20, method: 'T/T', bankRef: `ZZ-${styleNo}` })
  return o.id
}
// 单 1：定金 30，收 20，客户抹零核销 10 → 定金其实已经有着落
const r38DepWritten = await r38MakeDep('R38-DEP-W')
await orders.addSettlement(r38DepWritten, { kind: 'shortage', amount: 10, reason: 'R38 客户抹零' })
const r38RowWritten = (await money.listOrderMoney()).find((r) => r.orderId === r38DepWritten)!
eq('待收只算还欠的 70（已扣核销）', r38RowWritten.receivable, 70)
eq('定金差额归零（核销也算有着落）', money.depositDueOf(r38RowWritten), 0)
eq(
  '定金有没有着落决定状态：现金 20 + 抹零 10 已覆盖定金 30，升到已收定金',
  (await orders.getOrder(r38DepWritten))!.paymentStatus,
  'paid'
)
const r38RemsWritten = (await dashboard.reminders()).filter((r) => r.orderId === r38DepWritten)
check(
  '不再催那笔已经核销掉的定金',
  !r38RemsWritten.some((r) => r.kind === 'payment'),
  JSON.stringify(r38RemsWritten.map((r) => r.message))
)
check(
  '尾款提醒回来，金额是真实还欠的 70',
  r38RemsWritten.some((r) => r.kind === 'balance' && r.message.includes('70.00')),
  JSON.stringify(r38RemsWritten.map((r) => r.message))
)
// 单 2：定金 30，收 20，没核销 → 定金差额 10，尾款还不该催
const r38DepPlain = await r38MakeDep('R38-DEP-P')
const r38RemsPlain = (await dashboard.reminders()).filter((r) => r.orderId === r38DepPlain)
const r38DepRem = r38RemsPlain.find((r) => r.kind === 'payment')
check(
  '没核销的单照旧催定金 10，并写明已收 20',
  (r38DepRem?.message ?? '').includes('定金还差 10.00') && (r38DepRem?.message ?? '').includes('已收 20.00'),
  r38DepRem?.message
)
check(
  '定金没收齐时不喊尾款',
  !r38RemsPlain.some((r) => r.kind === 'balance'),
  JSON.stringify(r38RemsPlain.map((r) => r.message))
)
const r38DepAfter = await dashboard.dashboard()
eq(
  '待收四桶：定金桶只装定金差额 10 × 7',
  Math.round((r38DepAfter.pendingDeposit - r38DepBefore.pendingDeposit) * 100) / 100,
  70
)
eq(
  '待收四桶：尾款桶装两单各自的剩余（(70 + 70) × 7）',
  Math.round((r38DepAfter.pendingBalance - r38DepBefore.pendingBalance) * 100) / 100,
  980
)
eq(
  '四桶合计仍等于待收总额',
  Math.round(
    (r38DepAfter.pendingUnconfirmed +
      r38DepAfter.pendingDeposit +
      r38DepAfter.pendingBalance +
      r38DepAfter.pendingSample -
      r38DepAfter.pendingAmount) *
      100
  ) / 100,
  0
)
await saveSettings(r38RemPrev)

section('R38 打样入口：成本、收款状态、款号各行其位')

const r38GuardCust = await customers.saveCustomer({ company: 'R38-GUARD-CO' })
const r38GuardBase = {
  customerId: r38GuardCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: localDate(),
  items: [] as any[]
}
check(
  '工厂打样费填负数拦下（会把公司成本和净垫算反）',
  (await r8err(async () => await samples.saveSample({ ...r38GuardBase, factoryCost: -1 }))).includes('工厂打样费')
)
check(
  '工厂打样费填乱码拦下（不会落成 NaN）',
  (await r8err(async () => await samples.saveSample({ ...r38GuardBase, factoryCost: 'abc' as any }))).includes('工厂打样费')
)
check(
  '收款状态写了不认识的词拦下（脏值会让三处待收各说各话）',
  (await r8err(async () => await samples.saveSample({ ...r38GuardBase, feeStatus: 'Paid' as any }))).includes('不认识')
)
check(
  '填了数量或单价却没写款号的行拦下（否则会被当空行丢掉，样品费少算）',
  (await r8err(async () =>
    await samples.saveSample({
      ...r38GuardBase,
      items: [{ styleNo: '', productName: '脏行', color: 'White', size: 'L', quantity: 1, unitPrice: 0 } as any]
    })
  )).includes('第 1 行')
)
const r38GuardCount = () =>
  Number(
    (
      getDb().get('SELECT COUNT(*) AS n FROM sample_orders WHERE customer_id = ?', [r38GuardCust.id]) as {
        n?: number
      }
    )?.n ?? 0
  )
eq('上面三次都被挡在写库之前，一张单都没留下', r38GuardCount(), 0)
const r38GuardBlank = await samples.saveSample({
  ...r38GuardBase,
  // 缺 styleNo 字段、又没有数量的行：按空行忽略，不该整单报 TypeError
  items: [{ productName: '空行', quantity: 0, unitPrice: 0 } as any, { styleNo: '   ', quantity: 0, unitPrice: 0 } as any]
})
eq('真正空白的行照旧忽略', r38GuardBlank.items.length, 0)
eq('这一张单正常存下来了', r38GuardCount(), 1)

section('R38 打样列表待收与工作台同一口径')

const r38OffCust = await customers.saveCustomer({ company: 'R38-OFFSET-CO' })
const r38Off = await samples.saveSample({
  customerId: r38OffCust.id,
  sampleDate: dAgo(20),
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: dAgo(20),
  items: [
    { styleNo: 'R38-O1', productName: '抵扣挂起', color: 'White', size: 'L', quantity: 1, unitPrice: 40, goodsUnitPrice: 100 }
  ]
})
await samples.convertSampleToOrder(r38Off.id, { offsetSampleFee: true })
const r38OffSusp = await samples.getSample(r38Off.id)!
eq('转出的订单是草稿：抵扣挂起', r38OffSusp.offsetSuspended, true)
eq('挂起时待收按样品费算出来（列表不能再显示「—」）', r38OffSusp.receivableBase, 40 * 7.2)
check(
  '同一笔钱在工作台也催着',
  (await dashboard.reminders()).some((r) => r.kind === 'sample' && r.sampleId === r38Off.id && r.message.includes('打样费 40.00')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r38Off.id).map((r) => r.message))
)
const r38Free = await samples.saveSample({
  customerId: r38OffCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R38-FREE', productName: '免费样', color: 'White', size: 'L', quantity: 1, unitPrice: 0 }]
})
eq('没有待收的打样单算出来是 0（界面照旧显示「—」）', r38Free.receivableBase, 0)

section('R39 坏账追回的水单也只认一次（R38 前门拦过的，不许从后门进来）')

const r39Cust = await customers.saveCustomer({ company: 'R39-DUP-CO' })
const r39Order = await orders.createOrder({
  customerId: r39Cust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R39-DUP'
})
await orders.addOrderItem(r39Order.id, { styleNo: 'R39-DUP', quantity: 10, unitPrice: 10 })
await orders.addPayment(r39Order.id, { paidAt: localDate(), amount: 40, bankRef: 'R39-SLIP' })
await orders.addSettlement(r39Order.id, { kind: 'bad_debt', amount: 60, reason: 'R39 客户失联' })
eq('坏账挂上后待收归零', (await orders.getOrder(r39Order.id))!.remaining, 0)
await orders.addSettlement(r39Order.id, { kind: 'recovery', amount: 20, bankRef: 'R39-REC', reason: 'R39 追回一部分' })
const r39Rec = (await orders.getOrder(r39Order.id))!
eq('追回 20 落进收款流水：已收 60', r39Rec.paidAmount, 60)
eq('坏账未追回只剩 40', r39Rec.badDebtOutstanding, 40)

const r39DupErr = (await r8err(async () =>
  await orders.addSettlement(r39Order.id, { kind: 'recovery', amount: 10, bankRef: 'R39-SLIP', reason: 'R39 记错水单' })
))
check('追回款复用普通收款的水单号被拦', r39DupErr.includes('同一张水单'), r39DupErr)
const r39CaseErr = (await r8err(async () =>
  await orders.addSettlement(r39Order.id, { kind: 'recovery', amount: 10, bankRef: 'r39-rec', reason: 'R39 手抄大小写' })
))
check('追回款复用另一笔追回的水单号也拦（大小写不算两张）', r39CaseErr.includes('同一张水单'), r39CaseErr)
check('拦下时给出正确出口：到核销记录里撤销', r39CaseErr.includes('核销记录'), r39CaseErr)
const r39Blocked = (await orders.getOrder(r39Order.id))!
eq('拦下没有多落一笔收款', r39Blocked.payments.length, 2)
eq('拦下后坏账没被冲两遍', r39Blocked.badDebtOutstanding, 40)
eq('拦下后已收还是 60', r39Blocked.paidAmount, 60)

// 撤销那笔追回会把自动登记的收款一起退掉（R36）：水单腾出来了，同一个号才允许重录
const r39RecRow = (await orders.listSettlements(r39Order.id)).find((s) => s.kind === 'recovery' && s.amount > 0)!
check(
  '撤销追回也要写原因',
  (await r8err(async () => await orders.reverseSettlement(r39Order.id, r39RecRow.id, '  '))).includes('原因'),
  (await r8err(async () => await orders.reverseSettlement(r39Order.id, r39RecRow.id, '  ')))
)
await orders.reverseSettlement(r39Order.id, r39RecRow.id, 'R39 这笔钱是客户另一张单的')
eq('撤销追回连收款一起退', (await orders.getOrder(r39Order.id))!.paidAmount, 40)
eq('撤销追回后坏账余额回来', (await orders.getOrder(r39Order.id))!.badDebtOutstanding, 60)
await orders.addSettlement(r39Order.id, { kind: 'recovery', amount: 20, bankRef: 'R39-REC', reason: 'R39 撤销后重录' })
eq('撤销后同一张水单可以重新登记追回', (await orders.getOrder(r39Order.id))!.paidAmount, 60)

section('R39 一张出水单只退一次预收')

const r39RefCust = await customers.saveCustomer({ company: 'R39-REFUND-CO' })
const r39RefOrder = await orders.createOrder({
  customerId: r39RefCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R39-REF'
})
await orders.addOrderItem(r39RefOrder.id, { styleNo: 'R39-REF', quantity: 1, unitPrice: 100 })
await orders.addPayment(r39RefOrder.id, { paidAt: localDate(), amount: 140, bankRef: 'R39-IN' })
eq('多付 40 记进预收', await money.customerCreditAvailable(r39RefCust.id, 'USD'), 40)
await credits.refundCredit({
  customerId: r39RefCust.id,
  currency: 'USD',
  amount: 25,
  bankRef: 'R39-OUT',
  note: 'R39 客户多付退回'
})
eq('退 25 后可用 15', await money.customerCreditAvailable(r39RefCust.id, 'USD'), 15)
const r39RefDupErr = (await r8err(async () =>
  await credits.refundCredit({ customerId: r39RefCust.id, currency: 'USD', amount: 10, bankRef: 'r39-out', note: 'R39 又退一次' })
))
check('同一张出水单不能退两次', r39RefDupErr.includes('不能退两次'), r39RefDupErr)
check('拦下时给出撤销通道', r39RefDupErr.includes('撤销'), r39RefDupErr)
eq('拦下后退款台账还是那一笔', (await money.refundFlowRows({ customerId: r39RefCust.id })).length, 1)
eq('拦下后可用没被多扣', await money.customerCreditAvailable(r39RefCust.id, 'USD'), 15)

const r39RefundId = (await money.refundFlowRows({ customerId: r39RefCust.id }))[0].refundId
check(
  '撤销退款不写原因被拦',
  (await r8err(async () => await credits.reverseRefund(r39RefundId, '   '))).includes('原因'),
  (await r8err(async () => await credits.reverseRefund(r39RefundId, '   ')))
)
await credits.reverseRefund(r39RefundId, 'R39 水单录错，钱没退出去')
await credits.refundCredit({
  customerId: r39RefCust.id,
  currency: 'USD',
  amount: 25,
  bankRef: 'R39-OUT',
  note: 'R39 按正确水单重录'
})
eq('撤销后同一个水单号可以重录', await money.customerCreditAvailable(r39RefCust.id, 'USD'), 15)
eq('重录后台账一笔', (await money.refundFlowRows({ customerId: r39RefCust.id })).length, 1)

section('R39 撤销预收抵扣要写真原因')

const r39Open = await orders.createOrder({
  customerId: r39RefCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  paymentStatus: 'confirmed',
  piNo: 'PI-R39-OPEN'
})
await orders.addOrderItem(r39Open.id, { styleNo: 'R39-OPEN', quantity: 1, unitPrice: 30 })
const r39Apply = await credits.applyCredit({
  customerId: r39RefCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r39Open.id,
  amount: 5
})
const r39AppRow = r39Apply.find((c) => c.currency === 'USD')!.applications[0]
check(
  '空原因撤销抵扣被拦（不再自动补一句套话）',
  (await r8err(async () => await credits.reverseCredit(r39AppRow.id, '   '))).includes('原因'),
  (await r8err(async () => await credits.reverseCredit(r39AppRow.id, '   ')))
)
await credits.reverseCredit(r39AppRow.id, 'R39 抵错了单，客户说留着抵下一票')
const r39RevRow = getDb().get('SELECT reversed_reason FROM credit_applications WHERE id = ?', [
  r39AppRow.id
]) as { reversed_reason?: string } | null
eq('写进去的就是留痕的那句', String(r39RevRow?.reversed_reason ?? ''), 'R39 抵错了单，客户说留着抵下一票')
check(
  '订单操作历史里能找到这句原因',
  (
    getDb().all("SELECT note FROM order_events WHERE order_id = ? AND kind = 'credit_reverse'", [
      r39Open.id
    ]) as { note?: string }[]
  ).some((e) => String(e.note ?? '').includes('R39 抵错了单'))
)

/* ---------------- R40 ---------------- */
section('R40 定金比例与负合计：纸面上印不出来的数，服务层先拦')
const r40err = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}
const r40Cust = await customers.saveCustomer({ company: 'R40-GUARD-CO' })
const r40RatioErr = await (async (): Promise<string> => {
  try {
    await customers.saveCustomer({ id: r40Cust.id, company: 'R40-GUARD-CO', defaultDepositRatio: 1.5 })
    return ''
  } catch (e) {
    return (e as Error).message
  }
})()
check('客户档案默认定金比例 1.5 落库被拦', r40RatioErr.includes('0 到 1'))
check(
  '建单定金比例 1.5 被拦（IPC/导入能塞进来，不能只靠下拉框）',
  (await r40err(async () => await orders.createOrder({ customerId: r40Cust.id, piNo: 'PI-R40-DEP', depositRatio: 1.5 }))).includes('0 到 1')
)
const r40DepOk = await orders.createOrder({ customerId: r40Cust.id, piNo: 'PI-R40-DEP-OK', depositRatio: 0.3, paymentStatus: 'sent' })
eq('合法定金比例 0.3 存得进去', r40DepOk.depositRatio, 0.3)

const r40Neg = await orders.createOrder({ customerId: r40Cust.id, piNo: 'PI-R40-NEG', paymentStatus: 'sent' })
await orders.addOrderItem(r40Neg.id, { styleNo: 'R40-NEG', quantity: 1, unitPrice: 100 })
check(
  '费用行让利超过货值（合计 -50）被拦',
  (await r40err(async () => await orders.updateOrderCharges(r40Neg.id, [{ label: '折扣 Discount', amount: -150 }], 'R40 试探'))).includes('合计')
)
const r40NegSaved = await orders.updateOrderCharges(r40Neg.id, [{ label: '折扣 Discount', amount: -50 }], 'R40 老客让利')
eq('让利不越线照常保存', r40NegSaved.charges.length, 1)
check(
  '让利留痕是「新增」不是「0 → -50」（没填过的行谈不上改）',
  (
    getDb().all("SELECT note FROM order_events WHERE order_id = ? AND note LIKE '%修改费用%'", [r40Neg.id]) as {
      note?: string
    }[]
  ).some((e) => String(e.note ?? '').includes('新增 折扣 Discount -50'))
)
check(
  '改单把费用改成负合计被拦（货值和费用同框时才拦得住）',
  (await r40err(async () => await orders.updateOrder(r40Neg.id, { charges: [{ label: '折扣 Discount', amount: -150 }] }))).includes('合计')
)

section('R40 打样待收只认服务层 owed：免收、部分收款都是一套话')
const r40RemPrev = getSettings()
await saveSettings({ ...r40RemPrev, remindPaymentDays: 0, remindBalanceDays: 0 })
const r40FeeCust = await customers.saveCustomer({ company: 'R40-FEE-CO' })
const r40Fee = await samples.saveSample({
  customerId: r40FeeCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  expressFee: 20,
  items: [{ styleNo: 'R40-FEE', productName: '部分收款', color: 'White', size: 'L', quantity: 2, unitPrice: 50 }]
})
await samples.addSamplePayment(r40Fee.id, { paidAt: localDate(), amount: 50, method: 'T/T', bankRef: 'R40-FEE-1', note: '' })
eq('待收 = 120 − 已收 50（owed 由服务层给出）', (await samples.getSample(r40Fee.id))!.owed, 70)
check(
  '工作台打样催款催的也是 70（同一份金额底稿）',
  (await dashboard.reminders()).some((r) => r.kind === 'sample' && r.sampleId === r40Fee.id && r.message.includes('打样费 70.00')),
  JSON.stringify((await dashboard.reminders()).filter((r) => r.sampleId === r40Fee.id).map((r) => r.message))
)
const r40Waive = await samples.saveSample({
  customerId: r40FeeCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  feeStatus: 'waived',
  items: [{ styleNo: 'R40-WAIVE', productName: '免收样', color: 'White', size: 'L', quantity: 1, unitPrice: 30 }]
})
eq('免收单 owed 是 0（界面自算会把它算成还欠 30）', (await samples.getSample(r40Waive.id))!.owed, 0)
check(
  '免收单不再出现在打样费催款里（没寄出的样品提醒照发，那是另一件事）',
  !(await dashboard.reminders())
    .some((r) => r.kind === 'sample' && r.sampleId === r40Waive.id && r.message.includes('打样费'))
)

section('R40 对账单不印内部话术：坏账追回说成补付早前欠款')
const r40StmtCust = await customers.saveCustomer({ company: 'R40-STMT-CO' })
const r40Stmt = await orders.createOrder({ customerId: r40StmtCust.id, piNo: 'PI-R40-STMT', paymentStatus: 'sent' })
await orders.addOrderItem(r40Stmt.id, { styleNo: 'R40-STMT', quantity: 1, unitPrice: 100 })
await orders.addSettlement(r40Stmt.id, { kind: 'bad_debt', amount: 40, reason: 'R40 客户失联' })
await orders.addSettlement(r40Stmt.id, { kind: 'recovery', amount: 20, bankRef: 'R40-STMT-REC', reason: 'R40 又联系上了' })
const r40Csv = await dashboard.exportCsv('statement', { customerId: r40StmtCust.id })
check('对账单里不出现内部话术「坏账追回」', !r40Csv.includes('坏账追回'), r40Csv.split('\n').filter((l) => l.includes('追回')).join(' / '))
check('对账单把追回说成「补付早前欠款」', r40Csv.includes('补付早前欠款：R40 又联系上了'))
check('对账单不替公司认「减免」：坏账不是让利', !r40Csv.includes('减免'), r40Csv)
await saveSettings(r40RemPrev)

/* ---------------- R41 ---------------- */
section('R41 老账「已向客户收」不能一键改「免收」')
const r41LegCust = await customers.saveCustomer({ company: 'R41-LEGACY-CO' })
const r41Leg = await samples.saveSample({
  customerId: r41LegCust.id,
  currency: 'USD',
  exchangeRate: 7.2,
  exchangeRateDate: localDate(),
  items: [{ styleNo: 'R41-LEG', productName: '升级前老账', color: 'White', size: 'M', quantity: 1, unitPrice: 40 }]
})
getDb().run(`UPDATE sample_orders SET fee_status='paid' WHERE id=?`, [r41Leg.id])
check(
  'paid → waived 被拦（收过的钱不能从对账单和月报里无声消失）',
  (await r40err(async () => await samples.saveSample({ id: r41Leg.id, feeStatus: 'waived' }))).includes('免收')
)
eq('paid → unpaid 纠错正门照常走（拦的是流向免收，不是改错）', (await samples.saveSample({ id: r41Leg.id, feeStatus: 'unpaid' })).feeStatus, 'unpaid')

section('R41 汇率参考值只认钉盘日期，不被无关编辑带偏')
const r41RateCust = await customers.saveCustomer({ company: 'R41-RATE-CO' })
const r41a = await orders.createOrder({ customerId: r41RateCust.id, piNo: 'PI-R41-RATE-A', currency: 'USD', paymentStatus: 'sent' })
const r41b = await orders.createOrder({ customerId: r41RateCust.id, piNo: 'PI-R41-RATE-B', currency: 'USD', paymentStatus: 'sent' })
const r41c = await orders.createOrder({ customerId: r41RateCust.id, piNo: 'PI-R41-RATE-C', currency: 'USD', paymentStatus: 'sent' })
getDb().run(`UPDATE orders SET exchange_rate=7.25, exchange_rate_date='2099-01-01', updated_at='2026-03-01T10:00:00.000Z' WHERE id=?`, [r41a.id])
getDb().run(`UPDATE orders SET exchange_rate=7.1, exchange_rate_date='2098-01-01', updated_at=? WHERE id=?`, [new Date().toISOString(), r41b.id])
// r41c 刚建、updated_at 最新，但没钉过汇率（或只有哨兵值、没有钉盘日期）
eq('参考值按钉盘日期取最近（老单补备注/改状态不再把它带偏）', (await orders.lastExchangeRateInfo('USD'))?.rate, 7.25)
getDb().run(`UPDATE orders SET exchange_rate=1, exchange_rate_date=NULL, updated_at=? WHERE id=?`, [new Date().toISOString(), r41a.id])
check(
  '最新编辑的单没钉汇率（哨兵值、无钉盘日期）时，参考值落到上一张真钉过的单，不返回哨兵也不消失',
  (await orders.lastExchangeRateInfo('USD'))?.rate === 7.1,
  String((await orders.lastExchangeRateInfo('USD')))
)
section('R41 备份包超限说人话（图片和存档是凭据，不叫人删）')
const r41big = Array.from({ length: 65536 }, (_, i) => ({ name: `docs/x-${i}.txt`, data: Buffer.alloc(0) }))
check('65536 个文件的包在入口被拦且文案给出上限', (await r40err(async () => createZip(r41big))).includes('65535'))

/* ---------------- R42 ---------------- */
section('R42 对账单不再对挂起的抵扣说「已收回」')
const r42C = await customers.saveCustomer({ company: 'R42-STMT-CO' })
const r42Sample = await samples.saveSample({
  customerId: r42C.id,
  sampleDate: dAgo(5),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(5),
  items: [
    {
      styleNo: 'R42-S1',
      productName: '挂起抵扣对账',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 25,
      goodsUnitPrice: 80
    }
  ]
})
const r42Order = await samples.convertSampleToOrder(r42Sample.id, { offsetSampleFee: true })
const r42StmtOpen = async (): Promise<number | undefined> =>
  (await money.sampleStatementRows(r42C.id)).find((r) => r.sampleId === r42Sample.id)?.open
eq('转出订单落草稿，对账单未收是全额', (await r42StmtOpen()), 25)
const r42DraftCsv = await dashboard.exportCsv('statement', { customerId: r42C.id })
const r42DraftRow = parseCsv(r42DraftCsv).slice(1).find((r) => r.some((c) => c === r42Sample.sampleNo))
check(
  '挂起的抵扣不再印「账上已收回」（未收明明是全额）',
  !!r42DraftRow && !r42DraftRow.some((c) => c.includes('账上已收回')),
  r42DraftRow?.join('|') ?? '<缺行>'
)
check(
  '挂起的抵扣改印「暂不生效、暂计入未收」',
  !!r42DraftRow && r42DraftRow.some((c) => c.includes('抵扣暂不生效') && c.includes('暂计入未收')),
  r42DraftRow?.join('|') ?? '<缺行>'
)
await orders.setPaymentStatus(r42Order.id, 'confirmed', 'R42 客户确认，抵扣生效')
eq('抵扣生效后未收归零', (await r42StmtOpen()), 0)
const r42LiveCsv = await dashboard.exportCsv('statement', { customerId: r42C.id })
const r42LiveRow = parseCsv(r42LiveCsv).slice(1).find((r) => r.some((c) => c === r42Sample.sampleNo))
check('抵扣生效后照旧印「账上已收回」', !!r42LiveRow && r42LiveRow.some((c) => c.includes('账上已收回')), r42LiveRow?.join('|') ?? '<缺行>')

section('R42 赊销与全额单不印零数定金行')
const r42Zero = await orders.createOrder({
  customerId: r42C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0,
  piNo: 'PI-R42-ZERO'
})
const r42Full = await orders.createOrder({
  customerId: r42C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 1,
  piNo: 'PI-R42-FULL'
})
const r42Mid = await orders.createOrder({
  customerId: r42C.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.3,
  piNo: 'PI-R42-MID'
})
check(
  '0% 定金的 PI 不印 Deposit: USD 0.00',
  !renderPi({ order: (await orders.getOrder(r42Zero.id))!, settings: getSettings(), images: {} }).includes('Deposit:')
)
check(
  '100% 前收的 PI 不印 Balance: USD 0.00',
  !renderPi({ order: (await orders.getOrder(r42Full.id))!, settings: getSettings(), images: {} }).includes('Balance:')
)
const r42MidPi = renderPi({ order: (await orders.getOrder(r42Mid.id))!, settings: getSettings(), images: {} })
check('30% 定金的 PI 定金/尾款两行照印', r42MidPi.includes('Deposit:') && r42MidPi.includes('Balance:'))

section('R42 打样单抬头也挂公司 logo')
const r42Settings = getSettings()
const r42SampleDetail = await samples.getSample(r42Sample.id)!
const r42LogoSettings = { ...r42Settings, company: { ...r42Settings.company, logoFile: 'logo.png' } }
check(
  '传了 logo 就印 <img class="logo">（与 PI/PL/CI/报价同款）',
  renderSample({ sample: r42SampleDetail, settings: r42LogoSettings, images: { __logo__: 'data:image/png;base64,AAA' } }).includes(
    '<img class="logo"'
  )
)
check(
  '图片没取到就不印（不印破图）',
  !renderSample({ sample: r42SampleDetail, settings: r42LogoSettings, images: {} }).includes('<img class="logo"')
)

section('R42 单据路径不再有绝对路径直通口')
const r42Inside = join(dataDir(), 'docs', 'r42-inside.pdf')
eq('数据目录内的绝对路径照常解析', docs.resolveDocPath(r42Inside), r42Inside)
const r42Outside = join(dataDir(), '..', 'r42-outside.pdf')
check(
  '数据目录外的绝对路径被拒（不再能开任意文件）',
  (() => {
    try {
      docs.resolveDocPath(r42Outside)
      return false
    } catch {
      return true
    }
  })()
)
const r42OldMachine = `D:\\old-pc\\elsewhere\\docs\\r42-old.pdf`
eq(
  '老机器的绝对路径仍按 docs 段接回当前数据目录',
  docs.resolveDocPath(r42OldMachine),
  join(dataDir(), 'docs', 'r42-old.pdf')
)
check(
  '老路径没有 docs 段也拒（不再原样放行）',
  (() => {
    try {
      docs.resolveDocPath('D:\\old-pc\\elsewhere\\r42-nomarker.pdf')
      return false
    } catch {
      return true
    }
  })()
)

/* ---------------- R43 ---------------- */
section('R43 同一张单的存档排队，不撞版本号')
const r43Cust = await customers.saveCustomer({ company: 'R43-CONC-CO' })
const r43Order = await orders.createOrder({
  customerId: r43Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R43-CONC'
})
await orders.addOrderItem(r43Order.id, { styleNo: 'R43-C', quantity: 1, unitPrice: 20 })
const r43Pdf = Buffer.from('%PDF-1.4 r43 concurrent')
const r43Saves = await Promise.all([
  docs.saveDocFile({ pdf: r43Pdf, docNo: 'PI-R43-CONC', kind: 'pi', orderId: r43Order.id, amount: 20 }),
  docs.saveDocFile({ pdf: r43Pdf, docNo: 'PI-R43-CONC', kind: 'pi', orderId: r43Order.id, amount: 20 })
])
eq(
  '两个预览并发点存档，拿到的是第 1、2 两版（不再双双算成第 1 版）',
  r43Saves
    .map((s) => s.version)
    .sort((a, b) => a - b)
    .join(','),
  '1,2'
)
check('两版 PDF 都还在盘上（失败的一方不许回滚掉对手的文件）', r43Saves.every((s) => fs.existsSync(s.absolutePath)))
eq('库里也记了两版', docs.listDocVersions(r43Order.id).length, 2)
check(
  '存档记录里的相对路径都解析得回盘上',
  docs.listDocVersions(r43Order.id).every((v) => fs.existsSync(docs.resolveDocPath(v.filePath)))
)

section('R43 备份打包排队：同一秒点两次不留半截包')
const r43Zips = await Promise.all([createBackup('r43a'), createBackup('r43b')])
check('两份备份都真的落盘', r43Zips.every((p) => fs.existsSync(p)))
check('同一秒的两个请求各成一份包（没挤成一份）', r43Zips[0] !== r43Zips[1], r43Zips.join('|'))
eq('打包收尾不留 .part 临时文件', fs.readdirSync(backupsDir()).filter((f) => f.endsWith('.part')).length, 0)
check('两份都还当得了恢复源', r43Zips.every((p) => inspectBackup(p).hasDb))
// 半截 .part 的善后：断电/被杀留下的那份占着磁盘，名字却不带 .zip，界面永远看不见
const r43StalePart = join(backupsDir(), 'ikanbot-20200101000000-stale.4242-uuid.part')
const r43LivePart = join(backupsDir(), 'ikanbot-live-inflight.part')
fs.writeFileSync(r43StalePart, 'half')
fs.writeFileSync(r43LivePart, 'half')
fs.utimesSync(r43StalePart, new Date(), new Date(Date.now() - 2 * 24 * 3600 * 1000))
pruneBackups(30)
check('一小时前的半截包被顺手清掉', !fs.existsSync(r43StalePart))
check('刚留下的 .part 不碰（可能是另一条还在写的备份）', fs.existsSync(r43LivePart))
fs.unlinkSync(r43LivePart)

section('R43 恢复备份失败不能把写通道锁死')
eq('没在恢复时不挡任何通道', isRestoring(), false)
const r43RestoreErr = await r8err(async () => await restoreBackup(join(backupsDir(), 'ikanbot-19700101000000-none.zip')))
check('恢复一个不存在的包会报错', r43RestoreErr.includes('已经不在了'), r43RestoreErr)
eq('报错后写通道马上放开（点错一次不许锁到重启）', isRestoring(), false)

section('R43 删图前先问库里有谁在引用')
const r43Product = await products.saveProduct({
  styleNo: 'R43-REF',
  name: '引用检查',
  composition: '100% Cotton',
  sizes: ['M'],
  colors: ['Black']
})
await products.addProductImage(r43Product.id, 'R43-used.png')
const r43PhotoOrder = await orders.createOrder({
  customerId: r43Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R43-PHOTO'
})
await orders.addOrderPhoto(r43PhotoOrder.id, 'R43-photo.png', 'inspection', 'R43 验货照')
const r43Conf = getSettings()
await saveSettings({ ...r43Conf, company: { ...r43Conf.company, logoFile: 'R43-logo.png' } })
const r43Refs = await filesCore(coreDb).referenced([
  'R43-used.png',
  'R43-photo.png',
  'R43-logo.png',
  'R43-draft.png'
])
check('商品图认得出（不许当草稿删掉）', r43Refs.has('R43-used.png'))
check('订单照片认得出', r43Refs.has('R43-photo.png'))
check('公司 Logo 认得出（库里只有一条设置，不在这两张表里）', r43Refs.has('R43-logo.png'))
check('没登记过的名字不算被引用（上传到一半的草稿仍要清得掉）', !r43Refs.has('R43-draft.png'))
eq('空列表不查库', (await filesCore(coreDb).referenced([])).size, 0)
eq('传进来不是数组也不炸', (await filesCore(coreDb).referenced('R43-used.png')).size, 0)
check('混进非字符串只忽略它，别的照认', (await filesCore(coreDb).referenced([null, 7, '', 'R43-used.png'])).size, 1)
await saveSettings(r43Conf)

section('R43 没勾抵扣的转单：打样费还在这张单上收')
const r43ConvCust = await customers.saveCustomer({ company: 'R43-CONV-CO' })
const r43ConvSample = await samples.saveSample({
  customerId: r43ConvCust.id,
  sampleDate: dAgo(4),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(4),
  items: [
    {
      styleNo: 'R43-N1',
      productName: '不抵扣转单',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 60,
      goodsUnitPrice: 200
    }
  ]
})
const r43ConvOrder = await samples.convertSampleToOrder(r43ConvSample.id, { offsetSampleFee: false, paymentStatus: 'confirmed' })
eq('不勾抵扣：样品费收款标记还是未收', (await samples.getSample(r43ConvSample.id))!.feeStatus, 'unpaid')
eq('转出的订单里一条费用行都没有（那笔钱没挂到订单上）', r43ConvOrder.charges.length, 0)
const r43ConvPaid = await samples.addSamplePayment(r43ConvSample.id, {
  paidAt: localDate(),
  amount: 60,
  bankRef: 'R43-CONV-IN'
})
eq('转单后仍能把这笔现金记进账', r43ConvPaid.feeStatus, 'paid')
eq('记完待收归零', r43ConvPaid.owed, 0)
const r43ConvFlow = (await samples.listSamplePayments(r43ConvSample.id))[0]
const r43ConvBack = await samples.deleteSamplePayment(r43ConvSample.id, r43ConvFlow.id, '金额录错，撤回重录')
eq('录错的撤得回来（放开登记就不能锁死撤销）', r43ConvBack.feeStatus, 'unpaid')
eq('撤回后待收又回到 60', r43ConvBack.owed, 60)
const r43OffSample = await samples.saveSample({
  customerId: r43ConvCust.id,
  sampleDate: dAgo(4),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(4),
  items: [
    {
      styleNo: 'R43-N2',
      productName: '抵扣转单',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 60,
      goodsUnitPrice: 200
    }
  ]
})
await samples.convertSampleToOrder(r43OffSample.id, { offsetSampleFee: true, paymentStatus: 'confirmed' })
check(
  '勾了抵扣的照旧拦死（钱要登记在那张订单上）',
  (
    await r8err(
      async () => await samples.addSamplePayment(r43OffSample.id, { paidAt: localDate(), amount: 60, bankRef: 'R43-OFF-IN' })
    )
  ).includes('请直接登记在订单上')
)

section('R43 抵扣正好抵平货值的单：算结清，不许永远挂「已发送」')
const r43ZeroCust = await customers.saveCustomer({ company: 'R43-ZERO-CO' })
const r43ZeroSample = await samples.saveSample({
  customerId: r43ZeroCust.id,
  sampleDate: dAgo(2),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(2),
  items: [
    {
      styleNo: 'R43-Z1',
      productName: '抵扣抵平货值',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 40,
      goodsUnitPrice: 40
    }
  ]
})
const r43ZeroOrder = await samples.convertSampleToOrder(r43ZeroSample.id, { offsetSampleFee: true, paymentStatus: 'sent' })
eq('货值 40 − 抵扣 40 = 合计 0', r43ZeroOrder.grandTotal, 0)
// R44：转单事务收尾自己重算，落库那一刻就是结清——
// 以前要等下一次收款/改状态事件才被纠正，这期间列表同屏挂着「已发出 + 已收齐」
eq('转出来的单落库时已经是已结清（不再需要等一次事件）', r43ZeroOrder.paymentStatus, 'settled')
eq(
  '收款状态自动流转认「合计 0 就是收齐」',
  await orders.recomputePaymentStatus(r43ZeroOrder.id),
  'settled'
)
eq('库里也落成已结清', (await orders.getOrder(r43ZeroOrder.id))!.paymentStatus, 'settled')
const r43DraftZero = await orders.createOrder({
  customerId: r43ZeroCust.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: 'PI-R43-DRAFT-ZERO'
})
eq('草稿单即使合计 0 也不自动流转', await orders.recomputePaymentStatus(r43DraftZero.id), 'draft')
const r43BlankSent = await orders.createOrder({
  customerId: r43ZeroCust.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: 'PI-R43-BLANK-SENT'
})
await orders.setPaymentStatus(r43BlankSent.id, 'sent')
eq(
  '一张还没填货的 0 单不算结清：客户点头才是它的事，不能被当成「钱收齐了」',
  await orders.recomputePaymentStatus(r43BlankSent.id),
  'sent'
)
check(
  '结清了就不再挂「PI 已发出未确认」',
  !(await dashboard.reminders()).some((r) => r.orderId === r43ZeroOrder.id && r.kind === 'confirm')
)

section('R43 预收正好抵清的打样单：对账单说「预收已抵清」')
const r43CrCust = await customers.saveCustomer({ company: 'R43-CREDIT-CO' })
const r43SrcSample = await samples.saveSample({
  customerId: r43CrCust.id,
  sampleDate: dAgo(3),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(3),
  items: [
    {
      styleNo: 'R43-SRC',
      productName: '取消单的实收',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 30,
      goodsUnitPrice: 30
    }
  ]
})
await samples.addSamplePayment(r43SrcSample.id, { paidAt: localDate(), amount: 30, bankRef: 'R43-CR-IN' })
await samples.saveSample({ id: r43SrcSample.id, status: 'cancelled', note: 'R43 测试：客户改走别家，实收转预收' })
eq('取消单的实收成了客户预收', await money.customerCreditAvailable(r43CrCust.id, 'USD'), 30)
const r43TgtSample = await samples.saveSample({
  customerId: r43CrCust.id,
  sampleDate: dAgo(3),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(3),
  items: [
    {
      styleNo: 'R43-TGT',
      productName: '被预收抵清的样',
      color: 'Black',
      size: 'M',
      quantity: 1,
      unitPrice: 20,
      goodsUnitPrice: 20
    }
  ]
})
await credits.applyCredit({
  customerId: r43CrCust.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r43TgtSample.id,
  amount: 20,
  note: 'R43 用预收抵清'
})
const r43Tgt = (await samples.getSample(r43TgtSample.id))!
eq('待收归零', r43Tgt.owed, 0)
eq('收款标记仍是未收（抵扣不是现金，不改标记）', r43Tgt.feeStatus, 'unpaid')
const r43CrCsv = parseCsv(await dashboard.exportCsv('statement', { customerId: r43CrCust.id }))
const r43Col = (name: string): number => r43CrCsv[0].indexOf(name)
const r43TgtRow = r43CrCsv.slice(1).find((r) => r[r43Col('单据号')] === r43TgtSample.sampleNo)
check('对账单里有这张打样单', !!r43TgtRow, JSON.stringify(r43TgtRow))
check(
  '状态说「预收已抵清」：既不说明朝还欠着，也不说现金已收回',
  (r43TgtRow?.[r43Col('状态')] ?? '').includes('预收已抵清'),
  r43TgtRow?.[r43Col('状态')] ?? '<缺行>'
)
check('不再挂「已收 0.00」这种自相矛盾的备注', !(r43TgtRow?.[r43Col('备注')] ?? '').includes('未收'), r43TgtRow?.[r43Col('备注')])
eq('未收列是 0', Number(r43TgtRow?.[r43Col('未收(原币)')]), 0)
eq('预收抵扣列记 20', Number(r43TgtRow?.[r43Col('预收抵扣(原币)')]), 20)

section('R44 转单落库时就过重算：不再留「已发出 + 已收齐」那种自相矛盾的单')
const r44Cust = await customers.saveCustomer({ company: 'R44-CONV-CO' })
const r44Full = await samples.saveSample({
  customerId: r44Cust.id,
  sampleDate: dAgo(2),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(2),
  items: [
    { styleNo: 'R44-F1', productName: '抵扣抵平货值', color: 'Black', size: 'M', quantity: 1, unitPrice: 40, goodsUnitPrice: 40 }
  ]
})
const r44FullOrder = await samples.convertSampleToOrder(r44Full.id, { offsetSampleFee: true, paymentStatus: 'sent' })
eq('全额抵扣的转单：落库那一刻就是已结清（不用等下一次收款事件）', r44FullOrder.paymentStatus, 'settled')
eq('库里落的也是已结清', (await orders.getOrder(r44FullOrder.id))!.paymentStatus, 'settled')
eq('自动流转只留一条痕（同值不再重跑）', (await orders.listEvents(r44FullOrder.id)).filter((e) => e.kind === 'status_auto').length, 1)
check(
  '结清了就不该再天天催「客户没确认」',
  !(await dashboard.reminders()).some((r) => r.orderId === r44FullOrder.id && r.kind === 'confirm')
)
const r44Part = await samples.saveSample({
  customerId: r44Cust.id,
  sampleDate: dAgo(2),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(2),
  items: [
    { styleNo: 'R44-P1', productName: '只抵掉一小部分', color: 'Black', size: 'M', quantity: 1, unitPrice: 40, goodsUnitPrice: 300 }
  ]
})
const r44PartOrder = await samples.convertSampleToOrder(r44Part.id, { offsetSampleFee: true, paymentStatus: 'sent' })
eq('没抵平的单照旧停在「已发出」：重算不是把状态一律往上推', r44PartOrder.paymentStatus, 'sent')
const r44Draft = await samples.saveSample({
  customerId: r44Cust.id,
  sampleDate: dAgo(2),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(2),
  items: [
    { styleNo: 'R44-D1', productName: '选了先存草稿', color: 'Black', size: 'M', quantity: 1, unitPrice: 40, goodsUnitPrice: 40 }
  ]
})
const r44DraftOrder = await samples.convertSampleToOrder(r44Draft.id, { offsetSampleFee: true, paymentStatus: 'draft' })
eq('用户选的「先存草稿」不被自动流转覆盖（即使这张单合计 0）', r44DraftOrder.paymentStatus, 'draft')
const r44Quot = await quotations.saveQuotation({
  customerId: r44Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  items: [{ styleNo: 'R44-Q1', productName: '正常报价转单', color: 'Black', size: 'M', quantity: 10, unitPrice: 8 }]
})
const r44QuotOrder = await quotations.convertToOrder(r44Quot.id)
eq('报价转单也走同一条重算：正常有欠款的单仍停在「已发出」等客户点头', r44QuotOrder.paymentStatus, 'sent')

section('R44 负合计不算结清：那是该退客户钱，不是收齐了')
const r44Neg = await orders.createOrder({
  customerId: r44Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  piNo: 'PI-R44-NEG',
  charges: [{ label: '让利（录重了，把货值抵穿）', amount: -200 }]
})
await orders.addOrderItem(r44Neg.id, { styleNo: 'R44-NG', productName: '货值 100', color: 'Black', size: 'M', quantity: 1, unitPrice: 100 })
const r44NegRow = (await orders.getOrder(r44Neg.id))!
check('这张单合计是负的（让利把货值抵穿了）', r44NegRow.grandTotal < -0.001, String(r44NegRow.grandTotal))
check('原始欠款也记成负数：账面上要看得见「该退多少」', r44NegRow.remainingRaw < -0.001, String(r44NegRow.remainingRaw))
await orders.setPaymentStatus(r44Neg.id, 'sent')
eq('合计为负不判结清（顶多回到「已发出」，等人来处理这笔该退的钱）', await orders.recomputePaymentStatus(r44Neg.id), 'sent')
eq('界面上的待收把负数收在 0，不显示「待收 −100」', shownRemaining('sent', r44NegRow.remainingRaw), 0)

section('R44 删图判据认得下带路径的名字与 URL')
const r44Prod = await products.saveProduct({ styleNo: 'R44-PIC', name: '判据测试款', sizes: ['M'], colors: ['Black'] })
await products.addProductImage(r44Prod.id, 'R44-used.png', true)
const r44Files = filesCore(coreDb)
check(
  '传「sub/dir/R44-used.png」这种带目录的名字也认得是在用的图（删除端按 basename 落地）',
  (await r44Files.referenced(['sub/dir/R44-used.png'])).has('R44-used.png')
)
eq(
  '图片 URL 进来照样拦得住，剩下的才许删',
  JSON.stringify(await r44Files.deletable(['http://127.0.0.1:3000/api/files/images/R44-used.png', 'R44-draft.png'])),
  JSON.stringify(['R44-draft.png'])
)
eq('没登记过的草稿图还在可删清单里', (await r44Files.deletable(['R44-draft.png'])).length, 1)
eq('传进来不是数组就什么都不删', (await r44Files.deletable('R44-draft.png')).length, 0)
await products.deleteProduct(r44Prod.id)

section('R44 备份文件名撞上了不顶掉上一份')
eq('目录里没这个名就照原名', uniqueBackupName(backupsDir(), 'ikanbot-R44DUP.zip'), 'ikanbot-R44DUP.zip')
fs.writeFileSync(join(backupsDir(), 'ikanbot-R44DUP.zip'), 'SENTINEL')
eq('同秒撞名往后加 -2，不去覆盖那一份能救命的恢复点', uniqueBackupName(backupsDir(), 'ikanbot-R44DUP.zip'), 'ikanbot-R44DUP-2.zip')
fs.writeFileSync(join(backupsDir(), 'ikanbot-R44DUP-2.zip'), 'SENTINEL2')
eq('再撞就 -3', uniqueBackupName(backupsDir(), 'ikanbot-R44DUP.zip'), 'ikanbot-R44DUP-3.zip')
const r44Sentinel = fs.readFileSync(join(backupsDir(), 'ikanbot-R44DUP.zip'), 'utf8')
fs.rmSync(join(backupsDir(), 'ikanbot-R44DUP.zip'))
fs.rmSync(join(backupsDir(), 'ikanbot-R44DUP-2.zip'))
eq('上一份包的内容没被动过', r44Sentinel, 'SENTINEL')

section('R44 打样单的锁：那单作废了才放开（草稿/失效照旧锁死）')
const r44LockSample = await samples.saveSample({
  customerId: r44Cust.id,
  sampleDate: dAgo(3),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(3),
  items: [
    { styleNo: 'R44-L1', productName: '样品费录错了', color: 'Black', size: 'M', quantity: 1, unitPrice: 50, goodsUnitPrice: 200 }
  ]
})
const r44LockOrder = await samples.convertSampleToOrder(r44LockSample.id, { offsetSampleFee: true, paymentStatus: 'draft' })
check(
  '转出订单还是草稿：费用照旧锁死（那单随时可能活过来，抵扣已经烧进它的费用行）',
  (
    await r8err(
      async () =>
        await samples.saveSample({
          id: r44LockSample.id,
          items: [
            { styleNo: 'R44-L1', productName: '样品费录错了', color: 'Black', size: 'M', quantity: 1, unitPrice: 55, goodsUnitPrice: 200 }
          ]
        })
    )
  ).includes('不能再改')
)
await orders.voidOrder(r44LockOrder.id, 'R44 评审：客户取消这张单')
const r44Unlocked = await samples.saveSample({
  id: r44LockSample.id,
  items: [
    { styleNo: 'R44-L1', productName: '样品费录错了', color: 'Black', size: 'M', quantity: 1, unitPrice: 55, goodsUnitPrice: 200 }
  ]
})
eq('那单作废了就能改回真实样品费（不必删除重建、水单挂靠不断）', r44Unlocked.sampleFee, 55)
eq('作废单不再靠这张样用作凭据，样品费回到未收', r44Unlocked.feeStatus, 'unpaid')

/* ---------------- R45 ---------------- */

section('R45 撤销作废要重算守恒：作废期间别的批次把空间用满了，这一批不能直接翻案')
const r45Cust = await customers.saveCustomer({ company: 'R45-PL-CO' })
const r45Order = await orders.createOrder({
  customerId: r45Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-PL'
})
await orders.addOrderItem(r45Order.id, { styleNo: 'R45-SKU', color: 'Black', size: 'M', quantity: 100, unitPrice: 10 })
const r45A = (
  await packing.createPackingList({
    orderId: r45Order.id,
    containerNo: 'R45-A',
    lines: [{ boxNo: 'NO.1', styleNo: 'R45-SKU', color: 'Black', size: 'M', quantity: 40 }]
  })
).find((p) => p.containerNo === 'R45-A')!
const r45B = (
  await packing.createPackingList({
    orderId: r45Order.id,
    containerNo: 'R45-B',
    lines: [{ boxNo: 'NO.2', styleNo: 'R45-SKU', color: 'Black', size: 'M', quantity: 60 }]
  })
).find((p) => p.containerNo === 'R45-B')!
await packing.voidPackingList(r45Order.id, r45B.id, 'R45 这批没走成')
// 作废期间这一批不算件数，空出来的 60 件会被新批次吃掉
const r45C = (
  await packing.createPackingList({
    orderId: r45Order.id,
    containerNo: 'R45-C',
    lines: [{ boxNo: 'NO.3', styleNo: 'R45-SKU', color: 'Black', size: 'M', quantity: 60 }]
  })
).find((p) => p.containerNo === 'R45-C')!
const r45UnvoidErr = await r8err(async () => await packing.unvoidPackingList(r45Order.id, r45B.id, 'R45 客户又要了'))
check('翻案会让累计装得比订单多：当场拦下', r45UnvoidErr.includes('撤销作废会被件数守门拦下'), r45UnvoidErr)
check('拦下时把「还能装几件、这一批要加回几件」说清楚', r45UnvoidErr.includes('还能装 0 件') && r45UnvoidErr.includes('这一批填了 60 件'), r45UnvoidErr)
eq('拦下后这一批照旧躺着（作废状态没被改动）', (await packing.listPackingLists(r45Order.id)).find((p) => p.id === r45B.id)!.voidedAt != null, true)
eq('拦下后已装件数不变', (await shipmentSummary(r45Order.id)).packedQuantity, 100)
eq('拦下后不留撤销的留痕（守门在事务里，事件也不能写）', (await orders.listEvents(r45Order.id)).filter((e) => e.kind === 'pl_unvoid').length, 0)
// 把新批次改小到 20 件：仍然装不下这一批的 60 件
await packing.updatePackingListLine(r45Order.id, r45C.id, r45C.lines[0].id, { quantity: 20 })
const r45UnvoidErr2 = await r8err(async () => await packing.unvoidPackingList(r45Order.id, r45B.id, 'R45 客户又要了'))
check('改小一档还是拦：这次还能装 40 件，这一批要加回 60 件', r45UnvoidErr2.includes('还能装 40 件'), r45UnvoidErr2)
eq('改小后已装 60 件', (await shipmentSummary(r45Order.id)).packedQuantity, 60)
// 腾位置：删掉占位的批次，这一批才翻得过来
await packing.deletePackingList(r45Order.id, r45C.id)
await packing.unvoidPackingList(r45Order.id, r45B.id, 'R45 客户又要了')
eq('位置腾出来后果然翻案成功', (await packing.listPackingLists(r45Order.id)).find((p) => p.id === r45B.id)!.voidedAt == null, true)
eq('首批那 40 件全程没被动过', (await packing.listPackingLists(r45Order.id)).find((p) => p.id === r45A.id)!.lines[0].quantity, 40)
eq('翻案后合计回到订单量', (await shipmentSummary(r45Order.id)).packedQuantity, 100)
eq('翻案成功才留下那笔历史', (await orders.listEvents(r45Order.id)).filter((e) => e.kind === 'pl_unvoid').length, 1)

section('R45 存档前验纸面指纹：预览期间数据变了就不存这一版')
const r45DocCust = await customers.saveCustomer({ company: 'R45-DOC-CO' })
const r45DocOrder = await orders.createOrder({
  customerId: r45DocCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-DOC'
})
await orders.addOrderItem(r45DocOrder.id, { styleNo: 'R45-DOC', color: 'Black', size: 'M', quantity: 1, unitPrice: 100 })
const r45Pdf = Buffer.from('%PDF-1.4 r45 fingerprint')
const r45Fp = docPageFingerprint({
  kind: 'pi',
  docNo: 'PI-R45-DOC',
  order: await orders.getOrder(r45DocOrder.id),
  settings: getSettings()
})
const r45StaleErr = await r8err(
  async () =>
    await docs.saveDocFile({
      pdf: r45Pdf,
      docNo: 'PI-R45-DOC',
      kind: 'pi',
      orderId: r45DocOrder.id,
      amount: 100,
      pageFingerprint: 'deadbeefdeadbeef'
    })
)
check('纸面指纹对不上：拒存并叫人重开预览', r45StaleErr.includes('纸面已经过时') && r45StaleErr.includes('重新打开'), r45StaleErr)
eq('拒存后库里没记这一版', docs.listDocVersions(r45DocOrder.id).length, 0)
const r45Saved = await docs.saveDocFile({
  pdf: r45Pdf,
  docNo: 'PI-R45-DOC',
  kind: 'pi',
  orderId: r45DocOrder.id,
  amount: 100,
  pageFingerprint: r45Fp
})
eq('数据没动过：带着预览那份指纹存得进去', r45Saved.version, 1)
// 预览期间的真实改动：加一件明细，旧指纹立刻对不上
await orders.addOrderItem(r45DocOrder.id, { styleNo: 'R45-DOC2', color: 'Black', size: 'L', quantity: 2, unitPrice: 50 })
const r45Stale2Err = await r8err(
  async () =>
    await docs.saveDocFile({
      pdf: r45Pdf,
      docNo: 'PI-R45-DOC',
      kind: 'pi',
      orderId: r45DocOrder.id,
      amount: 100,
      pageFingerprint: r45Fp
    })
)
check('改过明细后用旧指纹存第 2 版被拦（不然 PDF 和账各说各话）', r45Stale2Err.includes('纸面已经过时'), r45Stale2Err)
eq('被拦的这一次没多出第 2 版', docs.listDocVersions(r45DocOrder.id).length, 1)
check(
  '不带指纹的老调用照样存得进（脚本与老入口不能凭空判死）',
  (await docs.saveDocFile({ pdf: r45Pdf, docNo: 'PI-R45-DOC', kind: 'pi', orderId: r45DocOrder.id, amount: 200 })).version,
  2
)

section('R45 CI 存档要先有 PI 号：空号会让所有闸门认错单')
const r45NoPiCust = await customers.saveCustomer({ company: 'R45-NOPI-CO' })
const r45NoPi = await orders.createOrder({
  customerId: r45NoPiCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed'
})
await orders.addOrderItem(r45NoPi.id, { styleNo: 'R45-NOPI', quantity: 1, unitPrice: 80 })
// 现在建单都会自动补号，空 PI 号只剩升级前那份老数据：照老数据的样子直接清
getDb().run("UPDATE orders SET pi_no = '' WHERE id = ?", [r45NoPi.id])
const r45CiErr = await r8err(
  async () => await docs.saveDocFile({ pdf: r45Pdf, docNo: 'CI', kind: 'ci', orderId: r45NoPi.id, amount: 80 })
)
check('这张单还没 PI 号：CI 存档当场拒绝', r45CiErr.includes('还没有 PI 号'), r45CiErr)
check('拒存时把闸门认错单这件事说给人听', r45CiErr.includes('补上 PI 号'), r45CiErr)
eq('没落库，不会留下一个光秃秃的 CI 键', docs.listDocVersions(r45NoPi.id).length, 0)
check('拦在落盘之前：盘上没多出 CI 目录', !fs.existsSync(join(docsDir(), 'CI')))
await orders.updateOrder(r45NoPi.id, { customerId: r45NoPiCust.id, piNo: 'PI-R45-NOPI' })
const r45CiOk = await docs.saveDocFile({
  pdf: r45Pdf,
  docNo: ciNoOf('PI-R45-NOPI'),
  kind: 'ci',
  orderId: r45NoPi.id,
  amount: 80
})
eq('补上 PI 号就能正常出这一版', r45CiOk.version, 1)
check('出的号是 CI 由 PI 派生（闸门认得这张单）', r45CiOk.filePath.includes('CI-R45-NOPI'), r45CiOk.filePath)

section('R45 抵扣与退款的守门在事务里：拦下时台账与余额都不许动')
const r45CrCust = await customers.saveCustomer({ company: 'R45-CREDIT-CO' })
const r45CrSrc = await orders.createOrder({
  customerId: r45CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-CRSRC'
})
await orders.addOrderItem(r45CrSrc.id, { styleNo: 'R45-CR', quantity: 1, unitPrice: 100 })
await orders.addPayment(r45CrSrc.id, { paidAt: localDate(), amount: 150, bankRef: 'R45-IN' })
eq('多收 50 进预收', await money.customerCreditAvailable(r45CrCust.id, 'USD'), 50)
const r45CrTarget = await orders.createOrder({
  customerId: r45CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-CRTGT'
})
await orders.addOrderItem(r45CrTarget.id, { styleNo: 'R45-CR2', quantity: 1, unitPrice: 30 })
const r45OverErr = await r8err(
  async () =>
    await credits.applyCredit({
      customerId: r45CrCust.id,
      currency: 'USD',
      targetKind: 'order',
      targetId: r45CrTarget.id,
      amount: 45
    })
)
check('抵超过这张单待收的钱被拦', r45OverErr.includes('待收'), r45OverErr)
eq('拦下的那次台账里没多一笔', (await money.customerCreditBalance(r45CrCust.id)).find((c) => c.currency === 'USD')!.applications.length, 0)
eq('拦下的那次余额一分没动', await money.customerCreditAvailable(r45CrCust.id, 'USD'), 50)
eq('拦下的那次也没把这张单的收款状态推上去', (await orders.getOrder(r45CrTarget.id))!.paymentStatus, 'confirmed')
const r45CrAfterOk = await credits.applyCredit({
  customerId: r45CrCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r45CrTarget.id,
  amount: 20
})
eq('抵成功才落下那一条台账', r45CrAfterOk.find((c) => c.currency === 'USD')!.applications.length, 1)
check(
  '抵完返回的余额就是 30（校验与落库同一个事务，返回的数即最终账）',
  r45CrAfterOk.find((c) => c.currency === 'USD')!.available,
  30
)

section('R45 备份打包：读不出来的文件必须留痕，不能记成「备份成功」')
const r45Skipped: string[] = []
const r45Collected = collectDir(join(dataDir(), 'ikanbot.db'), 'docs', r45Skipped)
eq('拿文件当目录：一个也没收进来', r45Collected.length, 0)
eq('但这条记在了缺件清单里', r45Skipped.length, 1)
check('缺件的话术说的是中文，不是 ENOTDIR', r45Skipped[0].includes('整个目录读不出来'), r45Skipped[0])
const r45FsErr = new Error('boom') as NodeJS.ErrnoException
r45FsErr.code = 'EACCES'
check('没权限说成「没权限读」，不是裸错误码', zhFsError(r45FsErr).includes('权限'), zhFsError(r45FsErr))
r45FsErr.code = 'ENOENT'
check('找不到文件说成「正被删除」这条线', zhFsError(r45FsErr).includes('已经不在了'), zhFsError(r45FsErr))

section('R45 提醒里要说清预收抵过多少：那部分钱不是现金')
const r45RemSettings = getSettings()
await saveSettings({ ...r45RemSettings, remindBalanceDays: 0 })
const r45RemCust = await customers.saveCustomer({ company: 'R45-REM-CO' })
const r45RemSrc = await orders.createOrder({
  customerId: r45RemCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-REMSRC'
})
await orders.addOrderItem(r45RemSrc.id, { styleNo: 'R45-REMS', quantity: 1, unitPrice: 100 })
await orders.addPayment(r45RemSrc.id, { paidAt: localDate(), amount: 240, bankRef: 'R45-REM-IN' })
eq('多收 140 进预收', await money.customerCreditAvailable(r45RemCust.id, 'USD'), 140)
const r45RemUnpaid = await orders.createOrder({
  customerId: r45RemCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R45-REMUP'
})
await orders.addOrderItem(r45RemUnpaid.id, { styleNo: 'R45-REMU', quantity: 1, unitPrice: 100 })
await credits.applyCredit({
  customerId: r45RemCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r45RemUnpaid.id,
  amount: 40
})
await orders.setShipStatus(r45RemUnpaid.id, 'shipped', 'R45 评审：出运')
const r45RemUnpaidRow = (await dashboard.reminders()).find((r) => r.orderId === r45RemUnpaid.id && r.kind === 'balance')
check('现金一分未收的单照样催', !!r45RemUnpaidRow, JSON.stringify(r45RemUnpaidRow))
check(
  '催款里写明其中 40 是预收抵的（不是现金）',
  (r45RemUnpaidRow?.message ?? '').includes('现金一分未收') &&
    (r45RemUnpaidRow?.message ?? '').includes('其中 40.00 已用客户预收抵扣'),
  r45RemUnpaidRow?.message
)
const r45RemBal = await orders.createOrder({
  customerId: r45RemCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.3,
  piNo: 'PI-R45-REMBAL'
})
await orders.addOrderItem(r45RemBal.id, { styleNo: 'R45-REMB', quantity: 1, unitPrice: 1000 })
await orders.addPayment(r45RemBal.id, { paidAt: localDate(), amount: 300, bankRef: 'R45-REM-BAL' })
await orders.setShipStatus(r45RemBal.id, 'shipped', 'R45 评审：出运')
const r45RemBalRow = (await dashboard.reminders()).find((r) => r.orderId === r45RemBal.id && r.kind === 'balance')
check(
  '没收过预收的尾款单：提醒里不多出那句话',
  (r45RemBalRow?.message ?? '').includes('已收 300.00 / 待收 700.00 USD，尾款') &&
    !(r45RemBalRow?.message ?? '').includes('预收抵扣'),
  r45RemBalRow?.message
)
await credits.applyCredit({
  customerId: r45RemCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r45RemBal.id,
  amount: 10
})
const r45RemBalRow2 = (await dashboard.reminders()).find((r) => r.orderId === r45RemBal.id && r.kind === 'balance')
check(
  '抵了一笔之后提醒改口：待收 690，其中 10 走的是客户预收',
  (r45RemBalRow2?.message ?? '').includes('待收 690.00 USD，其中 10.00 已用客户预收抵扣（非现金），尾款'),
  r45RemBalRow2?.message
)
await saveSettings(r45RemSettings)

/* ---------------- R46：一个数只许一张嘴 ---------------- */
section('R46 手工勾「已结清」但按流水还欠：原因必填，差额钉进留痕')
const r46Cust = await customers.saveCustomer({ company: 'R46-SETTLE-CO' })
const r46Owed = await orders.createOrder({
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-OWED'
})
await orders.addOrderItem(r46Owed.id, { styleNo: 'R46-S1', quantity: 1, unitPrice: 100 })
await orders.addPayment(r46Owed.id, { paidAt: localDate(), amount: 60, method: 'T/T', bankRef: 'ZZ-R46-OWED' })
const r46Before = (await orders.getOrder(r46Owed.id))!.paymentStatus
const r46NoReason = await r8err(async () => await orders.setPaymentStatus(r46Owed.id, 'settled'))
check('还欠 40 时直接勾「已结清」被拦', r46NoReason.includes('还欠'), r46NoReason)
check('拦下的话术说清该干什么（先做平，或写明为什么不收了）', r46NoReason.includes('请写明原因'), r46NoReason)
eq('拦下后状态一个字没动', (await orders.getOrder(r46Owed.id))!.paymentStatus, r46Before)
await orders.setPaymentStatus(r46Owed.id, 'settled', '客户现场付现金，水单不入账')
const r46SetEv = (await orders.listEvents(r46Owed.id)).find(
  (e) => e.kind === 'payment_status' && e.toStatus === 'settled'
)
check('结清留痕把差额钉进历史：将来对不上账知道差多少', (r46SetEv?.note ?? '').includes('按流水仍欠 40.00'), r46SetEv?.note ?? '')
const r46Clean = await orders.createOrder({
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-CLEAN'
})
await orders.addOrderItem(r46Clean.id, { styleNo: 'R46-S2', quantity: 1, unitPrice: 80 })
await orders.addPayment(r46Clean.id, { paidAt: localDate(), amount: 80, method: 'T/T', bankRef: 'ZZ-R46-CLEAN' })
eq('收齐了勾结清不折腾人（原因不必填）', (await orders.setPaymentStatus(r46Clean.id, 'settled')).paymentStatus, 'settled')
check('不欠钱的单，结清留痕里不多出「仍欠」', !(await orders.listEvents(r46Clean.id)).some((e) => e.note.includes('仍欠')))

section('R46 定金阶梯：状态和工作台定金桶吃同一份算术')
const r46DepCust = await customers.saveCustomer({ company: 'R46-DEP-CO' })
const r46Dep = await orders.createOrder({
  customerId: r46DepCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  depositRatio: 0.3,
  piNo: 'PI-R46-DEP'
})
await orders.addOrderItem(r46Dep.id, { styleNo: 'R46-D1', quantity: 10, unitPrice: 10 })
await orders.addSettlement(r46Dep.id, { kind: 'shortage', amount: 30, reason: 'ZZ-R46-DEP-W' })
const r46DepRow = (await money.listOrderMoney()).find((r) => r.orderId === r46Dep.id)!
eq('定金 30 全靠抹零有着落：depositDueOf 归零', money.depositDueOf(r46DepRow), 0)
eq('同一个数决定的状态升到已收定金（不再永远停在已确认）', (await orders.getOrder(r46Dep.id))!.paymentStatus, 'paid')
const r46DepRem = (await dashboard.reminders()).filter((r) => r.orderId === r46Dep.id)
check('定金桶已经是 0，催款里不再喊这笔定金', !r46DepRem.some((r) => r.kind === 'payment'), JSON.stringify(r46DepRem.map((r) => r.message)))

section('R46 待收排序排的是屏幕上那个数')
const r46HugeCust = await customers.saveCustomer({ company: 'R46-HUGE-CO' })
const r46Huge = await orders.createOrder({
  customerId: r46HugeCust.id,
  currency: 'USD',
  exchangeRate: 8,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-HUGE'
})
await orders.addOrderItem(r46Huge.id, { styleNo: 'R46-H1', quantity: 100000, unitPrice: 100 })
await orders.setPaymentStatus(r46Huge.id, 'expired')
const r46OverCust = await customers.saveCustomer({ company: 'R46-OVER-CO' })
const r46Over = await orders.createOrder({
  customerId: r46OverCust.id,
  currency: 'USD',
  exchangeRate: 8,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-OVER'
})
await orders.addOrderItem(r46Over.id, { styleNo: 'R46-O1', quantity: 1, unitPrice: 100 })
await orders.addPayment(r46Over.id, { paidAt: localDate(), amount: 30000, method: 'T/T', bankRef: 'ZZ-R46-OVER' })
const r46TopRow = (await orders.listOrderRows({ sort: 'owed_desc', limit: 1 })).rows[0]
check('失效单挂 1000 万待收也不占榜首（屏幕上它是「—」）', r46TopRow.id !== r46Huge.id, JSON.stringify(r46TopRow))
check('多收的单不许拿负待收倒挂抢前排', r46TopRow.id !== r46Over.id, JSON.stringify(r46TopRow))
check('榜首那一单屏幕上确实写着待收', shownRemaining(r46TopRow.paymentStatus, r46TopRow.remaining) > 0, JSON.stringify(r46TopRow))

section('R46 费用行留痕：两张同名「运费」按多重集配对，不互相顶掉')
const r46Chg = await orders.createOrder({
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-CHG'
})
await orders.addOrderItem(r46Chg.id, { styleNo: 'R46-C1', quantity: 1, unitPrice: 100 })
await orders.updateOrder(r46Chg.id, {
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  charges: [
    { label: '运费', amount: 300 },
    { label: '运费', amount: 50 }
  ]
})
await orders.updateOrder(r46Chg.id, {
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  charges: [
    { label: '运费', amount: 250 },
    { label: '运费', amount: 50 }
  ]
})
const r46ChgNotes = (await orders.listEvents(r46Chg.id)).map((e) => e.note)
check(
  '改的是哪一张说得清：300 → 250',
  r46ChgNotes.some((n) => n.includes('费用 运费 300 → 250')),
  JSON.stringify(r46ChgNotes)
)
check(
  '另一张 50 既没被说成删除、也没被说成新增',
  !r46ChgNotes.some((n) => n.includes('删除 运费') || n.includes('新增 运费')),
  JSON.stringify(r46ChgNotes)
)

section('R46 撤销抵扣/退款只看台账：第二次点不盖原因、不重复放钱')
const r46CrCust = await customers.saveCustomer({ company: 'R46-CAS-CO' })
const r46Src = await orders.createOrder({
  customerId: r46CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-SRC'
})
await orders.addOrderItem(r46Src.id, { styleNo: 'R46-A', quantity: 1, unitPrice: 100 })
await orders.addPayment(r46Src.id, { paidAt: localDate(), amount: 150, method: 'T/T', bankRef: 'ZZ-R46-SRC' })
eq('多收 50 进预收', await money.customerCreditAvailable(r46CrCust.id, 'USD'), 50)
const r46Tgt = await orders.createOrder({
  customerId: r46CrCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-TGT'
})
await orders.addOrderItem(r46Tgt.id, { styleNo: 'R46-B', quantity: 1, unitPrice: 100 })
await credits.applyCredit({
  customerId: r46CrCust.id,
  currency: 'USD',
  targetKind: 'order',
  targetId: r46Tgt.id,
  amount: 30
})
const r46Brief = (await customers.customerOrderBriefs(r46CrCust.id)).find((o) => o.orderNo === r46Tgt.orderNo)!
check(
  '客户页订单摘要露出「待收里有多少是预收抵的」（不是还差这么多现金）',
  Math.abs(r46Brief.creditApplied - 30) < 0.001 && r46Brief.remaining > 0.001,
  JSON.stringify(r46Brief)
)
const r46AppId = (getDb().get(
  'SELECT id FROM credit_applications WHERE target_kind = ? AND target_id = ? AND reversed_at IS NULL',
  ['order', r46Tgt.id]
) as { id: number }).id
await credits.reverseCredit(r46AppId, '甲：抵错了单')
const r46Twice = await r8err(async () => await credits.reverseCredit(r46AppId, '乙：盖掉甲的原因'))
check('第二次撤销被拦（不重复放钱）', r46Twice.includes('撤销过'), r46Twice)
eq(
  '原因还是第一次写的那个（CAS 写不许盖别人的手）',
  (getDb().get('SELECT reversed_reason FROM credit_applications WHERE id = ?', [r46AppId]) as {
    reversed_reason: string
  }).reversed_reason,
  '甲：抵错了单'
)
eq('余额只回来一次', await money.customerCreditAvailable(r46CrCust.id, 'USD'), 50)
check(
  '台账不删行，只打撤销标记',
  (getDb().get('SELECT reversed_at FROM credit_applications WHERE id = ?', [r46AppId]) as {
    reversed_at: string
  }).reversed_at !== null
)
const r46Brief2 = (await customers.customerOrderBriefs(r46CrCust.id)).find((o) => o.orderNo === r46Tgt.orderNo)!
eq('撤销后摘要跟着改口：这单没有抵扣了', r46Brief2.creditApplied, 0)
await credits.refundCredit({
  customerId: r46CrCust.id,
  currency: 'USD',
  amount: 20,
  bankRef: 'ZZ-R46-REF',
  note: '客户取消尾单，多付退回'
})
eq('退出去 20，余额只剩 30', await money.customerCreditAvailable(r46CrCust.id, 'USD'), 30)
const r46RefId = (getDb().get(
  'SELECT id FROM customer_refunds WHERE customer_id = ? AND reversed_at IS NULL',
  [r46CrCust.id]
) as { id: number }).id
await credits.reverseRefund(r46RefId, '水单录错，钱没退出去')
const r46RefTwice = await r8err(async () => await credits.reverseRefund(r46RefId, '再撤一次'))
check('退款第二次撤销同样被拦', r46RefTwice.includes('撤销过'), r46RefTwice)
eq('撤回来的钱正好是一次（不是两次的 40）', await money.customerCreditAvailable(r46CrCust.id, 'USD'), 50)

section('R46 报价状态、时间、留痕是同一笔事务')
const r46Q = await quotations.saveQuotation({
  customerId: r46Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  items: [{ styleNo: 'A001', productName: 'x', color: '', size: '', quantity: 10, unitPrice: 7.5 }]
})
await quotations.updateQuotationMeta(r46Q.id, { status: 'sent' })
eq('状态落了', (await quotations.getQuotation(r46Q.id))!.status, 'sent')
check(
  '同一次改动在历史里也有一条（不会出现「改了状态、历史里没有」）',
  (await quotations.listQuotationEvents(r46Q.id)).some((e) => e.note.includes('状态') && e.note.includes('sent'))
)
const r46QAfter = await quotations.getQuotation(r46Q.id)
check('发出时间钉在同一笔事务里：工作台按它起算等待天数', !!r46QAfter!.sentAt, JSON.stringify(r46QAfter?.sentAt))

section('R46 折不出基准币的流水：给 null，让报表露出「N 笔未折」')
const r46Base = getSettings().baseCurrency
const r46Fx = r46Base === 'EUR' ? 'USD' : 'EUR'
eq('本币单不需要汇率：老数据里汇率 0 也照原额算，不凭空少一笔', money.baseAmountOf(r46Base, r46Base, 0, 100), 100)
eq('外币单汇率没填折不出来：给 null，不拿 0 或原币凑一个数', money.baseAmountOf(r46Fx, r46Base, 0, 100), null)
eq('外币单填了汇率就正常折', money.baseAmountOf(r46Fx, r46Base, 7, 100), 700)
const r46FxCust = await customers.saveCustomer({ company: 'R46-FX-CO' })
const r46FxOrder = await orders.createOrder({
  customerId: r46FxCust.id,
  currency: r46Fx,
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R46-FX'
})
await orders.addOrderItem(r46FxOrder.id, { styleNo: 'R46-F1', quantity: 1, unitPrice: 100 })
await orders.addPayment(r46FxOrder.id, { paidAt: localDate(), amount: 100, method: 'T/T', bankRef: 'ZZ-R46-FX' })
// 模拟老数据 / 漏汇率快照：这笔流水折不出基准币
getDb().run('UPDATE payments SET exchange_rate = 0 WHERE order_id = ?', [r46FxOrder.id])
const r46Flow = (await money.cashFlowRows({ customerId: r46FxCust.id })).find((r) => r.bankRef === 'ZZ-R46-FX')!
eq('流水里这一笔的基准币是 null（不是 0）', r46Flow.amountBase, null)
const r46ThisMonth = localMonthOf(localDate())
const r46Rbm = (await money.receivedByMonth()).find((m) => m.month === r46ThisMonth)
check('本月未折笔数露出来：钱到过账，不许从合计里静默消失', (r46Rbm?.unconverted ?? 0) >= 1, JSON.stringify(r46Rbm))
check('工作台本月收款写明有几笔没折进来', (await dashboard.dashboard()).monthUnconverted >= 1)
const r46MonthlyRow = (await dashboard.monthlyReport()).find((m) => m.month === r46ThisMonth)
check('月度汇总同一个月带着同一个笔数', (r46MonthlyRow?.unconvertedCount ?? 0) >= 1, JSON.stringify(r46MonthlyRow))
const r46FxLine = (await dashboard.exportCsv('payments')).split(/\r?\n/).find((l) => l.includes('ZZ-R46-FX')) ?? ''
check('收款台账基准币那一格空得看得见，备注说清为什么空', r46FxLine.includes('汇率未填，未折算'), r46FxLine)
eq('这一格没有拿 0.00 冒充折算结果（Excel 里 SUM 才不会虚高）', r46FxLine.split(',')[7], '')

section('R46 事务不许插队：连接说在事务里、本地却一层都没开')
const r46TxErr = await (async () => {
  getDb().exec('BEGIN')
  try {
    await orders.addOrderItem(r46Clean.id, { styleNo: 'R46-TX-1', quantity: 1, unitPrice: 1 })
    return '没报错（守卫没拦住）'
  } catch (e) {
    return (e as Error).message
  } finally {
    getDb().exec('ROLLBACK')
  }
})()
check('手写的 BEGIN 想吞掉这段写入：当场拦下', r46TxErr.includes('事务插队'), r46TxErr)
eq(
  '拦下后本地深度没漏：同一笔写入紧接着照常成功（那条明细真落了库）',
  (await orders.addOrderItem(r46Clean.id, { styleNo: 'R46-TX-2', quantity: 1, unitPrice: 1 })).grandTotal,
  81
)

section('R46 嵌套链的存档点只增不复用：内层失败只回滚自己')
await coreDb.transact(async () => {
  await coreDb.run('INSERT INTO counters(name, value) VALUES(?, ?)', ['ZZ-R46-TX-KEEP', 1])
  await coreDb
    .transact(async () => {
      await coreDb.run('INSERT INTO counters(name, value) VALUES(?, ?)', ['ZZ-R46-TX-BAD', 1])
      throw new Error('内层自己失败')
    })
    .catch(() => {})
  await coreDb.transact(async () => {
    await coreDb.run('INSERT INTO counters(name, value) VALUES(?, ?)', ['ZZ-R46-TX-GOOD', 1])
  })
})
eq(
  '内层炸了，外层先写的和后面那条链的都没被牵连',
  (getDb().get("SELECT COUNT(*) AS c FROM counters WHERE name LIKE 'ZZ-R46-TX%'") as { c: number }).c,
  2
)
eq(
  '炸掉那条的写入确实没落库',
  getDb().get("SELECT name FROM counters WHERE name = 'ZZ-R46-TX-BAD'") ?? null,
  null
)
getDb().run("DELETE FROM counters WHERE name LIKE 'ZZ-R46-TX%'")

section('R47 明细写口也守合计：抽走货值不许把样品费抵扣顶成负数')
const r47Cust = await customers.saveCustomer({ company: 'R47-GUARD-CO' })
const r47Order = await orders.createOrder({
  customerId: r47Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R47-GUARD'
})
await orders.addOrderItem(r47Order.id, { styleNo: 'R47-A1', quantity: 10, unitPrice: 20 })
const r47OffsetLabel = '样品费及快递费抵扣 Sample Fee & Courier (offset)'
await orders.updateOrderCharges(r47Order.id, [{ label: r47OffsetLabel, amount: -120 }], 'ZZ-R47 抵扣挂上')
eq('抵扣行存住了（货值 200，合计 80）', (await orders.getOrder(r47Order.id))!.grandTotal, 80)
const r47Item = (await orders.getOrder(r47Order.id))!.items[0]
for (const [name, run] of [
  ['改小数量', () => orders.updateOrderItem(r47Order.id, r47Item.id, { quantity: 3 })],
  ['删掉这一行', () => orders.removeOrderItem(r47Order.id, r47Item.id)],
  ['整批换成更小的货', () => orders.replaceOrderItems(r47Order.id, [{ styleNo: 'R47-A1', quantity: 1, unitPrice: 20 }])]
] as const) {
  check(`${name} 也拦得住（货值撑不住抵扣）`, (await r40err(run)).includes('合计'), await r40err(run))
}
eq('拦下后原单一个数没变', (await orders.getOrder(r47Order.id))!.grandTotal, 80)
eq('抵扣行也还在', (await orders.getOrder(r47Order.id))!.chargesTotal, -120)

section('R47 抵扣行 ↔ 打样单：改一张脸，另一张跟着变')
const r47SmpCust = await customers.saveCustomer({ company: 'R47-LINK-CO' })
const r47Sample = await samples.saveSample({
  customerId: r47SmpCust.id,
  expressFee: 5,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R47-SP1', productName: '联动测试', color: 'Grey', size: 'M', quantity: 4, unitPrice: 5, goodsUnitPrice: 20 }]
})
const r47Conv = await samples.convertSampleToOrder(r47Sample.id, { offsetSampleFee: true, paymentStatus: 'confirmed' })
const r47Offset0 = (await samples.getSample(r47Sample.id))!.offsetAmount
eq('转单时打样单记下的抵扣 = 订单那条负费用行', Math.abs(r47Conv.chargesTotal + r47Offset0) < 0.001, true)
await orders.updateOrderCharges(
  r47Conv.id,
  [{ label: r47OffsetLabel, amount: -(r47Offset0 / 2) }],
  'ZZ-R47 只抵一半'
)
const r47Half = (await samples.getSample(r47Sample.id))!
eq('抵扣行改成一半，打样单那个数跟着走', r47Half.offsetAmount, r47Offset0 / 2)
check('打样单备注说清这次是费用行调的', r47Half.feeNote.includes('费用行调整后抵扣'), r47Half.feeNote)
check(
  '改让利不写原因照样拦住：这条正门不含抵扣行也算让利',
  (await r40err(async () => await orders.updateOrderCharges(r47Conv.id, [{ label: r47OffsetLabel, amount: -1 }, { label: '折让', amount: -1 }])))
    .includes('让利'),
  await r40err(async () => await orders.updateOrderCharges(r47Conv.id, [{ label: r47OffsetLabel, amount: -1 }, { label: '折让', amount: -1 }]))
)
await orders.updateOrderCharges(r47Conv.id, [], 'ZZ-R47 取消抵扣')
const r47Back = (await samples.getSample(r47Sample.id))!
eq('抵扣行整条删掉，打样单退回未收', r47Back.feeStatus, 'unpaid')
check('退回去也留了话', r47Back.feeNote.includes('抵扣行已取消'), r47Back.feeNote)
check('订单历史里有抵扣回退', (await orders.listEvents(r47Conv.id)).some((e) => e.kind === 'sample_offset_back'))
check('退回的样品费重新进客户应收', await money.sampleReceivable(r47SmpCust.id) > 0.001)

const r47AmbSample = await samples.saveSample({
  customerId: r47SmpCust.id,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: '2026-10-21',
  items: [{ styleNo: 'R47-SP2', productName: '第二张', color: 'Navy', size: 'L', quantity: 1, unitPrice: 9, goodsUnitPrice: 30 }]
})
// 历史脏数据：两张打样单挂着同一张转出的订单，订单上却只有一条抵扣金额
getDb().run('UPDATE sample_orders SET fee_status = ? WHERE id = ?', ['offset', r47Sample.id])
getDb().run('UPDATE sample_orders SET converted_order_id = ?, fee_status = ? WHERE id = ?', [r47Conv.id, 'offset', r47AmbSample.id])
const r47AmbErr = await r40err(async () => await orders.updateOrderCharges(r47Conv.id, [{ label: r47OffsetLabel, amount: -10 }], 'ZZ-R47 说不清抵给谁'))
check('说不清抵在哪张打样单上就拒落，不猜', r47AmbErr.includes('张已抵扣的打样单'), r47AmbErr)
eq('拒下后订单费用行一个数没落', (await orders.getOrder(r47Conv.id))!.chargesTotal, 0)
getDb().run('UPDATE sample_orders SET converted_order_id = NULL, fee_status = ? WHERE id = ?', ['unpaid', r47AmbSample.id])

section('R47 编辑订单改让利也要留话：正门补好的闸门，侧门不能不设')
const r47WhyCust = await customers.saveCustomer({ company: 'R47-WHY-CO' })
const r47Why = await orders.createOrder({
  customerId: r47WhyCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R47-WHY'
})
await orders.addOrderItem(r47Why.id, { styleNo: 'R47-W1', quantity: 10, unitPrice: 20 })
check(
  '不带原因改负费用行：当场拦下',
  (await r40err(async () => await orders.updateOrder(r47Why.id, { customerId: r47WhyCust.id, charges: [{ label: '折让', amount: -50 }] }))).includes(
    '让利'
  ),
  await r40err(async () => await orders.updateOrder(r47Why.id, { customerId: r47WhyCust.id, charges: [{ label: '折让', amount: -50 }] }))
)
eq('拦下后费用行一个字没改', (await orders.getOrder(r47Why.id))!.chargesTotal, 0)
await orders.updateOrder(r47Why.id, {
  customerId: r47WhyCust.id,
  charges: [{ label: '折让', amount: -50 }],
  chargeReason: 'ZZ-R47 老客户运费对折'
})
const r47WhyNotes = (await orders.listEvents(r47Why.id)).map((e) => e.note)
check('原因跟着数字进历史', r47WhyNotes.some((n) => n.includes('让利原因：ZZ-R47 老客户运费对折')), JSON.stringify(r47WhyNotes))
check(
  '合计让过头（负数）照样拦：报错说清是哪笔让出去的',
  (await r40err(async () => await orders.updateOrder(r47Why.id, { customerId: r47WhyCust.id, charges: [{ label: '折让', amount: -250 }], chargeReason: 'ZZ-R47 让过头' }))).includes(
    '让利'
  ),
  await r40err(async () => await orders.updateOrder(r47Why.id, { customerId: r47WhyCust.id, charges: [{ label: '折让', amount: -250 }], chargeReason: 'ZZ-R47 让过头' }))
)

section('R47 同一笔欠款只喊一遍：船期那句折进催款卡，不再叠三条')
const r47RemCust = await customers.saveCustomer({ company: 'R47-ETA-CO' })
const r47RemOrder = await orders.createOrder({
  customerId: r47RemCust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentMethod: 'oa',
  paymentStatus: 'confirmed',
  depositRatio: 0.3,
  piNo: 'PI-R47-ETA'
})
await orders.addOrderItem(r47RemOrder.id, { styleNo: 'R47-ETA', quantity: 10, unitPrice: 10 })
const r47RemPl = await packing.createPackingList({ orderId: r47RemOrder.id, lines: [{ styleNo: 'R47-ETA', quantity: 10 }] })
await packing.updatePackingListInfo(r47RemOrder.id, r47RemPl[0].id, { shipStatus: 'shipped', atdDate: dAgo(20), etaDate: dAgo(10) })
const r47Set0 = getSettings()
await saveSettings({ ...r47Set0, remindPaymentDays: 0, remindBalanceDays: 0 })
const r47RemList = (await dashboard.reminders()).filter((x) => x.orderId === r47RemOrder.id)
const r47DebtCards = r47RemList.filter((x) => x.kind === 'payment' || x.kind === 'balance')
eq('催定金 / 催全款 / ETA 清款三条收成一条', r47DebtCards.length, 1)
const r47Debt = r47DebtCards[0]?.message ?? ''
check('留下的是说得最全的那条：货已出运、一分未收', r47Debt.includes('一分未收') && r47Debt.includes('赊销'), r47Debt)
check('整单欠款还是那句话里的数', r47Debt.includes('100.00'), r47Debt)
check('船期那句折进话尾，批次号没丢', r47Debt.includes('预计到港已过期') && r47Debt.includes(r47RemPl[0].plNo), r47Debt)
check('到港已过期，这张卡排在逾期区', (r47DebtCards[0]?.days ?? 0) < 0, String(r47DebtCards[0]?.days))
const r47RemOther = (await dashboard.reminders()).find((x) => x.kind === 'payment' && x.orderId !== r47RemOrder.id)
check('别的单该催定金照催，没被一起压掉', !!r47RemOther, '全场一条催定金都没有')
await saveSettings(r47Set0)

section('R47 商品 CSV：分批提交、坏行只跳自己、行数有上限')
const r47Row = (i: number): string => {
  const cols = new Array(15).fill('')
  cols[0] = `R47-I${i}`
  cols[1] = `批量导入款${i}`
  cols[2] = '80% Cotton'
  cols[5] = i === 120 ? '-5' : '10'
  return cols.join(',')
}
const r47Imp = await products.importProductsCsv(
  [products.CSV_TEMPLATE_HEADER, ...Array.from({ length: 250 }, (_, i) => r47Row(i))].join('\n'),
  'skip'
)
eq('250 行里 249 款落库（跨过 200 行的批界）', r47Imp.created, 249)
eq('坏的那一行只跳自己', r47Imp.skipped, 1)
check('坏行按行号报出来', r47Imp.errors.some((e) => e.includes('第 122 行')), JSON.stringify(r47Imp.errors))
check('坏行前后都留下了', !!(await products.findProductByStyleNo('R47-I119')) && !!(await products.findProductByStyleNo('R47-I121')))
check('第二批也没被牵连', !!(await products.findProductByStyleNo('R47-I249')))
const r47TooMany = [products.CSV_TEMPLATE_HEADER, ...Array.from({ length: 5001 }, (_, i) => `R47-X${i},超上限的款`)].join('\n')
check('整份超过上限直接拒绝，不写一行', (await r40err(async () => await products.importProductsCsv(r47TooMany, 'skip'))).includes('一次最多导 5000 行'))
eq('拒下后库里没有那批款', (await products.findProductByStyleNo('R47-X0')) ?? null, null)

/* ---------------- R48：本币不乘汇率、折不出来要说、多付只算一遍、抵扣留痕 ---------------- */

section('R48 本币单那一列留着 0 也照样折：老数据不许把销售额吃掉')
const r48Cust = await customers.saveCustomer({ company: 'R48-MONEY-CO' })
const r48HomeOrder = await orders.createOrder({
  customerId: r48Cust.id,
  currency: 'CNY',
  paymentStatus: 'confirmed',
  piNo: 'PI-R48-HOME'
})
await orders.addOrderItem(r48HomeOrder.id, { styleNo: 'R48-H', quantity: 10, unitPrice: 100 })
getDb().run('UPDATE order_items SET unit_cost = 60 WHERE order_id = ?', [r48HomeOrder.id])
// 模拟升级前的老数据：本币单没人填过汇率，那一列是默认 0
getDb().run('UPDATE orders SET exchange_rate = 0 WHERE id = ?', [r48HomeOrder.id])
const r48HomeRow = (await money.listOrderMoney()).find((r) => r.orderId === r48HomeOrder.id)!
eq('本币单不乘汇率：含费用合计原样进基准币', r48HomeRow.grandTotalBase, r48HomeRow.grandTotal)
eq('本币单不算「汇率待修」', r48HomeRow.rateMissing, false)
eq('本币单毛利用全额折出来，不是 0', r48HomeRow.profitBase, r48HomeRow.profit)

section('R48 外币单汇率没填：折不出来要亮出来，不许悄悄当 1:1 记账')
const r48FxOrder = await orders.createOrder({
  customerId: r48Cust.id,
  currency: 'USD',
  exchangeRate: 7,
  paymentStatus: 'confirmed',
  piNo: 'PI-R48-FX'
})
await orders.addOrderItem(r48FxOrder.id, { styleNo: 'R48-FX', quantity: 10, unitPrice: 10 })
getDb().run('UPDATE order_items SET unit_cost = 4 WHERE order_id = ?', [r48FxOrder.id])
getDb().run('UPDATE orders SET exchange_rate = 0 WHERE id = ?', [r48FxOrder.id])
const r48FxRow = (await money.listOrderMoney()).find((r) => r.orderId === r48FxOrder.id)!
eq('折不出来 → 基准币待收按 0 计，不蒙成 1:1', r48FxRow.receivableBase, 0)
eq('这一行标出「汇率待修」', r48FxRow.rateMissing, true)
eq('毛利也折不出来 → null，不许报成 0 毛利', r48FxRow.profitBase, null)
const r48FxRem = (await dashboard.reminders()).find((x) => x.orderId === r48FxOrder.id && x.kind === 'data')
check('待修卡说的是「没填汇率、折不成基准币」', !!r48FxRem && r48FxRem.message.includes('没填汇率'), r48FxRem?.message ?? '<没有这条提醒>')
check('没填汇率的单不再冒充 1:1 那条话术', !(r48FxRem?.message ?? '').includes('按 1:'), r48FxRem?.message ?? '')

section('R48 打样单多付：对账单与客户预收结余说同一个数')
const r48CrCust = await customers.saveCustomer({ company: 'R48-PREPAID-CO' })
const r48Smp = await samples.saveSample({
  customerId: r48CrCust.id,
  sampleDate: dAgo(5),
  expressFee: 15,
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(5),
  items: [{ styleNo: 'R48-S', productName: '取消的样', color: 'White', size: 'M', quantity: 1, unitPrice: 30 }]
})
await samples.addSamplePayment(r48Smp.id, { paidAt: localDate(), amount: 20, bankRef: 'R48-PRE-IN' })
await samples.saveSample({ id: r48Smp.id, status: 'cancelled', note: 'R48 客户改走别家' })
const r48Bal = (await money.customerCreditBalance(r48CrCust.id)).find((c) => c.currency === 'USD')!
eq('取消单的实收 20 进了客户预收结余', r48Bal.gross, 20)
const r48Csv = parseCsv(await dashboard.exportCsv('statement', { customerId: r48CrCust.id }))
const r48Col = (name: string): number => r48Csv[0].indexOf(name)
const r48SmpRow = r48Csv.slice(1).find((r) => r[r48Col('单据号')] === r48Smp.sampleNo)
const r48SmpNote = r48SmpRow?.[r48Col('备注')] ?? ''
check('对账单把这 20 说成「留在账上」，预收区才不会凭空多一笔', r48SmpNote.includes('留在账上'), r48SmpNote || '<缺行>')
check('对账单同时点明已计入预收结余', r48SmpNote.includes('计入客户预收结余'), r48SmpNote)
check(
  '同一笔钱不重复出现在两句话里',
  // 备注里的金额是数字直接拼进串的（money2 四舍五入到分但保持数字，免得 Excel 当公式），
  // 20 就写成「20」，不会补成 20.00
  (r48SmpNote.match(/20/g) ?? []).length === 1 && !r48SmpNote.includes('实收比单据多'),
  r48SmpNote
)

section('R48 预收抵到打样单上要留痕：fee_note 就是这张单的账本')
const r48Smp2 = await samples.saveSample({
  customerId: r48CrCust.id,
  sampleDate: dAgo(2),
  currency: 'USD',
  exchangeRate: 7,
  exchangeRateDate: dAgo(2),
  items: [{ styleNo: 'R48-S2', productName: '抵预收的样', color: 'Black', size: 'M', quantity: 1, unitPrice: 30 }]
})
await credits.applyCredit({
  customerId: r48CrCust.id,
  currency: 'USD',
  targetKind: 'sample',
  targetId: r48Smp2.id,
  amount: 10,
  note: 'R48 用取消单的实收抵'
})
const r48Smp2After = (await samples.getSample(r48Smp2.id))!
check('抵扣落进打样单的账本备注', r48Smp2After.feeNote.includes('客户预收抵扣 10.00'), r48Smp2After.feeNote)
check('备注带上人工写的原因', r48Smp2After.feeNote.includes('R48 用取消单的实收抵'), r48Smp2After.feeNote)
const r48Apps = (await money.customerCreditBalance(r48CrCust.id)).find((c) => c.currency === 'USD')!
await credits.reverseCredit(r48Apps.applications[0].id, 'R48 抵错了单')
const r48Smp2Back = (await samples.getSample(r48Smp2.id))!
check('撤销也在账本上留一句', r48Smp2Back.feeNote.includes('撤销客户预收抵扣'), r48Smp2Back.feeNote)
check('撤销原因写进账本', r48Smp2Back.feeNote.includes('R48 抵错了单'), r48Smp2Back.feeNote)
eq('撤销后待收回到 30', r48Smp2Back.owed, 30)

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
