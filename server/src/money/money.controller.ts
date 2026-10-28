import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { idParam } from '../common/params'
import { MoneyService } from './money.service'

/**
 * 路由名照通道名走（report:receivables → POST /api/report/receivables）。
 * 同一份 core/money.ts 也挂在桌面本机模式下——这里只换数据驱动。
 */
@Controller('api/report')
export class ReportsController {
  constructor(private readonly money: MoneyService) {}

  @Post('receivables')
  @HttpCode(200)
  receivables() {
    return this.money.receivables()
  }

  @Post('customerOrderRows')
  @HttpCode(200)
  customerOrderRows(@Body() body: Record<string, unknown>) {
    return this.money.customerOpenRows(idParam(body['customerId'], '客户编号'))
  }
}

@Controller('api/pl')
export class PackingAmountsController {
  constructor(private readonly money: MoneyService) {}

  /** 本批金额：纸面箱单、存档、批次列表都取这一个数 */
  @Post('amounts')
  @HttpCode(200)
  amounts(@Body() body: Record<string, unknown>) {
    return this.money.packingAmounts(idParam(body['orderId'], '订单编号'))
  }
}

@Controller('api/credits')
export class CreditsReadController {
  constructor(private readonly money: MoneyService) {}

  /** 预收余额是派生值：来源单据 − 已抵扣 − 已退还，不单独存一张余额表 */
  @Post('balance')
  @HttpCode(200)
  balance(@Body() body: Record<string, unknown>) {
    return this.money.creditBalance(idParam(body['customerId'], '客户编号'))
  }
}
