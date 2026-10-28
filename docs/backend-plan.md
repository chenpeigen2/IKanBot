# IKanBot 后端数据服务 · 落地拆分

> 2026-10-28 定案：接 MySQL 走后端数据服务（路 B），不做桌面直连 MySQL，也不做 repository 层。
> 同日补充：**必须支持双模式**——本地 SQLite（现状、单机、离线可用）与远端服务（多人）都要能跑，
> 由用户在设置里选。前置契约见 `docs/api-contract.md`（R40）。本文是可执行的施工图，不是愿景。

## 〇、双模式：一套业务核心，两个数据后端

```
模式 A（本地，现状）                    模式 B（远端服务）
┌──────── Electron ────────┐           ┌──────── Electron ────────┐
│ 渲染层 ─ IPC ─▶ 转发器    │           │ 渲染层 ─ IPC ─▶ 转发器    │
│              │ 本地         │           │              │ HTTP      │
│        core 服务（异步）    │           │        core 服务（异步）   │
│              │              │           │              │           │
│        Db: SQLite 适配器    │           │     （本地无数据库）        │
│        （同步包成 Promise）  │           │              │           │
└──────────────────────────┘           └──────────────┼───────────┘
                                                      │
                                          ┌───────────▼───────────┐
                                          │ 后端服务（同一 core）   │
                                          │ Db: MySQL 适配器       │
                                          └───────────┬───────────┘
                                                  ┌───▼───┐
                                                  │ MySQL │
                                                  └───────┘
```

- **业务逻辑只有一份**：`electron/services/*` 提升为与运行环境无关的 `core/`，异步函数、通过注入的 `Db` 访问数据。
  桌面本地模式与后端服务跑的是同一份代码——口径、守门、纸面数字不可能两边不一致。
- **两个 Db 实现**：`SqliteDb`（node-sqlite3-wasm，同步 API 包成 Promise，供本地模式与测试）
  与 `MysqlDb`（mysql2 连接池，事务钉连接，供后端服务）。
- **两种模式共用 IPC 边界**：`electron/ipc/index.ts` 变成一个转发器——模式 A 调本地 core，
  模式 B 调远程 HTTP。渲染层、`preload`、纸面渲染一行不改。
- **模式配置必须存在数据库之外**：服务器地址/账号写在本地配置文件（打包后 `userData/config.json`），
  否则「先连哪里」这件事本身就没有着落。切换模式需要重启程序。
- 离线只在模式 A 成立；模式 B 在线优先（断网只能看不能录），这是明确的取舍。

## 一、终局形态

```
┌───────────── Electron 桌面壳（每个业务员一台）─────────────┐
│ 渲染层 React  ── IPC ──▶  electron/ipc/index.ts（变薄：只转发） │
│ 本机独有：打印、另存 PDF、托盘、窗口、打开本地文件            │
└───────────────────────────┬───────────────────────────────┘
                            │ HTTPS + Bearer Token
┌───────────────────────────▼───────────────────────────────┐
│ 后端服务（Node 22 + Fastify/Express，一台或一小群）          │
│  electron/services/* 原样搬入（业务规则、口径、守门）         │
│  数据访问：mysql2 连接池（getDb 红线改为 getPool）           │
│  文件：对象存储（S3/MinIO）或服务器本地目录（第一阶段）        │
│  备份：mysqldump / 云快照                                  │
└───────────────────────────┬───────────────────────────────┘
                     ┌──────▼──────┐
                     │    MySQL    │
                     └─────────────┘
```

原则：**接口面就是现有 118 个通道名**，参数与返回体沿用 `src/shared/types.ts` 的类型。
渲染层、`preload`、纸面渲染（`src/shared/documents.ts`）一行不改。

## 二、接口面：118 通道 → HTTP 路由

命名一一对应，`域:动作` → `POST /api/域/动作`（只读动作可用 GET + query）：

| 现通道 | 新路由 |
| --- | --- |
| `orders:create` | `POST /api/orders/create` |
| `orders:list` | `POST /api/orders/list`（筛选条件走 body，避免 query 类型丢失） |
| `credits:refund` | `POST /api/credits/refund` |
| `report:monthly` | `POST /api/report/monthly` |
| `dashboard:stats` | `POST /api/dashboard/stats` |

统一约定：
- 请求体：`{ params: [...] }`，与现在 IPC 实参数组同序；或按动作定型 body。**实现时按域定型，别做万能 `params[]`**。
- 返回体：成功直接是业务返回值（与 IPC 一致）；失败 `{ error: { message: string } }`，`message` 就是现在那句中文，界面 toast 原样显示。
- 状态码只表达传输层（400 参数、401 未登录、403 无权限、404 不存在、409 并发冲突、500 内部）；业务拒绝不靠状态码，靠 message。
- 桌面最后用的那张表：

| 留在桌面壳 | 说明 |
| --- | --- |
| `docs:openFile` / `docs:reveal` / `window:*` / `shell:openExternal` / `images:pick` / `images:importLogo` / `backup:pick` | 需要本机 GUI 或本机路径 |
| 其余全部 | 走 HTTP |

`images:*` 的读：商品图/柜照在服务端对象存储，桌面不再读本机目录；`images:url` 返回签名 URL。

## 三、数据层：SQLite → MySQL

- 24 个对象（23 张表 + `payments` 视图），DDL 从 `electron/db/schema.ts` 的 v1→v22 汇总成一份 MySQL 建库脚本；**MySQL 侧一次建到位，不再复刻 22 次迁移**。
- 迁移纪律保留：建库后新增结构一律追加 `migrations/NNN_*.sql`，不改旧列。
- 方言映射：
  - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT AUTO_INCREMENT PRIMARY KEY`
  - `INSERT … ON CONFLICT(x) DO UPDATE` → `INSERT … ON DUPLICATE KEY UPDATE`
  - `INSERT OR IGNORE` → `INSERT IGNORE`
  - 布尔用 `TINYINT(1)`；JSON 文本列用 `JSON`（读出仍是字符串，服务层解析逻辑不动）
  - 日期业务日 `DATE`（本地日字符串），时刻用 `DATETIME(3)` 存 UTC
  - `PRAGMA` 全部去掉；`sqlite_master` 查询改 `information_schema`
  - `LIKE` 转义不同：现有 `escapeLike` 逻辑要按 MySQL 的 `ESCAPE` 规则核对
- **接口形状（关键，2026-10-28 实测修正）**：`Db` 接口必须是**异步**的——mysql2 只有异步 API，
  而现有 service 全是同步函数（node-sqlite3-wasm 是同步驱动）。同步→异步无法用「兼容层」藏起来，
  因此 M1 的主干就是**把 service 层逐域异步化**（函数加 `async`、`getDb()` 换成注入的 `Db`）。
  这是机械改动但覆盖面广（约 1.2 万行 service），本地 SQLite 用同步 API 包成 Promise 即可，桌面行为不变。
  **不做**「为后端另写一份同步/异步服务」——两份业务逻辑必然漂移。

## 四、事务与并发

- `transact<T>` 语义不变：外层 `BEGIN/COMMIT`，嵌套 `SAVEPOINT`。MySQL 原生支持，适配层里按当前连接维护 `inTransaction` 与深度。
- **注意连接绑定**：MySQL 连接池下事务必须钉在同一条连接上（`pool.getConnection()`），SAVEPOINT 与后续写不能漂到别的连接；这是与 SQLite 单连接最大的实现差异。
- 多用户冲突（现在是单写者假设）：
  - 第一版：`UPDATE` 带 `WHERE id=? AND updated_at=?`，`affectedRows=0` 即视为「别人改过」，抛 409 + 中文提示「这单刚被别人改过，请刷新再看」。
  - 第二版（M4）：给热表加 `row_version BIGINT`，读时带出、写时校验并自增；列表页可做「有人正在改」的弱提示。
- 幂等：收款/退款这类入口收到 `request_id` 去重（防双击与重试造成两笔）。

## 五、鉴权与留痕

- 登录：用户名 + 密码（服务端 argon2/bcrypt），签发 JWT；桌面设置里填服务器地址，登录态存 `safeStorage`。
- `actor`：现有 `order_events` 的 actor 字段已存在，改为取 token 里的用户名，不再靠界面传。
- 权限第一版只有「能登录 = 全部权限」，角色/只读账号留到有真实需求再加（不做多租户）。

## 六、文件、备份、运维

- 单据/图片：第一阶段仍存服务器本地目录（沿用 `imagesDir/docsDir` 结构，服务端挂数据盘）；第二阶段换对象存储，`images:url`、`docs:openFile` 改签名 URL。`docs` 存档的版本只增不减语义不变。
- 备份：`mysqldump --single-transaction` + 文件目录打包，保留现在「按天 + 每小时自动备份」的节奏；恢复 = 整库导入 + 文件目录替换（保留 R36 的失败回滚语义，只是搬进服务端脚本）。
- 运维：进程守护（systemd/PM2）、日志轮转、健康检查 `/healthz`、每日备份校验（能读回、表行数对得上）。

## 七、数据搬迁（一次性）

1. 桌面端升级包附带「导出整库」：SQLite 原样复制 + `data/images`、`data/docs` 打包（复用现有备份格式，zip）。
2. 服务端导入工具：建表 → 逐表搬运（保留显式主键，不重排联表）→ 重置 `AUTO_INCREMENT` 到 max+1 → 校验（每表行数、金额合计、单号唯一、`customerCreditBalance` 抽查 10 个客户与原库一致）。
3. 切换窗口：停桌面写入 → 导出 → 导入 → 服务端冒烟 → 桌面改服务器地址 → 恢复使用。**导入后桌面本地库只读保留 30 天作回滚。**

## 八、里程碑（每段可独立验收）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | `server/` 骨架、异步 `Db` 接口、SQLite/MySQL 两个实现、`transact`（钉连接 + SAVEPOINT）、`/healthz`、样板域 | 骨架 typecheck + SQLite 冒烟（嵌套事务回滚）全绿 |
| M1 | `electron/services/*` 逐域提升为 `core/`：异步化、注入 `Db` 与目录（去掉 electron 依赖）；桌面本地模式接 core | **现有 1800+ 断言全绿**（这是硬门槛），桌面全功能真跑 |
| M2 | 后端服务：118 路由 + 鉴权 + 统一错误 + 请求日志，跑同一份 core + MySQL | 通道清单逐条对拍；错误文案与现在一致 |
| M3 | 桌面双模式：转发器按配置走本地 core 或 HTTP；本地配置文件存服务器地址/账号；登录态存 safeStorage | 两模式各跑一遍全功能（打印/存档/备份）；断网有明确提示；切换需重启 |
| M4 | 并发：`row_version` / `updated_at` 冲突检测、409 提示、收款幂等 | 两窗口同时改同一单，后写者收到可见提示；双击收款只落一笔 |
| M5 | 文件上对象存储、备份/恢复脚本、部署与监控、整库搬迁工具 | 恢复演练成功；搬迁校验报告逐项通过 |

预估：M0–M2 是本体的三分之二；M3 才是用户能感知的切换；M4/M5 是上线前的必修课。

## 九、明确不做

- 不做离线优先/双向同步：第一版在线优先，断网只能看不能录（要离线是另一个项目）。
- 不做 repository/DAO 层：接口面就是通道，service 就是数据访问层。
- 不做多租户、不做 GraphQL、不做微服务拆分（单体 + 按域模块即可）。
- 不为了后端化重写纸面渲染与业务口径：`documents.ts`、`money.ts` 原样复用。

## 十、风险

1. **方言暗礁**：`LIKE` 转义、排序规则（`utf8mb4` 下大小写/重音比较）、`ON CONFLICT` 语义、`COALESCE` 在索引上的行为。对策：M1 的 e2e 就是照妖镜，逐条断言逼出来。
2. **事务连接漂移**：池化后必须连接绑定，否则「回滚了主表、明细却提交了」。
3. **时间双轨**（契约拦路虎 5）：服务端时区必须固定 `Asia/Shanghai` 解释业务日，时刻一律 UTC。
4. **切库当天**：搬迁做两遍演练（生产库副本），写清楚回滚步骤。
5. **成本**：一台小服务器 + MySQL + 备份盘即可起步；不必上云托管数据库，先把形态跑通。
