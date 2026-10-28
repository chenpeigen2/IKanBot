import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { arrayParam, idParam, objectParam, optionalObject } from '../common/params'
import { QuotationsService } from './quotations.service'

/** 路由名 = IPC 通道名（quotations:convert → POST /api/quotations/convert）。 */
@Controller('api/quotations')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.quotations.list(optionalObject(body['filter'], '报价筛选条件'))
  }

  @Post('get')
  @HttpCode(200)
  get(@Body() body: Record<string, unknown>) {
    return this.quotations.get(idParam(body['id'], '报价单编号'))
  }

  @Post('save')
  @HttpCode(200)
  save(@Body() body: Record<string, unknown>) {
    const input = objectParam(body['input'], '报价单')
    // core 会逐行校验数量与单价，但前提是 items 真是列表：非数组在这里就拒，别让英文 TypeError 冒上去
    arrayParam(input['items'], '报价单明细')
    return this.quotations.save(input)
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.quotations.remove(idParam(body['id'], '报价单编号'))
  }

  @Post('updateMeta')
  @HttpCode(200)
  updateMeta(@Body() body: Record<string, unknown>) {
    return this.quotations.updateMeta(
      idParam(body['id'], '报价单编号'),
      objectParam(body['meta'], '报价状态')
    )
  }

  @Post('events')
  @HttpCode(200)
  events(@Body() body: Record<string, unknown>) {
    return this.quotations.events(idParam(body['id'], '报价单编号'))
  }

  @Post('convert')
  @HttpCode(200)
  convert(@Body() body: Record<string, unknown>) {
    return this.quotations.convert(idParam(body['id'], '报价单编号'), optionalObject(body['opts'], '转单选项'))
  }

  @Post('versions')
  @HttpCode(200)
  versions(@Body() body: Record<string, unknown>) {
    return this.quotations.versions(idParam(body['id'], '报价单编号'))
  }
}
