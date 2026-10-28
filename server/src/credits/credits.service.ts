import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import {
  creditsCore,
  type ApplyCreditInput,
  type CreditsCore,
  type RefundCreditInput
} from '../../../core/credits'
import type { CustomerCreditCurrency } from '../../../src/shared/types'

/**
 * 预收抵扣/退款的写路径。读余额在 MoneyService（同一个 core/money.ts 口径），
 * 写这边也必须回同一处算余额：抵扣完的余额就是给界面看的那一个数。
 */
@Injectable()
export class CreditsService {
  private readonly core: CreditsCore

  constructor(@Inject(DB) db: Db) {
    this.core = creditsCore(db)
  }

  apply(input: Record<string, unknown>): Promise<CustomerCreditCurrency[]> {
    return this.core.applyCredit(input as unknown as ApplyCreditInput)
  }

  reverse(applicationId: number, reason: string): Promise<CustomerCreditCurrency[]> {
    return this.core.reverseCredit(applicationId, reason)
  }

  refund(input: Record<string, unknown>): Promise<CustomerCreditCurrency[]> {
    return this.core.refundCredit(input as unknown as RefundCreditInput)
  }

  reverseRefund(refundId: number, reason: string): Promise<CustomerCreditCurrency[]> {
    return this.core.reverseRefund(refundId, reason)
  }
}
