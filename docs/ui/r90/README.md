# R90 截图矩阵（2026-11-14）—— 健康红条两分支共用 + 审计收编小账

本轮界面变更一处：**健康红条提为两分支共用**——R89 复验挑的洞：深损坏把 stats 全挂时
工作台走「没加载出来 + 重新加载」的早退分支，那个分支没有红条 JSX，最需要「请先不要录单」
的最坏场景反而没这句话。R90 把红条抽成 `healthBanner` 共用件，两个分支都渲染。
另有 server 口径一行的类型补齐（settings.service 返回值补 problems 字段声明）与
审计两件收尾（见下）。

深损坏副本拍法（与 r84 freelist 配方不同的**数据页**配方）：真库拷副本 →
`SELECT rootpage FROM sqlite_master WHERE name='orders'` 定位 orders 根页 → 该页整页清零
（页号从 1 起、偏移 (root−1)×4096——首版差一清错了隔壁页，quick_check 报的是 Tree 8）→
migrate 能过（表都在、版本对）、stats 的金额查询必炸（database disk image is malformed）。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| dashboard-health-deep-error.png | **最坏场景**：orders 表页毁 → 工作台 stats 全挂（「工作台没加载出来 / database disk image is malformed / 重新加载」早退分支）+ 页面顶部健康红条照挂（「先别录单」+ problems 首条 + 跳转链接）——R89 前这个场景只有 LoadError 没有红条 | e2e「R90 补锁」healthBanner 三处出现（定义 + 早退分支 + 主分支）；红条文案与 problems 来源同 R89 锁 |

## 没有独立画面的行为

- **审计公共模块抽取**（R88 复验-2 小账）：controllerRoutes/stripComments 唯一真源收进
  `scripts/lib/audit-shared.cjs`，audit:http 与 audit:ipc 共用——终态不变
  （108/108、132/132·100，实跑 exit 0）。
- **硬闸 B0**（R88 复验-2 小账）：REMOTE_ROUTES 条目数与路径提取数必须相等（B2 正则要求
  path 在入口首字段，字段重排的条目会静默掉出口径）——篡改红验证：customers:list 的
  args 提到 path 前 → `硬闸 B0：REMOTE_ROUTES 条目 100 与路径提取 99 不等` exit 1，还原
  exit 0（留档 out/audit-ipc-red-b0.log）。
- **settings.service.ts 返回类型补 problems 声明**（R89 复验小账：TS 口径，运行时一直带着）。
- **深损坏首版副本（缺 10 表 + freelist 坏）会把应用启动挂死**——migrate 建 10 张表要写页、
  撞坏 freelist。真机这类「缺表」本来会被 migrate 修回来，所以深损坏红条的场景是「页内容
  坏」不是「缺表」——挂死实验的教训记在这里，别再拿缺表副本开真机。
