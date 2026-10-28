import { Module } from '@nestjs/common'
import { PackingController } from './packing.controller'
import { PackingService } from './packing.service'

@Module({
  controllers: [PackingController],
  providers: [PackingService]
})
export class PackingModule {}
