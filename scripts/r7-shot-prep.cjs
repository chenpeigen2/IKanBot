/**
 * 第 7 轮截图前的数据准备（只动演示库，不动结构）：
 *  1) SMP20261021001 → 已寄已收，用来验打样列表新加的「寄出 / 签收」列（N36 / N25 补完）
 *  2) 造一张「规则上线前的旧打样单」：未收、汇率没填、没寄出 —— 验「⚠ 汇率未填」黄标真的会亮
 * （汇率缺失的单不计入工作台待收，money.ts sampleReceivable 已跳过，不破坏三个不变量）
 */
const { Database } = require('node-sqlite3-wasm')
const db = new Database('data/ikanbot.db')

db.run(`UPDATE sample_orders SET shipped_at='2026-10-18', received_at='2026-10-21' WHERE id=13`)

const cust = db.get('SELECT customer_id FROM sample_orders WHERE id=13').customer_id
const has = db.get("SELECT id FROM sample_orders WHERE sample_no='SMP20261021002'")
if (!has) {
  db.run(
    `INSERT INTO sample_orders(sample_no, customer_id, sample_date, courier, tracking_no, express_fee,
      status, note, shipped_at, received_at, factory_cost, fee_status, fee_note, currency, exchange_rate,
      exchange_rate_date, created_at, updated_at)
     VALUES('SMP20261021002', ?, '2026-10-19', '顺丰', 'SF7777777777', 60, 'pending',
      '旧数据：汇率规则上线前存的单，汇率没填', '', '', 30, 'unpaid', '', 'USD', 0, '',
      '2026-10-19 10:00:00.000', '2026-10-19 10:00:00.000')`,
    [cust]
  )
}
console.log('samples:', JSON.stringify(db.all('SELECT id, sample_no, shipped_at, received_at, exchange_rate, fee_status FROM sample_orders')))
db.close()
