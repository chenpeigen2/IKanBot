# IKanBot 数据访问契约

> 目的：为「从本地 SQLite 换到后端数据库」留后路。本文写的是**已经成立的边界**，
> 不是未来的重构计划——照着它换库，界面一行不用改，业务口径一处不丢。

## 红线

**`getDb()` 不许跨出 `electron/services/`。**
目前 153 处调用全部住在 services 层（orders.ts 47 处最多），renderer 与 IPC 层（`electron/ipc/index.ts`）只认函数不认 SQL。
任何新代码想把 SQL 写进 IPC handler、组件或 `src/` 里，都是在凿沉这条船的洞。

接口面就是 IPC 边界的 118 个通道：`electron/ipc/index.ts` 里的每个 `handle('域:动作', …)`
就是一份已经定型的 API。换后端 = 把这 118 个 handler 的实现从「调本地 service」换成「调远程 API」，
**不另起一层 repository 抽象**——那层抽象和 IPC 边界是同一个东西，写两遍只会漂移。

## 换后端必须先解的五只拦路虎

这些不是细节，是当前实现「只对单机 SQLite 成立」的硬前提。换库前逐条给出对应方案：

1. **事务 = SAVEPOINT 嵌套**（`electron/db/index.ts` 的 `transact<T>(fn)`）。
   service 层大量「先查后写再留痕」的复合操作都包在 `transact` 里，且允许嵌套
   （转单、改费用、传照片都是「多表同生同死」）。SQLite 没有真事务嵌套，这里用 SAVEPOINT 模拟；
   后端要换成真事务（外层 BEGIN / 内层 SAVEPOINT 或重入式事务管理器）。
   `transact` 里若抛错，SAVEPOINT 回滚，错误原样抛给界面——这个语义必须保住。
2. **单写者假设**。现在是单机单进程单连接：没有并发写、没有乐观锁。
   同一张单两个人同时改，后写者直接覆盖先写者。后端必须引入行版本或更新时间戳的冲突检测，
   否则这条要写进「多人使用的已知限制」。
3. **备份 = `VACUUM INTO`**（`electron/services/backup.ts`）。
   快照靠 SQLite 自己导出一份事务一致的副本，失败才退回直拷文件。
   后端要换成 `pg_dump`/云快照等同类机制，恢复（`restoreBackup`）是整库替换，语义一样要给。
4. **图片、单据存档、备份都在本地磁盘**：`imagesDir`（商品图/柜照）、`docsDir`（PI/CI 存档）、
   `backupsDir`，数据库里只存相对路径与 JSON 元数据。
   后端要换成对象存储 + 签名 URL；`docs:openFile` / `docs:reveal` / `images:url`
   这几个通道的实现会跟着变，通道名与参数不变。
5. **时间语义是双轨制**，混用必错：
   - 时刻（created_at / updated_at / 收款登记时间）：`new Date().toISOString()`，UTC 串；
   - 业务日（到账日 / 交期 / ETD / 报价有效期）：本地日字符串 `YYYY-MM-DD`（`src/shared/date.ts` 的 `localDate`）。
   所有「按月归集、按天催款」的口径都走 `localDateOf()` 换算（见 `dashboard.ts` 的 `daysFrom`）。
   服务端若用别的时区解释这两类字段，月报串月、催款差一天——R12/R35 踩过的坑都在这。

## 守门的分工

**界面是给正常人用的，IPC 是给所有调用方开的门。** 所以每条业务规则都在 service 层拦一遍，
界面里的校验只是少让用户绕远路。换后端时这些守门必须跟着搬进服务端：

- 数量/单价/费用/单号等入口闸门：`src/shared/guards.ts`（`assertQuantity`、`assertUnitPrice`、
  `assertOptionalMoney`、`assertDepositRatio`、`assertOrderTotalNonNegative`、`assertDocNo`）。
  这是纯函数、无依赖，服务端可直接复用同一份代码。
- 业务状态闸门（作废单禁改、出过 CI 锁价、有流水禁删收款等）：散在各 service 的函数开头，
  报错文案是说人话的中文，错误经 IPC 原样到界面 toast。换后端时保留「错误文本直接给用户」的约定。
- 数据库迁移是 append-only（`electron/db/schema.ts`，当前 v22）：只加列加表，不改旧列。
  后端迁移工具要能表达同一条纪律。

## 口径真源

一个业务数字只有一个算它的地方。换后端时这些函数要么原样搬走、要么用 SQL 等价重写，**不许各端各算**：

| 口径 | 真源 |
| --- | --- |
| 待收 / 已收 / 定金差 / 核销 / 坏账 / 客户预收余额 | `electron/services/money.ts`（`listOrderMoney`、`customerCreditBalance`、`depositDueOf`…） |
| 打样费每一分钱（已收/抵扣/挂起/老账） | `money.ts` 的 `sampleMoneyRows`（待收、对账单、工作台催款同一份底稿） |
| 收款状态流转（draft→sent→partial→…） | `orders.ts` 的 `recomputePaymentStatus` |
| 打样 fee_status 派生（offset 生效/挂起） | `samples.ts` + `src/shared/billing.ts` 的 `isBillingStatus` |
| 工作台提醒时钟（状态钟不看 updated_at） | `dashboard.ts` 的 `reminders()` |
| 本月销售额/毛利/收款 | `dashboard.ts` 的月度报表（按 `localDateOf` 归集） |

## 分域通道清单

每域一句话说明 + 特殊标注：**【事务】**= 多表同生同死；**【守门】**= 服务端必须重做的校验；
**【真源】**= 上面口径表的函数；**【文件】**= 涉及本地磁盘，换后端要换对象存储。

### customers
档案 CRUD 与查重。`list/get/save/delete/setActive`；
`save` 同名查重【守门】（同名要显式确认才放行，防一户两档劈开欠款）；默认定金比例【守门】0–1；
`stats/orders/stylePriceHistory` 是该客户的订单、欠款与历史成交价。

### products
商品档案、图片、CSV 导入。`list/get/save/delete/copy/setActive`；
图片 `addImage/delImage/setPrimary/images`【文件】——主图不变量（删主图补位、批量上传首张为主）在 service 的事务里【事务】；
`importCsv` 整文件一次解析逐行报告【守门】；`referenceCount` 防删被引用的款。

### orders
主战场。头表 CRUD：`create/update/get/list/void/delete`；
明细行：`addItem/addItems/updateItem/removeItem/replaceItems/summarizeSkus`【守门】数量正整数、单价非负、同款唯一；
收款：`addPayment/deletePayment/batchAddPayments`（删收款先撤核销【守门】，水单号查重）；
核销与坏账：`addSettlement/reverseSettlement/listSettlements`（追回自动落一条收款，撤销连退【事务】）；
状态：`setPaymentStatus`（真源 recompute）/`setShipStatus`；
照片：`addPhoto/delPhoto/photos`【文件】删照片补位【事务】；
杂项：`events`（操作历史，谁改的为什么）、`ports/lastExchangeRate/lastTerms`（上张单的默认值）。
`update` 只写「这次真的传了」的列：undefined=保留原值，null/''=清空——服务端必须保持这个语义。

### pl（装箱单 / 批次）
`create/delete/list`、`updateInfo`（船期/柜号/封条）、`updateLine/addLine/deleteLine`（箱明细，
出运后锁定【守门】）、`void/unvoid`（作废留档）、`amounts`（本批金额，批次 CI 的数字来源【真源】）。

### samples（打样单）
`list/get/save/delete`、`addPayment/deletePayment`（转单后不能再收【守门】）、`convert`【事务】
（订单+明细+负费用抵扣行一次建成，offset 与货值的差额校验【守门】）。
`fee_status` 不是普通字段：由流水与转单状态派生，见真源表。

### quotations（报价单）
`list/get/save/delete/updateMeta/convert/versions/events`。
改价前冻结一版快照（quotation_versions），客户按旧版回单时有据可查【事务】。

### credits（客户预收）
`apply/reverse`（抵扣与撤销，撤销连打样回退【事务】）、`balance`、`refund/reverseRefund`（退款正门）。
核心不变量：余额只来自真金白银（实收−退款−转单抵扣），服务端要重跑 `assertCreditSolvent` 的等价校验【守门】。

### dashboard / report / export
`dashboard:stats`、`dashboard:reminders`（催款时钟）、`report:monthly/receivables/customerOrderRows`、
`export:csv`（订单/明细/收款/月报/对账单，kind 分支见 `dashboard.ts` 的 `exportCsv`）。
全部只读，但每一行都来自真源表里的函数——别为了省一次调用在服务端重写 SQL。

### docs（单据存档）
`save/list/listQuotation/void/openFile/reveal/nextVersion`【文件】。
存档号即目录名【守门】（`assertDocNo` 防路径穿越）；版本只增不减，作废是留痕不是删除。

### backup / settings / images / app / window / shell
`backup:create/inspect/list/pick/restore/reveal`【文件】（VACUUM INTO，见拦路虎 3）；
`settings:get/save`（baseCurrency 锁定后禁改【守门】）、`settings:baseLocked`；
`images:pick/importLogo/readDataUrl/url/discard`【文件】；
`app:paths/*`、`window:print/printPdf/hide`、`shell:openExternal`——Electron 壳专属，
后端化时这几个通道留在桌面壳里，不进服务端契约。

## 换库时的验收底线

现有 `scripts/e2e-test.ts`（1800+ 断言）直接调 service 层，跑的就是这份契约的语义。
换后端的第一步是让它对着新实现变绿；任何一条断言改不动，说明新实现漏了这里的口径。
