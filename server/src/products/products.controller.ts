import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common'
import { ProductsService } from './products.service'
import { boolParam, idParam, objectParam, strParam } from '../common/params'

/**
 * 路由名 = IPC 通道名（products:list → POST /api/products/list），
 * 与客户域同一条规矩：桌面端转发器按通道名一对一映射，不维护第二套命名。
 */
@Controller('api/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.products.list(strParam(body['keyword']), boolParam(body['includeInactive']))
  }

  @Post('get')
  @HttpCode(200)
  get(@Body() body: Record<string, unknown>) {
    return this.products.get(idParam(body['id'], '商品编号'))
  }

  @Post('save')
  @HttpCode(200)
  save(@Body() body: Record<string, unknown>) {
    return this.products.save(objectParam(body['input'], '商品档案'))
  }

  @Post('delete')
  @HttpCode(200)
  remove(@Body() body: Record<string, unknown>) {
    return this.products.remove(idParam(body['id'], '商品编号'))
  }

  @Post('copy')
  @HttpCode(200)
  copy(@Body() body: Record<string, unknown>) {
    return this.products.copy(idParam(body['id'], '商品编号'), strParam(body['newStyleNo']))
  }

  @Post('images')
  @HttpCode(200)
  images(@Body() body: Record<string, unknown>) {
    return this.products.listImages(idParam(body['productId'], '商品编号'))
  }

  @Post('addImage')
  @HttpCode(200)
  addImage(@Body() body: Record<string, unknown>) {
    const fileName = strParam(body['fileName']).trim()
    if (!fileName) throw new BadRequestException('图片文件名不能为空')
    return this.products.addImage(
      idParam(body['productId'], '商品编号'),
      fileName,
      body['isPrimary'] === true
    )
  }

  @Post('delImage')
  @HttpCode(200)
  delImage(@Body() body: Record<string, unknown>) {
    return this.products.removeImage(idParam(body['id'], '图片编号'))
  }

  @Post('setPrimary')
  @HttpCode(200)
  setPrimary(@Body() body: Record<string, unknown>) {
    return this.products.setPrimary(
      idParam(body['productId'], '商品编号'),
      idParam(body['imageId'], '图片编号')
    )
  }

  @Post('setActive')
  @HttpCode(200)
  setActive(@Body() body: Record<string, unknown>) {
    const active = body['active'] === 1 || body['active'] === true ? 1 : 0
    return this.products.setActive(idParam(body['id'], '商品编号'), active)
  }

  @Post('referenceCount')
  @HttpCode(200)
  referenceCount(@Body() body: Record<string, unknown>) {
    return this.products.referenceCount(idParam(body['id'], '商品编号'))
  }

  @Post('importCsv')
  @HttpCode(200)
  importCsv(@Body() body: Record<string, unknown>) {
    const mode = body['mode'] === 'overwrite' ? 'overwrite' : 'skip'
    return this.products.importCsv(strParam(body['text']), mode)
  }
}
