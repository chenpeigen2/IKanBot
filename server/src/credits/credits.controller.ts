import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { idParam, objectParam, strParam } from '../common/params'
import { CreditsService } from './credits.service'

/**
 * 路由名 = IPC 通道名（credits:reverseRefund → POST /api/credits/reverseRefund）。
 * 余额读在 MoneyModule 上挂同一前缀，两处各管读写，路由不冲突。
 */
@Controller('api/credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Post('apply')
  @HttpCode(200)
  apply(@Body() body: Record<string, unknown>) {
    return this.credits.apply(objectParam(body['input'], '抵扣内容'))
  }

  @Post('reverse')
  @HttpCode(200)
  reverse(@Body() body: Record<string, unknown>) {
    return this.credits.reverse(idParam(body['applicationId'], '抵扣编号'), strParam(body['reason']))
  }

  @Post('refund')
  @HttpCode(200)
  refund(@Body() body: Record<string, unknown>) {
    return this.credits.refund(objectParam(body['input'], '退款内容'))
  }

  @Post('reverseRefund')
  @HttpCode(200)
  reverseRefund(@Body() body: Record<string, unknown>) {
    return this.credits.reverseRefund(idParam(body['refundId'], '退款编号'), strParam(body['reason']))
  }
}
