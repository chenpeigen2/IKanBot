import { Body, Controller, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common'
import { CONFIG } from '../config/config.module'
import type { ServerConfig } from '../config/config'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { verifyPassword } from './password'
import { getOrCreateSecret } from './secret'
import { signToken } from './token'
import { findUserByUsername } from './users'

/**
 * 登录（M2 鉴权第一片）。这是 /api 下唯一不挂校验的路由：
 * 它的产出就是那张通行证。密码不对与查无此人回同一句话——
 * 不告诉试探的人「这个用户名存在」。
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ServerConfig
  ) {}

  /** token 有效期：一个工作日。过期后桌面端会收到 401，重新登录即可 */
  static readonly TTL_MINUTES = 12 * 60

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { username?: unknown; password?: unknown }): Promise<{
    token: string
    username: string
    displayName: string
    expiresAt: string
  }> {
    const user = await findUserByUsername(this.db, String(body?.username ?? ''))
    if (!user || !verifyPassword(String(body?.password ?? ''), user.passwordHash)) {
      throw new UnauthorizedException('用户名或密码不对')
    }
    const ttl = AuthController.TTL_MINUTES
    const token = signToken(user.username, getOrCreateSecret(this.config), ttl, user.displayName)
    return {
      token,
      username: user.username,
      displayName: user.displayName,
      expiresAt: new Date(Date.now() + ttl * 60_000).toISOString()
    }
  }
}
