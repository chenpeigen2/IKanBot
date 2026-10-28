import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { dashboardCore, type DashboardCore } from '../../../core/dashboard'
import { localDate } from '../../../src/shared/date'
import { EXPORT_FILE_NAME } from '../../../src/shared/types'
import type {
  DashboardStats,
  ExportKind,
  MonthlyReportRow,
  OrderExportFilter,
  Reminder
} from '../../../src/shared/types'

/**
 * 工作台 / 提醒 / 月报 / 导出。口径不在这里另算：全部回头调 money 与 orders 的 core，
 * 桌面工作台和后端工作台看的是同一批 SQL、同一套待收拆分。
 */
@Injectable()
export class DashboardService {
  private readonly core: DashboardCore

  constructor(@Inject(DB) db: Db) {
    this.core = dashboardCore(db)
  }

  stats(): Promise<DashboardStats> {
    return this.core.dashboard()
  }

  reminders(): Promise<Reminder[]> {
    return this.core.reminders()
  }

  monthly(): Promise<MonthlyReportRow[]> {
    return this.core.monthlyReport()
  }

  /**
   * 导出的 CSV 由后端算、桌面落盘：文件对话框在本机，数据必须来自后端那份账。
   * 文件名也一起回去——对账单要带客户名，两处各拼一次迟早不一致。
   */
  async exportCsv(kind: ExportKind, filter?: OrderExportFilter): Promise<{ csv: string; fileName: string }> {
    const csv = await this.core.exportCsv(kind, filter)
    const fileName =
      kind === 'statement' && filter?.customerId
        ? await this.core.statementFileName(filter.customerId)
        : EXPORT_FILE_NAME[kind].replace(/\.csv$/, `_${localDate()}.csv`)
    return { csv, fileName }
  }
}
