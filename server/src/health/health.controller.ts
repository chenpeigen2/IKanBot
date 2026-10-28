import { Controller, Get, Inject } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 不放在 /api 下：运维探针不该依赖业务前缀，也不该要求鉴权 */
  @Get('healthz')
  async health() {
    const row = await this.db.get('SELECT 1 AS ok')
    return { ok: row?.['ok'] === 1, db: this.db.kind }
  }
}
