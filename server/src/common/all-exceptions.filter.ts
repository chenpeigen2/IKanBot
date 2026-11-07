import { BadRequestException, Catch, Injectable, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common'
import type { Request, Response } from 'express'
import { RoutesService } from '../meta/routes.service'
import { BizError } from '../../../src/shared/errors'

/**
 * 所有错误一律 { error: { message } }，message 是中文原句——
 * 桌面端 preload 的 call() 直接把它抛给界面 toast，和 IPC 那条路一个字都不差。
 *
 * 404 也走这里：Nest 自己抛的是 `Cannot POST /api/xxx`，英文且不区分
 * 「没这个接口」与「有这个接口但不吃这个方法」，而这正是联调时最需要看清的一句话。
 *
 * 非 HttpException 的意外错误不把驱动/SQL 的英文原文倒给用户（看不懂，还可能带表结构），
 * 只在服务端日志里留全栈；返回的是「服务器内部错误」。
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly routes: RoutesService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<Request>()
    let status = 500
    let message = '服务器内部错误'

    if (isJsonParseError(exception)) {
      // express 的 body-parser 抛的是 SyntaxError，默认文案是英文原文
      status = 400
      message = '请求体不是合法 JSON'
    } else if (exception instanceof BadRequestException) {
      status = 400
      const own = textOf(exception) ?? ''
      // Nest 会把 body-parser 的解析失败包成 BadRequestException（原 err.type 丢了），
      // 只剩一句英文的 "Expected property name ... in JSON"——这句不能原样弹给用户
      message = looksLikeJsonError(own) ? '请求体不是合法 JSON' : own || message
    } else if (exception instanceof BizError) {
      // core/ 里抛的业务错误：message 本就是给用户看的中文原句，status 由它自己定（400/404）
      status = exception.status
      message = exception.message
    } else if (isHttp(exception)) {
      status = exception.getStatus()
      message = textOf(exception) ?? defaultText(status)
      // 只有 Nest 内置 404（文案是英文的 Cannot POST /x）才换成中文；
      // 业务自己抛的「客户不存在」原样保留
      if (status === 404 && /^Cannot [A-Z]+ /.test(message)) {
        message = notFoundText(req, this.routes)
      }
    } else if (isFsError(exception)) {
      // 文件系统错误（磁盘满、目录被 chmod、文件被手工移走）真会发生在服务器上，
      // 不能裸奍成「服务器内部错误」五个字：说清是哪个路径坏了、该找谁（r60-verify 账）
      console.error('[ikanbot-server] 文件系统错误', exception)
      status = 500
      message = fsErrorText(exception)
    } else {
      console.error('[ikanbot-server] 未处理的错误', exception)
    }

    // 错误体必须是 JSON：路由上用 @Header 声明过别的 Content-Type（如单据存档的
    // application/pdf）时，Nest 在方法抛错前就把头设好了，express 的 res.json
    // 见「已有 Content-Type」就不再改——错误体会被客户端按 PDF 去解，
    // 话术全变成二进制。错误体永远显式回 JSON。
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.status(status).json({ error: { message } })
  }
}

function notFoundText(req: Request, routes: RoutesService): string {
  const known = routes.list().filter((r) => r.path === req.path)
  if (known.length === 0) return '没有这个接口'
  return `这个接口不接 ${req.method}（只接 ${known.map((r) => r.method).join(' / ')}）`
}

function isFsError(e: unknown): e is NodeJS.ErrnoException {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    // Node 系统调用的错误码就是这几个字母开头；避开把业务错误码误认成文件系统错
    /^(EACCES|EPERM|ENOSPC|ENOENT|EISDIR|ENOTDIR|EMFILE|ENFILE|EROFS|EXDEV)$/.test(
      (e as { code: string }).code
    )
  )
}

function fsErrorText(e: NodeJS.ErrnoException): string {
  const where = typeof e.path === 'string' && e.path ? `（路径：${e.path}）` : ''
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return `服务器读写文件被系统拒绝：${where} 权限不对。找管服务器的人检查这个目录的权限`
  }
  if (e.code === 'ENOSPC') {
    return `服务器磁盘满了，写不进去${where}。找管服务器的人清理磁盘`
  }
  if (e.code === 'ENOENT') {
    return `服务器上要找的文件或目录不在了${where}（可能被手工移动或删除）。找管服务器的人看一眼`
  }
  if (e.code === 'EROFS') {
    return `服务器上的文件系统是只读的，写不进去${where}。找管服务器的人`
  }
  return `服务器读写文件出了问题（${e.code}）${where}。找管服务器的人`
}

function isJsonParseError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { type?: unknown }).type === 'entity.parse.failed'
  )
}

/** 业务话术里不会出现这些字样，命中即判定是请求体 JSON 坏了 */
function looksLikeJsonError(message: string): boolean {
  return /in JSON at position|is not valid JSON|Unexpected token|Unexpected end of JSON|Expected property name/i.test(
    message
  )
}

function isHttp(e: unknown): e is { getStatus(): number; getResponse(): unknown } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { getStatus?: unknown }).getStatus === 'function' &&
    typeof (e as { getResponse?: unknown }).getResponse === 'function'
  )
}

function textOf(e: { getResponse(): unknown }): string | undefined {
  const r = e.getResponse()
  if (typeof r === 'string') return r
  if (r && typeof r === 'object' && 'message' in r) {
    const m = (r as { message: unknown }).message
    // Nest 的内置错误 message 可能是数组/英文串，数组取第一条
    if (Array.isArray(m)) return String(m[0] ?? '')
    if (typeof m === 'string' && m) return m
  }
  return undefined
}

function defaultText(status: number): string {
  if (status === 404) return '没有这个接口'
  if (status === 400) return '请求参数不对'
  if (status === 401 || status === 403) return '没有权限'
  return '服务器内部错误'
}
