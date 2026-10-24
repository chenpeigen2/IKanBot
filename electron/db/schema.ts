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
  },
  {
    version: 8,
    name: 'packing_list_shipment_batches',
    sql: `
-- 分批出运：每张装箱单 = 一个出货批次，状态与船期挂在批次上。
-- ship_status 允许 NULL：迁移前的老批次保持 NULL，不参与推导，订单继续沿用手工状态，
-- 绝不会因为升级把已经签收的老单算回「已包装」。
ALTER TABLE packing_lists ADD COLUMN ship_status TEXT;
ALTER TABLE packing_lists ADD COLUMN vessel TEXT NOT NULL DEFAULT '';
ALTER TABLE packing_lists ADD COLUMN etd_date TEXT;
ALTER TABLE packing_lists ADD COLUMN atd_date TEXT;
ALTER TABLE packing_lists ADD COLUMN eta_date TEXT;
ALTER TABLE packing_lists ADD COLUMN seal_no TEXT NOT NULL DEFAULT '';
ALTER TABLE packing_lists ADD COLUMN bl_no TEXT NOT NULL DEFAULT '';
ALTER TABLE packing_lists ADD COLUMN delivered_at TEXT;
`
  },
  {
    version: 9,
    name: 'order_settlements',
    sql: `
-- 核销台账：短款让利 / 坏账 / 追回，只追加不修改。
-- 撤销 = 再记一条负数并指向原记录，金额与原因都留在流水里。
-- 钱到账只认 payments；核销没有流水号，不能混进收款台账。
CREATE TABLE order_settlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  amount      REAL NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '',
  reverses_id INTEGER,
  payment_id  INTEGER,
  at          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_order_settlements_order ON order_settlements(order_id);
`
  },
  {
    version: 10,
    name: 'quotation_versions_and_sample_goods_price',
    sql: `
-- 报价版本快照：每次改价前冻结一版，客户按旧版回单时能按那一版转单。
CREATE TABLE quotation_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id  INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  goods_total   REAL NOT NULL DEFAULT 0,
  grand_total   REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE(quotation_id, revision)
);
CREATE INDEX idx_quotation_versions_q ON quotation_versions(quotation_id);

-- 订单记住自己由哪张报价单的哪一版转来：客户拿 PI 对报价时有据可查。
ALTER TABLE orders ADD COLUMN source_quotation_id INTEGER;
ALTER TABLE orders ADD COLUMN source_revision INTEGER;

-- 打样单价是打样费，不是大货价；转单必须另填大货单价，绝不静默沿用样品价。
ALTER TABLE sample_order_items ADD COLUMN goods_unit_price REAL;
`
  },
  {
    version: 11,
    name: 'doc_version_unique',
    sql: `
-- 存档版本必须唯一：两个窗口同时点「存到系统」时，靠数据库兜底，
-- 不允许同一张单据出现两条同版记录（否则纸面版次与存档对不上）。
CREATE UNIQUE INDEX ux_doc_versions_doc_kind_version
  ON doc_versions(doc_no, kind, version);
`
  },
  {
    version: 12,
    name: 'party_snapshot_and_archive_hygiene',
    sql: `
-- 抬头快照：客户搬地址、被收购改名，都不能把已经发出去的 PI / PL / CI 改掉。
-- 建单（和报价转单）时把买方 / 收货方钉在这张单上；老数据字段为空，读取时回退客户档案。
ALTER TABLE orders ADD COLUMN bill_to_json TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN ship_to_json TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN bill_to_json TEXT NOT NULL DEFAULT '';

-- 客户：收货地址单独一套（德国客户账单在汉堡、货送不来梅仓是常态）；
-- 建错但不想留档案的客户用「停用」，不再出现在建单下拉里，历史记录一条不动。
ALTER TABLE customers ADD COLUMN ship_attn TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN ship_address TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN ship_zip_code TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN ship_country TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- 商品：工厂与工厂货号记在款号上（跟单时不用翻 1688 聊天记录）
ALTER TABLE products ADD COLUMN factory TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN factory_no TEXT NOT NULL DEFAULT '';
`
  },
  {
    version: 13,
    name: 'quotation_sent_at',
    sql: `
-- 报价真正发出去的那天。工作台的「报价发出 N 天客户没回」必须按它算：
-- 拿 updated_at 会导致改个备注就把等待天数清零，拖了三个月的报价永远催不出来。
ALTER TABLE quotations ADD COLUMN sent_at TEXT;
`
  },
  {
    version: 14,
    name: 'batch_credentials',
    sql: `
-- 客户实收件数：短卸、破损扣款要在数量层面留痕，不能只靠金额核销把差异抹平。
-- NULL = 没记录，视同全收（跟 ship_status 的老批次空值一个处理方式，别拿 0 当「一件没收到」）。
ALTER TABLE packing_lists ADD COLUMN received_qty REAL;

-- 这批的纸面单据日期：箱单日期要落在出运前后一两天、且不得晚于提单日，
-- 不能被「今天点上方的那一下」钉死。空 = 用建单当天。
ALTER TABLE packing_lists ADD COLUMN doc_date TEXT;

-- 批次作废留档：订舱被货代取消、整批发错时，纸面箱单可能已经发到客户邮箱了。
-- 只能「消失」是不行的——作废的批次不参与汇总、不占箱号，但记录和存档一条不动。
ALTER TABLE packing_lists ADD COLUMN voided_at TEXT;
`
  },
  {
    version: 15,
    name: 'gross_measured_flag',
    sql: `
-- 毛重是不是实测过磅：把「这行毛重是量出来的、还是拿净重×系数猜的」钉在数据里。
-- 以前靠「毛重恰好等于净重×系数」反推，改一次毛重系数，去年已出运单据上的 (est.)
-- 标记就当场翻脸——同一张 PDF 前后两次打印结论不一样，报关行据此复核会吃闷亏。
ALTER TABLE packing_list_lines ADD COLUMN gross_est INTEGER;
`
  }
]

/** 本程序认识的最高库结构版本：备份里 user_version 比它大，说明是升级版程序写的数据，直接拒开 */
export const LATEST_DB_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

