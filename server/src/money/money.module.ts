import { Module } from '@nestjs/common'
import { CreditsReadController, PackingAmountsController, ReportsController } from './money.controller'
import { MoneyService } from './money.service'

@Module({
  controllers: [ReportsController, PackingAmountsController, CreditsReadController],
  providers: [MoneyService]
})
export class MoneyModule {}
