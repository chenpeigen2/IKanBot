const esbuild = require('esbuild')
esbuild.build({
  entryPoints: ['scripts/pdftest.ts'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: 'out/test/pdftest.cjs',
  external: ['electron', 'node-sqlite3-wasm'],
  logLevel: 'error'
}).catch(() => process.exit(1))
