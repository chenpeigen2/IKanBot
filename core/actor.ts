import { AsyncLocalStorage } from 'node:async_hooks'
import type { Db } from './db'
import { settingsCore } from './settings'

/**
 * 操作者身份（M2 鉴权第一片）。
 *
 * 远端模式下「是谁在操作」只能由服务端认定：token 验过了才算，桌面传什么不算数——
 * 留痕不真，历史就是给人看的摆设。后端中间件验完 token，把身份套住整个请求的调用链；
 * 任何一层要用操作者，都从这里拿，不再各传各的。
 *
 * 桌面本地模式没有登录这回事：调用链上没人套身份，回落 settings.operator（现状不变）。
 */
const als = new AsyncLocalStorage<string>()

/** 服务端中间件用：把 token 认定的身份套住整个请求的下游调用 */
export function runAsActor<T>(actor: string, fn: () => T): T {
  return als.run(actor, fn)
}

/** 当前调用链上被认定的操作者；没有就是 null（本地模式） */
export function currentActor(): string | null {
  const v = als.getStore()
  return v ? v : null
}

/** 留痕用操作者：先认 token 认定的身份，本地模式回落设置里那位业务员 */
export async function actorOf(db: Db): Promise<string> {
  return currentActor() ?? (await settingsCore(db).get()).operator
}
