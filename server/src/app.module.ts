import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { ConfigModule } from './config/config.module'
import { DbModule } from './db/db.module'
import { CustomersModule } from './customers/customers.module'
import { FilesModule } from './files/files.module'
import { ProductsModule } from './products/products.module'
import { HealthController } from './health/health.controller'
import { MetaController } from './meta/meta.controller'
import { RoutesService } from './meta/routes.service'
import { AllExceptionsFilter } from './common/all-exceptions.filter'

@Module({
  imports: [DiscoveryModule, ConfigModule, DbModule, CustomersModule, ProductsModule, FilesModule],
  controllers: [HealthController, MetaController],
  providers: [RoutesService, AllExceptionsFilter]
})
export class AppModule {}
