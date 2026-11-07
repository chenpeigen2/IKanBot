import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * 登录令牌：HMAC-SHA256 签名的紧凑 token（M2 鉴权第一片）。
 * 不引 JWT 库：我们只需要「签发-验签-过期」三件事，node 内置 HMAC 一口气做完，
 * 引纯 JS 轻依赖也省了——依赖越少，服务端越难被供应链钻空子。
 * 格式：`base64url(payload).base64url(hmac)`；payload 里带用户名、显示名与过期时刻。
 * 换秘钥（IKAN_AUTH_SECRET 换了 / 秘钥文件丢了）= 全员重新登录，这是特性不是事故。
 */

export interface TokenPayload {
  /** 用户名（登录身份，唯一） */
  u: string
  /** 显示名（操作留痕用；重新登录前不跟库里的改名同步） */
  n?: string
  /** 过期时刻（毫秒） */
  exp: number
}

export function signToken(username: string, secret: string, ttlMinutes: number, displayName?: string): string {
  const payload: TokenPayload = {
    u: username,
    ...(displayName ? { n: displayName } : {}),
    exp: Date.now() + ttlMinutes * 60_000
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

/** 验签 + 查过期；验不过一律 null，不给「为什么」——token 不是给人读的 */
export function verifyToken(token: string, secret: string): TokenPayload | null {
  const s = String(token ?? '')
  const dot = s.indexOf('.')
  if (dot <= 0 || dot === s.length - 1) return null
  const body = s.slice(0, dot)
  const mac = s.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest()
  let given: Buffer
  try {
    given = Buffer.from(mac, 'base64url')
  } catch {
    return null
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
  } catch {
    return null
  }
  if (typeof payload.u !== 'string' || !payload.u || typeof payload.exp !== 'number') return null
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null
  return payload
}
