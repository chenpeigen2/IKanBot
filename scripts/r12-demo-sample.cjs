/** r12 自验：给演示库补一张「寄出 45 天、打样费未收」的打样单，让工作台催打样费青色圆点常驻可抽查 */
const { Database } = require('node-sqlite3-wasm')
const db = new Database('data/ikanbot.db')
const d = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
const now = new Date().toISOString()
const exists = db.get("SELECT id FROM sample_orders WHERE sample_no = 'SMP20261021002'")
let id
if (exists) {
  id = exists.id
  console.log('已存在 SMP20261021002, id=', id)
} else {
  const res = db.run(
    `INSERT INTO sample_orders(sample_no, customer_id, sample_date, courier, tracking_no, express_fee, status, note, created_at, updated_at, fee_status, currency, exchange_rate, exchange_rate_date, factory_cost, shipped_at)
     VALUES('SMP20261021002', 61, ?, '顺丰', 'SF9988776611', 120, 'sent', '催打样费青色圆点演示单（研发补的，寄出 45 天未收）', ?, ?, 'unpaid', 'USD', 7.15, ?, 30, ?)`,
    [d, now, now, d, d]
  )
  id = Number(res.lastInsertRowid)
  db.run(
    `INSERT INTO sample_order_items(sample_order_id, style_no, product_name, color, size, quantity, unit_price)
     VALUES(?, 'TS-001', '纯棉圆领短袖T恤', 'Black', 'M', 2, 15)`,
    [id]
  )
  console.log('插入打样单 SMP20261021002, id=', id, '日期=', d)
}
console.log(
  'SAMPLES:',
  JSON.stringify(db.all('SELECT id, sample_no, sample_date, fee_status, express_fee FROM sample_orders'))
)
db.close()
