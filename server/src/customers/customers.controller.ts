import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { boolParam, objectParam, optionalId, optionalObject, strParam, idParam } from '../common/params'

/**
 * 路由名 = IPC 通道名（customers:list → POST /api/customers/list）。
 * 这是刻意的：桌面端的转发器按通道名一对一映射，接口面与 118 通道清单重合，
 * 不需要维护第二套命名。
 */
@Controller('api/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.customers.list(strParam(body['keyword']), boolParam(body['includeInactive']))
  }

  @Post('get')
  @HttpCode(200)
  get(@Body() body: Record<string, unknown>) {
    return this.customers.get(idParam(body['id'], '客户编号'))
  }

  @Post('save')
  @HttpCode(200)
  save(@Body() body: Record<string, unknown>) {
    return this.customers.save(objectParam(body['input'], '客户档案'))
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.customers.remove(idParam(body['id'], '客户编号'))
  }

  @Post('setActive')
  @HttpCode(200)
  setActive(@Body() body: Record<string, unknown>) {
    const active = body['active'] === 1 || body['active'] === true ? 1 : 0
    return this.customers.setActive(idParam(body['id'], '客户编号'), active)
  }

  @Post('sameName')
  @HttpCode(200)
  sameName(@Body() body: Record<string, unknown>) {
    return this.customers.sameName(
      strParam(body['company']),
      optionalId(body['selfId'], '客户编号')
    )
  }

  @Post('stats')
  @HttpCode(200)
  stats(@Body() body: Record<string, unknown>) {
    return this.customers.stats(idParam(body['id'], '客户编号'))
  }

  @Post('orders')
  @HttpCode(200)
  orderBriefs(@Body() body: Record<string, unknown>) {
    return this.customers.orderBriefs(idParam(body['id'], '客户编号'))
  }

  @Post('stylePriceHistory')
  @HttpCode(200)
  stylePriceHistory(@Body() body: Record<string, unknown>) {
    const filter = optionalObject(body['filter'], '筛选条件')
    return this.customers.stylePriceHistory({
      customerId: optionalId(filter['customerId'], '客户编号'),
      styleNo: strParam(filter['styleNo']) || undefined
    })
  }
}
