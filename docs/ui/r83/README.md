# R83 截图矩阵（2026-11-13）—— 设置页「数据自检」（探针闸的用户主动版）

本轮界面变更一处：**备份卡新增「数据自检」按钮**——点一下对当前活库跑三道闸
（quick_check / 版本 ≤ 最新 / 12 张核心表行数），结果块内联显示（通过绿框 / 不过红框）。
数据通道：settings:health（本机读本机库、远端读服务器库——谁的数据显示谁的健康）。
探针闸与 restore/backup 共用同一套口径（core dataHealthCheck）。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| settings-data-health.png | 备份卡五按钮形态（新增「数据自检」）+ 自检通过结果块（quick_check ok / v25 / 12 表行数） | e2e「R83：数据自检」四条（core 三道闸 / 12 表行数 / 设置页入口 / 通道声明与 ipc 注册）；按钮与结果块形态为本实拍 |

## 没有独立画面的行为

- core dataHealthCheck 的三道闸语义（quick_check=ok / ver ≤ 最新 / 核心表在）：与
  restore/backup 的探针同一套口径，由 R76（缺汇率清单同款 12 表）与 restore 路探针的
  既有断言背书；通道三层透传（preload→ipc→远端/server）由 HTTP 路由计数（110）锁。
