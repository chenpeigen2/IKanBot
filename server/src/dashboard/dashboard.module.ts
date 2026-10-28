import { Module } from '@nestjs/common'
import { DashboardController, ExportController, MonthlyReportController } from './dashboard.controller'
import { DashboardService } from './dashboard.service'

@Module({
  controllers: [DashboardController, MonthlyReportController, ExportController],
  providers: [DashboardService]
})
export class DashboardModule {}
