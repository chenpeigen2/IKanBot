/* 审计共用件（R90 抽取——R88 复验-2 小账：controllerRoutes 曾在两份审计里各持一份复制，
 * 将来只改一边就会「server 路由真相」分叉。现在唯一真源在这里。）
 * 消费方：scripts/audit-http-coverage.cjs、scripts/audit-ipc-wiring.cjs */
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')

/** 字符串感知的注释剥离：'...' / "..." / `...` 里的 // 和 /* 不算注释（保留字符串字面量） */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 收集 server 控制器路由：所有域目录 × 所有 *.controller.ts × 所有 @Controller 块。
 *  装饰器认 @Post/@Get/@Put/@Delete/@Patch、单双引号，以及空装饰器（R103：
 *  @Controller() 与 @Get() 此前被只认非空参数的正则漏掉，静态 108 vs 运行时 110）。
 *  路径拼接对齐 routes.service.ts 的 joinPath，避免出现 `//healthz` 或 `/api/`。 */
function controllerRoutes() {
  const routes = []
  const serverSrc = path.join(ROOT, 'server/src')
  for (const dir of fs.readdirSync(serverSrc)) {
    const cdir = path.join(serverSrc, dir)
    if (!fs.statSync(cdir).isDirectory()) continue
    for (const file of fs.readdirSync(cdir).filter((f) => f.endsWith('.controller.ts'))) {
      const src = fs.readFileSync(path.join(cdir, file), 'utf8')
      const blocks = []
      const re = /@Controller\(\s*(?:(['"])([^'"]*)\1)?\s*\)/g
      let m
      while ((m = re.exec(src))) blocks.push({ base: m[2] ?? '', start: m.index })
      for (let i = 0; i < blocks.length; i++) {
        const seg = src.slice(blocks[i].start, i + 1 < blocks.length ? blocks[i + 1].start : src.length)
        for (const r of seg.matchAll(/@(Post|Get|Put|Delete|Patch)\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g)) {
          const route = joinPath(blocks[i].base, r[3] ?? '')
          routes.push({ route, method: r[1], file })
        }
      }
    }
  }
  return routes
}

/** 与 server/src/meta/routes.service.ts 的 joinPath 同款：去两端斜杠、滤空段、补根斜杠。 */
function joinPath(base, sub) {
  const parts = [base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean)
  return `/${parts.join('/')}`
}

/** 路由比对前的归一：截掉 query/hash、补前导斜杠、去掉非根尾斜杠。
 *  审计里的路径可能来自 `<img>` URL 或带查询串的负向探针，不能按原始字面量全等。 */
function normalizePath(value) {
  let out = String(value ?? '').trim()
  const cut = out.search(/[?#]/)
  if (cut >= 0) out = out.slice(0, cut)
  if (!out) return '/'
  if (!out.startsWith('/')) out = `/${out}`
  if (out.length > 1) out = out.replace(/\/+$/, '') || '/'
  return out
}

/** 单条路由匹配：支持 `:param` 占一个非空路径段，段数必须相等。
 *  例：`/api/files/images/:name` 命中 `/api/files/images/x.png`，
 *  不命中 `/api/files/images/x.png/extra`（参数路由不能变成前缀通配）。 */
function matchRoute(pattern, actual) {
  const patternPath = normalizePath(pattern)
  const actualPath = normalizePath(actual)
  const patternSegs = patternPath === '/' ? [] : patternPath.slice(1).split('/')
  const actualSegs = actualPath === '/' ? [] : actualPath.slice(1).split('/')
  if (patternSegs.length !== actualSegs.length) return false
  for (let i = 0; i < patternSegs.length; i++) {
    const expected = patternSegs[i]
    if (expected.startsWith(':')) {
      if (!actualSegs[i]) return false
      continue
    }
    if (expected !== actualSegs[i]) return false
  }
  return true
}

/** 在控制器路由表里查一条实际路径；精确路由优先于参数路由。
 *  routes 可传字符串数组或 `{ route }` 对象数组，返回命中的原始项（未命中 null）。 */
function findServerRoute(pathValue, routes) {
  const normalized = normalizePath(pathValue)
  const entries = routes.map((item) => ({
    item,
    route: typeof item === 'string' ? item : item.route
  }))
  const exact = entries.find((entry) => normalizePath(entry.route) === normalized)
  if (exact) return exact.item
  const matched = entries.find((entry) => matchRoute(entry.route, normalized))
  return matched ? matched.item : null
}

module.exports = { stripComments, controllerRoutes, normalizePath, matchRoute, findServerRoute, ROOT }
