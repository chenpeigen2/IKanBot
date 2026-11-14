# R85 截图矩阵（2026-11-14）—— 数据自检的远端路实弹（R83 复验挂账「远端 UI 改动一并拍」清偿）

本轮**桌面 UI 零改动**；变的是两处证据面：① server e2e 给 `POST /api/settings/health`
补功能断言（R83 复验只锁了路由数 110，「设置自检 1」——ok/quickCheck/version/tables/
problems 全没锁）；② 远端模式 UI 实拍两态（R84 改的 problems 红框在远端路的呈现，
R83 复验挂账 #1「下轮若有远端 UI 改动一并拍」——R84 恰好改了这块 UI）。

远端实拍拍法（R61 同款）：真起后端编译产物（`server/dist/server/src/main.js`，
`IKAN_PORT=8794/8795`、独立库目录、bootstrap 用户 wenjuan），桌面
`IKAN_MODE=remote + IKAN_REMOTE_URL + IKAN_AUTH_FILE`（全新 auth 文件保证登录卡从
未登录开始）注入 JS 真登录 → 点「重新加载」→ 实点「数据自检」；拍完临时库与 auth
文件全删。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| settings-health-remote-green.png | 远端模式（已登录：周文娟）数据自检绿框——查的是**服务器那份库**：12 表行数**全是 0**（服务器空库；本机 data/ikanbot.db 同屏可证 orders=4——「谁的数据显示谁的健康」的远端半句实锤）；远端备份卡形态（备份在服务器上打、按钮只有本机三个的远端版） | HTTP 冒烟「POST /api/settings/health 200：ok/quick_check ok/版本/12 表全带」；远端备份卡形态由 R61 双模式断言背书 |
| settings-health-remote-red.png | 服务器库换成 freelist 坏副本（header 32–35 = 00 ff ff ff）后同一路实点：problems 人话（数据库文件自检没通过（库可能损坏）——请先不要录单…）+「自检原文（给技术支持看）：Freelist: invalid page number 16777215…」技术行 + 12 表行数 chips，**经 HTTP 通道原样渲染** | HTTP 冒烟「problems 过远端通道（健康库是空数组不是 undefined）」——红态呈现证明丢了 problems 远端红框就退回一句英文这条威胁是真的被锁住 |

## 没有独立画面的行为

- **定向红验证**（本轮新增断言的红）：server controller 临时剥掉 problems 字段重跑
  HTTP 冒烟 → 「problems 过远端通道」✗ 红、exit 1——还原后 226 全绿。剥字段剧情正是
  未来「响应包装层无声丢字段」的替身。
- e2e / 双模式 / 数据层数字不变（2549 / 146 / 82）——本轮零桌面代码、零 core 代码改动，
  变的只是 server 测试与文档。
