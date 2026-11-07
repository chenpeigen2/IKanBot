/**
 * 截图矩阵用：在 seed 之后补造 seed 里没有的收款状态（草稿/部分收款/已失效/已作废）。
 * 走服务层而不是 SQL 硬改，保证状态流转、事件日志都是真实路径产生的。
 * 运行： node scripts/build-uishots.cjs && IKAN_DATA_DIR=<项目>/data node out/test/ui-shots-status.cjs
 */
import { openDb, closeDb } from '../electron/db'
import * as products from '../electron/services/products'
import * as customers from '../electron/services/customers'
import * as orders from '../electron/services/orders'

async function main() {
  openDb()
  const tshirt = (await products.listProducts('TS-001'))[0]
  const c1 = (await customers.listCustomers('Acme'))[0]
  const c2 = (await customers.listCustomers('Nordic'))[0]
  if (!tshirt || !c1 || !c2) throw new Error('请先跑 seed：npm run seed（IKAN_DATA_DIR=<项目>/data）')

  // ① 草稿：createOrder 不动状态就是 draft
  const d1 = await orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Ningbo',
    portOfDestination: 'Hamburg',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'PO-ACME-DRAFT'
  })
  await orders.addOrderItem(d1.id, {
    productId: tshirt.id,
    styleNo: 'TS-001',
    productName: '纯棉圆领短袖T恤',
    composition: '100% Cotton',
    color: 'Navy',
    size: 'L',
    quantity: 100,
    unitPrice: 7.6,
    unitCost: 4.2
  })
  console.log('draft order', d1.id)

  // ② 部分收款：确认后收一笔低于定金的钱 → partial
  const p1 = await orders.createOrder({
    customerId: c2.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Shanghai',
    portOfDestination: 'Stockholm',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'NW-PARTIAL'
  })
  const withItem = await orders.addOrderItem(p1.id, {
    productId: tshirt.id,
    styleNo: 'TS-001',
    productName: '纯棉圆领短袖T恤',
    composition: '100% Cotton',
    color: 'White',
    size: 'M',
    quantity: 200,
    unitPrice: 7.5,
    unitCost: 4.2
  })
  await orders.setPaymentStatus(p1.id, 'confirmed')
  await orders.addPayment(p1.id, {
    paidAt: '2026-11-01',
    amount: 500,
    method: 'T/T',
    bankRef: 'SF9000111222',
    note: '头一笔，定金还差一截'
  })
  console.log('partial order', p1.id)

  // ③ 已失效：确认后改失效（账上没挂东西，原因可留）
  const e1 = await orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Ningbo',
    portOfDestination: 'Hamburg',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'PO-ACME-EXPIRED'
  })
  await orders.addOrderItem(e1.id, {
    productId: tshirt.id,
    styleNo: 'TS-001',
    productName: '纯棉圆领短袖T恤',
    composition: '100% Cotton',
    color: 'Black',
    size: 'XL',
    quantity: 80,
    unitPrice: 7.9,
    unitCost: 4.2
  })
  await orders.setPaymentStatus(e1.id, 'sent')
  await orders.setPaymentStatus(e1.id, 'expired')
  console.log('expired order', e1.id)

  // ④ 已作废：走 voidOrder 正门，记录全留
  const v1 = await orders.createOrder({
    customerId: c2.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Shanghai',
    portOfDestination: 'Stockholm',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'NW-VOID'
  })
  await orders.addOrderItem(v1.id, {
    productId: tshirt.id,
    styleNo: 'TS-001',
    productName: '纯棉圆领短袖T恤',
    composition: '100% Cotton',
    color: 'Red',
    size: 'S',
    quantity: 60,
    unitPrice: 7.4,
    unitCost: 4.2
  })
  await orders.voidOrder(v1.id, '客户取消，演示数据')
  console.log('void order', v1.id)

  closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
