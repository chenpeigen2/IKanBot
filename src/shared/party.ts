/**
 * 单据抬头快照。
 *
 * 客户档案会改（搬家、改名、换付款条件），但已经发给客户的 PI / PL / CI 不能跟着改——
 * 那是退税和催款用的凭据。所以建单时把抬头钉在单子上，重印永远印当时那一版。
 */
import type { Customer, PartySnapshot } from './types'

const s = (v: unknown): string => (v == null ? '' : String(v))

/** 抬头字段名（表单与历史留痕共用一套中文标签） */
export type PartyFields = keyof PartySnapshot

export const PARTY_FIELD_LABEL: Record<PartyFields, string> = {
  company: '公司',
  attn: '收件人',
  contact: '联系人',
  address: '地址',
  zipCode: '邮编',
  country: '国家',
  email: '邮箱',
  phone: '电话',
  paymentPref: '付款条款'
}

export function emptyParty(): PartySnapshot {
  return {
    company: '',
    attn: '',
    contact: '',
    address: '',
    zipCode: '',
    country: '',
    email: '',
    phone: '',
    paymentPref: ''
  }
}

/** 账单抬头（PI / CI 用） */
export function billPartyOf(c: Customer | null | undefined): PartySnapshot {
  if (!c) return emptyParty()
  return {
    company: s(c.company),
    attn: s(c.attn),
    contact: s(c.contact),
    address: s(c.address),
    zipCode: s(c.zipCode),
    country: s(c.country),
    email: s(c.email),
    phone: s(c.phone),
    paymentPref: s(c.paymentPref)
  }
}

/**
 * 收货抬头（PL 用）。
 * 客户没单独填收货地址时，等于账单抬头——不然是空白一张，货代直接退单。
 */
export function shipPartyOf(c: Customer | null | undefined): PartySnapshot {
  const bill = billPartyOf(c)
  if (!c || !s(c.shipAddress).trim()) return bill
  return {
    ...bill,
    attn: s(c.shipAttn) || bill.attn || bill.contact,
    address: s(c.shipAddress),
    zipCode: s(c.shipZipCode) || bill.zipCode,
    country: s(c.shipCountry) || bill.country
  }
}

/** 读快照；没存过快照（老数据）返回 null，由调用方回退客户档案 */
export function parseParty(json: unknown): PartySnapshot | null {
  const text = s(json).trim()
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<PartySnapshot>
    if (!raw || typeof raw !== 'object' || !s(raw.company).trim()) return null
    return { ...emptyParty(), ...raw, company: s(raw.company) } as PartySnapshot
  } catch {
    return null
  }
}

export function stringifyParty(p: PartySnapshot): string {
  return JSON.stringify(p)
}

/** 在原快照上只覆盖传了值的字段（空串是用户主动清空，不能当成没传） */
export function patchParty(base: PartySnapshot, patch?: Partial<PartySnapshot> | null): PartySnapshot {
  if (!patch) return base
  const out: Record<keyof PartySnapshot, string> = { ...base }
  for (const k of Object.keys(patch) as (keyof PartySnapshot)[]) {
    const v = patch[k]
    if (v !== undefined) out[k] = String(v)
  }
  return out
}

/** 一行地址（单据与界面共用，避免两种写法） */
export function partyAddress(p: PartySnapshot): string {
  return [p.address, [p.zipCode, p.country].filter(Boolean).join(' ')].filter(Boolean).join(', ')
}
