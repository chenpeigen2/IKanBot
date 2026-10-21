/**
 * UI 优化循环 · 重启版（接续 429 中断）
 *
 * 完成情况：
 *  - r1：审查+实现 ✅（design-system.md + token 层落地）
 *  - r2：审查 ✅（S1~S8 + P1~P6）；研发被 429 打断，但代码已大半落地（S8 图标/S3 操作列等已做），**缺 r2 实现报告**
 *  - S1（审查官误报的单据列错位）：协调员核实为误报，但期间研发中断时误改 colspan 5→6 造成真错位，
 *    协调员已修回并加了 6 条列数对齐断言锁死（385 项全过）
 *  - r3、r4：429 空转，未执行
 *
 * 本脚本完成：① 补完 r2 研发收尾（写实现报告）② r3 审查+实现 ③ r4 审查+实现
 */

const root = 'D:/code/IKanBot'
const fb = `${root}/docs/feedback`

const rounds = []

// ================= 第 1 步：r2 研发收尾 =================
try {
  const d = await runs.run('ui-dev-r2redo', {
    agent: 'yanfa',
    cwd: root,
    timeoutMs: 2400000,
    task: `【UI 优化 · 第 2 轮 · 研发收尾（你上一次被 429 打断，缺一份实现报告）】

背景：你上一轮做 ui-r2 实现时被限额中断。**代码大概率已大半落地**（我看到 App.tsx 的 NAV 图标已换成
NavIconName/SVG、styles.css 有「列表页操作列」区块）——你的工作是**先盘点、再补完、然后写报告**。

先读：
1. 审查报告：docs/feedback/2026-10-21-ui-r2-review.md（S1~S8 + P1~P6 的施工图）
2. 设计规范：docs/ui/design-system.md

**关于 S1（打印单据列错位）—— 协调员已处理，你不用碰：**
- 审查官的 S1 报告前后矛盾过（先说表头没对齐、后来给像素扫描）。我实测渲染四张单据逐列数过：
  **审查当时是对的（9/10 错位），但你中断前把 colspan 改成了 6 也错**，我已修回 5，
  现在四张单据表头与合计行全部对齐（pi 9/9、quotation 9/9、ci 8/8、pl 10/10）。
- **我还在 scripts/e2e-test.ts 加了 6 条列数对齐断言**（现在 385 项全过）。
- **硬红线：不许再碰 src/shared/documents.ts 的任何 colspan/列数/表头结构**。改了测试会红，我不认。

**你要做的：**
1. 盘点审查报告里 S2~S8 + P1~P6 每一条，逐条确认「已做/部分做/没做」（对照代码+截图，别猜）。
2. 没做完的**做完**（预期还有部分残余：比如表格横滚的 padding 收敛是否两页都生效、报表黄条、
   设置页语义宽度、空状态三分、PI 预览照片断图标等——以你盘点为准）。
3. 每条改动配前后对比截图（bash scripts/shot.sh，**绝不裸跑 electron**）。
4. typecheck 0 错 + npm run test:e2e **385 项全过**（新增了 6 条列数锁，别红）。
5. 写报告 docs/feedback/2026-10-21-ui-r2-yanfa.md：逐条 S2~S8/P1~P6 状态表、改动文件、
   截图路径、验证数字、没做的+原因。**注明：S1 列错位由协调员修复并加断言锁死（你中断期间的改动已回退）。**

**时间 40 分钟**，先盘点（10 分钟）再动手，报告必须写完。`
  })
  console.log('ui-dev-r2redo:', d.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-dev-r2redo 异常:', e && e.message)
}

// ================= 第 2 步：r3 审查 + 实现 =================
try {
  const r = await runs.run('ui-review-r3', {
    agent: 'ui-reviewer',
    cwd: root,
    timeoutMs: 1800000,
    task: `【UI 优化 · 第 3 轮 · 审查与复审】

1. **先复审第 2 轮实现**：读 docs/feedback/2026-10-21-ui-r2-review.md（你的上轮报告）
   和 docs/feedback/2026-10-21-ui-r2-yanfa.md（研发的实现报告）。
   逐条对照重新截图确认真改了、没改坏别的页面。

   **关于你的 S1（单据列错位）要先知道的**：协调员（我）已介入处理——期间研发被限额中断时
   误把 colspan 改成 6，我修回 5，现在四张单据表头/合计行全部对齐，并加了 6 条断言锁死。
   这条标记「已解决（协调员修复）」，不要重复报，也不要再去动 documents.ts。

2. **再全量重审**：11 个页面 + 6 个弹窗 + 4 张打印单据全部重截。
   上一轮问题被改掉后常暴露新不一致——这是你的核心价值。
3. 挑出**这一轮最该做的 3~5 件**，写成施工图（CSS 变量名 + 具体值 + 具体位置）。
   格式照你前两轮的（一、总体印象 / 二、系统性问题 / 三、单页问题 / 四、优先级 / 五、本轮做哪几件）。

**纪律**：每条指到文件+行号或类名 + 量化依据；不许建议动效/渐变/加阴影；不许改业务逻辑；
不许提 documents.ts / services / money.ts（硬红线）。
截图：bash scripts/shot.sh <路由> <文件名>，看图用 read 读 out/shots/*.png。
报告写到 docs/feedback/2026-10-21-ui-r3-review.md。**时间 30 分钟。**`
  })
  console.log('ui-review-r3:', r.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-review-r3 异常:', e && e.message)
}

try {
  const d = await runs.run('ui-dev-r3', {
    agent: 'yanfa',
    cwd: root,
    timeoutMs: 2400000,
    task: `【UI 优化 · 第 3 轮 · 研发实现】

先读 docs/feedback/2026-10-21-ui-r3-review.md，把「五、这一轮我建议研发做哪 3~5 件」全部做完。

纪律（与前几轮相同，重复一遍是因为你有过违规前科）：
- 只动 styles.css 和 pages/*.tsx；**硬红线：documents.ts / services / money.ts 一个字符都不许改**
  （我加了 385 条断言，包括 6 条单据列数锁，改了必红）。
- 改一条截一张对比图（bash scripts/shot.sh，绝不裸跑 electron）。
- typecheck 0 错 + test:e2e 385 项全过。
- 报告 docs/feedback/2026-10-21-ui-r3-yanfa.md：逐条状态 + CSS 变量清单 + 截图路径 + 验证数字 + 没做的。

**时间 40 分钟。** 宁少做透，报告必须写完。`
  })
  console.log('ui-dev-r3:', d.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-dev-r3 异常:', e && e.message)
}

// ================= 第 3 步：r4 审查 + 实现（收官轮）=================
try {
  const r = await runs.run('ui-review-r4', {
    agent: 'ui-reviewer',
    cwd: root,
    timeoutMs: 1800000,
    task: `【UI 优化 · 第 4 轮（收官）· 审查与复审】

1. 复审第 3 轮实现（读 docs/feedback/2026-10-21-ui-r3-review.md + ui-r3-yanfa.md），重新截图逐条核。
2. 全量重审 11 页 + 6 弹窗 + 4 打印单据。
3. **本轮是收官轮**：
   - 挑出**最后 3~5 件**（收益/成本最高的，能做完的）
   - 在报告末尾附一节「**UI 状态盘点**」：design-system.md 里的每条规范，
     当前界面是「已达标 / 部分 / 未达标」，作为项目 UI 治理的存档基线
4. 格式照前几轮。截图用 bash scripts/shot.sh。报告写 docs/feedback/2026-10-21-ui-r4-review.md。
   **时间 30 分钟。**`
  })
  console.log('ui-review-r4:', r.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-review-r4 异常:', e && e.message)
}

try {
  const d = await runs.run('ui-dev-r4', {
    agent: 'yanfa',
    cwd: root,
    timeoutMs: 2400000,
    task: `【UI 优化 · 第 4 轮（收官）· 研发实现】

先读 docs/feedback/2026-10-21-ui-r4-review.md，把「五、这一轮」清单全部做完。

纪律同前：只动 styles.css 和 pages/*.tsx；**documents.ts / services / money.ts 硬红线不许碰**；
每条改动配前后对比截图；typecheck 0 错 + test:e2e 385 项全过；裸跑 electron 会挂死会话（只用 scripts/shot.sh）。

报告 docs/feedback/2026-10-21-ui-r4-yanfa.md：逐条状态、改动文件、截图、验证数字、没做的+原因。

**时间 40 分钟，这是最后一轮，报告写完就是胜利。**`
  })
  console.log('ui-dev-r4:', d.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-dev-r4 异常:', e && e.message)
}

return { done: true, message: 'UI 优化重启循环完成（r2收尾 + r3 + r4）' }
