import { Injectable } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'

export interface RouteInfo {
  method: string
  /** 已带前缀的完整路径，如 /api/customers/list */
  path: string
}

/**
 * 从 Nest 的路由元数据里把「已实现的接口」数出来。
 * 手写一份清单迟早会漂移；这里是唯一自描述来源，GET /api 与桌面端的覆盖率都读它。
 */
@Injectable()
export class RoutesService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner
  ) {}

  list(): RouteInfo[] {
    const out: RouteInfo[] = []
    for (const wrapper of this.discovery.getControllers()) {
      const { metatype } = wrapper
      if (!metatype) continue
      const base = pathOf(Reflect.getMetadata(PATH_METADATA, metatype) as unknown)
      const proto = metatype.prototype as Record<string, unknown>
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const fn = proto[name]
        if (typeof fn !== 'function') continue
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined
        if (method === undefined) continue
        const sub = pathOf(Reflect.getMetadata(PATH_METADATA, fn) as unknown)
        out.push({ method: RequestMethod[method] ?? 'GET', path: joinPath(base, sub) })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  }
}

function pathOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return ''
}

function joinPath(base: string, sub: string): string {
  const parts = [base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean)
  return '/' + parts.join('/')
}
