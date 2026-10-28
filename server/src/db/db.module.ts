import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { CONFIG } from '../config/config.module'
import type { ServerConfig } from '../config/config'
import { createDb } from './factory'
import { migrate } from './migrate'
import type { Db } from './types'

export const DB = 'IKAN_DB'

/**
 * 全库只有一个连接入口：注入 DB 记号即可，服务层不碰工厂。
 * 建库/升级在启动时一次做完，失败就让服务起不来——带病的库比不启动更危险。
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: async (config: ServerConfig): Promise<Db> => {
        const db = createDb(config)
        try {
          await migrate(db)
        } catch (e) {
          await db.close()
          throw e
        }
        return db
      }
    }
  ],
  exports: [DB]
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close()
  }
}
