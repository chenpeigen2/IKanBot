import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  StreamableFile
} from '@nestjs/common'
import type { Request } from 'express'
import { DocsService } from './docs.service'

/**
 * 单据存档（R60 从本机独有通道搬上后端）：
 *   save        —— PDF 字节原样上传（octet-stream），元数据走 meta 查询参数；
 *                  版次/指纹/CI 重叠闸门都在 core/docs，服务端落笔那一刻把门
 *   list        —— 按订单列存档版次
 *   listQuotation —— 按报价单列存档版次
 *   void        —— 作废一版 CI 存档（原因必填，core 里把门）
 *   nextVersion —— 下一个版次号（纸面印的版次要跟它对上）
 *   read        —— 按相对路径取 PDF 字节（桌面「打开/在文件夹中显示」用；
 *                  远端模式下文件在服务器上，桌面下载到临时文件再开）
 */
@Controller('api/docs')
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  /** 存档元数据太大塞不进查询串时给一句人话，不让解析错误裸奔 */
  private parseMeta(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BadRequestException('存档要带上 meta（单号、类型、金额这些），请从桌面端重试一次。')
    }
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('meta 不是对象')
      }
      return parsed as Record<string, unknown>
    } catch {
      throw new BadRequestException('meta 解析失败：请从桌面端重新生成预览后再存。')
    }
  }

  @Post('save')
  @HttpCode(200)
  async save(@Query('meta') meta: string, @Req() req: Request): Promise<{ filePath: string; version: number }> {
    const body: unknown = req.body
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException('PDF 要以 application/octet-stream 原样上传，不要 base64。')
    }
    if (body.length === 0) throw new BadRequestException('PDF 内容是空的，存不了这一版。')
    return this.docs.save(body, this.parseMeta(meta))
  }

  @Post('list')
  @HttpCode(200)
  list(@Body() body: Record<string, unknown>) {
    return this.docs.list(Number(body['orderId']))
  }

  @Post('listQuotation')
  @HttpCode(200)
  listQuotation(@Body() body: Record<string, unknown>) {
    return this.docs.listQuotation(Number(body['quotationId']))
  }

  @Post('void')
  @HttpCode(200)
  void(@Body() body: Record<string, unknown>) {
    return this.docs.void(Number(body['versionId']), body['reason'] == null ? undefined : String(body['reason']))
  }

  @Post('nextVersion')
  @HttpCode(200)
  nextVersion(@Body() body: Record<string, unknown>) {
    return this.docs.nextVersion(body['docNo'], body['kind'])
  }

  @Post('read')
  @HttpCode(200)
  @Header('content-type', 'application/pdf')
  read(@Body() body: Record<string, unknown>): StreamableFile {
    return new StreamableFile(this.docs.read(body['filePath']))
  }
}
