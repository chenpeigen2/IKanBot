import { useEffect, useState } from 'react'
import { Modal, useToast, today, money, Button, clientKey } from '../ui'
import {
  CURRENCIES,
  INCOTERMS,
  PAYMENT_METHOD_LABEL,
  type Currency,
  type Incoterm,
  type PaymentMethod
} from '../../../shared/types'
import { localDate } from '../../../shared/date'

interface EditForm {
  customerId: number
  piNo: string
  currency: Currency
  exchangeRate: number
  exchangeRateDate: string
  incoterm: Incoterm
  portOfLoading: string
  portOfDestination: string
  paymentMethod: PaymentMethod
  depositRatio: number
  validUntil: string
  expectedShipDate: string
  expectedArrivalDate: string
  customerPo: string
  note: string
  factory: string
  factoryDueDate: string
  cutOffDate: string
  etdDate: string
  vessel: string
  sealNo: string
}

/**
 * 订单编辑：修改 PI 上会体现的订单级字段。
 * 单价/数量在「商品明细」里直接改，这里改客户、币种、条款、日期等。
 */
export default function EditOrderModal({
  order,
  settings,
  onClose,
  onSaved
}: {
  order: any
  settings: any
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [customers, setCustomers] = useState<any[]>([])
  const [ports, setPorts] = useState<{ loading: string[]; destination: string[] }>({
    loading: [],
    destination: []
  })
  const [charges, setCharges] = useState<{ uid: string; label: string; amount: number }[]>(
    (order.charges ?? []).map((c: any) => ({ uid: clientKey(), label: String(c.label), amount: Number(c.amount) || 0 }))
  )
  const [form, setForm] = useState<EditForm>({
    customerId: order.customerId,
    piNo: order.piNo ?? '',
    currency: order.currency,
    exchangeRate: order.exchangeRate,
    exchangeRateDate: order.exchangeRateDate ?? '',
    incoterm: order.incoterm,
    portOfLoading: order.portOfLoading ?? '',
    portOfDestination: order.portOfDestination ?? '',
    paymentMethod: order.paymentMethod,
    depositRatio: order.depositRatio,
    validUntil: order.validUntil ?? '',
    expectedShipDate: order.expectedShipDate ?? '',
    expectedArrivalDate: order.expectedArrivalDate ?? '',
    customerPo: order.customerPo ?? '',
    note: order.note ?? '',
    factory: order.factory ?? '',
    factoryDueDate: order.factoryDueDate ?? '',
    cutOffDate: order.cutOffDate ?? '',
    etdDate: order.etdDate ?? '',
    vessel: order.vessel ?? '',
    sealNo: order.sealNo ?? ''
  })
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const [chargeReason, setChargeReason] = useState('')
  /** 动了让利（负费用行）就要写原因——和订单详情里「只改费用」那条正门同一道闸门 */
  const negativeSnap = (cs: { label: string; amount: number }[]): string =>
    cs
      .filter((c) => Number(c.amount) < 0)
      .map((c) => `${c.label.trim()}\u0000${Number(c.amount)}`)
      .sort()
      .join('\u0001')
  const negativeTouched =
    negativeSnap(charges.filter((c) => c.label.trim())) !==
    negativeSnap((order.charges ?? []).map((c: any) => ({ label: String(c.label ?? ''), amount: Number(c.amount) || 0 })))

  useEffect(() => {
    // 已停用的客户也要能选：改历史单时下拉里必须还有当时那个客户
    const fail = (e: unknown) => toast(`下拉候选没拉出来：${(e as Error).message}`, 'error')
    window.api.customers.list('', true).then(setCustomers, fail)
    window.api.orders.ports().then(setPorts, fail)
  }, [])

  // 保存期间按住按钮：一次改单要写主表 + 历史 + 状态重算，连点两下会把同一份改动提交两遍
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    const rate = Number(form.exchangeRate)
    const paidCount = (order.payments ?? []).length
    // 收款是按原币登记的：已经收过钱的单不许换币种，否则客户对账和银行流水都会错位
    if (form.currency !== order.currency && paidCount > 0) {
      toast(
        `这张单已经登记了 ${paidCount} 笔收款，不能改币种——收款按 ${order.currency} 记的，改了会和银行流水对不上。确实要换币种，请作废这张单后按正确币种重开。`,
        'error'
      )
      return
    }
    if (!(rate > 0)) {
      toast('汇率必须填大于 0 的数。清空不能保存——整单金额会按错汇率折算', 'error')
      return
    }
    // 换了币种却沿用旧币种的汇率，等于把 USD 的 7.1 套在 EUR 上
    if (form.currency !== order.currency && rate === Number(order.exchangeRate)) {
      toast('换币种后汇率不能沿用原来的数值，请按新币种重新填写汇率。', 'error')
      return
    }
    // 已经收过钱的单，换汇率等于把已收的钱重新折算，对账单会对不上 → 先问一声
    if (rate !== Number(order.exchangeRate) && paidCount > 0) {
      const ok = confirm(
        `这张单已经记过 ${paidCount} 笔收款。换汇率，已收的钱折成本位币也会跟着变，跟银行流水对账时对不上。\n\n确认按新汇率保存吗？`
      )
      if (!ok) return
    }
    // 换客户 = 换这张单的主人：PI 重出后客户手里会出现不同抬头的两张纸。
    // 非草稿的单已具备凭据属性，换主必须有意确认
    if (form.customerId !== order.customerId && order.paymentStatus !== 'draft') {
      const from = customers.find((c) => c.id === order.customerId)?.company || '原客户'
      const to = customers.find((c) => c.id === form.customerId)?.company || '新客户'
      const ok = confirm(
        `确认把这张订单从「${from}」换到「${to}」名下吗？\n\n` +
          'PI 上的买方/收货抬头会重钉成新客户；客户手里已发出的单据不会跟着变，重出后就是两张不同抬头的 PI。\n' +
          '这次换主会写进操作历史。'
      )
      if (!ok) return
    }
    // 让利的「为什么」不落一句话，半年后只剩应收少了一块，没人答得出是谁答应的
    if (negativeTouched && !chargeReason.trim()) {
      toast('这次动了让利（负费用行），请写明原因：这句话会记进订单操作历史。', 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.orders.update(order.id, {
        customerId: form.customerId,
        piNo: form.piNo.trim(),
        currency: form.currency,
        exchangeRate: rate,
        exchangeRateDate: form.exchangeRateDate || null,
        baseCurrency: settings?.baseCurrency ?? 'CNY',
        incoterm: form.incoterm,
        portOfLoading: form.portOfLoading,
        portOfDestination: form.portOfDestination,
        paymentMethod: form.paymentMethod,
        depositRatio: form.depositRatio,
        validUntil: form.validUntil || null,
        expectedShipDate: form.expectedShipDate || null,
        expectedArrivalDate: form.expectedArrivalDate || null,
        customerPo: form.customerPo,
        note: form.note,
        factory: form.factory,
        factoryDueDate: form.factoryDueDate || null,
        cutOffDate: form.cutOffDate || null,
        etdDate: form.etdDate || null,
        vessel: form.vessel,
        sealNo: form.sealNo,
        charges: charges.filter((c) => c.label.trim()).map((c) => ({ label: c.label, amount: c.amount })),
        chargeReason: chargeReason.trim() || undefined
      })
      toast('订单已更新')
      await onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const extendValidity = (days: number) => {
    const base = form.validUntil ? new Date(form.validUntil + 'T00:00:00') : new Date()
    base.setDate(base.getDate() + days)
    setForm({ ...form, validUntil: localDate(base) })
  }

  return (
    <Modal
      title={`编辑订单 ${order.orderNo}`}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            保存修改
          </Button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label>客户 *</label>
          <select
            value={form.customerId || ''}
            onChange={(e) => setForm({ ...form, customerId: Number(e.target.value) })}
          >
            <option value="">请选择客户…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company}
                {c.country ? ` (${c.country})` : ''}
              </option>
            ))}
          </select>
          <div className="hint">改客户后，PI 上的收件信息会跟着变</div>
        </div>
        <div className="field">
          <label>PI 号</label>
          <input value={form.piNo} onChange={(e) => setForm({ ...form, piNo: e.target.value })} />
          <div className="hint">对外的单据编号，可改</div>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>币种</label>
          <select
            value={form.currency}
            disabled={(order.payments ?? []).length > 0}
            onChange={(e) =>
              // 换币种就把汇率清掉，逼着按新币种重新填，不许沿用旧数值
              setForm({ ...form, currency: e.target.value as Currency, exchangeRate: 0 })
            }
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="hint">
            {(order.payments ?? []).length > 0
              ? '已登记收款，币种不能改——收款按原币记，改了和银行流水对不上。'
              : '换币种后要按新币种重新填汇率'}
          </div>
        </div>
        <div className="field">
          <label>汇率（1 {form.currency} = ? {settings?.baseCurrency ?? 'CNY'}）</label>
          <input
            type="number"
            step="0.0001"
            value={form.exchangeRate}
            onChange={(e) => setForm({ ...form, exchangeRate: Number(e.target.value) })}
          />
          <div className="hint">
            汇率锁定日期：{form.exchangeRateDate || '未记录'}
            <input
              type="date"
              style={{ width: 140, marginLeft: 8 }}
              value={form.exchangeRateDate}
              onChange={(e) => setForm({ ...form, exchangeRateDate: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>贸易术语</label>
          <select
            value={form.incoterm}
            onChange={(e) => setForm({ ...form, incoterm: e.target.value as Incoterm })}
          >
            {INCOTERMS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>装运港</label>
          <input
            list="edit-ports-loading"
            value={form.portOfLoading}
            onChange={(e) => setForm({ ...form, portOfLoading: e.target.value })}
            placeholder="如 Ningbo"
          />
          <datalist id="edit-ports-loading">
            {ports.loading.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>目的港</label>
          <input
            list="edit-ports-dest"
            value={form.portOfDestination}
            onChange={(e) => setForm({ ...form, portOfDestination: e.target.value })}
            placeholder="如 Hamburg"
          />
          <datalist id="edit-ports-dest">
            {ports.destination.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>付款方式</label>
          <select
            value={form.paymentMethod}
            onChange={(e) => setForm({ ...form, paymentMethod: e.target.value as PaymentMethod })}
          >
            {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field">
          <label>定金比例</label>
          <select
            value={String(form.depositRatio)}
            onChange={(e) => setForm({ ...form, depositRatio: Number(e.target.value) })}
          >
            <option value="0">无定金</option>
            <option value="0.2">20%</option>
            <option value="0.3">30%</option>
            <option value="0.4">40%</option>
            <option value="0.5">50%</option>
            <option value="1">全额</option>
          </select>
        </div>
        <div className="field">
          <label>PI 有效期</label>
          <input
            type="date"
            value={form.validUntil}
            onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
          />
          <div className="row" style={{ marginTop: 5, gap: 5 }}>
            <Button size="sm"  onClick={() => extendValidity(7)}>
              +7天
            </Button>
            <Button size="sm"  onClick={() => extendValidity(15)}>
              +15天
            </Button>
            <Button size="sm"  onClick={() => extendValidity(30)}>
              +30天
            </Button>
            <Button size="sm"  onClick={() => setForm({ ...form, validUntil: today() })}>
              今天
            </Button>
          </div>
        </div>
        <div className="field">
          <label>客户 PO 号</label>
          <input
            value={form.customerPo}
            onChange={(e) => setForm({ ...form, customerPo: e.target.value })}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>预计出货日</label>
          <input
            type="date"
            value={form.expectedShipDate}
            onChange={(e) => setForm({ ...form, expectedShipDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label>预计到港日</label>
          <input
            type="date"
            value={form.expectedArrivalDate}
            onChange={(e) => setForm({ ...form, expectedArrivalDate: e.target.value })}
          />
        </div>
      </div>

      <h3 style={{ fontSize: 13, margin: '12px 0 4px' }}>工厂与船期</h3>
      <div className="field-row-3">
        <div className="field">
          <label>加工厂</label>
          <input
            value={form.factory}
            onChange={(e) => setForm({ ...form, factory: e.target.value })}
            placeholder="如 袜厂王老板"
          />
        </div>
        <div className="field">
          <label>工厂交货日</label>
          <input
            type="date"
            value={form.factoryDueDate}
            onChange={(e) => setForm({ ...form, factoryDueDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label>截关日</label>
          <input
            type="date"
            value={form.cutOffDate}
            onChange={(e) => setForm({ ...form, cutOffDate: e.target.value })}
          />
        </div>
      </div>
      <div className="field-row-3">
        <div className="field">
          <label>实际开船日</label>
          <input
            type="date"
            value={form.etdDate}
            onChange={(e) => setForm({ ...form, etdDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label>船名航次</label>
          <input
            value={form.vessel}
            onChange={(e) => setForm({ ...form, vessel: e.target.value })}
            placeholder="如 MAERSK V.034E"
          />
        </div>
        <div className="field">
          <label>封条号</label>
          <input
            value={form.sealNo}
            onChange={(e) => setForm({ ...form, sealNo: e.target.value })}
            placeholder="如 CN1234567"
          />
        </div>
      </div>
      <div className="hint" style={{ marginTop: -4 }}>
        这里是整单默认船期：PI / CI 用这里的值。分批出运时，装箱单批次可以单独填自己的船期，填了优先用批次的。
      </div>

      <h3 style={{ fontSize: 13, margin: '12px 0 4px' }}>费用（运费 / 保险费 / 其他）</h3>
      <div className="row" style={{ marginBottom: 5 }}>
        <span className="hint">CIF / CFR / FOB 天天变，运费保险在这里改，PI 和 CI 会一起变</span>
        <div className="spacer" />
        <Button size="sm"  onClick={() => setCharges((cs) => [...cs, { uid: clientKey(), label: '运费 Freight', amount: 0 }])}>
          + 加费用
        </Button>
      </div>
      {charges.length === 0 ? (
        <div className="hint">还没有费用行（PI 上只有货值）</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>费用名称</th>
                <th className="num" style={{ width: '32%' }}>
                  金额（{form.currency}）
                </th>
                <th className="col-num-sm"></th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.uid}>
                  <td>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        setCharges((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, label: e.target.value } : x)))
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
                          cs.map((x) => (x.uid === c.uid ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                    />
                  </td>
                  <td className="right">
                    <Button variant="danger" size="sm"
                      
                      onClick={() => setCharges((cs) => cs.filter((x) => x.uid !== c.uid))}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="tfoot-strong">
                <td>费用合计</td>
                <td className="num">{chargesTotal.toFixed(2)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className="hint mt-1">
        含费用合计 {money((order.totalAmount ?? 0) + chargesTotal, form.currency)}
      </div>
      {negativeTouched ? (
        <div className="field mt-1">
          <label>让利原因 *</label>
          <input
            value={chargeReason}
            onChange={(e) => setChargeReason(e.target.value)}
            placeholder="为什么让这一步，如「老客户运费对折」「补上次多收的 20」"
          />
          <div className="hint">负费用行会直接改变客户该付的钱，这句原因会记进订单操作历史。</div>
        </div>
      ) : null}

      <div className="field">
        <label>备注（会原样印在 PI / CI 的 Remarks 上）</label>
        <textarea
          rows={3}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          placeholder="如：左胸印 Logo，黑色款加急，7 月 10 日前交货。"
        />
      </div>
    </Modal>
  )
}
