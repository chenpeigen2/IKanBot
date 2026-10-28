import { SqliteDb } from './sqlite'
import { MysqlDb } from './mysql'
import type { Db } from './types'
import type { ServerConfig } from '../config/config'

/**
 * 模式选择：有 MySQL 配置就连 MySQL，否则用本地 SQLite 文件。
 * 两种实现共用同一个 Db 接口，业务代码不知道背后是哪个。
 */
export function createDb(config: ServerConfig): Db {
  const c = config.db
  if (c.kind === 'mysql') {
    return new MysqlDb({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database
    })
  }
  return new SqliteDb(c.file)
}
