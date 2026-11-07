import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * 登录态的存身处（M2 鉴权第一片）。
 *
 * token 是通行证，不能明文落盘：用 safeStorage（操作系统钥匙串/DPAPI）加密后
 * 存在 userData/auth-token.json。用户名与显示名不是秘密，明文存着让设置页显示「已登录为谁」。
 * 没有登录态、解不开、token 过期，都按「未登录」算——过期不本地判，交给后端 401 统一说。
 */

export interface StoredAuth {
  token: string
  username: string
  displayName: string
}

const FALLBACK_WARNING = '（系统加密不可用，token 只能明文存放——这台电脑别人能读到就别保存登录）'

function file(): string {
  return process.env['IKAN_AUTH_FILE'] ?? join(app.getPath('userData'), 'auth-token.json')
}

interface DiskShape {
  enc?: string
  plain?: string
  username?: string
  displayName?: string
}

let cache: StoredAuth | null | undefined

function encrypt(token: string): DiskShape {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(token).toString('base64') }
  }
  // Linux 部分发行版没有钥匙串：明文兜底但明确说破，不装作安全
  console.warn(`[auth] safeStorage 不可用，登录态明文落盘${FALLBACK_WARNING}`)
  return { plain: token }
}

function decrypt(d: DiskShape): string {
  if (d.enc) return safeStorage.decryptString(Buffer.from(d.enc, 'base64'))
  return d.plain ?? ''
}

export function loadStoredAuth(): StoredAuth | null {
  if (cache !== undefined) return cache
  cache = null
  try {
    if (!existsSync(file())) return cache
    const d = JSON.parse(readFileSync(file(), 'utf8')) as DiskShape
    const token = decrypt(d)
    if (token) {
      cache = { token, username: String(d.username ?? ''), displayName: String(d.displayName ?? '') }
    }
  } catch {
    // 解不开/文件坏了 = 没登录，让用户重新登一次比报错卡死强
    cache = null
  }
  return cache
}

export function saveStoredAuth(a: StoredAuth): void {
  const shape = encrypt(a.token)
  const payload: DiskShape = {
    ...shape,
    username: a.username,
    displayName: a.displayName
  }
  const f = file()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, `${JSON.stringify(payload)}\n`, 'utf8')
  cache = a
}

export function clearStoredAuth(): void {
  cache = null
  try {
    rmSync(file(), { force: true })
  } catch {
    // 文件已经不在 = 已经登出了
  }
}

/** 远端请求带头用：没有登录态就空串（后端会回 401 说请先登录） */
export function currentToken(): string {
  return loadStoredAuth()?.token ?? ''
}

/** 设置页显示用：登录了吗、登的是谁 */
export function authState(): { loggedIn: boolean; username: string; displayName: string } {
  const a = loadStoredAuth()
  return { loggedIn: a !== null, username: a?.username ?? '', displayName: a?.displayName ?? '' }
}
