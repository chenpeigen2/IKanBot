import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common'
import { BackupService } from './backup.service'

/**
 * 备份（R61 从本机独有通道搬上后端）：
 *   create   —— 服务器侧打包（库 + 图片目录 + 单据存档目录），节奏与桌面同一份 core
 *   list     —— 备份包列表（新→旧），桌面远端模式的恢复入口从这里挑
 *   inspect  —— 打开一个备份包看摘要（几单几笔、多大），恢复确认框用
 *   restore  —— 整库导入 + 文件目录替换 + 失败回滚；恢复期间业务请求被闸门挡回去
 *
 * 桌面本机模式的 backup: 前缀通道不经过这里（本机备份还是本机的事）。
 */
@Controller('api/backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Post('create')
  @HttpCode(200)
  async create(): Promise<{ path: string }> {
    // 包成对象：裸字符串回来时 HTTP 层不给 application/json，桌面端解析会含糊
    return { path: await this.backup.create() }
  }

  @Post('list')
  @HttpCode(200)
  list() {
    return this.backup.list()
  }

  @Post('inspect')
  @HttpCode(200)
  inspect(@Body() body: Record<string, unknown>) {
    if (body['path'] == null) throw new BadRequestException('请先选择一个备份文件')
    return this.backup.inspect(body['path'])
  }

  @Post('restore')
  @HttpCode(200)
  restore(@Body() body: Record<string, unknown>) {
    if (body['path'] == null) throw new BadRequestException('请先选择一个备份文件')
    return this.backup.restore(body['path'])
  }
}
