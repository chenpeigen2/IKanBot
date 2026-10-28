import { getConnection, normalizeBaseUrl } from '../mode'

/** 一条通道在后端的落点：路由与请求体里的参数名 */
interface RouteSpec {
  path: string
  args: string[]
}

/**
 * 通道 → HTTP 路由。键必须与 electron/ipc/index.ts 的通道名一字不差：
 * 服务端就是照通道名起的路由，另起一套命名迟早两套都漂。
 * args 是服务端读请求体用的字段名（{ keyword, includeInactive } 这种），
 * 桌面端是按位置传参的，到这里翻成具名对象——加参数时两边一起改。
 *
 * 只登记真正搬到后端的通道。没登记的通道在远端模式下会当场报错（见 handle.ts），
 * 不会悄悄退回本机库：一份客户改在远端、一张单改在本机，比报错难查得多。
 */
export const REMOTE_ROUTES: Record<string, RouteSpec> = {
  'customers:list': { path: '/api/customers/list', args: ['keyword', 'includeInactive'] },
  'customers:get': { path: '/api/customers/get', args: ['id'] },
  'customers:save': { path: '/api/customers/save', args: ['input'] },
  'customers:delete': { path: '/api/customers/delete', args: ['id'] },
  'customers:setActive': { path: '/api/customers/setActive', args: ['id', 'active'] },
  'customers:sameName': { path: '/api/customers/sameName', args: ['company', 'selfId'] },
  'products:list': { path: '/api/products/list', args: ['keyword', 'includeInactive'] },
  'products:get': { path: '/api/products/get', args: ['id'] },
  'products:save': { path: '/api/products/save', args: ['input'] },
  'products:delete': { path: '/api/products/delete', args: ['id'] },
  'products:copy': { path: '/api/products/copy', args: ['id', 'newStyleNo'] },
  'products:images': { path: '/api/products/images', args: ['productId'] },
  'products:addImage': { path: '/api/products/addImage', args: ['productId', 'fileName', 'isPrimary'] },
  'products:delImage': { path: '/api/products/delImage', args: ['id'] },
  'products:setPrimary': { path: '/api/products/setPrimary', args: ['productId', 'imageId'] },
  'products:setActive': { path: '/api/products/setActive', args: ['id', 'active'] },
  'products:referenceCount': { path: '/api/products/referenceCount', args: ['id'] },
  'products:importCsv': { path: '/api/products/importCsv', args: ['text', 'mode'] },
  'settings:get': { path: '/api/settings/get', args: [] },
  'settings:save': { path: '/api/settings/save', args: ['input'] },
  'settings:baseLocked': { path: '/api/settings/baseLocked', args: [] },

  'orders:list': { path: '/api/orders/list', args: ['filter'] },
  'orders:get': { path: '/api/orders/get', args: ['id'] },
  'orders:create': { path: '/api/orders/create', args: ['input'] },
  'orders:update': { path: '/api/orders/update', args: ['id', 'input'] },
  'orders:setParties': { path: '/api/orders/setParties', args: ['id', 'patch'] },
  'orders:updateCharges': { path: '/api/orders/updateCharges', args: ['id', 'charges', 'reason'] },
  'orders:delete': { path: '/api/orders/delete', args: ['id'] },
  'orders:void': { path: '/api/orders/void', args: ['id', 'reason', 'opts'] },
  'orders:addItem': { path: '/api/orders/addItem', args: ['orderId', 'item'] },
  'orders:updateItem': { path: '/api/orders/updateItem', args: ['orderId', 'itemId', 'patch'] },
  'orders:addItems': { path: '/api/orders/addItems', args: ['orderId', 'items'] },
  'orders:removeItem': { path: '/api/orders/removeItem', args: ['orderId', 'itemId'] },
  'orders:replaceItems': { path: '/api/orders/replaceItems', args: ['orderId', 'items'] },
  'orders:summarizeSkus': { path: '/api/orders/summarizeSkus', args: ['orderId'] },
  'orders:addPayment': { path: '/api/orders/addPayment', args: ['orderId', 'p'] },
  'orders:batchAddPayments': { path: '/api/orders/batchAddPayments', args: ['entries'] },
  'orders:deletePayment': { path: '/api/orders/deletePayment', args: ['orderId', 'paymentId', 'reason'] },
  'orders:listSettlements': { path: '/api/orders/listSettlements', args: ['orderId'] },
  'orders:addSettlement': { path: '/api/orders/addSettlement', args: ['orderId', 'input'] },
  'orders:reverseSettlement': { path: '/api/orders/reverseSettlement', args: ['orderId', 'settlementId', 'reason'] },
  'orders:setShipStatus': { path: '/api/orders/setShipStatus', args: ['orderId', 'status', 'note'] },
  'orders:setPaymentStatus': { path: '/api/orders/setPaymentStatus', args: ['orderId', 'status', 'note'] },
  'orders:events': { path: '/api/orders/events', args: ['orderId'] },
  'orders:ports': { path: '/api/orders/ports', args: [] },
  'orders:lastTerms': { path: '/api/orders/lastTerms', args: ['customerId'] },
  'orders:lastExchangeRate': { path: '/api/orders/lastExchangeRate', args: [] },
  'orders:lastExchangeRateInfo': { path: '/api/orders/lastExchangeRateInfo', args: ['currency'] },
  'orders:photos': { path: '/api/orders/photos', args: ['orderId'] },
  'orders:addPhoto': { path: '/api/orders/addPhoto', args: ['orderId', 'fileName', 'kind', 'note'] },
  'orders:delPhoto': { path: '/api/orders/delPhoto', args: ['orderId', 'photoId'] },

  'quotations:list': { path: '/api/quotations/list', args: ['filter'] },
  'quotations:get': { path: '/api/quotations/get', args: ['id'] },
  'quotations:save': { path: '/api/quotations/save', args: ['input'] },
  'quotations:delete': { path: '/api/quotations/delete', args: ['id'] },
  'quotations:updateMeta': { path: '/api/quotations/updateMeta', args: ['id', 'meta'] },
  'quotations:events': { path: '/api/quotations/events', args: ['id'] },
  'quotations:convert': { path: '/api/quotations/convert', args: ['id', 'opts'] },
  'quotations:versions': { path: '/api/quotations/versions', args: ['id'] },

  'samples:list': { path: '/api/samples/list', args: ['filter'] },
  'samples:get': { path: '/api/samples/get', args: ['id'] },
  'samples:save': { path: '/api/samples/save', args: ['input'] },
  'samples:delete': { path: '/api/samples/delete', args: ['id'] },
  'samples:convert': { path: '/api/samples/convert', args: ['id', 'opts'] },
  'samples:listPayments': { path: '/api/samples/listPayments', args: ['id'] },
  'samples:addPayment': { path: '/api/samples/addPayment', args: ['id', 'p'] },
  'samples:deletePayment': { path: '/api/samples/deletePayment', args: ['id', 'paymentId', 'reason'] },

  'pl:list': { path: '/api/pl/list', args: ['orderId'] },
  'pl:create': { path: '/api/pl/create', args: ['input'] },
  'pl:delete': { path: '/api/pl/delete', args: ['orderId', 'plId'] },
  'pl:updateInfo': { path: '/api/pl/updateInfo', args: ['orderId', 'plId', 'patch'] },
  'pl:updateLine': { path: '/api/pl/updateLine', args: ['orderId', 'plId', 'lineId', 'patch'] },
  'pl:addLine': { path: '/api/pl/addLine', args: ['orderId', 'plId', 'line'] },
  'pl:deleteLine': { path: '/api/pl/deleteLine', args: ['orderId', 'plId', 'lineId'] },
  'pl:void': { path: '/api/pl/void', args: ['orderId', 'plId', 'reason'] },
  'pl:unvoid': { path: '/api/pl/unvoid', args: ['orderId', 'plId', 'reason'] },
  'pl:amounts': { path: '/api/pl/amounts', args: ['orderId'] },

  'dashboard:stats': { path: '/api/dashboard/stats', args: [] },
  'dashboard:reminders': { path: '/api/dashboard/reminders', args: [] },
  'report:monthly': { path: '/api/report/monthly', args: [] },
  'report:receivables': { path: '/api/report/receivables', args: [] },
  'report:customerOrderRows': { path: '/api/report/customerOrderRows', args: ['customerId'] },

  'credits:balance': { path: '/api/credits/balance', args: ['customerId'] },
  'credits:apply': { path: '/api/credits/apply', args: ['input'] },
  'credits:reverse': { path: '/api/credits/reverse', args: ['applicationId', 'reason'] },
  'credits:refund': { path: '/api/credits/refund', args: ['input'] },
  'credits:reverseRefund': { path: '/api/credits/reverseRefund', args: ['refundId', 'reason'] }
}

export function isRemoteChannel(channel: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOTE_ROUTES, channel)
}

export function remoteChannelCount(): number {
  return Object.keys(REMOTE_ROUTES).length
}

/** 一句话说清覆盖到哪儿：设置页和远端模式的报错都用这一句 */
export function coverageWords(): string {
  return `后端目前接了客户、商品、设置、订单、报价、打样、装箱、预收与报表（${remoteChannelCount()} 个接口）`
}

interface ErrorBody {
  error?: { message?: string }
}

function explainFetchError(e: unknown, remoteUrl: string, timeoutMs: number): Error {
  const msg = (e as Error).message || ''
  const why = /timeout|abort/i.test(msg) ? `等了 ${Math.round(timeoutMs / 1000)} 秒没有回应` : msg
  return new Error(
    `连不上后端 ${remoteUrl}（${why}）。\n` +
      `确认后端已启动、地址写对了没有——都在「设置 · 数据来源」。` +
      `后端没起来时，可以先把数据来源切回「本机」。`
  )
}

/** 发请求并把「连不上」翻成人话；HTTP 状态交给调用方判 */
async function fetchRemote(path: string, init: RequestInit, timeoutMs = 20000): Promise<Response> {
  const { remoteUrl } = getConnection()
  try {
    // 超时不能无限等：后端机器掉线时 fetch 会一直挂着，界面就永远转圈
    return await fetch(`${remoteUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw explainFetchError(e, remoteUrl, timeoutMs)
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`后端返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  const err = (data as ErrorBody | null)?.error?.message
  if (!res.ok || err) throw new Error(err || `后端出错（HTTP ${res.status}）`)
  return data
}

export async function remoteCall(channel: string, args: unknown[]): Promise<unknown> {
  const spec = REMOTE_ROUTES[channel]
  if (!spec) throw new Error(`「${channel}」没有登记后端路由`)
  const body: Record<string, unknown> = {}
  spec.args.forEach((name, i) => {
    if (i < args.length) body[name] = args[i]
  })
  const res = await fetchRemote(spec.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return readJson(res)
}

/* ---------------- 导出 ---------------- */

/**
 * 导出的 CSV 在后端算、在本机落盘。
 * export: 前缀留在 LOCAL_ONLY（另存对话框是本机的事），数据却必须来自后端那份账——
 * 远端模式还读本机库导出台账，等于把一张空表交给客户。
 */
export async function remoteExportCsv(
  kind: string,
  filter?: unknown
): Promise<{ csv: string; fileName: string }> {
  const res = await fetchRemote('/api/export/csv', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, filter })
  })
  const data = (await readJson(res)) as { csv?: unknown; fileName?: unknown } | null
  return { csv: String(data?.csv ?? ''), fileName: String(data?.fileName ?? '') }
}

/* ---------------- 图片文件 ---------------- */

/** 远端模式下商品图的基地址：<img src> 直接用它拼文件名 */
export function remoteImageBase(): string {
  return `${getConnection().remoteUrl}/api/files/images`
}

/** 上传一张图片，返回后端生成的文件名（桌面端只拿这个名字登记进库） */
export async function remoteUploadImage(originalName: string, bytes: Buffer): Promise<string> {
  const res = await fetchRemote(
    `/api/files/upload?name=${encodeURIComponent(originalName)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes
    },
    // 大图走慢网络时 20 秒不够，单独给宽一点
    60000
  )
  const data = (await readJson(res)) as { fileName?: unknown } | null
  const name = String(data?.fileName ?? '')
  if (!name) throw new Error('后端没有返回图片文件名，上传可能没成功')
  return name
}

export async function remoteDiscardImages(names: string[]): Promise<void> {
  if (names.length === 0) return
  const res = await fetchRemote('/api/files/discard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names })
  })
  await readJson(res)
}

/** 取图片字节；后端没有这张图时返回 null（公司 Logo 这类还在本机，由调用方回退） */
export async function remoteReadImage(name: string): Promise<Buffer | null> {
  const res = await fetchRemote(`/api/files/images/${encodeURIComponent(name)}`, { method: 'GET' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`后端取图失败（HTTP ${res.status}）`)
  return Buffer.from(await res.arrayBuffer())
}

export interface RemoteProbe {
  ok: boolean
  url: string
  /** 给人看的一句话结论 */
  message: string
  db?: string
  routeCount?: number
  /** 服务端缺哪几条桌面端要用的路由（版本对不上时会非空） */
  missing: string[]
}

/**
 * 探活。只打 GET /api：服务端会把路由清单自报出来（见 server/src/meta），
 * 前端不用维护一份手抄的接口表，也不会「连上了但少一半接口」还报平安。
 */
export async function probeRemote(urlRaw?: string): Promise<RemoteProbe> {
  const url = normalizeBaseUrl(urlRaw ?? getConnection().remoteUrl)
  if (!url) throw new Error('还没填后端地址')
  let res: Response
  try {
    res = await fetch(`${url}/api`, { signal: AbortSignal.timeout(6000) })
  } catch (e) {
    const msg = (e as Error).message || ''
    return {
      ok: false,
      url,
      missing: [],
      message: /timeout|abort/i.test(msg)
        ? `等了 6 秒没有回应：${url}。确认后端已启动、端口没被占、防火墙没挡。`
        : `连不上 ${url}：${msg}`
    }
  }
  if (!res.ok) {
    return { ok: false, url, missing: [], message: `${url} 回了 HTTP ${res.status}，这不像 IKanBot 后端。` }
  }
  let info: { service?: string; db?: string; routes?: unknown }
  try {
    info = (await res.json()) as typeof info
  } catch {
    return { ok: false, url, missing: [], message: `${url}/api 回的不是 JSON，确认地址没写错。` }
  }
  if (info?.service !== 'ikanbot-server') {
    return { ok: false, url, missing: [], message: `${url} 上跑的不是 IKanBot 后端（service=${String(info?.service)}）。` }
  }
  const routes = Array.isArray(info.routes) ? info.routes.map(String) : []
  const missing = Object.values(REMOTE_ROUTES)
    .map((r) => `POST ${r.path}`)
    .filter((r) => !routes.includes(r))
  const db = String(info.db ?? '未知')
  return {
    ok: missing.length === 0,
    url,
    db,
    routeCount: routes.length,
    missing,
    message:
      missing.length === 0
        ? `连上了：${db} 数据，共 ${routes.length} 个接口，桌面端要用的都已就位。`
        : `连上了（${db}，共 ${routes.length} 个接口），但后端少了桌面端要用的：${missing.join('、')}。` +
          `多半是后端版本比桌面端旧，换同一版再试。`
  }
}
