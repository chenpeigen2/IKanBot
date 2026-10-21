const { Database } = require('node-sqlite3-wasm')
const db = new Database('data/ikanbot.db', { readOnly: true })
const q = (s, ...p) => db.all(s, ...p)
const label = process.argv[2] || 'ALL'
if (label === 'ALL' || label === 'schema') {
  console.log('TABLES:', q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name).join(','))
  for (const t of ['orders', 'order_items', 'charges', 'payments', 'sample_orders', 'quotations', 'customers', 'doc_versions']) {
    try { console.log(t + ':', q(`PRAGMA table_info(${t})`).map(c => c.name).join(',')) } catch (e) { console.log(t + ': ERR', e.message) }
  }
}
if (label === 'ALL' || label === 'data') {
  const dump = (name, sql) => { try { console.log(name + ':', JSON.stringify(q(sql), null, 0)) } catch (e) { console.log(name + ': ERR ' + e.message) } }
  dump('ORDERS', 'SELECT * FROM orders')
  dump('ITEMS', 'SELECT * FROM order_items')
  dump('CHARGES', 'SELECT * FROM charges')
  dump('PAYMENTS', 'SELECT * FROM payments')
  dump('SAMPLES', 'SELECT * FROM sample_orders')
  dump('QUO', 'SELECT * FROM quotations')
  dump('CUST', 'SELECT id,name FROM customers')
  dump('DOCV', 'SELECT * FROM doc_versions')
}
db.close()
