import { Module } from '@nestjs/common'
import { CustomersController } from './customers.controller'
import { CustomersRepository } from './customers.repository'
import { CustomersService } from './customers.service'

@Module({
  controllers: [CustomersController],
  providers: [CustomersRepository, CustomersService]
})
export class CustomersModule {}
