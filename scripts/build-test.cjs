const esbuild = require('esbuild')
esbuild.build({
  entryPoints: ['scripts/e2e-test.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'out/test/e2e-test.cjs',
  external: ['electron', 'node-sqlite3-wasm'],
  alias: { electron: './scripts/electron-stub.cjs' },
  logLevel: 'info'
}).catch(() => process.exit(1))
