/* 只读审计（R87 版）：server 控制器路由 vs HTTP 冒烟（server/test/e2e.ts）的功能断言覆盖。
 * 一个 .controller.ts 文件可能挂多个 @Controller 类（如 dashboard/dashboard.controller.ts
 * 同时挂 api/dashboard、api/report、api/export）——按 @Controller 块切开逐块配对。
 * 判定：路由全名（/api/<域>/<action>）在 e2e.ts 正文里被字面引用过。 */
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const e2e = fs.readFileSync(path.join(ROOT, 'server/test/e2e.ts'), 'utf8')
const domainDirs = fs.readdirSync(path.join(ROOT, 'server/src')).filter((d) => {
  const p = path.join(ROOT, 'server/src', d)
  return fs.existsSync(p) && fs.statSync(p).isDirectory()
})
const results = []
for (const dir of domainDirs) {
  const cdir = path.join(ROOT, 'server/src', dir)
  const ctrlFile = fs.readdirSync(cdir).find((f) => f.endsWith('.controller.ts'))
  if (!ctrlFile) continue
  const src = fs.readFileSync(path.join(cdir, ctrlFile), 'utf8')
  // 按 @Controller(...) 切块：每块从自己的 @Controller 起到下一个 @Controller 或文件尾
  const blocks = []
  const re = /@Controller\('([^']+)'\)/g
  let m
  while ((m = re.exec(src))) blocks.push({ base: m[1], start: m.index })
  for (let i = 0; i < blocks.length; i++) {
    const seg = src.slice(blocks[i].start, i + 1 < blocks.length ? blocks[i + 1].start : src.length)
    for (const r of seg.matchAll(/@(Post|Get|Put)\('([^']+)'\)/g)) {
      results.push({ route: `/${blocks[i].base}/${r[2]}`, method: r[1] })
    }
  }
}
const unused = results.filter((r) => {
  if (e2e.includes(r.route)) return false
  // 参数路由（:name）：冒烟里只会出现真实 URL——按参数段前缀匹配
  if (r.route.includes(':')) {
    const prefix = r.route.slice(0, r.route.indexOf(':'))
    return !e2e.includes(prefix)
  }
  return true
})
console.log('总路由（controller 声明）:', results.length, ' 功能断言引用:', results.length - unused.length)
console.log('--- 未在 HTTP 冒烟正文引用的路由（参数路由按前缀匹配） ---')
for (const r of unused) console.log(`${r.method} ${r.route}`)
