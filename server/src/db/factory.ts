import { join } from 'node:path'
import { SqliteDb } from './sqlite'
import { MysqlDb } from './mysql'
import type { Db } from './types'

/**
 * 模式选择：有 MySQL 配置就连远端的库，否则用本地 SQLite 文件。
 * 桌面双模式与后端服务共用这个工厂；桌面端的「本地/远端」选择在 M3 接配置。
 */
export function createDb(env: NodeJS.ProcessEnv = process.env): Db {
  const host = env['IKAN_MYSQL_HOST']
  if (env['IKAN_DB'] === 'mysql' && host) {
    return new MysqlDb({
      host,
      port: env['IKAN_MYSQL_PORT'] ? Number(env['IKAN_MYSQL_PORT']) : 3306,
      user: env['IKAN_MYSQL_USER'] ?? 'ikanbot',
      password: env['IKAN_MYSQL_PASSWORD'] ?? '',
      database: env['IKAN_MYSQL_DATABASE'] ?? 'ikanbot'
    })
  }
  return new SqliteDb(env['IKAN_SQLITE_FILE'] ?? join(process.cwd(), '.tmp', 'ikanbot.db'))
}
