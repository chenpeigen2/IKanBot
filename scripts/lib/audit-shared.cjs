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
 *  装饰器认 @Post/@Get/@Put/@Delete/@Patch、单双引号——口径与 audit:http、audit:ipc 同源。 */
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

module.exports = { stripComments, controllerRoutes, ROOT }
