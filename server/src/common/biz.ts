import { BadRequestException } from '@nestjs/common'

/**
 * 守门函数（src/shared/guards.ts）抛的是给用户看的中文原句，
 * 这里统一转成 400，别让它们落到 500 被换成「服务器内部错误」。
 */
export function biz<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new BadRequestException(e instanceof Error ? e.message : String(e))
  }
}
