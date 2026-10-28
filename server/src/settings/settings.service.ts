import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { settingsCore, type SettingsCore } from '../../../core/settings'
import type { AppSettings } from '../../../src/shared/types'

/**
 * 设置域的 HTTP 门面：默认值、脏数据兜底、表单守门、基准币锁全在 core/settings.ts，
 * 桌面端走同一个 core，只是 Db 换成本机适配器。
 */
@Injectable()
export class SettingsService {
  private readonly core: SettingsCore

  constructor(@Inject(DB) db: Db) {
    this.core = settingsCore(db)
  }

  get(): Promise<AppSettings> {
    return this.core.get()
  }

  save(raw: Record<string, unknown>): Promise<AppSettings> {
    return this.core.save(raw)
  }

  baseCurrencyLocked(): Promise<boolean> {
    return this.core.baseCurrencyLocked()
  }
}
