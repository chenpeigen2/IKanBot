import { Controller, Get, Inject } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { RoutesService } from './routes.service'

/** 接口自描述：curl 一下就知道服务端接了什么，桌面端也拿它算覆盖率 */
@Controller('api')
export class MetaController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly routes: RoutesService
  ) {}

  @Get()
  index() {
    return {
      service: 'ikanbot-server',
      version: 1,
      db: this.db.kind,
      routes: this.routes.list().map((r) => `${r.method} ${r.path}`)
    }
  }
}
