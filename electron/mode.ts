import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * 数据来源：本机库，还是后端服务。
 *
 * 这份配置不能存在库里——「连哪个库」是库本身答不出来的问题，
 * 偏偏它又是每次启动第一个要回答的。所以单放一份 connection.json（userData 根目录），
 * 不随备份打包、不随库迁移，换机器重配一次也只是两行字。
 */
export type DataMode = 'local' | 'remote'

export interface Connection {
  mode: DataMode
  /** 后端根地址，不带结尾斜杠 */
  remoteUrl: string
}

const DEFAULTS: Connection = { mode: 'local', remoteUrl: 'http://localhost:8787' }

let cache: Connection | null = null

function configFile(): string {
  return process.env['IKAN_CONNECTION_FILE'] ?? join(app.getPath('userData'), 'connection.json')
}

/** 地址写错要在设置页当场看见，不能等到开单时才发现连了个 http// 的鬼东西 */
export function normalizeBaseUrl(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\/[^\s/]+/i.test(s)) {
    throw new Error('后端地址要以 http:// 或 https:// 开头，例如 http://192.168.1.10:8787')
  }
  return s
}

/** 环境变量钉住时不读文件——自动化验收入口靠它，不受上次在界面上点的模式影响 */
export function envLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return envMode(env) !== null || Boolean(env['IKAN_REMOTE_URL'])
}

function envMode(env: NodeJS.ProcessEnv): DataMode | null {
  const v = env['IKAN_MODE']
  return v === 'local' || v === 'remote' ? v : null
}

/**
 * 文件里存的 + 环境变量 → 最终生效的连接。纯函数，测试和小工具可以直接喂假 env，
 * 不必去动真实配置文件或模块缓存。
 */
export function resolveConnection(saved: Partial<Connection> | null, env: NodeJS.ProcessEnv): Connection {
  let remoteUrl = DEFAULTS.remoteUrl
  try {
    remoteUrl = normalizeBaseUrl(env['IKAN_REMOTE_URL'] ?? saved?.remoteUrl) || DEFAULTS.remoteUrl
  } catch {
    // 存进去的地址不合法（手改坏了）：先用默认值把程序带起来，设置页里再改
  }
  return {
    mode: envMode(env) ?? (saved?.mode === 'remote' ? 'remote' : 'local'),
    remoteUrl
  }
}

export function getConnection(): Connection {
  if (cache) return cache
  let saved: Partial<Connection> = {}
  try {
    if (existsSync(configFile())) saved = JSON.parse(readFileSync(configFile(), 'utf8'))
  } catch {
    // 文件坏了按默认走。这里不能抛：抛了就整台程序起不来，而它只是「上次选了哪个来源」
  }
  cache = resolveConnection(saved, process.env)
  return cache
}

export function isRemoteMode(): boolean {
  return getConnection().mode === 'remote'
}

export function saveConnection(patch: { mode?: unknown; remoteUrl?: unknown }): Connection {
  const cur = getConnection()
  const next: Connection = {
    mode: patch.mode === undefined ? cur.mode : patch.mode === 'remote' ? 'remote' : 'local',
    remoteUrl:
      patch.remoteUrl === undefined
        ? cur.remoteUrl
        : normalizeBaseUrl(patch.remoteUrl) || DEFAULTS.remoteUrl
  }
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  cache = next
  return next
}
