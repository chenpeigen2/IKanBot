/* 只读审计（R88 版 + R90 抽取 + R101 反向收口 + R102 正向统一）：server 控制器路由 vs
 * HTTP 冒烟（server/test/e2e.ts）的功能断言覆盖。
 * 已修掉的口径坑：
 *   ① 一个域目录可以有多个 *.controller.ts——全扫（共用件）；
 *   ② @Delete/@Patch、双引号装饰器——同扫（共用件）；
 *   ③ 注释剥离——判定前把 e2e.ts 的注释剥掉（保留字符串字面量：check 名里带路由也算锁）；
 *   ④ 反方向对表——e2e.ts 里出现的 /api/... 字面量逐个反查控制器，不存在的报「打空气的死测试」；
 *   ⑤ R101：反向对表改用 matchRoute（`:param` 只吃一段、query/尾斜杠归一）；负向探针只豁免
 *     `/api/no-such-route?audit=negative-probe` 精确字面量 + 过期豁免检查；
 *   ⑥ R102：正向覆盖也统一到 matchRoute（与反向同款单段语义）——旧写法的两个字面问题一并
 *     消掉：字面量 includes 是子串匹配（/api/customers/list 会误配进 /api/customers/list-x），
 *     参数路由前缀匹配不限段数（:name 能被多段字面量误配）。
 * 判定仍是「路由在冒烟正文（剥注释后）被字面引用过」——它是接线锁，不是断言强度锁。
 * controllerRoutes/stripComments/matchRoute 唯一真源在 scripts/lib/audit-shared.cjs。 */
const fs = require('fs')
const path = require('path')
const { stripComments, controllerRoutes, matchRoute, ROOT } = require('./lib/audit-shared.cjs')
const raw = fs.readFileSync(path.join(ROOT, 'server/test/e2e.ts'), 'utf8')
const e2e = stripComments(raw)

const routes = controllerRoutes()

/** 冒烟正文里的 /api|/healthz 字面量（去重、剥注释后提取） */
const literals = [...new Set([...e2e.matchAll(/['"`](\/(?:api|healthz)[^'"`\s]*)['"`]/g)].map((m) => m[1]))]

/** 正向覆盖（R102 统一）：声明路由作为 pattern、冒烟字面量作为 actual，走与反向同一把
 *  matchRoute 尺——精确路由逐段相等、参数路由只吃一段。 */
function covered(route) {
  return literals.some((lit) => matchRoute(route, lit))
}

const uncovered = routes.filter((r) => !covered(r.route))

console.log('总路由（controller 声明）:', routes.length, ' 功能断言引用:', routes.length - uncovered.length)
console.log('--- 未在 HTTP 冒烟正文引用的路由（参数路由单段精确匹配，与反向同款） ---')
for (const r of uncovered) console.log(`${r.method} ${r.route}  (${r.file})`)

/** 反方向对表：冒烟正文里的 /api|/healthz 字面量必须指向真实控制器路由（否则是打空气的死测试）。
 * allowlist 语义（R88 复验打回后修正：原版 '/' 前缀把所有字面量整体放行，反方向形同虚设）：
 * 尾斜杠项按前缀匹配，无尾斜杠项**精确**匹配。query 串字面量（/api/...?x=y）先截到 ? 再对。 */
const ALLOW_EXACT = ['/', '/healthz', '/api']
const ALLOW_PREFIX = ['/api/files/images/', '/api/export/']
/** 负向探针只豁免带显式标记的精确字面量：将来有人塞同名死路由不会被按名放过。
 *  每条豁免必须在 e2e 正文里真的出现，否则也报红（防止探针删了、豁免还留着）。 */
const NEGATIVE_PROBES = ['/api/no-such-route?audit=negative-probe']
const dead = []
for (const rawLit of literals) {
  if (NEGATIVE_PROBES.includes(rawLit)) continue
  const lit = rawLit.split('?')[0]
  if (ALLOW_EXACT.includes(lit)) continue
  if (ALLOW_PREFIX.some((a) => lit.startsWith(a))) continue
  const hit = routes.some((r) => matchRoute(r.route, lit))
  if (!hit) dead.push(rawLit)
}
const staleProbes = NEGATIVE_PROBES.filter((probe) => !literals.includes(probe))
console.log('--- 反方向对表：冒烟引用了但控制器没有的路由（打空气） ---')
console.log(dead.length === 0 ? '（无）' : dead.join('\n'))
console.log('--- 负向探针豁免：已声明但正文里没出现的（过期豁免） ---')
console.log(staleProbes.length === 0 ? '（无）' : staleProbes.join('\n'))
if (uncovered.length > 0 || dead.length > 0 || staleProbes.length > 0) process.exitCode = 1
