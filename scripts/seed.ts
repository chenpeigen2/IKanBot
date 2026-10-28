/**
 * 往真实数据库灌入一份演示数据（便于查看真实渲染效果）。
 * 运行： node scripts/build-seed.cjs && node out/test/seed.cjs
 */
import { openDb, closeDb, dataDir } from '../electron/db'
import * as products from '../electron/services/products'
import * as customers from '../electron/services/customers'
import * as orders from '../electron/services/orders'
import * as quotations from '../electron/services/quotations'
import * as samples from '../electron/services/samples'
import * as packing from '../electron/services/packing'
import { getSettings, saveSettings } from '../electron/services/settings'
import { renderPi, renderPl, renderQuotation } from '../src/shared/documents'
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

async function main() {
  openDb()

  // 清空演示数据
  const db = (await import('../electron/db')).getDb()
  db.exec('DELETE FROM quotations')
  db.exec('DELETE FROM sample_orders')
  db.exec('DELETE FROM orders')
  db.exec('DELETE FROM customers')
  db.exec('DELETE FROM products')
  db.exec('DELETE FROM counters')

  // 清空演示数据（含图片关联）
  db.exec('DELETE FROM product_images')

  // 商品
  const tshirt = products.saveProduct({
    styleNo: 'TS-001',
    name: '纯棉圆领短袖T恤',
    composition: '100% Cotton / 纯棉',
    category: 'T恤',
    brand: 'IKAN',
    season: 'SS26',
    costPrice: 4.2,
    sizes: ['S', 'M', 'L', 'XL'],
    colors: ['Black', 'White', 'Navy']
  })
  const polo = products.saveProduct({
    styleNo: 'PL-002',
    name: '涤纶珠地POLO衫',
    composition: '95% Polyester 5% Spandex / 涤纶氨纶',
    category: 'POLO衫',
    brand: 'IKAN',
    season: 'SS26',
    costPrice: 8.5,
    sizes: ['M', 'L', 'XL'],
    colors: ['Navy', 'Red']
  })
  const shirt = products.saveProduct({
    styleNo: 'SH-003',
    name: '牛津纺商务长袖衬衫',
    composition: '100% Cotton Oxford / 牛津纺纯棉',
    category: '衬衫',
    brand: 'IKAN',
    season: 'AW25',
    costPrice: 12,
    sizes: ['39', '40', '41', '42'],
    colors: ['Light Blue', 'White']
  })

  // 给商品挂上示例图片（若无图片文件则跳过）
  const sampleImages: Record<string, string> = {
    'TS-001': 'seed-ts001.png',
    'PL-002': 'seed-pl002.png',
    'SH-003': 'seed-sh003.png'
  }
  for (const [styleNo, file] of Object.entries(sampleImages)) {
    const p = products.listProducts(styleNo).find((x) => x.styleNo === styleNo)
    if (!p) continue
    if (!existsSync(join((await import('../electron/db')).imagesDir(), file))) continue
    products.addProductImage(p.id, file, true)
  }

  // 客户
  const c1 = await customers.saveCustomer({
    company: 'Acme Fashion GmbH',
    contact: 'Michael Schmidt',
    attn: 'Mr. Schmidt',
    email: 'm.schmidt@acme-fashion.de',
    phone: '+49 40 1234 5678',
    country: 'Germany',
    address: 'Musterstrasse 88, Hamburg',
    zipCode: '20095',
    paymentPref: 'T/T 30% 定金，70% 见提单副本',
    note: '要求所有款式左胸印 Logo，色牢度 4 级以上。'
  })
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

  // 设置公司信息与银行
  const s = getSettings()
  saveSettings({
    ...s,
    company: {
      name: 'IKAN TRADING CO., LTD',
      address: 'Room 1802, Tianhe Business Building, Guangzhou, Guangdong, China',
      phone: '+86 20 8888 6666',
      email: 'sales@ikan-trading.com',
      website: 'www.ikan-trading.com'
    },
    banks: [
      {
        currency: 'USD',
        bankName: 'Bank of China, Guangzhou Branch',
        accountName: 'IKAN TRADING CO., LTD',
        accountNo: '6011 2233 4455 6677',
        swift: 'BKCHCNBJGUA',
        address: 'No. 136 Huan Shi Dong Road, Guangzhou, Guangdong, China'
      }
    ]
  })

  // 订单 1：进行中，已确认部分收款
  const o1 = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    baseCurrency: 'CNY',
    incoterm: 'FOB',
    portOfLoading: 'Ningbo',
    portOfDestination: 'Hamburg',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'PO-ACME-2026-0417',
    charges: [
      { label: '运费 Freight', amount: 200 },
      { label: '保险费 Insurance', amount: 30 }
    ],
    expectedShipDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    expectedArrivalDate: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10),
    factory: '袜厂王老板',
    factoryDueDate: new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10),
    cutOffDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
    etdDate: new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10),
    vessel: 'MAERSK HMM V.034E',
    sealNo: 'CN7821345',
    note: '左胸印 Logo，黑色款需加急，7 月 10 日前交货。'
  })
  let cur = o1
  for (const it of [
    { productId: tshirt.id, styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', composition: '100% Cotton', color: 'Black', size: 'S', quantity: 200, unitPrice: 7.5, unitCost: 4.2 },
    { productId: tshirt.id, styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', composition: '100% Cotton', color: 'Black', size: 'M', quantity: 300, unitPrice: 7.5, unitCost: 4.2 },
    { productId: tshirt.id, styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', composition: '100% Cotton', color: 'White', size: 'M', quantity: 250, unitPrice: 7.8, unitCost: 4.2 },
    { productId: polo.id, styleNo: 'PL-002', productName: '涤纶珠地POLO衫', composition: '95% Polyester', color: 'Navy', size: 'L', quantity: 150, unitPrice: 12.5, unitCost: 8.5 }
  ]) {
    cur = await orders.addOrderItem(o1.id, it)
  }
  orders.setPaymentStatus(o1.id, 'confirmed')
  cur = await orders.addPayment(o1.id, { paidAt: '2026-03-18', amount: 3000, method: 'T/T', bankRef: 'HSBC2303188842', note: '定金' })
  orders.setShipStatus(o1.id, 'preparing')

  // 装箱单
  packing.createPackingList({
    orderId: o1.id,
    containerNo: 'MSKU4471882',
    note: '40HQ 柜，装柜前需熏蒸',
    lines: [
      { boxNo: 'NO.1', styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', color: 'Black', size: 'S', quantity: 200, netWeight: 24, boxLength: 60, boxWidth: 40, boxHeight: 50 },
      { boxNo: 'NO.2', styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', color: 'Black', size: 'M', quantity: 300, netWeight: 36, boxLength: 60, boxWidth: 40, boxHeight: 50 },
      { boxNo: 'NO.3', styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', color: 'White', size: 'M', quantity: 250, netWeight: 30, boxLength: 60, boxWidth: 40, boxHeight: 50 },
      { boxNo: 'NO.4', styleNo: 'PL-002', productName: '涤纶珠地POLO衫', color: 'Navy', size: 'L', quantity: 150, netWeight: 27, boxLength: 60, boxWidth: 40, boxHeight: 50 }
    ]
  })

  // 报价单 1：还没成交的报价（不进销售额）
  quotations.saveQuotation({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Ningbo',
    portOfDestination: 'Hamburg',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'RFQ-ACME-2026-1020',
    note: '客户要求 11 月底前交货。',
    charges: [
      { label: '运费 Freight', amount: 200 },
      { label: '保险费 Insurance', amount: 30 }
    ],
    items: [
      {
        productId: tshirt.id,
        styleNo: 'TS-001',
        productName: '纯棉圆领短袖T恤',
        composition: '100% Cotton',
        color: 'Black',
        size: 'M',
        quantity: 500,
        unitPrice: 7.5
      },
      {
        productId: tshirt.id,
        styleNo: 'TS-001',
        productName: '纯棉圆领短袖T恤',
        composition: '100% Cotton',
        color: 'White',
        size: 'L',
        quantity: 200,
        unitPrice: 7.8
      }
    ]
  })

  // 订单 2：已结清已签收
  const o2 = orders.createOrder({
    customerId: c2.id,
    currency: 'USD',
    exchangeRate: 7.15,
    baseCurrency: 'CNY',
    incoterm: 'CIF',
    portOfLoading: 'Shanghai',
    portOfDestination: 'Stockholm',
    paymentMethod: 'tt_full',
    depositRatio: 1,
    customerPo: 'NW-88012',
    expectedShipDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    expectedArrivalDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  })
  cur = o2
  for (const it of [
    { productId: shirt.id, styleNo: 'SH-003', productName: '牛津纺商务长袖衬衫', composition: '100% Cotton Oxford', color: 'Light Blue', size: '40', quantity: 120, unitPrice: 19.5, unitCost: 12 },
    { productId: shirt.id, styleNo: 'SH-003', productName: '牛津纺商务长袖衬衫', composition: '100% Cotton Oxford', color: 'White', size: '41', quantity: 80, unitPrice: 19.5, unitCost: 12 }
  ]) {
    cur = await orders.addOrderItem(o2.id, it)
  }
  orders.setPaymentStatus(o2.id, 'confirmed')
  await orders.addPayment(o2.id, { paidAt: '2026-02-20', amount: cur.totalAmount, method: 'T/T', bankRef: 'SEB2202201199' })
  orders.setShipStatus(o2.id, 'packed')
  orders.setShipStatus(o2.id, 'shipped')
  orders.setShipStatus(o2.id, 'cleared')
  orders.setShipStatus(o2.id, 'delivered')

  // 订单 3：草稿，待确认
  const o3 = orders.createOrder({
    customerId: c1.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Ningbo',
    portOfDestination: 'Hamburg',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'PO-ACME-2026-0522'
  })
  cur = o3
  for (const it of [
    { productId: tshirt.id, styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', composition: '100% Cotton', color: 'Navy', size: 'L', quantity: 400, unitPrice: 7.8, unitCost: 4.2 }
  ]) {
    cur = await orders.addOrderItem(o3.id, it)
  }
  orders.setPaymentStatus(o3.id, 'sent')

  // 订单 4：客户临时加的款号，成本还没录（毛利显示「—」，不给你一个假数字）
  const o4 = orders.createOrder({
    customerId: c2.id,
    currency: 'USD',
    exchangeRate: 7.15,
    incoterm: 'FOB',
    portOfLoading: 'Shanghai',
    portOfDestination: 'Stockholm',
    paymentMethod: 'tt_deposit',
    depositRatio: 0.3,
    customerPo: 'NW-TEMP-01'
  })
  await orders.addOrderItem(o4.id, {
    styleNo: 'TS-900',
    productName: '客户临时加的款号',
    color: 'Black',
    size: 'M',
    quantity: 100,
    unitPrice: 8.5
  })
  orders.setPaymentStatus(o4.id, 'confirmed')

  // 导出单据 HTML 供人工查看
  const full = orders.getOrder(o1.id)!
  const settings = getSettings()
  const images: Record<string, string> = {}
  for (const p of [tshirt, polo, shirt]) {
    const imgs = products.listProductImages(p.id)
    const primary = imgs.find((i) => i.isPrimary) ?? imgs[0]
    if (!primary) continue
    const f = join((await import('../electron/db')).imagesDir(), primary.fileName)
    if (existsSync(f)) {
      images[p.styleNo] = `data:image/png;base64,${readFileSync(f).toString('base64')}`
    }
  }
  const dir = join(process.cwd(), 'out', 'shots')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pi.html'), renderPi({ order: full, settings, images }))
  writeFileSync(join(dir, 'pl.html'), renderPl({ order: full, settings, images: {} }, full.packingLists[0]))
  const qlist = quotations.listQuotations()
  if (qlist[0]) {
    writeFileSync(join(dir, 'quotation.html'), renderQuotation({ quotation: qlist[0], settings, images: {} }))
  }
  // 打样单（样品单）：客户要打样，公司先垫快递费。
  // 寄出日期故意放 45 天前：样品费没收 + 超阈值 → 工作台「催打样费」青色圆点常驻，随时可抽查（r12）
  const shipped45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
  const sample = samples.saveSample({
    customerId: c1.id,
    sampleDate: shipped45,
    courier: '顺丰',
    trackingNo: 'SF7788990011',
    expressFee: 120,
    status: 'sent',
    note: '客户确认：黑色 M 码两件、POLO 藏青 L 一件。',
    currency: 'USD',
    exchangeRate: 7.15,
    exchangeRateDate: shipped45,
    factoryCost: 30,
    shippedAt: shipped45,
    items: [
      { styleNo: 'TS-001', productName: '纯棉圆领短袖T恤', color: 'Black', size: 'M', quantity: 2, unitPrice: 15 },
      { styleNo: 'PL-002', productName: '涤纶珠地POLO衫', color: 'Navy', size: 'L', quantity: 1, unitPrice: 20 }
    ]
  })

  console.log('seeded: orders', [o1.id, o2.id, o3.id, o4.id].join(','))
  console.log('seeded: sample', sample.sampleNo)
  // 说清楚数据写到哪儿去了：设了 IKAN_DATA_DIR 就是程序正在用的目录，没设才是临时目录
  const dataPath = dataDir()
  if (process.env['IKAN_DATA_DIR']) {
    console.log(`演示数据已写入你指定的 data 目录：${dataPath}`)
    console.log('程序里现在就能看到这些数据。（会清空该目录里的订单/客户/商品，请先备份。）')
  } else {
    console.log(`演示数据已写入：${dataPath}`)
    console.log(
      '提示：这是临时目录，程序里看不到这些数据。' +
        '要重建演示数据，请设 IKAN_DATA_DIR=<项目>/data 再跑一次 npm run seed（会清空该目录里的订单/客户/商品，请先备份）。'
    )
  }

  closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
