/**
 * 数据库 schema 与迁移。
 *
 * 采用 user_version 做版本管理，每次 schema 变更追加一条迁移。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  style_no      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  composition   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  season        TEXT NOT NULL DEFAULT '',
  cost_price    REAL,
  sizes         TEXT NOT NULL DEFAULT '[]',
  colors        TEXT NOT NULL DEFAULT '[]',
  note          TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE product_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_images_product ON product_images(product_id);

CREATE TABLE customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company       TEXT NOT NULL DEFAULT '',
  contact       TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  zip_code      TEXT NOT NULL DEFAULT '',
  attn          TEXT NOT NULL DEFAULT '',
  payment_pref  TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE orders (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no              TEXT NOT NULL UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  pi_no                 TEXT NOT NULL DEFAULT '',
  payment_status        TEXT NOT NULL DEFAULT 'draft',
  ship_status           TEXT NOT NULL DEFAULT 'not_prepared',
  currency              TEXT NOT NULL DEFAULT 'USD',
  exchange_rate         REAL NOT NULL DEFAULT 1,
  base_currency         TEXT NOT NULL DEFAULT 'CNY',
  incoterm              TEXT NOT NULL DEFAULT 'FOB',
  port_of_loading       TEXT NOT NULL DEFAULT '',
  port_of_destination   TEXT NOT NULL DEFAULT '',
  payment_method        TEXT NOT NULL DEFAULT 'tt_deposit',
  deposit_ratio         REAL NOT NULL DEFAULT 0.3,
  valid_until           TEXT,
  expected_ship_date    TEXT,
  expected_arrival_date TEXT,
  customer_po           TEXT NOT NULL DEFAULT '',
  note                  TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(payment_status, ship_status);

CREATE TABLE order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  style_no     TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  composition  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  size         TEXT NOT NULL DEFAULT '',
  quantity     REAL NOT NULL DEFAULT 0,
  unit_price   REAL NOT NULL DEFAULT 0,
  unit_cost    REAL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  paid_at    TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  method     TEXT NOT NULL DEFAULT 'T/T',
  bank_ref   TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_date ON payments(paid_at);

CREATE TABLE packing_lists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  pl_no        TEXT NOT NULL,
  container_no TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_pl_order ON packing_lists(order_id);

CREATE TABLE packing_list_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  packing_list_id INTEGER NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
  box_no          TEXT NOT NULL DEFAULT '',
  style_no        TEXT NOT NULL DEFAULT '',
  product_name    TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  size            TEXT NOT NULL DEFAULT '',
  quantity        REAL NOT NULL DEFAULT 0,
  net_weight      REAL,
  gross_weight    REAL,
  box_length      REAL,
  box_width       REAL,
  box_height      REAL
);
CREATE INDEX idx_pll_pl ON packing_list_lines(packing_list_id);

CREATE TABLE order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  from_status TEXT,
  to_status   TEXT,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_events_order ON order_events(order_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`
  },
  {
    version: 2,
    name: 'quotations_and_order_extras',
    sql: `
-- 报价单：下单之前的环节，独立于订单，绝不进销售额/毛利
CREATE TABLE quotations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  q_no                TEXT NOT NULL UNIQUE,
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  status              TEXT NOT NULL DEFAULT 'draft',
  result              TEXT NOT NULL DEFAULT 'pending',
  currency            TEXT NOT NULL DEFAULT 'USD',
  exchange_rate       REAL NOT NULL DEFAULT 1,
  base_currency       TEXT NOT NULL DEFAULT 'CNY',
  incoterm            TEXT NOT NULL DEFAULT 'FOB',
  port_of_loading     TEXT NOT NULL DEFAULT '',
  port_of_destination TEXT NOT NULL DEFAULT '',
  payment_method      TEXT NOT NULL DEFAULT 'tt_deposit',
  deposit_ratio       REAL NOT NULL DEFAULT 0.3,
  valid_until         TEXT,
  customer_po         TEXT NOT NULL DEFAULT '',
  note                TEXT NOT NULL DEFAULT '',
  charges             TEXT NOT NULL DEFAULT '[]',
  converted_order_id  INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_quotations_customer ON quotations(customer_id);

CREATE TABLE quotation_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  style_no     TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  composition  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  size         TEXT NOT NULL DEFAULT '',
  quantity     REAL NOT NULL DEFAULT 0,
  unit_price   REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_quotation_items_q ON quotation_items(quotation_id);

-- 订单照片（验货照 / 柜照），与商品图片分开
CREATE TABLE order_photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  file_name  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'inspection',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_photos_order ON order_photos(order_id);

-- 订单补充字段：汇率日期、工厂、船期、封条
ALTER TABLE orders ADD COLUMN exchange_rate_date TEXT;
ALTER TABLE orders ADD COLUMN factory TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN factory_due_date TEXT;
ALTER TABLE orders ADD COLUMN cut_off_date TEXT;
ALTER TABLE orders ADD COLUMN etd_date TEXT;
ALTER TABLE orders ADD COLUMN vessel TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN seal_no TEXT NOT NULL DEFAULT '';

-- 商品库：单件净重与箱规，供装箱单自动算净重
ALTER TABLE products ADD COLUMN unit_net_weight REAL;
ALTER TABLE products ADD COLUMN box_pieces INTEGER;
ALTER TABLE products ADD COLUMN box_length REAL;
ALTER TABLE products ADD COLUMN box_width REAL;
ALTER TABLE products ADD COLUMN box_height REAL;

-- 单据存档：每次出单据留一版记录（老板要的「留痕」）
CREATE TABLE doc_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  quotation_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
  doc_no       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'pi',
  version      INTEGER NOT NULL DEFAULT 1,
  amount       REAL NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_doc_versions_order ON doc_versions(order_id);
CREATE INDEX idx_doc_versions_q ON doc_versions(quotation_id);
`
  },
  {
    version: 3,
    name: 'customer_default_terms',
    sql: `
-- 客户档案里的默认条款：建单时直接带出来，不用一个个下拉框选
ALTER TABLE customers ADD COLUMN default_payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN default_deposit_ratio REAL;
ALTER TABLE customers ADD COLUMN default_incoterm TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN default_port_loading TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN default_port_destination TEXT NOT NULL DEFAULT '';
`
  },
  {
    version: 4,
    name: 'quotation_rate_date_revision_and_order_charges',
    sql: `
-- 报价单：汇率锁定日期（不填汇率日期，系统不替你编一个）+ 改过几版
ALTER TABLE quotations ADD COLUMN exchange_rate_date TEXT;
ALTER TABLE quotations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- 订单：正式费用行（运费/保险等），不再塞进备注里
ALTER TABLE orders ADD COLUMN charges TEXT NOT NULL DEFAULT '[]';
`
  },
  {
    version: 5,
    name: 'quotation_events',
    sql: `
-- 报价单自己的操作历史：改了什么、什么时候改的
CREATE TABLE quotation_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_quotation_events_q ON quotation_events(quotation_id);
`
  },
  {
    version: 6,
    name: 'sample_orders',
    sql: `
-- 打样单（样品单）：公司垫的钱要记账：样品费、快递费、快递单号
CREATE TABLE sample_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_no   TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sample_date TEXT NOT NULL DEFAULT '',
  courier     TEXT NOT NULL DEFAULT '',
  tracking_no TEXT NOT NULL DEFAULT '',
  express_fee REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_sample_orders_customer ON sample_orders(customer_id);

CREATE TABLE sample_order_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_order_id INTEGER NOT NULL REFERENCES sample_orders(id) ON DELETE CASCADE,
  product_id      INTEGER,
  style_no        TEXT NOT NULL DEFAULT '',
  product_name    TEXT NOT NULL DEFAULT '',
  composition     TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  size            TEXT NOT NULL DEFAULT '',
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_price      REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_sample_items_order ON sample_order_items(sample_order_id);
`
  },
  {
    version: 7,
    name: 'sample_orders_money_status',
    sql: `
-- 打样单补字段（使用者第 4~5 轮需求）：
--  N25 寄出/签收日期
--  N23/N33 三笔分清：样品费（应收）/ 快递费（公司垫）/ 工厂打样费（公司成本）+ 收款标记
--  N24 转订单；应收要进工作台，必须记币种与汇率
ALTER TABLE sample_orders ADD COLUMN shipped_at TEXT;
ALTER TABLE sample_orders ADD COLUMN received_at TEXT;
ALTER TABLE sample_orders ADD COLUMN factory_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE sample_orders ADD COLUMN fee_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE sample_orders ADD COLUMN fee_note TEXT NOT NULL DEFAULT '';
ALTER TABLE sample_orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE sample_orders ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 0;
ALTER TABLE sample_orders ADD COLUMN exchange_rate_date TEXT;
ALTER TABLE sample_orders ADD COLUMN converted_order_id INTEGER;
`
  }
]
