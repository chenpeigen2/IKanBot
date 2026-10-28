import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { quotationsCore, type QuotationInput, type QuotationsCore } from '../../../core/quotations'
import type {
  OrderDetail,
  QuotationDetail,
  QuotationResult,
  QuotationStatus,
  QuotationVersionSummary
} from '../../../src/shared/types'

/**
 * 报价域的 HTTP 门面：编号、版本冻结、转单守门全在 core/quotations.ts。
 * 桌面本机模式与后端服务跑同一份实现，纸面数字不会两边各说各的。
 */
@Injectable()
export class QuotationsService {
  private readonly core: QuotationsCore

  constructor(@Inject(DB) db: Db) {
    this.core = quotationsCore(db)
  }

  list(filter: Record<string, unknown>): Promise<QuotationDetail[]> {
    return this.core.listQuotations(filter as { keyword?: string; customerId?: number; status?: string; result?: string })
  }

  get(id: number): Promise<QuotationDetail | null> {
    return this.core.getQuotation(id)
  }

  save(input: Record<string, unknown>): Promise<QuotationDetail> {
    return this.core.saveQuotation(input as unknown as QuotationInput)
  }

  remove(id: number): Promise<void> {
    return this.core.deleteQuotation(id)
  }

  updateMeta(id: number, meta: Record<string, unknown>): Promise<QuotationDetail> {
    return this.core.updateQuotationMeta(id, meta as { status?: QuotationStatus; result?: QuotationResult })
  }

  events(quotationId: number): Promise<{ id: number; at: string; kind: string; note: string }[]> {
    return this.core.listQuotationEvents(quotationId)
  }

  convert(id: number, opts: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.convertToOrder(
      id,
      opts as { paymentStatus?: 'draft' | 'sent'; revision?: number; override?: { approvedBy?: string; reason?: string } }
    )
  }

  versions(id: number): Promise<QuotationVersionSummary[]> {
    return this.core.listQuotationVersions(id)
  }
}
