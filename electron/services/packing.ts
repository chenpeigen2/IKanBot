/**
 * 桌面侧的装箱服务：SQL 与守门全在 core/packing.ts（后端跑同一份）。
 */
import { coreDb } from '../db'
import { packingCore, type PackingListInfoInput, type PackingListInput } from '../../core/packing'

export type { PackingListInfoInput, PackingListInput }

const core = packingCore(coreDb)

export const {
  listPackingLists,
  createPackingList,
  deletePackingList,
  voidPackingList,
  unvoidPackingList,
  updatePackingListInfo,
  updatePackingListLine,
  addPackingListLine,
  deletePackingListLine
} = core
