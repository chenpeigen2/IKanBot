import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Db } from '../db/types'
import { listCustomers } from '../core/customers'

interface Ctx {
  db: Db
  body: Record<string, unknown>
  url: URL
}

interface Route {
  method: 'GET' | 'POST'
  path: string
  run: (ctx: Ctx) => Promise<unknown>
}

/**
 * M0 的最小 HTTP 面：健康检查 + 一条样板路由。
 * M2 会把 118 个「域:动作」按域补全，错误一律 { error: { message } }，文案即中文原句。
 * 路由写在这张表里，`GET /api` 直接列出已实现的接口，方便 curl 摸底。
 */
const routes: Route[] = [
  {
    method: 'GET',
    path: '/healthz',
    run: async ({ db }) => {
      const row = await db.get('SELECT 1 AS ok')
      return { ok: row?.['ok'] === 1, db: db.kind }
    }
  },
  {
    method: 'POST',
    path: '/api/customers/list',
    run: ({ db, body }) => listCustomers(db, { includeInactive: body['includeInactive'] === true })
  }
]

export function createApp(db: Db): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method === 'POST' ? 'POST' : 'GET'

      if (method === 'GET' && url.pathname === '/api') {
        send(200, { routes: routes.map((r) => `${r.method} ${r.path}`) })
        return
      }

      const route = routes.find((r) => r.path === url.pathname && r.method === method)
      if (!route) {
        const known = routes.some((r) => r.path === url.pathname)
        send(404, { error: { message: known ? `这个接口不接 ${req.method}` : '没有这个接口' } })
        return
      }

      const body = method === 'POST' ? await readJson(req) : {}
      send(200, await route.run({ db, body, url }))
    } catch (e) {
      const message = (e as Error).message || '服务器内部错误'
      send(500, { error: { message } })
    }
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    // 顶层必须是对象：数组/字符串进来会让 body['x'] 静默变 undefined，查出来像"没有数据"
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('请求体必须是一个 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (e) {
    const msg = (e as Error).message
    throw new Error(msg.startsWith('请求体') ? msg : '请求体不是合法 JSON')
  }
}
