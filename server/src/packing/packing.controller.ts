import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { arrayParam, idParam, objectParam, strParam } from '../common/params'
import { PackingService } from './packing.service'

/** 路由名 = IPC 通道名（pl:updateLine → POST /api/pl/updateLine）。 */
@Controller('api/pl')
export class PackingController {
  constructor(private readonly packing: PackingService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.packing.list(idParam(body['orderId'], '订单编号'))
  }

  @Post('create')
  @HttpCode(200)
  create(@Body() body: Record<string, unknown>) {
    const input = objectParam(body['input'], '装箱单')
    arrayParam(input['lines'], '装箱明细')
    return this.packing.create(input)
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.packing.remove(idParam(body['orderId'], '订单编号'), idParam(body['plId'], '批次编号'))
  }

  @Post('updateInfo')
  @HttpCode(200)
  updateInfo(@Body() body: Record<string, unknown>) {
    return this.packing.updateInfo(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      objectParam(body['patch'], '批次信息')
    )
  }

  @Post('updateLine')
  @HttpCode(200)
  updateLine(@Body() body: Record<string, unknown>) {
    return this.packing.updateLine(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      idParam(body['lineId'], '装箱行编号'),
      objectParam(body['patch'], '装箱行改动')
    )
  }

  @Post('addLine')
  @HttpCode(200)
  addLine(@Body() body: Record<string, unknown>) {
    return this.packing.addLine(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      objectParam(body['line'], '装箱行')
    )
  }

  @Post('deleteLine')
  @HttpCode(200)
  deleteLine(@Body() body: Record<string, unknown>) {
    return this.packing.deleteLine(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      idParam(body['lineId'], '装箱行编号')
    )
  }

  @Post('void')
  @HttpCode(200)
  void(@Body() body: Record<string, unknown>) {
    return this.packing.void(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      strParam(body['reason'])
    )
  }

  @Post('unvoid')
  @HttpCode(200)
  unvoid(@Body() body: Record<string, unknown>) {
    return this.packing.unvoid(
      idParam(body['orderId'], '订单编号'),
      idParam(body['plId'], '批次编号'),
      strParam(body['reason'])
    )
  }
}
