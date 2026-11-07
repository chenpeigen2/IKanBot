import { Inject, Module, OnModuleInit } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { AuthController } from './auth.controller'
import { createUser } from './users'

/**
 * 鉴权装配（M2 第一片）：登录路由 + 首个用户的引导。
 *
 * 首个用户怎么来：users 表为空时读 IKAN_BOOTSTRAP_USER / IKAN_BOOTSTRAP_PASSWORD
 * （可加 IKAN_BOOTSTRAP_NAME 给显示名）建一个；两个变量没设齐就只打警告照常启动——
 * 这时除了 /healthz 与 GET /api 都会回 401，服务是安全的，只是还没有人能进来。
 * 后续加人不重启服务：跑 `curl -X POST …/api/auth/login` 没用，用 CLI：
 * `IKAN_BOOTSTRAP_USER=xxx IKAN_BOOTSTRAP_PASSWORD=xxx 重启一次`（表非空时跳过，不重复建），
 * 或者直接往 users 表插一行（密码用 server/src/auth/password.ts 的 hashPassword 生成）。
 */
@Module({
  controllers: [AuthController]
})
export class AuthModule implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    const n = (await this.db.get('SELECT COUNT(*) AS n FROM users')) as Record<string, unknown> | null
    if (Number(n?.['n'] ?? 0) > 0) return
    const username = process.env['IKAN_BOOTSTRAP_USER'] ?? ''
    const password = process.env['IKAN_BOOTSTRAP_PASSWORD'] ?? ''
    if (username && password) {
      const created = await createUser(this.db, username, password, process.env['IKAN_BOOTSTRAP_NAME'] ?? '')
      console.log(`[ikanbot-server] 已创建首个用户 ${created.username}（显示名：${created.displayName}）`)
    } else {
      console.warn(
        '[ikanbot-server] users 表是空的：设 IKAN_BOOTSTRAP_USER / IKAN_BOOTSTRAP_PASSWORD 后重启即可创建首个用户。' +
          '在那之前除 /healthz 与 GET /api 外的接口都会回 401「请先登录」。'
      )
    }
  }
}
