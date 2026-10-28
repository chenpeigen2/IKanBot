import { coreDb } from '../db'
import { dashboardCore } from '../../core/dashboard'

const core = dashboardCore(coreDb)

export const { dashboard, reminders, monthlyReport, exportCsv, statementFileName } = core
