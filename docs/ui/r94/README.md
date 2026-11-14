# R94 截图矩阵（2026-11-14）—— 远端模式健康链路全链实拍（R89/R91/R92 远端挂账清偿）

本轮**零代码改动**（evidence-only 轮）：R89/R91/R92 的健康红条与锚点直滚此前只拍过本机态，
「远端模式」一直挂账（R89⑧/R91⑥/R92⑧）。本轮把整条远端健康链路三连拍清：
**工作台红条 → 「详情」锚点直滚 → 设置页红框详情**，全部查的是**服务器那份坏库**
（problems 经 HTTP 通道来，settings.get 走 HTTP——锚点竞态修复 [s, source] 闸在慢通道下
的真实验证：数据到位才滚与传输耗时无关）。

拍法（R85/R61 同款）：真起后端编译产物（`server/dist/server/src/main.js`、IKAN_PORT=8797、
freelist 坏副本库、bootstrap wenjuan），curl 实弹先核 `/api/settings/health`（**POST**，GET
会吃「只接 POST」拒绝——R94 复验踩过的坑；ok:false + problems 人话）再拍桌面；桌面
`IKAN_MODE=remote + IKAN_REMOTE_URL + IKAN_AUTH_FILE`（全新文件），注入 JS 真登录
（`window.api.mode.login`）→ 工作台需点「重新加载」（登录前取数 401 的坑，工作台与设置页
两处都要过）。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| remote-dashboard-banner.png | 远端模式工作台（登录态见第二张图）：顶部健康红条（查的是**服务器那份坏库**——problems 首条经 HTTP），统计/待办照常渲染（freelist 级损坏 COUNT 全活） | R89 三条源码锁的远端消费面；problems 来源与 R84/R86 数据层断言同源 |
| remote-settings-anchored.png | 远端第二跳：`#/settings?scroll=backup` 直滚生效（数据备份卡在视口内——HTTP 慢通道下 [s, source] 闸等到数据到位才滚）+ 实点「数据自检」后的红框详情同屏（problems 两条含 R86「好消息」指引条 + 自检原文技术行 + 12 表 chips）+ 服务器备份卡形态与「服务器最近一次成功备份：1 分钟前」+ 服务器 auto 备份包可见（R86 服务器侧隐形修复包的实拍交叉印证） | R91 两条锚点源码锁的远端消费面；R92 竞态修复在 HTTP 慢通道下的行为验证 |

## 没有独立画面的行为

- 登录时序的坑记档：登录前工作台/设置页取数 401 → 「没加载出来/登录已失效」，登录后必须
  点「重新加载」——两处注入 JS 都处理了（截图能拍出来说明全链路通了）。
- 服务器对坏库的 auto 备份包（图里 `ikanbot-20261114100142-auto.zip`）：VACUUM INTO 快照
  重建的干净库——R86 行为锁的远端实拍交叉印证。
