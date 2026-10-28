import { coreDb } from '../db'
import { quotationsCore, type QuotationItemInput, type QuotationInput, type QuotationSnapshot } from '../../core/quotations'

export type { QuotationItemInput, QuotationInput, QuotationSnapshot }

const core = quotationsCore(coreDb)

export const {
  listQuotationVersions,
  listQuotations,
  getQuotation,
  saveQuotation,
  logQuotationEvent,
  listQuotationEvents,
  deleteQuotation,
  updateQuotationMeta,
  convertToOrder
} = core
