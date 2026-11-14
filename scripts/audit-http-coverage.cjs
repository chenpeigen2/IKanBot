/* 只读审计（R88 版）：server 控制器路由 vs HTTP 冒烟（server/test/e2e.ts）的功能断言覆盖。
 * R87 版的四个潜伏口径（复验拆出来的）本版修掉：
 *   ① 一个域目录可以有多个 *.controller.ts——全扫；
 *   ② @Delete/@Patch、双引号装饰器——同扫；
 *   ③ 注释剥离——判定前把 e2e.ts 的注释剥掉（保留字符串字面量：check 名里带路由也算锁）；
 *   ④ 反方向对表——e2e.ts 里出现的 /api/... 字面量逐个反查控制器，不存在的报「打空气的死测试」。
 * 判定仍是「路由全名在冒烟正文（剥注释后）被字面引用过」——它是接线锁，不是断言强度锁。 */
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const raw = fs.readFileSync(path.join(ROOT, 'server/test/e2e.ts'), 'utf8')

/** 字符串感知的注释剥离：'...' / "..." / `...` 里的 // 和 /* 不算注释 */
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

const e2e = stripComments(raw)

/** 收集控制器路由：所有域目录 × 所有 *.controller.ts × 所有 @Controller 块 */
function controllerRoutes() {
  const routes = []
  const serverSrc = path.join(ROOT, 'server/src')
  for (const dir of fs.readdirSync(serverSrc)) {
    const cdir = path.join(serverSrc, dir)
    if (!fs.statSync(cdir).isDirectory()) continue
    for (const file of fs.readdirSync(cdir).filter((f) => f.endsWith('.controller.ts'))) {
      const src = fs.readFileSync(path.join(cdir, file), 'utf8')
      const blocks = []
      const re = /@Controller\((['"])([^'"]+)\1\)/g
      let m
      while ((m = re.exec(src))) blocks.push({ base: m[2], start: m.index })
      for (let i = 0; i < blocks.length; i++) {
        const seg = src.slice(blocks[i].start, i + 1 < blocks.length ? blocks[i + 1].start : src.length)
        for (const r of seg.matchAll(/@(Post|Get|Put|Delete|Patch)\((['"])([^'"]+)\2\)/g)) {
          routes.push({ route: `/${blocks[i].base}/${r[3]}`, method: r[1], file })
        }
      }
    }
  }
  return routes
}

const routes = controllerRoutes()

function covered(route) {
  if (e2e.includes(route)) return true
  if (route.includes(':')) {
    const prefix = route.slice(0, route.indexOf(':'))
    return e2e.includes(prefix)
  }
  return false
}

const uncovered = routes.filter((r) => !covered(r.route))

console.log('总路由（controller 声明）:', routes.length, ' 功能断言引用:', routes.length - uncovered.length)
console.log('--- 未在 HTTP 冒烟正文引用的路由（参数路由按前缀匹配） ---')
for (const r of uncovered) console.log(`${r.method} ${r.route}  (${r.file})`)

/** 反方向对表：冒烟正文里的 /api|/healthz 字面量必须指向真实控制器路由（否则是打空气的死测试）。
 * allowlist 语义（R88 复验打回后修正：原版 '/' 前缀把所有字面量整体放行，反方向形同虚设）：
 * 尾斜杠项按前缀匹配，无尾斜杠项**精确**匹配。query 串字面量（/api/...?x=y）先截到 ? 再对。 */
const ALLOW_EXACT = ['/', '/healthz', '/api', '/api/no-such-route']
const ALLOW_PREFIX = ['/api/files/images/', '/api/export/']
const literals = [...new Set([...e2e.matchAll(/['"`](\/(?:api|healthz)[^'"`\s]*)['"`]/g)].map((m) => m[1]))]
const dead = []
for (const rawLit of literals) {
  const lit = rawLit.split('?')[0]
  if (ALLOW_EXACT.includes(lit)) continue
  if (ALLOW_PREFIX.some((a) => lit.startsWith(a))) continue
  const hit = routes.some((r) => r.route === lit || (r.route.includes(':') && lit.startsWith(r.route.slice(0, r.route.indexOf(':')))))
  if (!hit) dead.push(rawLit)
}
console.log('--- 反方向对表：冒烟引用了但控制器没有的路由（打空气） ---')
console.log(dead.length === 0 ? '（无）' : dead.join('\n'))
if (uncovered.length > 0 || dead.length > 0) process.exitCode = 1
