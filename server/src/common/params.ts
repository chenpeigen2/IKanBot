import { BadRequestException } from '@nestjs/common'

/**
 * 请求体是外部输入，必须在这里过一道：
 * undefined / 字符串数字 / 数组混进来，SQL 参数会静默变成 NULL 或 "undefined"。
 */
export function idParam(v: unknown, label = '编号'): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new BadRequestException(`${label}不对：${String(v)}`)
  }
  return n
}

export function optionalId(v: unknown, label: string): number | undefined {
  return v === undefined || v === null ? undefined : idParam(v, label)
}

export function strParam(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function boolParam(v: unknown): boolean {
  return v === true
}

/** 明细/档案这类嵌套对象：只要求是个普通对象，字段由服务层按白名单读 */
export function objectParam(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new BadRequestException(`${label}必须是对象`)
  }
  return v as Record<string, unknown>
}

/** 筛选条件这类可以整块不传的对象：不传就是「不筛」，不是错误 */
export function optionalObject(v: unknown, label: string): Record<string, unknown> {
  return v === undefined || v === null ? {} : objectParam(v, label)
}

/** 明细/费用/收款这类列表：传了就必须是数组，别让单行对象混进去当数组用 */
export function arrayParam(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new BadRequestException(`${label}必须是列表`)
  return v
}
