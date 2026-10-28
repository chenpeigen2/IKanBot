import { join } from 'node:path'

export type DbKind = 'sqlite' | 'mysql'

export interface ServerConfig {
  port: number
  /**
   * 商品图片目录。桌面端图片在 userData/images，后端必须有自己的那份：
   * 库搬过来了、图没搬，商品卡就是一片空白。
   */
  imagesDir: string
  db:
    | { kind: 'sqlite'; file: string }
    | {
        kind: 'mysql'
        host: string
        port: number
        user: string
        password: string
        database: string
      }
}

/**
 * 配置只来自环境变量：容器/服务端最省心的形态，不引入配置文件解析。
 * 本地开发用 `npm run dev`（会设置 IKAN_SQLITE_FILE 指到 .tmp 的副本）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['IKAN_PORT'] ?? 8787)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`IKAN_PORT 不是合法端口：${String(env['IKAN_PORT'])}`)
  }
  // 后端图片目录不能跟着桌面端走：两边各存各的，各自的备份各自带走
  const imagesDir = env['IKAN_IMAGES_DIR'] ?? join(process.cwd(), '.tmp', 'images')
  const mysqlHost = env['IKAN_MYSQL_HOST']
  const db: ServerConfig['db'] =
    env['IKAN_DB'] === 'mysql' && mysqlHost
      ? {
          kind: 'mysql',
          host: mysqlHost,
          port: env['IKAN_MYSQL_PORT'] ? Number(env['IKAN_MYSQL_PORT']) : 3306,
          user: env['IKAN_MYSQL_USER'] ?? 'ikanbot',
          password: env['IKAN_MYSQL_PASSWORD'] ?? '',
          database: env['IKAN_MYSQL_DATABASE'] ?? 'ikanbot'
        }
      : { kind: 'sqlite', file: env['IKAN_SQLITE_FILE'] ?? join(process.cwd(), '.tmp', 'ikanbot.db') }
  return { port, db, imagesDir }
}
