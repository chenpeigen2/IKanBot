import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common'
import { arrayParam, idParam, objectParam, optionalObject, strParam } from '../common/params'
import { OrdersService } from './orders.service'

/**
 * 路由名 = IPC 通道名（orders:addPayment → POST /api/orders/addPayment）。
 * 参数名与 desktop 的 REMOTE_ROUTES.args 一一对应：桌面按位置传参，转发器翻成这份具名请求体。
 */
@Controller('api/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.orders.list(optionalObject(body['filter'], '订单筛选条件'))
  }

  @Post('get')
  @HttpCode(200)
  get(@Body() body: Record<string, unknown>) {
    return this.orders.get(idParam(body['id'], '订单编号'))
  }

  @Post('create')
  @HttpCode(200)
  create(@Body() body: Record<string, unknown>) {
    return this.orders.create(objectParam(body['input'], '订单内容'))
  }

  @Post('update')
  @HttpCode(200)
  update(@Body() body: Record<string, unknown>) {
    return this.orders.update(idParam(body['id'], '订单编号'), objectParam(body['input'], '订单内容'))
  }

  @Post('setParties')
  @HttpCode(200)
  setParties(@Body() body: Record<string, unknown>) {
    return this.orders.setParties(idParam(body['id'], '订单编号'), objectParam(body['patch'], '抬头改动'))
  }

  @Post('updateCharges')
  @HttpCode(200)
  updateCharges(@Body() body: Record<string, unknown>) {
    return this.orders.updateCharges(
      idParam(body['id'], '订单编号'),
      arrayParam(body['charges'], '费用行'),
      strParam(body['reason'])
    )
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.orders.remove(idParam(body['id'], '订单编号'))
  }

  @Post('void')
  @HttpCode(200)
  void(@Body() body: Record<string, unknown>) {
    const opts = optionalObject(body['opts'], '作废选项')
    return this.orders.void(
      idParam(body['id'], '订单编号'),
      strParam(body['reason']),
      opts['confirmDocs'] === true
    )
  }

  @Post('addItem')
  @HttpCode(200)
  addItem(@Body() body: Record<string, unknown>) {
    return this.orders.addItem(idParam(body['orderId'], '订单编号'), objectParam(body['item'], '明细行'))
  }

  @Post('updateItem')
  @HttpCode(200)
  updateItem(@Body() body: Record<string, unknown>) {
    return this.orders.updateItem(
      idParam(body['orderId'], '订单编号'),
      idParam(body['itemId'], '明细编号'),
      objectParam(body['patch'], '明细改动')
    )
  }

  @Post('addItems')
  @HttpCode(200)
  addItems(@Body() body: Record<string, unknown>) {
    return this.orders.addItems(idParam(body['orderId'], '订单编号'), arrayParam(body['items'], '明细行'))
  }

  @Post('removeItem')
  @HttpCode(200)
  removeItem(@Body() body: Record<string, unknown>) {
    return this.orders.removeItem(idParam(body['orderId'], '订单编号'), idParam(body['itemId'], '明细编号'))
  }

  @Post('replaceItems')
  @HttpCode(200)
  replaceItems(@Body() body: Record<string, unknown>) {
    return this.orders.replaceItems(idParam(body['orderId'], '订单编号'), arrayParam(body['items'], '明细行'))
  }

  @Post('summarizeSkus')
  @HttpCode(200)
  summarizeSkus(@Body() body: Record<string, unknown>) {
    return this.orders.summarizeSkus(idParam(body['orderId'], '订单编号'))
  }

  @Post('addPayment')
  @HttpCode(200)
  addPayment(@Body() body: Record<string, unknown>) {
    return this.orders.addPayment(idParam(body['orderId'], '订单编号'), objectParam(body['p'], '收款'))
  }

  @Post('batchAddPayments')
  @HttpCode(200)
  batchAddPayments(@Body() body: Record<string, unknown>) {
    return this.orders.batchAddPayments(arrayParam(body['entries'], '批量收款'))
  }

  @Post('deletePayment')
  @HttpCode(200)
  deletePayment(@Body() body: Record<string, unknown>) {
    return this.orders.deletePayment(
      idParam(body['orderId'], '订单编号'),
      idParam(body['paymentId'], '收款编号'),
      strParam(body['reason'])
    )
  }

  @Post('listSettlements')
  @HttpCode(200)
  listSettlements(@Body() body: Record<string, unknown>) {
    return this.orders.listSettlements(idParam(body['orderId'], '订单编号'))
  }

  @Post('addSettlement')
  @HttpCode(200)
  addSettlement(@Body() body: Record<string, unknown>) {
    return this.orders.addSettlement(
      idParam(body['orderId'], '订单编号'),
      objectParam(body['input'], '核销')
    )
  }

  @Post('reverseSettlement')
  @HttpCode(200)
  reverseSettlement(@Body() body: Record<string, unknown>) {
    return this.orders.reverseSettlement(
      idParam(body['orderId'], '订单编号'),
      idParam(body['settlementId'], '核销编号'),
      strParam(body['reason'])
    )
  }

  @Post('setShipStatus')
  @HttpCode(200)
  setShipStatus(@Body() body: Record<string, unknown>) {
    return this.orders.setShipStatus(
      idParam(body['orderId'], '订单编号'),
      strParam(body['status']),
      strParam(body['note'])
    )
  }

  @Post('setPaymentStatus')
  @HttpCode(200)
  setPaymentStatus(@Body() body: Record<string, unknown>) {
    return this.orders.setPaymentStatus(
      idParam(body['orderId'], '订单编号'),
      strParam(body['status']),
      strParam(body['note'])
    )
  }

  @Post('events')
  @HttpCode(200)
  events(@Body() body: Record<string, unknown>) {
    return this.orders.listEvents(idParam(body['orderId'], '订单编号'))
  }

  @Post('ports')
  @HttpCode(200)
  ports() {
    return this.orders.listPorts()
  }

  @Post('lastTerms')
  @HttpCode(200)
  lastTerms(@Body() body: Record<string, unknown>) {
    return this.orders.lastTerms(idParam(body['customerId'], '客户编号'))
  }

  @Post('lastExchangeRate')
  @HttpCode(200)
  lastExchangeRate() {
    return this.orders.lastExchangeRate()
  }

  @Post('lastExchangeRateInfo')
  @HttpCode(200)
  lastExchangeRateInfo(@Body() body: Record<string, unknown>) {
    const currency = body['currency']
    return this.orders.lastExchangeRateInfo(currency === undefined || currency === null ? undefined : strParam(currency))
  }

  @Post('photos')
  @HttpCode(200)
  photos(@Body() body: Record<string, unknown>) {
    return this.orders.listPhotos(idParam(body['orderId'], '订单编号'))
  }

  @Post('addPhoto')
  @HttpCode(200)
  addPhoto(@Body() body: Record<string, unknown>) {
    const fileName = strParam(body['fileName']).trim()
    if (!fileName) throw new BadRequestException('照片文件名不能为空')
    const kind = body['kind'] === 'container' || body['kind'] === 'other' ? body['kind'] : 'inspection'
    return this.orders.addPhoto(idParam(body['orderId'], '订单编号'), fileName, kind, strParam(body['note']))
  }

  @Post('delPhoto')
  @HttpCode(200)
  delPhoto(@Body() body: Record<string, unknown>) {
    return this.orders.removePhoto(idParam(body['orderId'], '订单编号'), idParam(body['photoId'], '照片编号'))
  }
}
