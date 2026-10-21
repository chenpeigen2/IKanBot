(async () => {
  const L = []
  const log = (k, v) => L.push(k + ' = ' + JSON.stringify(v))
  try {
    const dash0 = await window.api.dashboard.stats()
    log('dashboardRaw', dash0)

    const custs = await window.api.customers.list()
    const cust = custs[0]

    const o = await window.api.orders.create({
      customerId: cust.id,
      currency: 'USD', exchangeRate: 7.15, exchangeRateDate: '2026-10-21',
      depositRatio: 0.3, incoterm: 'FOB', portOfLoading: 'Ningbo', portOfDestination: 'Hamburg',
      paymentMethod: 'T/T', customerPo: 'R6TEST2', expectedShipDate: '2026-11-30',
      charges: [], paymentStatus: 'confirmed'
    })
    log('created', { id: o.id, no: o.orderNo, status: o.paymentStatus })

    await window.api.orders.addItem(o.id, {
      styleNo: 'R6-TS', productName: 'T shirt', color: 'Black', size: 'M',
      quantity: 1000, unitPrice: 8, unitCost: 4
    })
    let cur = await window.api.orders.get(o.id)
    log('A_afterAddItem', { total: cur.grandTotal, status: cur.paymentStatus, deposit: cur.depositAmount, receivable: cur.receivable })

    await window.api.orders.addPayment(o.id, { amount: 2400, method: 'T/T', paidAt: '2026-10-21', bankRef: 'R6BANK002' })
    cur = await window.api.orders.get(o.id)
    log('B_afterPayment2400', { status: cur.paymentStatus, receivable: cur.receivable, paid: cur.paidAmount })

    const itemId = cur.items[0].id
    await window.api.orders.updateItem(o.id, itemId, { quantity: 1500 })
    cur = await window.api.orders.get(o.id)
    log('C_afterQty1500', { total: cur.grandTotal, deposit: cur.depositAmount, receivable: cur.receivable, status: cur.paymentStatus })

    await window.api.orders.addItem(o.id, {
      styleNo: 'R6-TS', productName: 'T shirt', color: 'White', size: 'L',
      quantity: 500, unitPrice: 8, unitCost: 4
    })
    cur = await window.api.orders.get(o.id)
    log('D_afterAddSecondItem', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    const item2 = cur.items[cur.items.length - 1].id
    await window.api.orders.removeItem(o.id, item2)
    cur = await window.api.orders.get(o.id)
    log('E_afterRemoveSecondItem', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    await window.api.orders.updateItem(o.id, itemId, { quantity: 1000 })
    cur = await window.api.orders.get(o.id)
    log('F_afterQtyBack1000', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    await window.api.orders.updateItem(o.id, itemId, { quantity: 100 })
    cur = await window.api.orders.get(o.id)
    log('G_afterQty100_overpaid', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    await window.api.orders.updateItem(o.id, itemId, { quantity: 1000 })
    cur = await window.api.orders.get(o.id)
    log('H_restore1000', { total: cur.grandTotal, receivable: cur.receivable, status: cur.paymentStatus })

    const evs = await window.api.orders.events(o.id)
    log('events', evs.map(e => e.kind + ' | ' + e.note))

    // 打样单
    const s = await window.api.samples.save({
      customerId: cust.id, styleNo: 'R6-SMP', productName: 'sample tee',
      sampleQty: 3, samplePrice: 12, courierFee: 120, courier: 'DHL',
      sampleDate: '2026-10-21', status: 'shipped'
    })
    log('sampleSaved', s)
    const sl = await window.api.samples.list()
    log('samplesList', sl)
    const sg = await window.api.samples.get(s.id)
    log('sampleGet', sg)

    // 打包单明细增删改是否留痕
    const pl = await window.api.pl.list(o.id)
    log('plList', pl)
  } catch (e) {
    log('FATAL', String(e && e.stack || e))
  }
  console.log('R6RESULT2 ' + JSON.stringify(L, null, 1))
  return L.join('\n')
})()
