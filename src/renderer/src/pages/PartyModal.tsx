/**
 * 单据抬头（买方 / 收货人）。
 *
 * 建单时抬头就从客户档案钉在这张单上了，之后改档案不会重写已发出的 PI / PL / CI。
 * 这个弹窗是唯一的例外通道：客户真搬家了、当初填错了，业务员在这一单上手工纠正，
 * 改动会写进订单历史（谁改的、改了哪一项）。
 */
import { useState } from 'react'
import { Modal, Button, useToast } from '../ui'
import { PARTY_FIELD_LABEL, billPartyOf, emptyParty, shipPartyOf, type PartyFields } from '../../../shared/party'

const BILL_LABELS: PartyFields[] = [
  'company',
  'attn',
  'contact',
  'email',
  'phone',
  'address',
  'zipCode',
  'country',
  'paymentPref'
]
const SHIP_LABELS: PartyFields[] = ['company', 'attn', 'address', 'zipCode', 'country']

/** 地址类字段占满一行，其余两列排 */
const WIDE: PartyFields[] = ['address', 'paymentPref']

/** 一张抬头的输入网格 */
function PartyGrid({
  title,
  hint,
  fields,
  value,
  onChange
}: {
  title: string
  hint: string
  fields: PartyFields[]
  value: Record<string, string>
  onChange: (patch: Record<string, string>) => void
}) {
  return (
    <div className="field">
      <label>{title}</label>
      <div className="hint">{hint}</div>
      <div className="field-row" style={{ marginTop: 8 }}>
        {fields.map((f) => (
          <div className="field" key={f} style={WIDE.includes(f) ? { gridColumn: '1 / -1' } : undefined}>
            <label>{PARTY_FIELD_LABEL[f]}</label>
            <input value={value[f] ?? ''} onChange={(e) => onChange({ [f]: e.target.value })} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PartyModal({
  order,
  onClose,
  onSaved
}: {
  order: any
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const toast = useToast()
  const [bill, setBill] = useState<Record<string, string>>(() => ({ ...emptyParty(), ...(order.billTo || {}) }))
  const [ship, setShip] = useState<Record<string, string>>(() => ({ ...emptyParty(), ...(order.shipTo || {}) }))
  const [sameAsBill, setSameAsBill] = useState(() => !order.shipTo || JSON.stringify(order.shipTo) === JSON.stringify(order.billTo))
  const [saving, setSaving] = useState(false)

  const live = order.customer
  // 档案的最新值：客户真改了地址时从这里带出，不用手抄
  const useArchive = () => {
    if (!live) {
      toast('这张单没有关联客户档案，请手工填写', 'error')
      return
    }
    setBill({ ...billPartyOf(live) })
    setShip({ ...shipPartyOf(live) })
    toast('已带出客户档案的当前抬头，确认后保存才生效')
  }

  const save = async () => {
    if (!String(bill.company ?? '').trim()) {
      toast('买方抬头公司名不能为空，PI / CI 上要印它', 'error')
      return
    }
    setSaving(true)
    try {
      await window.api.orders.setParties(order.id, { billTo: bill, shipTo: sameAsBill ? bill : ship })
      toast('抬头已更新，之后重印就用这一版')
      await onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="单据抬头"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button onClick={useArchive}>带出客户档案最新值</Button>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            保存抬头
          </Button>
        </>
      }
    >
      <div className="alert info">
        抬头是钉在这张单上的快照：改客户档案不会重写已经发出去的单据，这里改的只影响本单。
      </div>
      <PartyGrid
        title="买方 / BUYER（PI、CI 印这个）"
        hint={live ? `档案当前是 ${live.company}` : '本单没有客户档案'}
        fields={BILL_LABELS}
        value={bill}
        onChange={(p) => setBill({ ...bill, ...p })}
      />
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={sameAsBill} onChange={(e) => setSameAsBill(e.target.checked)} />
          收货抬头与买方相同
        </label>
      </div>
      {sameAsBill ? null : (
        <PartyGrid
          title="收货人 / CONSIGNEE（PL 印这个）"
          hint="货代和报关看的是收货人，与买方不同时务必单独填"
          fields={SHIP_LABELS}
          value={ship}
          onChange={(p) => setShip({ ...ship, ...p })}
        />
      )}
    </Modal>
  )
}
