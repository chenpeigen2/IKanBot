import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import {
  packingCore,
  type PackingCore,
  type PackingListInfoInput,
  type PackingListInput
} from '../../../core/packing'
import type { PackingList, PackingListLine } from '../../../src/shared/types'

/**
 * 装箱域的 HTTP 门面：箱号唯一、超装守门、批次凭据冻结、收货数联动全在 core/packing.ts。
 * 批次金额不在这里（money.ts 的唯一口径，挂 /api/pl/amounts）。
 */
@Injectable()
export class PackingService {
  private readonly core: PackingCore

  constructor(@Inject(DB) db: Db) {
    this.core = packingCore(db)
  }

  list(orderId: number): Promise<PackingList[]> {
    return this.core.listPackingLists(orderId)
  }

  create(input: Record<string, unknown>): Promise<PackingList[]> {
    return this.core.createPackingList(input as unknown as PackingListInput)
  }

  remove(orderId: number, plId: number): Promise<PackingList[]> {
    return this.core.deletePackingList(orderId, plId)
  }

  updateInfo(orderId: number, plId: number, patch: Record<string, unknown>): Promise<PackingList[]> {
    return this.core.updatePackingListInfo(orderId, plId, patch as unknown as PackingListInfoInput)
  }

  updateLine(orderId: number, plId: number, lineId: number, patch: Record<string, unknown>): Promise<PackingList[]> {
    return this.core.updatePackingListLine(orderId, plId, lineId, patch as Partial<PackingListLine>)
  }

  addLine(orderId: number, plId: number, line: Record<string, unknown>): Promise<PackingList[]> {
    return this.core.addPackingListLine(
      orderId,
      plId,
      line as unknown as Parameters<PackingCore['addPackingListLine']>[2]
    )
  }

  deleteLine(orderId: number, plId: number, lineId: number): Promise<PackingList[]> {
    return this.core.deletePackingListLine(orderId, plId, lineId)
  }

  void(orderId: number, plId: number, reason: string): Promise<PackingList[]> {
    return this.core.voidPackingList(orderId, plId, reason)
  }

  unvoid(orderId: number, plId: number, reason: string): Promise<PackingList[]> {
    return this.core.unvoidPackingList(orderId, plId, reason)
  }
}
