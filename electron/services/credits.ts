/**
 * 桌面侧的预收抵扣服务：口径与守门全在 core/credits.ts（后端跑同一份）。
 */
import { coreDb } from '../db'
import { creditsCore, type ApplyCreditInput, type RefundCreditInput } from '../../core/credits'

export type { ApplyCreditInput, RefundCreditInput }

const core = creditsCore(coreDb)

export const {
  applyCredit,
  reverseCredit,
  refundCredit,
  reverseRefund,
  reverseCreditsForTarget,
  hasActiveCredit,
  assertCreditFitsOrder,
  assertCreditSolvent
} = core
