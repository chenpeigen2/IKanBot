(async () => {
  const L = []
  const log = (k, v) => L.push(k + ' = ' + JSON.stringify(v))
  try {
    const custs = await window.api.customers.list()
    const cust = custs[0]
    log('customer', { id: cust.id, company: cust.company })

    // ---- 建一单 ----
    const o = await window.api.orders.create({
      customerId: cust.id,
      currency: 'USD',
      exchangeRate: 7.15,
      exchangeRateDate: '2026-10-21',
      depositRatio: 0.3,
      incoterm: 'FOB',
      portOfLoading: 'Ningbo',
      portOfDestination: 'Hamburg',
      paymentMethod: 'T/T',
      customerPo: 'R6TEST',
      expectedShipDate: '2026-11-30',
      charges: []
    })
    log('created', { id: o.id, no: o.orderNo, status: o.paymentStatus })

    // ---- 加明细 1000 件 @ 8 = 8000 ----
    await window.api.orders.addItem(o.id, {
      styleNo: 'R6-TS', productName: 'T shirt', color: 'Black', size: 'M',
      quantity: 1000, unitPrice: 8, unitCost: 4
    })
    let cur = await window.api.orders.get(o.id)
    log('afterAddItem', { total: cur.grandTotal, goods: cur.totalAmount, status: cur.paymentStatus, deposit: cur.depositAmount })

    // ---- 记定金 2400 ----
    await window.api.orders.addPayment(o.id, { amount: 2400, method: 'T/T', paidAt: '2026-10-21', bankRef: 'R6BANK001' })
    cur = await window.api.orders.get(o.id)
    log('afterPayment2400', { status: cur.paymentStatus, receivable: cur.receivable, paid: cur.paidAmount })

    // ---- 客户加单：数量 1000 -> 1500 ----
    const itemId = cur.items[0].id
    await window.api.orders.updateItem(o.id, itemId, { quantity: 1500 })
    cur = await window.api.orders.get(o.id)
    log('afterQty1500', { total: cur.grandTotal, deposit: cur.depositAmount, receivable: cur.receivable, status: cur.paymentStatus })

    // ---- 再加一行 ----
    await window.api.orders.addItem(o.id, {
      styleNo: 'R6-TS', productName: 'T shirt', color: 'White', size: 'L',
      quantity: 500, unitPrice: 8, unitCost: 4
    })
    cur = await window.api.orders.get(o.id)
    log('afterAddSecondItem', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    // ---- 删掉第二行 ----
    const item2 = cur.items[cur.items.length - 1].id
    await window.api.orders.removeItem(o.id, item2)
    cur = await window.api.orders.get(o.id)
    log('afterRemoveSecondItem', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    // ---- 减单：1500 -> 1000，应回到 paid ----
    await window.api.orders.updateItem(o.id, itemId, { quantity: 1000 })
    cur = await window.api.orders.get(o.id)
    log('afterQtyBack1000', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    // ---- 减到收超：1000 -> 100 (total 800 < paid 2400) ----
    await window.api.orders.updateItem(o.id, itemId, { quantity: 100 })
    cur = await window.api.orders.get(o.id)
    log('afterQty100', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    // ---- 恢复 1000 ----
    await window.api.orders.updateItem(o.id, itemId, { quantity: 1000 })
    cur = await window.api.orders.get(o.id)
    log('restore1000', { total: cur.grandTotal, status: cur.paymentStatus })

    // ---- 操作历史 ----
    const evs = await window.api.orders.events(o.id)
    log('events', evs.map(e => e.action + ':' + e.message))

    // ---- N28: 有钱有明细的订单能不能删 ----
    let delErr = null
    try { await window.api.orders.remove(o.id) } catch (e) { delErr = String(e && e.message || e) }
    log('deleteOrderWithPayments', delErr)
    log('orderStillThere', !!(await window.api.orders.get(o.id)))

    // ---- N31: 报价单转订单后能不能删 ----
    const q = await window.api.quotations.save({
      customerId: cust.id, currency: 'USD', exchangeRate: 7.15, depositRatio: 0.3,
      incoterm: 'FOB', portOfLoading: 'Ningbo', portOfDestination: 'Hamburg',
      items: [{ styleNo: 'R6-Q', productName: 'hoodie', color: 'Grey', size: 'L', quantity: 100, unitPrice: 20 }]
    })
    const converted = await window.api.quotations.convert(q.id, { paymentStatus: 'draft' })
    log('quotationConverted', { qid: q.id, oid: converted.id })
    let qDelErr = null
    try { await window.api.quotations.remove(q.id) } catch (e) { qDelErr = String(e && e.message || e) }
    log('deleteConvertedQuotation', qDelErr)
    log('quotationStillThere', !!(await window.api.quotations.get(q.id)))

    // ---- N32: 删有订单的客户 ----
    let cDelErr = null
    try { await window.api.customers.remove(cust.id) } catch (e) { cDelErr = String(e && e.message || e) }
    log('deleteCustomerWithOrders', cDelErr)

    // ---- 作废订单后，待收/销售额是否排除 ----
    const dashBefore = await window.api.dashboard.stats()
    log('dashBeforeVoid', { pending: dashBefore.pending_amount, sales: dashBefore.month_sales, profit: dashBefore.monthProfit })
    await window.api.orders.void(o.id, 'R6 测试作废')
    const dashAfter = await window.api.dashboard.stats()
    log('dashAfterVoid', { pending: dashAfter.pending_amount, sales: dashAfter.month_sales, profit: dashAfter.monthProfit })
    const cur2 = await window.api.orders.get(o.id)
    log('voidedOrder', { status: cur2.paymentStatus, receivable: cur2.receivable })

    log('R6_ORDER_ID', o.id)
    log('R6_QUOTATION_ID', q.id)
  } catch (e) {
    log('FATAL', String(e && e.stack || e))
  }
  console.log('R6RESULT ' + JSON.stringify(L, null, 1))
  return L.join('\n')
})()
