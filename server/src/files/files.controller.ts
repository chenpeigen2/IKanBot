import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  StreamableFile
} from '@nestjs/common'
import type { Request } from 'express'
import { strParam } from '../common/params'
import { ImageStore, MAX_IMAGE_BYTES } from './image-store.service'

/**
 * 图片传输。桌面端把商品图传到后端，渲染时按 URL 直接取——
 * 库搬到了服务器而图留在本机，商品卡会一片空白，等于没搬。
 *
 * 上传走 application/octet-stream（不是 JSON base64）：照片动辄几 MB，
 * base64 白涨三分之一，还得让 JSON 解析器吃下几 MB 字符串。
 */
@Controller('api/files')
export class FilesController {
  constructor(private readonly store: ImageStore) {}

  @Post('upload')
  @HttpCode(200)
  upload(@Query('name') name: string, @Req() req: Request): { fileName: string } {
    const body: unknown = req.body
    if (!Buffer.isBuffer(body)) throw new BadRequestException('图片要以 application/octet-stream 原样上传')
    if (body.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException(`图片太大了（${(body.length / 1024 / 1024).toFixed(1)}MB），单张上限 20MB。`)
    }
    return { fileName: this.store.save(body, strParam(name)) }
  }

  @Post('discard')
  @HttpCode(200)
  discard(@Body() body: Record<string, unknown>): { removed: number } {
    const names: unknown[] = Array.isArray(body['names']) ? body['names'] : []
    let removed = 0
    for (const n of names) {
      if (typeof n !== 'string') continue
      if (this.store.remove(n)) removed++
    }
    return { removed }
  }

  @Get('images/:name')
  @Header('cache-control', 'public, max-age=31536000, immutable')
  serve(@Param('name') name: string): StreamableFile {
    const buf = this.store.read(name)
    // 图不在就说图不在：前端会退回本机目录再找一次（公司 Logo 还在本机设置里）
    if (!buf) throw new NotFoundException('图片不存在')
    return new StreamableFile(buf, { type: this.store.mimeOf(name) })
  }
}
