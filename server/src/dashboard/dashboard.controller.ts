import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common'
import { optionalObject, strParam } from '../common/params'
import { DashboardService } from './dashboard.service'
import { EXPORT_FILE_NAME } from '../../../src/shared/types'
import type { ExportKind, OrderExportFilter } from '../../../src/shared/types'

/** 路由名 = IPC 通道名（dashboard:stats → POST /api/dashboard/stats）。 */
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Post('stats')
  @HttpCode(200)
  stats() {
    return this.dashboard.stats()
  }

  @Post('reminders')
  @HttpCode(200)
  reminders() {
    return this.dashboard.reminders()
  }
}

/** 月报沿用 report 前缀（report:monthly），与待收榜、客户未结单同一个命名域。 */
@Controller('api/report')
export class MonthlyReportController {
  constructor(private readonly dashboard: DashboardService) {}

  @Post('monthly')
  @HttpCode(200)
  monthly() {
    return this.dashboard.monthly()
  }
}

/**
 * 导出：数据在后端算，文件在桌面落盘（另存对话框是本机的事）。
 * 桌面在远端模式下拿这里回的 CSV 写本地文件，文件名也由后端给，两种模式同一个名字。
 */
@Controller('api/export')
export class ExportController {
  constructor(private readonly dashboard: DashboardService) {}

  @Post('csv')
  @HttpCode(200)
  csv(@Body() body: Record<string, unknown>) {
    const kind = strParam(body['kind'])
    if (!(kind in EXPORT_FILE_NAME)) {
      throw new BadRequestException(
        `导出类型「${kind || '空'}」不对，只接：${Object.keys(EXPORT_FILE_NAME).join(' / ')}`
      )
    }
    return this.dashboard.exportCsv(kind as ExportKind, optionalObject(body['filter'], '导出筛选条件') as OrderExportFilter)
  }
}
