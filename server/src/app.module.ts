import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { ConfigModule } from './config/config.module'
import { DbModule } from './db/db.module'
import { CreditsModule } from './credits/credits.module'
import { CustomersModule } from './customers/customers.module'
import { DashboardModule } from './dashboard/dashboard.module'
import { FilesModule } from './files/files.module'
import { MoneyModule } from './money/money.module'
import { OrdersModule } from './orders/orders.module'
import { PackingModule } from './packing/packing.module'
import { ProductsModule } from './products/products.module'
import { QuotationsModule } from './quotations/quotations.module'
import { SamplesModule } from './samples/samples.module'
import { SettingsModule } from './settings/settings.module'
import { HealthController } from './health/health.controller'
import { MetaController } from './meta/meta.controller'
import { RoutesService } from './meta/routes.service'
import { AllExceptionsFilter } from './common/all-exceptions.filter'

@Module({
  imports: [
    DiscoveryModule,
    ConfigModule,
    DbModule,
    CustomersModule,
    ProductsModule,
    FilesModule,
    MoneyModule,
    SettingsModule,
    OrdersModule,
    QuotationsModule,
    SamplesModule,
    CreditsModule,
    PackingModule,
    DashboardModule
  ],
  controllers: [HealthController, MetaController],
  providers: [RoutesService, AllExceptionsFilter]
})
export class AppModule {}
