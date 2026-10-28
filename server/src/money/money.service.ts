import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { moneyCore, type MoneyCore } from '../../../core/money'
import type { CustomerCreditCurrency, CustomerReceivable, PackingAmount } from '../../../src/shared/types'
import type { CustomerOpenRow } from '../../../core/money'

/**
 * 金额只读面：待收榜、客户待收、预收余额、批次金额。
 *
 * 写路径（收款、核销、抵扣）还在桌面的 orders/credits 里，等它们异步化后再搬；
 * 这四个是纯读，core/money.ts 一份 SQL，桌面与后端只是驱动不同。
 */
@Injectable()
export class MoneyService {
  private readonly core: MoneyCore

  constructor(@Inject(DB) db: Db) {
    this.core = moneyCore(db)
  }

  receivables(): Promise<CustomerReceivable[]> {
    return this.core.receivableByCustomer()
  }

  customerOpenRows(customerId: number): Promise<CustomerOpenRow[]> {
    return this.core.customerOpenRows(customerId)
  }

  creditBalance(customerId: number): Promise<CustomerCreditCurrency[]> {
    return this.core.customerCreditBalance(customerId)
  }

  packingAmounts(orderId: number): Promise<PackingAmount[]> {
    return this.core.packingAmounts(orderId)
  }
}
