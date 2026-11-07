# R60 截图矩阵（2026-11-07）—— Modal portal 化

本轮界面变更只有一处：`Modal` 从「渲染在页面树里」改为 `createPortal` 挂到 `document.body`。
受影响的面 = **所有弹窗**，因此每个弹窗形态各拍一张证明无回归；
核心证据是复现 R59 报的那个 bug 场景（订单详情收款页签的「登记短款核销」弹窗）。

根因（修复前确认过）：`.main .content` 带 `page-in` 动画且 `fill-mode: both`，
动画的 transform 关键帧让 Chromium 把 `.content` 当成 `position:fixed` 后代的包含块，
遮罩的 `inset:0` 变成相对内容区——长页面上弹窗不在视口居中、顶部被 sticky 页头压住
（修复前实拍见 [docs/ui/r59/settle-modal.png](../r59/settle-modal.png)：弹窗缩在右下角，
页面顶部根本没有被遮罩盖住）。portal 到 body 后祖先链上没有任何 transform/动画，
三种形态（默认/宽/超宽）一起修好。

数据底座：`npm run seed`（订单 1~4）+ `scripts/ui-shots-status.cjs`（补造订单 5~8：草稿/部分收款/已失效/已作废）。

| 文件 | 这是什么状态 | 断言说明 |
| --- | --- | --- |
| settle-modal.png | **本轮要修的场景**：长页面（订单详情 → 收款记录页签）打开「登记短款核销」弹窗——弹窗在视口正中，遮罩盖住整屏（含 sticky 页头）。与 r59 同场景对比：修复前弹窗缩在内容区右下、顶部没盖住 | 弹窗居中无专门 e2e 断言：渲染层断言没有现成接缝（e2e 是数据层、双模式测试走 IPC 桩，都不渲染 DOM）。证据为实拍对照 + 根因分析（styles.css `.main .content` 的 page-in 动画与 `position:fixed` 包含块规则）；「核销与坏账」行为本身仍由 e2e「核销与坏账：短款让利、坏账、追回、撤销与全站口径」section 锁着，本轮未动 |
| void-modal.png | 宽弹窗（wide 语义在详情页）：草稿单「⋯ → 作废此单」确认弹窗，同样整屏遮罩、视口居中 | 「N28：有款的单不能物理删除，只能作废」；本轮未动其行为 |
| pi-preview.png | 超宽弹窗（xwide）：PI 预览（A4 纸面 + 页脚按钮），portal 后照常铺满可用高度、纸面渲染不变 | 「单据渲染」「CI 与 PI 金额一致」；本轮未动 documents.ts |
| order-new.png | 默认宽度弹窗：订单列表「+ 新建订单」表单弹窗 | 「订单与状态流转」（汇率手填）；本轮未动 |
| quotation-preview.png | 超宽弹窗（xwide）：报价单预览，Rev.1 版次照常印在纸面 | 「单据渲染」「R5 报价单抬头快照」；本轮未动 |

补一句边界：`position:fixed` 的另外两处都不受此 bug 影响、也未改动——
`.menu-pop.fixed`（表格行内菜单）本来就是 portal 到 body 的；`.toast-wrap` 挂在 `ToastProvider`
（`App.tsx` 根部，不在 `.content` 里）。
