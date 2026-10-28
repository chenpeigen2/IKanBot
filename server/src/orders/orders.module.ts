import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

@Module({
  imports: [FilesModule],
  controllers: [OrdersController],
  providers: [OrdersService]
})
export class OrdersModule {}
