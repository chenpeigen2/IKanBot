const esbuild = require('esbuild')
esbuild.build({
  entryPoints: ['scripts/render-docs.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: 'out/test/render-docs.cjs', external: ['electron', 'node-sqlite3-wasm'],
  alias: { electron: './scripts/electron-stub.cjs' }, logLevel: 'error'
}).catch(() => process.exit(1))
