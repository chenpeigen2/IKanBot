// 直接查 ikanbot.db 的小工具： node scripts/q.cjs "SELECT ..." [params...]
const path = require('path')
const { Database } = require('node-sqlite3-wasm')
const file = process.env.IKAN_DB || path.join(process.cwd(), 'data', 'ikanbot.db')
const db = new Database(file)
const sql = process.argv[2]
const params = process.argv.slice(3)
try {
  const stmt = db.prepare(sql)
  const rows = stmt.all.apply(stmt, params)
  console.log(JSON.stringify(rows, null, 2))
} catch (e) {
  console.log('ERR', e.message)
}
db.close()
