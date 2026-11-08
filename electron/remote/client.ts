import { basename } from 'path'
import { readFileSync } from 'fs'
import { getConnection, normalizeBaseUrl } from '../mode'
import { clearStoredAuth, currentToken } from './token-store'

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
  // 客户页的三个数：以前留在了桌面薄壳里，远端模式只能读本机那份空库（R53）
  'customers:stats': { path: '/api/customers/stats', args: ['id'] },
  'customers:orders': { path: '/api/customers/orders', args: ['id'] },
  'customers:stylePriceHistory': { path: '/api/customers/stylePriceHistory', args: ['filter'] },
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
  'orders:batchAddPayments': { path: '/api/orders/batchAddPayments', args: ['entries', 'requestId'] },
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

  // 单据存档的读侧四条（R60）：存档账（doc_versions）在服务器库里，
  // 「出过 CI 锁单价」「有存档禁删」这些闸门从此认服务器那份账
  'docs:list': { path: '/api/docs/list', args: ['orderId'] },
  'docs:listQuotation': { path: '/api/docs/listQuotation', args: ['quotationId'] },
  'docs:void': { path: '/api/docs/void', args: ['versionId', 'reason'] },
  'docs:nextVersion': { path: '/api/docs/nextVersion', args: ['docNo', 'kind'] },

  'credits:balance': { path: '/api/credits/balance', args: ['customerId'] },
  'credits:apply': { path: '/api/credits/apply', args: ['input'] },
  'credits:reverse': { path: '/api/credits/reverse', args: ['applicationId', 'reason'] },
  'credits:refund': { path: '/api/credits/refund', args: ['input'] },
  'credits:reverseRefund': { path: '/api/credits/reverseRefund', args: ['refundId', 'reason'] },

  // 备份簇上后端（R61）：远端模式备份发生在服务器（库+图片+单据存档整包），
  // 桌面只转发与展示；恢复从服务器备份列表里挑，路径是服务器磁盘上的
  'backup:create': { path: '/api/backup/create', args: [] },
  'backup:list': { path: '/api/backup/list', args: [] },
  'backup:inspect': { path: '/api/backup/inspect', args: ['path'] },
  'backup:restore': { path: '/api/backup/restore', args: ['path'] }
}

export function isRemoteChannel(channel: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOTE_ROUTES, channel)
}

export function remoteChannelCount(): number {
  return Object.keys(REMOTE_ROUTES).length
}

/** 一句话说清覆盖到哪儿：设置页和远端模式的报错都用这一句 */
export function coverageWords(): string {
  return `后端目前接了客户、商品、设置、订单、报价、打样、装箱、预收、报表与单据存档（${remoteChannelCount()} 个接口）`
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

/** 登录后的请求一律带头；没登录就空著，后端回 401 统一说「请先登录」 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = currentToken()
  const h: Record<string, string> = extra ? { ...extra } : {}
  if (token) h['authorization'] = `Bearer ${token}`
  return h
}

/**
 * 401 时的广播钩子：由 ipc 层注入（给所有窗口发 auth:expired），测试里可换成樁。
 * 不直接 import BrowserWindow：让 client.ts 保持纯转发层，也避免测试环境拉起 electron。
 */
let notifyAuthExpired: () => void = () => {}
export function setAuthExpiredNotifier(fn: () => void): void {
  notifyAuthExpired = fn
}

/**
 * 会话已失效（后端换了秘钥、token 被服务端拒认）：清掉 safeStorage 里的登录态、
 * 通知界面把「已登录：某某」变回未登录，再抛人话。
 * 不是本地存的用户名不算登录——那只是个名字，不是服务端验过的通行证（r60-verify 账）。
 */
function handleAuthExpired(): never {
  clearStoredAuth()
  try {
    notifyAuthExpired()
  } catch {
    // 通知失败不挡登录态清理与报错（测试樁里没有窗口，也不能把话术变形成英文堆栈）
  }
  throw new Error('登录已失效，请到「设置 · 数据来源」重新登录')
}

async function readJson(res: Response, opts: { auth?: boolean } = {}): Promise<unknown> {
  // 会话失效与「密码不对」是两回事：登录接口的 401 原样透回「用户名或密码不对」，
  // 业务接口的 401 才按「这份登录态已经作废」处理
  if (res.status === 401 && opts.auth) handleAuthExpired()
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
  // 本机传得比路由登记的参数多时，多出来的那几个以前是静默丢掉：界面少报一个原因、
  // 少报一个备注，后端收到的就是「没填」，同一句话术在本机拦住、在远端放行（R56）。
  if (args.length > spec.args.length) {
    throw new Error(
      `「${channel}」要传 ${args.length} 个参数，后端路由只登记了 ${spec.args.length} 个` +
        `（${spec.args.join('、') || '没有参数'}）。多出来的会被丢掉，请先在路由表补登记，或切回「本机」。`
    )
  }
  const body: Record<string, unknown> = {}
  spec.args.forEach((name, i) => {
    if (i < args.length) body[name] = args[i]
  })
  const res = await fetchRemote(spec.path, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  return readJson(res, { auth: true })
}

/* ---------------- 登录 ---------------- */

export interface RemoteLoginResult {
  token: string
  username: string
  displayName: string
}

/** 拿用户名密码换 token：存不存由调用方（IPC 层）定，这里只管跟后端换 */
export async function remoteLogin(usernameRaw: unknown, passwordRaw: unknown): Promise<RemoteLoginResult> {
  const username = String(usernameRaw ?? '').trim()
  if (!username) throw new Error('用户名不能为空')
  if (!String(passwordRaw ?? '')) throw new Error('密码不能为空')
  const res = await fetchRemote('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: String(passwordRaw) })
  })
  const data = (await readJson(res)) as RemoteLoginResult | null
  if (!data?.token) throw new Error('后端没有返回登录凭证，登录可能没成功')
  return { token: data.token, username: String(data.username ?? username), displayName: String(data.displayName ?? '') }
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
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ kind, filter })
  })
  const data = (await readJson(res, { auth: true })) as { csv?: unknown; fileName?: unknown } | null
  return { csv: String(data?.csv ?? ''), fileName: String(data?.fileName ?? '') }
}

/* ---------------- 图片文件 ---------------- */

/** 远端模式下商品图的基地址：<img src> 直接用它拼文件名 */
export function remoteImageBase(): string {
  return `${getConnection().remoteUrl}/api/files/images`
}

/**
 * 老桌面的整库包传到服务器（搬迁最后一公里，R66）：本机 zip 字节原样 POST，
 * 服务器落进备份目录并按同一条闸门验收，回服务器路径。同一本机路径的本次会话
 * 上传结果缓存一份——界面流程「先看摘要再确认恢复」是两次调用，不该传两遍。
 */
const uploadedBackupCache = new Map<string, string>()

export async function remoteUploadBackup(localPath: string): Promise<string> {
  const cached = uploadedBackupCache.get(localPath)
  if (cached) return cached
  const bytes = readFileSync(localPath)
  const res = await fetchRemote(
    `/api/backup/upload?name=${encodeURIComponent(basename(localPath))}`,
    {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: bytes
    },
    // 整库包比图片大得多，慢网络下给足时间
    120000
  )
  const data = (await readJson(res, { auth: true })) as { path?: unknown } | null
  const serverPath = String(data?.path ?? '')
  if (!serverPath) throw new Error('后端没有返回备份包路径，上传可能没成功')
  uploadedBackupCache.set(localPath, serverPath)
  return serverPath
}

/** 上传一张图片，返回后端生成的文件名（桌面端只拿这个名字登记进库） */
export async function remoteUploadImage(originalName: string, bytes: Buffer): Promise<string> {
  const res = await fetchRemote(
    `/api/files/upload?name=${encodeURIComponent(originalName)}`,
    {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: bytes
    },
    // 大图走慢网络时 20 秒不够，单独给宽一点
    60000
  )
  const data = (await readJson(res, { auth: true })) as { fileName?: unknown } | null
  const name = String(data?.fileName ?? '')
  if (!name) throw new Error('后端没有返回图片文件名，上传可能没成功')
  return name
}

export async function remoteDiscardImages(names: string[]): Promise<void> {
  if (names.length === 0) return
  const res = await fetchRemote('/api/files/discard', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ names })
  })
  await readJson(res, { auth: true })
}

/* ---------------- 单据存档（R60） ---------------- */

export interface RemoteDocSaveMeta {
  docNo: string
  kind: 'pi' | 'pl' | 'ci' | 'quotation'
  orderId?: number | null
  quotationId?: number | null
  amount?: number
  expectedVersion?: number
  pageFingerprint?: string
  confirmOverlap?: boolean
}

export interface RemoteDocSaveResult {
  path: ''
  filePath: string
  version: number
}

/**
 * 存档：桌面把 HTML 渲染成 PDF（Chromium 在本机），字节上传到服务器落档。
 * 版次、纸面指纹、CI 重叠闸门都在服务端 core/docs 落笔那一刻把关。
 */
export async function remoteSaveDoc(pdf: Buffer, meta: RemoteDocSaveMeta): Promise<RemoteDocSaveResult> {
  // meta 走查询参数（PDF 是二进制请求体，塞不进 JSON）
  const res = await fetchRemote(
    `/api/docs/save?meta=${encodeURIComponent(JSON.stringify(meta))}`,
    {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: new Uint8Array(pdf)
    },
    // 多页单据走慢网络时 20 秒不够
    60000
  )
  const data = (await readJson(res, { auth: true })) as { filePath?: unknown; version?: unknown } | null
  if (!data?.filePath || data.version == null) {
    throw new Error('后端没有回存档路径与版本号，存档可能没成功，请打开存档列表核对。')
  }
  return { path: '', filePath: String(data.filePath), version: Number(data.version) }
}

/** 取回一版 PDF 的字节（打开/在文件夹中显示用）；文件不在了把后端那句话透回界面 */
export async function remoteReadDoc(filePath: string): Promise<Buffer> {
  const res = await fetchRemote('/api/docs/read', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ filePath })
  })
  if (res.status === 401) handleAuthExpired()
  if (res.status === 404) {
    let msg = '文件已不存在（可能被手工删了）'
    try {
      const data = (await res.json()) as { error?: { message?: string } }
      if (data?.error?.message) msg = data.error.message
    } catch {
      /* 保留默认话术 */
    }
    throw new Error(msg)
  }
  if (!res.ok) {
    let msg = `后端取单据失败（HTTP ${res.status}）`
    try {
      const data = (await res.json()) as { error?: { message?: string } }
      if (data?.error?.message) msg = data.error.message
    } catch {
      /* 保留默认话术 */
    }
    throw new Error(msg)
  }
  return Buffer.from(await res.arrayBuffer())
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
