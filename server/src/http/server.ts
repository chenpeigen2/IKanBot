import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Db } from '../db/types'
import { listCustomers } from '../core/customers'

/**
 * M0 的最小 HTTP 面：健康检查 + 一条样板路由。
 * M2 会把 118 个「域:动作」按域补全，错误一律 { error: { message } }，文案即中文原句。
 */
export function createApp(db: Db): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const row = await db.get('SELECT 1 AS ok')
        send(200, { ok: row?.['ok'] === 1, db: db.kind })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/customers/list') {
        const body = await readJson(req)
        const rows = await listCustomers(db, {
          includeInactive: body['includeInactive'] === true
        })
        send(200, rows)
        return
      }

      send(404, { error: { message: '没有这个接口' } })
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
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}
