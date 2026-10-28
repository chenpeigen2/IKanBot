import type { NestExpressApplication } from '@nestjs/platform-express'
import type { NextFunction, Request, Response } from 'express'
import { AllExceptionsFilter } from './common/all-exceptions.filter'

/**
 * 全部形态在这里一次装好（服务启动与测试共用），避免测试跑的 app 与线上不是同一个。
 * 错误体（含 404 的文案）由全局过滤器统一产出，不额外挂兜底中间件——
 * 那个中间件会被 Nest 自己的 404 挡住。
 */
export async function configureApp(app: NestExpressApplication): Promise<void> {
  app.useGlobalFilters(app.get(AllExceptionsFilter))
  // 订单带明细/照片元数据时体积不小，默认 100kb 会把正常保存挡在门外
  app.useBodyParser('json', { limit: '4mb' })
  // 完全不带请求体的 POST（`curl -X POST …/list`、某些客户端不发明 Content-Length）时
  // express 5 给的是 undefined，控制器一读 body['keyword'] 就 TypeError → 500。
  // 空对象在这里补上：路由一律按「字段缺省」处理，不因少个 {} 就报服务器内部错误。
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body === undefined) req.body = {}
    next()
  })
  app.enableShutdownHooks()
  await app.init()
}
