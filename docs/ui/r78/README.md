# R78 截图矩阵（2026-11-11）—— 毛利卡的「成本没录全」直达链接

本轮界面变更一处：客户详情**毛利卡**的「有 N 单成本没录全」升级为**可点直达**（与 R76
缺汇率清单同构——同一份 listOrderMoney 行数据，毛利不可信的两个原因都能点排查）。
数据：customerStats 新增 missingCostList（customerId/orderId/orderNo/currency/missingItems）。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| customer-cost-missing-link.png | 毛利卡「—」+「有 1 单成本没录全（SO… 点单号直达 补成本）」 | e2e 客户统计段两条：清单含 A002 那张单（单号/缺失行数）、清单带客户 id；渲染接线一条（missingCostList 渲染 + 直达文案）。卡片形态为本实拍 |

## 拍法

`scripts/shot.sh /customers`：预置脚本（node 直连 SQLite）造一张 unit_cost 为 NULL 的
确认单 → shot 开第一客户的详情滚到毛利卡。演示库拍完重置回干净 seed。
