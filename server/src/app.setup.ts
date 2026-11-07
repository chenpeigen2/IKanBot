import type { NestExpressApplication } from '@nestjs/platform-express'
import type { NextFunction, Request, Response } from 'express'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { CONFIG } from './config/config.module'
import type { ServerConfig } from './config/config'
import { runAsActor } from '../../core/actor'
import { getOrCreateSecret } from './auth/secret'
import { verifyToken } from './auth/token'
import { BackupService } from './backup/backup.service'

/**
 * 鉴权闸门（M2 第一片）：除「说明自己是谁」的三个入口外全要 token。
 *   /healthz、GET /api —— 运维与探活，不给它们挂锁；
 *   POST /api/auth/login —— 它的产出就是通行证；
 *   GET /api/files/images/:name —— <img> 标签发不了 Authorization 头，现阶段放行
 *     （局域网内能看到图，账打不开）；签名 URL 按 M5 的计划补，这里先记挂账。
 * 验过 token 后把身份套住整个请求的调用链（core/actor 的 ALS）：
 * order_events 留痕的操作者从此是服务端认定的，桌面传什么不算数。
 */
export function installAuthGuard(app: NestExpressApplication): void {
  const config = app.get<ServerConfig>(CONFIG)
  const secret = getOrCreateSecret(config)
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const path = req.path
    if (
      path === '/api' ||
      path === '/healthz' ||
      path === '/api/auth/login' ||
      (req.method === 'GET' && path.startsWith('/api/files/images/'))
    ) {
      next()
      return
    }
    const header = String(req.headers.authorization ?? '')
    const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '', secret)
    if (!payload) {
      res.status(401).json({
        error: {
          message: '请先登录：打开「设置 · 数据来源」，用用户名密码登录后再用（登录过期也是这个提示）'
        }
      })
      return
    }
    // 身份以 token 为准（显示名优先，留痕写的是人名）； ALS 套住 next()，下游任何一层都取得
    runAsActor(payload.n || payload.u, () => next())
  })
}

/**
 * 恢复在途的写闸门（R61）：备份恢复 = 整库导入 + 文件目录替换，恢复完成前谁写进去的
 * 都会被旧包盖掉。完整的多用户并发方案留 M4/M5，第一版先把话说清：
 * 恢复期间除 backup: 自家通道外，业务请求一律挡回去「请全员停手」。
 */
export function installRestoreGate(app: NestExpressApplication): void {
  const backup = app.get(BackupService)
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (backup.isRestoring() && req.method === 'POST' && !req.path.startsWith('/api/backup')) {
      res.status(503).json({
        error: {
          message:
            '恢复期间请全员停手：服务器正在用备份恢复数据，恢复完成前写进去的都会被覆盖掉。恢复完成后再继续录单。'
        }
      })
      return
    }
    next()
  })
}

/**
 * 全部形态在这里一次装好（服务启动与测试共用），避免测试跑的 app 与线上不是同一个。
 * 错误体（含 404 的文案）由全局过滤器统一产出，不额外挂兜底中间件——
 * 那个中间件会被 Nest 自己的 404 挡住。
 */
export async function configureApp(app: NestExpressApplication): Promise<void> {
  app.useGlobalFilters(app.get(AllExceptionsFilter))
  installAuthGuard(app)
  installRestoreGate(app)
  // 订单带明细/照片元数据时体积不小，默认 100kb 会把正常保存挡在门外
  app.useBodyParser('json', { limit: '4mb' })
  // 商品图片原样二进制上传：照片动辄几 MB，走 base64 会白涨三分之一。
  // 只接 application/octet-stream，其余请求仍由上面的 JSON 解析器处理。
  app.useBodyParser('raw', { limit: '20mb', type: 'application/octet-stream' })
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
