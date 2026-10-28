import { createDb } from './db/factory'
import { createApp } from './http/server'

const port = Number(process.env['IKAN_PORT'] ?? 8787)
const db = createDb()
const app = createApp(db)

app.listen(port, () => {
  console.log(`[ikanbot-server] 已启动 :${port}（数据后端 ${db.kind}）`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close(() => {
      void db.close().finally(() => process.exit(0))
    })
  })
}
