/**
 * 业务错误：message 是给用户看的中文原句，status 只对后端有意义。
 *
 * 桌面端 IPC 的 handle() 只取 message 弹 toast；后端按 status 落 400/404。
 * 以前桌面抛 Error、后端另抛 Nest 异常，同一句话要写两遍、还容易写歪。
 *
 * 放在 shared 而不是 core：src/shared/guards.ts 这类入口闸门也要用它，
 * 而 core 与桌面渲染层都依赖 shared；后端把「不是 BizError 的意外错误」当 500 藏起来，
 * 所以守门话术必须显式走这一个类型。
 */
export class BizError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message)
    this.name = 'BizError'
  }
}

/** 守门话术：后端落 400，桌面照旧只取 message */
export function bizError(message: string): BizError {
  return new BizError(message)
}

/** 找不到东西：桌面只认 message，后端落 404 */
export function notFound(message: string): BizError {
  return new BizError(message, 404)
}

/**
 * 写冲突（M4 乐观锁）：按读时的 updated_at 条件更新，affected 0 行 = 别人刚改过。
 * 后端落 409，桌面 toast 这句原话——后写的人当场知道要刷新，不能拿旧内容悄悄盖掉新账。
 */
export const WRITE_CONFLICT_MESSAGE = '这条记录刚被别人改过，请刷新后再试'

export function writeConflict(): BizError {
  return new BizError(WRITE_CONFLICT_MESSAGE, 409)
}
