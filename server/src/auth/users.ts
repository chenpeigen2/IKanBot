import type { Db } from '../db/types'
import { hashPassword, MIN_PASSWORD_LEN } from './password'

/**
 * 用户台账（M2 鉴权第一片）：登录名的唯一真源。
 * 服务端只认这张表里的人；「业务员名字」那套 settings.operator 是给桌面本地模式用的，
 * 两套名字并存是有意的——本地模式没有登录这回事。
 */

export interface UserRow {
  id: number
  username: string
  displayName: string
  passwordHash: string
}

/** 用户名归一：大小写与首尾空格不算差异（跟款号、客户名同一套口径） */
export function normalizeUsername(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase()
}

export async function findUserByUsername(db: Db, username: string): Promise<UserRow | null> {
  const row = (await db.get('SELECT id, username, display_name, password_hash FROM users WHERE username = ?', [
    normalizeUsername(username)
  ])) as Record<string, unknown> | null
  if (!row) return null
  return {
    id: Number(row['id']),
    username: String(row['username'] ?? ''),
    displayName: String(row['display_name'] ?? ''),
    passwordHash: String(row['password_hash'] ?? '')
  }
}

export async function createUser(
  db: Db,
  username: string,
  password: string,
  displayName = ''
): Promise<{ id: number; username: string; displayName: string }> {
  const name = normalizeUsername(username)
  if (!name) throw new Error('用户名不能为空')
  if (String(password ?? '').length < MIN_PASSWORD_LEN) {
    throw new Error(`密码至少要 ${MIN_PASSWORD_LEN} 位，太短的密码谁也救不回来`)
  }
  if (await findUserByUsername(db, name)) {
    throw new Error(`用户「${name}」已存在，换一个用户名`)
  }
  const shown = String(displayName ?? '').trim() || name
  const now = new Date().toISOString()
  const r = await db.run(
    'INSERT INTO users(username, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)',
    [name, shown, hashPassword(String(password)), now, now]
  )
  return { id: r.lastInsertRowid, username: name, displayName: shown }
}
