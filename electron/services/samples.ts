/**
 * 桌面侧的打样服务：SQL 与守门全在 core/samples.ts（后端跑同一份）。
 */
import { coreDb } from '../db'
import { samplesCore, type SampleInput, type SampleItemInput, type SamplePaymentInput } from '../../core/samples'

export type { SampleInput, SampleItemInput, SamplePaymentInput }

const core = samplesCore(coreDb)

export const {
  listSamples,
  getSample,
  saveSample,
  deleteSample,
  convertSampleToOrder,
  listSamplePayments,
  addSamplePayment,
  deleteSamplePayment
} = core
