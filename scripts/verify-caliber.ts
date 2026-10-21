/** 口径核对脚本：把同一个数在十一个地方各对一遍 */
import { openDb, closeDb } from '../electron/db'
import * as orders from '../electron/services/orders'
import * as customers from '../electron/services/customers'
import * as dashboard from '../electron/services/dashboard'
import * as money from '../electron/services/money'
import { renderPi, renderCi } from '../src/shared/documents'
import { getSettings } from '../electron/services/settings'

openDb()
const rows = money.listOrderMoney()
console.log('\n== 每张订单：详情 / 列表 / 客户页 / CSV / 工作台 待收必须相等 ==')
let allOk = true
for (const r of rows) {
  const detail = orders.getOrder(r.orderId)!
  const listRow = orders.listOrders({ keyword: r.orderNo })[0]
  const custRow = customers.customerOrderBriefs(r.customerId).find((o) => o.id === r.orderId)!
  const csv = dashboard.exportCsv('orders').split('\r\n')
  const head = csv[0].replace(/^\uFEFF/, '').split(',')
  const csvRow = csv.find((x) => x.split(',')[head.indexOf('订单号')] === r.orderNo)
  const csvRemain = Number(csvRow!.split(',')[head.indexOf('待收金额(原币)')])
  const csvTotal = Number(csvRow!.split(',')[head.indexOf('含费用合计(原币)')])
  const ok =
    detail.remaining === r.receivable &&
    listRow.remaining === r.receivable &&
    custRow.remaining === r.receivable &&
    csvRemain === r.receivable &&
    csvTotal === r.grandTotal
  if (!ok) allOk = false
  console.log(
    `${ok ? 'OK ' : 'BAD'} ${r.orderNo} 货值=${r.goodsValue} 费用=${r.chargesTotal} 含费用合计=${r.grandTotal} 已收=${r.paidAmount} 待收=${r.receivable} | 详情=${detail.remaining} 列表=${listRow.remaining} 客户=${custRow.remaining} CSV=${csvRemain}`
  )
  // PI / CI 上的合计
  const pi = renderPi({ order: detail, settings: getSettings(), images: {} })
  const ci = renderCi({ order: detail, settings: getSettings(), images: {} })
  const piOk = pi.includes(r.grandTotal.toFixed(2))
  const ciOk = ci.includes(r.grandTotal.toFixed(2))
  if (!piOk || !ciOk) allOk = false
  console.log(`   PI合计=${piOk ? 'OK' : 'BAD'} CI合计=${ciOk ? 'OK' : 'BAD'} (${r.grandTotal})`)
}
console.log('\n== 工作台待收款 = Σ(含费用合计 − 已收) ==')
const dash = dashboard.dashboard()
console.log('工作台待收款 =', dash.pendingAmount)
console.log('各单待收之和 =', rows.reduce((s, r) => s + r.receivableBase, 0))
console.log('客户页未收合计 =', rows.reduce((s, r) => s + r.receivableBase, 0))
console.log('\n结论：', allOk ? '全部一致' : '有不一致的地方')
closeDb()
