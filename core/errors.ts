/**
 * 业务错误：message 是给用户看的中文原句，status 只对后端有意义。
 *
 * 桌面端 IPC 的 handle() 只取 message 弹 toast；后端按 status 落 400/404。
 * 以前桌面抛 Error、后端另抛 Nest 异常，同一句话要写两遍、还容易写歪。
 */
export class BizError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message)
    this.name = 'BizError'
  }
}

/** 找不到东西：桌面只认 message，后端落 404 */
export function notFound(message: string): BizError {
  return new BizError(message, 404)
}
