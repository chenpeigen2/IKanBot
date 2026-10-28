/**
 * 打双模式测试包。
 *
 * 特殊点：这份测试要 import 整个 electron/ipc，会顺带拉进 electron-updater。
 * 所以 electron 一定得别名到桩上（不能设成 external，普通 node 里没这模块），
 * 让 electron-updater 也一起打进包里；它只在 handler 里才碰 autoUpdater，不会在加载时就炸。
 */
const esbuild = require('esbuild')
esbuild.build({
  entryPoints: ['scripts/mode-test.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'out/test/mode-test.cjs',
  external: ['node-sqlite3-wasm'],
  alias: { electron: './scripts/electron-stub.cjs' },
  logLevel: 'info'
}).catch(() => process.exit(1))
