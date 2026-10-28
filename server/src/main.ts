import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { configureApp } from './app.setup'
import { CONFIG } from './config/config.module'
import type { ServerConfig } from './config/config'
import { DB } from './db/db.module'
import type { Db } from './db/types'
import { RoutesService } from './meta/routes.service'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest 默认每行日志都带 [NestFactory] 前缀，服务端日志混在一起不好读，只留错误
    logger: ['error', 'warn']
  })
  await configureApp(app)

  const config = app.get<ServerConfig>(CONFIG)
  await app.listen(config.port)

  const db = app.get<Db>(DB)
  const routes = app.get(RoutesService).list()
  console.log(
    `[ikanbot-server] 已启动 http://localhost:${config.port}（数据后端 ${db.kind}，已接 ${routes.length} 个接口）`
  )
  console.log(`[ikanbot-server] 接口清单：curl http://localhost:${config.port}/api`)
}

bootstrap().catch((e: unknown) => {
  console.error('[ikanbot-server] 启动失败', e)
  process.exit(1)
})
