import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'

@Module({
  imports: [FilesModule],
  controllers: [ProductsController],
  providers: [ProductsService]
})
export class ProductsModule {}
