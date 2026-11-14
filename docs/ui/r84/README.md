# R84 截图矩阵（2026-11-14）—— 数据自检红框人话化（R83 复验挂账清偿）

本轮界面变更一处：**自检红框从「一句话 + 英文原文」升级为「人话问题清单先行 +
quick_check 原文技术行」**；catch toast 补「请先不要录单」（与红框同话术）。绿框不变。

坏库副本拍法（真库 `data/ikanbot.db` 没碰）：`data/ikanbot.db` 拷副本，改 header 第
32–35 字节（freelist 首干页指针指到不存在的页 0x00ffffff），放独立目录，`IKAN_DATA_DIR`
重定向过去再点「数据自检」。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| settings-data-health-green.png | 自检通过绿框（problems 为空，hint 行照旧：quick_check ok · v25 + 12 表行数 chips） | e2e R83 段「自检三道闸全过」「自检带 12 表行数」+ R84「健康库 problems 为空（字段必须存在——旧核心没有 problems 会红）」 |
| settings-data-health-red-problems.png | freelist 损坏副本实拍：红框 = 首行「数据自检没通过——请先不要录单…」+ problems 人话（数据库文件自检没通过（库可能损坏）——请先不要录单，立即联系技术支持。）+「自检原文（给技术支持看）：Freelist: invalid page number…」技术行 + 12 表行数 chips（COUNT 全活） | R84「红框渲染 problems 清单（人话怎么办先行；quickCheck 原文单独技术细节行给技术支持）」；problems 数据路由「版本超前 → problems 给人话」同函数同通道锁 |

## 没有独立画面的行为

- **catch toast 话术**（health 通道整体跑不起来时才走，如远端错误/磁盘错）：本机两种坏库
  配方（freelist 指针坏、页内容清零）实测 quick_check 都返回错误行、12 表 COUNT 全活，
  **都走红框不进 catch**——toast 态无本机配方可复现，话术由源码断言锁（正则
  `没跑出来：${…}——请先不要录单`，红验证见研发报告：旧源码目标串计数为 0）。
- **版本超前的红框**：user_version > 25 的库程序启动时开不了库（migrate 抛错，防呆设计
  本来如此），按钮到不了——problems 人话（「把程序升级到最新版」）由数据层断言实跑锁
  （裸驱动临时库 v999 → settingsCore，真红验证时旧核心在同场景直接未捕获崩溃）。
