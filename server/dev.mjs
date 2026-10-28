// 本地起服务：把开发库拷一份到 .tmp/dev.db 再启动，服务只改这份副本。
// 用途是拿 curl / Postman 直接打接口，不需要 MySQL，也不会动桌面端的开发数据。
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const source = process.env['IKAN_SQLITE_FILE'] ?? join(repoRoot, 'data', 'ikanbot.db')
const port = process.env['IKAN_PORT'] ?? '8787'
const target = join(here, '.tmp', 'dev.db')

mkdirSync(join(here, '.tmp'), { recursive: true })

const fresh = process.argv.includes('--fresh')
const stale =
  existsSync(target) && existsSync(source) && statSync(source).mtimeMs > statSync(target).mtimeMs
if (fresh || !existsSync(target) || stale) {
  if (!existsSync(source)) {
    console.error(`[dev] 找不到开发库：${source}`)
    console.error('[dev] 先让桌面端起一次生成 data/ikanbot.db，或用 IKAN_SQLITE_FILE=<路径> npm run dev')
    process.exit(1)
  }
  copyFileSync(source, target)
  console.log(`[dev] 已拷贝 ${source} → ${target}`)
}

console.log(`[dev] 接口地址 http://localhost:${port}`)
console.log(`[dev]   curl http://localhost:${port}/healthz`)
console.log(
  `[dev]   curl -X POST http://localhost:${port}/api/customers/list ` +
    `-H "content-type: application/json" -d '{"includeInactive":true}'`
)

const child = spawn(process.execPath, [join(here, 'dist', 'src', 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, IKAN_SQLITE_FILE: target, IKAN_PORT: port }
})
child.on('exit', (code) => process.exit(code ?? 0))
