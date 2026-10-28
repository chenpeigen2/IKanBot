import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { assertDepositRatio } from '../../../src/shared/guards'
import { biz } from '../common/biz'
import { CustomersRepository, type CustomerInput } from './customers.repository'
import type { Customer } from '../../../src/shared/types'

@Injectable()
export class CustomersService {
  constructor(private readonly repo: CustomersRepository) {}

  list(keyword = '', includeInactive = false): Promise<Customer[]> {
    return this.repo.list(keyword, includeInactive)
  }

  async get(id: number): Promise<Customer> {
    const c = await this.repo.get(id)
    if (!c) throw new NotFoundException('客户不存在')
    return c
  }

  sameName(company: string, selfId?: number): Promise<Customer[]> {
    return this.repo.sameName(company, selfId)
  }

  async save(raw: Record<string, unknown>): Promise<Customer> {
    const input = normalize(raw)
    const company = input.company.trim()
    if (!company) throw new BadRequestException('客户公司名不能为空')
    input.company = company

    const sameName = await this.repo.sameName(company, input.id)
    if (sameName.length > 0 && !input.allowDuplicate) {
      const who = sameName
        .map(
          (c) =>
            `${c.company}（${[c.country, c.contact, c.email].filter(Boolean).join(' · ') || '没填国家/联系人'}）`
        )
        .join('、')
      throw new BadRequestException(
        `已经有同名客户：${who}。\n` +
          `同一个客户建两份，订单和欠款会被劈成两半，漏催一笔就是真钱。\n` +
          `确认是两家不同的公司（比如同一集团下的两个采购办），再点一次「就是同名，继续保存」。`
      )
    }
    // 档案里的默认定金比例是每张新单的起点：这里混进 1.5，以后每张单的 PI 都印负尾款
    biz(() => assertDepositRatio(input.defaultDepositRatio))

    const ts = new Date().toISOString()
    if (input.id != null) {
      const exists = await this.repo.get(input.id)
      if (!exists) throw new NotFoundException('客户不存在')
      await this.repo.update(input, ts)
      return this.get(input.id)
    }
    const id = await this.repo.insert(input, ts)
    return this.get(id)
  }

  async setActive(id: number, active: 0 | 1): Promise<Customer> {
    await this.get(id)
    await this.repo.setActive(id, active, new Date().toISOString())
    return this.get(id)
  }

  async remove(id: number): Promise<void> {
    const c = await this.repo.get(id)
    if (!c) return
    const n = await this.repo.refCounts(id)
    const parts: string[] = []
    if (n.orders > 0) parts.push(`${n.orders} 个订单`)
    if (n.quotations > 0) parts.push(`${n.quotations} 个报价单`)
    if (n.samples > 0) parts.push(`${n.samples} 个打样单`)
    if (parts.length > 0) {
      throw new BadRequestException(
        `${c.company} 已经有 ${parts.join('、')}，不能删——删了这些记录就没了凭据。\n` +
          `建错了又不想在建单下拉里看见它，请用「停用」：档案和历史单据都留着，只是不再带出来。`
      )
    }
    await this.repo.remove(id)
  }
}

/** 外部输入按白名单读字段：多传的键不进 SQL，也防止把 id 写成字符串带进 WHERE */
function normalize(raw: Record<string, unknown>): CustomerInput {
  const s = (k: string): string | undefined => {
    const v = raw[k]
    return typeof v === 'string' ? v : undefined
  }
  const id = raw['id']
  const ratio = raw['defaultDepositRatio']
  return {
    id: typeof id === 'number' && Number.isInteger(id) ? id : undefined,
    company: s('company') ?? '',
    contact: s('contact'),
    email: s('email'),
    phone: s('phone'),
    country: s('country'),
    address: s('address'),
    zipCode: s('zipCode'),
    attn: s('attn'),
    paymentPref: s('paymentPref'),
    shipAttn: s('shipAttn'),
    shipAddress: s('shipAddress'),
    shipZipCode: s('shipZipCode'),
    shipCountry: s('shipCountry'),
    defaultPaymentMethod: s('defaultPaymentMethod'),
    defaultDepositRatio: typeof ratio === 'number' ? ratio : ratio === null ? null : undefined,
    defaultIncoterm: s('defaultIncoterm'),
    defaultPortLoading: s('defaultPortLoading'),
    defaultPortDestination: s('defaultPortDestination'),
    note: s('note'),
    allowDuplicate: raw['allowDuplicate'] === true
  }
}
