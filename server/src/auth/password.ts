import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 密码哈希：node 内置 scrypt（M2 鉴权第一片）。
 * 不为这件事引原生依赖（argon2/bcrypt 要编译或带二进制包），scrypt 是 node 自带的同档算法。
 * 存储格式：`scrypt:<盐hex>:<哈希hex>`——盐是每次哈希随机生成的，同一个密码两次哈希不同，
 * 库被拖走也不能直接拿哈希撞库；校验用 timingSafeEqual，不给计时侧信道留门。
 */

const SALT_BYTES = 16
const KEY_LEN = 64
/** 密码下限：太短的密码 scrypt 也救不回来 */
export const MIN_PASSWORD_LEN = 6

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(plain, salt, KEY_LEN)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = String(stored ?? '').split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let expected: Buffer
  let salt: Buffer
  try {
    salt = Buffer.from(parts[1], 'hex')
    expected = Buffer.from(parts[2], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const actual = scryptSync(plain, salt, expected.length)
  return timingSafeEqual(expected, actual)
}
