import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../config/config'

/**
 * token 签名秘钥。
 * IKAN_AUTH_SECRET 环境变量优先（部署时显式给）；没给就自动生成一把，
 * 存在数据库文件旁边的 .auth-secret（重启不变——重启就把全员登出去了）。
 * 文件丢了/换机器 = 全员重新登录，这是可接受的代价：秘钥只用来验 token，不碰业务数据。
 */
export function getOrCreateSecret(config: ServerConfig): string {
  const env = process.env['IKAN_AUTH_SECRET']
  if (env) return env
  const dir = config.db.kind === 'sqlite' ? dirname(config.db.file) : process.cwd()
  const file = join(dir, '.auth-secret')
  try {
    if (existsSync(file)) {
      const s = readFileSync(file, 'utf8').trim()
      if (s.length >= 32) return s
    }
  } catch {
    // 读不动就重造一把：代价只是老 token 全部失效
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return secret
}
