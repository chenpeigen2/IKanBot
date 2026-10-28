import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { arrayParam, idParam, objectParam, optionalObject, strParam } from '../common/params'
import { SamplesService } from './samples.service'

/** 路由名 = IPC 通道名（samples:addPayment → POST /api/samples/addPayment）。 */
@Controller('api/samples')
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.samples.list(optionalObject(body['filter'], '打样筛选条件'))
  }

  @Post('get')
  @HttpCode(200)
  get(@Body() body: Record<string, unknown>) {
    return this.samples.get(idParam(body['id'], '打样单编号'))
  }

  @Post('save')
  @HttpCode(200)
  save(@Body() body: Record<string, unknown>) {
    const input = objectParam(body['input'], '打样单')
    // 漏传 items 是合法的「这次不动明细」；传了就必须是列表
    if (input['items'] !== undefined) arrayParam(input['items'], '打样单明细')
    return this.samples.save(input)
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.samples.remove(idParam(body['id'], '打样单编号'))
  }

  @Post('convert')
  @HttpCode(200)
  convert(@Body() body: Record<string, unknown>) {
    return this.samples.convert(idParam(body['id'], '打样单编号'), optionalObject(body['opts'], '转单选项'))
  }

  @Post('listPayments')
  @HttpCode(200)
  listPayments(@Body() body: Record<string, unknown>) {
    return this.samples.listPayments(idParam(body['id'], '打样单编号'))
  }

  @Post('addPayment')
  @HttpCode(200)
  addPayment(@Body() body: Record<string, unknown>) {
    return this.samples.addPayment(idParam(body['id'], '打样单编号'), objectParam(body['p'], '打样收款'))
  }

  @Post('deletePayment')
  @HttpCode(200)
  deletePayment(@Body() body: Record<string, unknown>) {
    return this.samples.deletePayment(
      idParam(body['id'], '打样单编号'),
      idParam(body['paymentId'], '收款编号'),
      strParam(body['reason'])
    )
  }
}
