import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import {
  samplesCore,
  type SampleInput,
  type SamplePaymentInput,
  type SamplesCore
} from '../../../core/samples'
import type { OrderDetail, Payment, SampleOrderDetail } from '../../../src/shared/types'

/**
 * 打样域的 HTTP 门面：样品费口径、转单锁、收款守门全在 core/samples.ts。
 */
@Injectable()
export class SamplesService {
  private readonly core: SamplesCore

  constructor(@Inject(DB) db: Db) {
    this.core = samplesCore(db)
  }

  list(filter: Record<string, unknown>): Promise<SampleOrderDetail[]> {
    return this.core.listSamples(filter as { keyword?: string; customerId?: number; status?: string })
  }

  get(id: number): Promise<SampleOrderDetail | null> {
    return this.core.getSample(id)
  }

  save(input: Record<string, unknown>): Promise<SampleOrderDetail> {
    return this.core.saveSample(input as unknown as SampleInput)
  }

  remove(id: number): Promise<void> {
    return this.core.deleteSample(id)
  }

  convert(id: number, opts: Record<string, unknown>): Promise<OrderDetail> {
    return this.core.convertSampleToOrder(id, opts as { offsetSampleFee?: boolean; paymentStatus?: 'draft' | 'sent' })
  }

  listPayments(sampleId: number): Promise<Payment[]> {
    return this.core.listSamplePayments(sampleId)
  }

  addPayment(sampleId: number, p: Record<string, unknown>): Promise<SampleOrderDetail> {
    return this.core.addSamplePayment(sampleId, p as unknown as SamplePaymentInput)
  }

  deletePayment(sampleId: number, paymentId: number, reason: string): Promise<SampleOrderDetail> {
    return this.core.deleteSamplePayment(sampleId, paymentId, reason)
  }
}
