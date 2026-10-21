/**
 * UI 优化 · 恢复收尾工作流
 *
 * 环境重载导致上一轮循环中断（ui-dev-r4 被停）。现场：
 *  - r1 ✅✅ / r2 ✅(审查) 研发(超时无报告, 代码大半落地) / r3 审查(超时无报告, 30+截图已拍) 研发✅ / r4 审查(超时无报告, 15截图已拍) 研发(被停)
 *  - 当前代码健康：typecheck 0 错、395 项断言全过、单据列数锁 4 条在
 *
 * 从两次超时学到的关键改进（本脚本贯彻）：
 *  1. **审查官不要重拍截图** —— r3-*.png(30+) 与 r4-*.png(15) 都已存在，直接读图写报告，省 80% 时间
 *  2. **边做边写** —— 每完成一个页面/问题立刻写进报告草稿，不攒到最后
 */

const root = 'D:/code/IKanBot'
const fb = `${root}/docs/feedback`

// ================= ① 补写 r3 审查报告（复审 r3 研发实现）=================
try {
  const r = await runs.run('ui-review-r3r', {
    agent: 'ui-reviewer',
    cwd: root,
    timeoutMs: 1500000,
    task: `【UI 优化 · 第 3 轮审查 · 补写报告】

你上两次审查都因为超时没写完报告。**这次不要重拍截图** —— 截图早就拍好了，直接用。

**已有的截图（直接读，不用重拍）**：
- r3-*.png：r3-probe-dash / probe-orders / probe-quotations / probe-samples / probe-samples2 / probe-products /
  probe-customers / probe-reports / probe-detail / probe-mo2 / probe-controls / probe-list-orders /
  probe-img / probe-img2 / tab-items / tab-payment / tab-packing / tab-history / tab-photos /
  doc-pi / doc-pl / doc-ci / doc-quotation / modal-*（约 30 张）
- r4-*.png：r4-order-detail / tab-items / tab-payment / tab-packing / tab-history / tab-photos /
  modal-product / modal-sample / modal-pi / modal-pl / doc-pi / doc-pl / doc-ci / doc-quotation / empty-filter（15 张）
  **r4-* 反映的是 r3 研发完成后的状态**，正好可用来复审 r3 的实现。

**要做的（照你原来的报告格式）**：
1. **复审 r3 研发实现**：读 docs/feedback/2026-10-21-ui-r3-yanfa.md（研发的实现报告），
   对照 r4-*.png 逐条核对：它说做了的，真的做了吗？没改坏别的页面吗？
2. **全量审一遍**：11 页 + 6 弹窗 + 4 打印单据（用上面现成的截图）。
3. **挑出这一轮最该做的 3~5 件**，写成施工图（CSS 变量名 + 具体值 + 具体位置）。

**已知状态，不用再查**：
- S1（单据列错位）：协调员已修复并加 6 条列数断言锁死，标记「已解决（协调员修复）」，**不要动 documents.ts**。
- 代码健康：typecheck 0 错、395 项断言全过。

**格式**：一、总体印象 / 二、系统性问题（跨页面，每条含 现象+量化依据+为什么是问题+改法）/ 三、单页问题 / 四、优先级表 / 五、本轮建议研发做哪 3~5 件。

**时间纪律（重要）**：
- **最多 20 分钟**。截图全部现成，你的活是「读图 + 分析 + 写报告」。
- **边看边写**：每审完一个页面就往报告里写一段，不要全部看完再动笔。写到哪算哪，写完就交。
- 宁可少审两个页面，也要把报告写出来——**没有报告，这轮等于没做**。

报告写到 docs/feedback/2026-10-21-ui-r3-review.md。`
  })
  console.log('ui-review-r3r:', r.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-review-r3r 异常:', e && e.message)
}

// ================= ② r4 研发收官 =================
try {
  const d = await runs.run('ui-dev-r4r', {
    agent: 'yanfa',
    cwd: root,
    timeoutMs: 2400000,
    task: `【UI 优化 · 第 4 轮（收官）· 研发实现】

先读 docs/feedback/2026-10-21-ui-r3-review.md，把「五、这一轮我建议研发做哪 3~5 件」全部做完。
（如果该文件不存在——审查官可能又超时了——就按上次任务书里的清单做：S2 横滚彻底消除、S5 订单详情右半屏空白、
S6 报表空值写法统一、S7 设置页语义宽度、P1 待办圆点加文字、P2 USD 0.00 与真 0 区分、P3 报价状态改只读 tag、
P4 打样最右 4 链接挤压、P5 空状态三分、P6 PI 预览照片断图标。做完的别重复做。）

**纪律**：
- 只动 styles.css + pages/*.tsx + ui.tsx
- **硬红线：documents.ts / services / money.ts 一个字符不许改**（395 断言盯着，含 4 条单据列数锁）
- 截图用 bash scripts/shot.sh，**绝不裸跑 electron**（会挂死会话）
- **边做边写**：每完成一条立刻记进报告草稿，不要攒到最后（你已经超时过两次，报告没写等于白干）
- 收尾：typecheck 0 错 + test:e2e 395 项全过

报告写到 docs/feedback/2026-10-21-ui-r4-yanfa.md：逐条状态表、改动文件、CSS 变量清单、
每条改动的前后对比截图路径、验证数字、没做的+原因。

**时间纪律：最多 35 分钟。宁可做 3 条做透并写完报告，也不要 6 条做一半没有报告。**`
  })
  console.log('ui-dev-r4r:', d.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-dev-r4r 异常:', e && e.message)
}

// ================= ③ r4 收官审查 + 达标盘点 =================
try {
  const r = await runs.run('ui-review-r4r', {
    agent: 'ui-reviewer',
    cwd: root,
    timeoutMs: 1500000,
    task: `【UI 优化 · 第 4 轮（收官）· 审查 + UI 状态盘点】

1. **复审第 4 轮实现**：读 docs/feedback/2026-10-21-ui-r4-yanfa.md，重新截图（bash scripts/shot.sh）逐条核。
2. **全量重审**：11 页 + 6 弹窗 + 4 打印单据。
3. **本轮是收官轮**，报告末尾必须附一节「**UI 状态盘点**」：
   把 docs/ui/design-system.md 里的每一条规范（spacing / 字号 / 色彩 / 圆角阴影 / 各类组件）列出来，
   标 **已达标 / 部分达标 / 未达标**，作为项目 UI 治理的存档基线。
4. **总评**：这 4 轮 UI 优化到底解决了什么、还剩什么、值不值得继续。

格式沿用前几轮。报告写到 docs/feedback/2026-10-21-ui-r4-review.md。

**时间纪律：最多 20 分钟。这轮的重点是「盘点」不是「找新问题」——盘点表 + 总评写完就交，不要为找问题而拖到超时。**
边看边写。`
  })
  console.log('ui-review-r4r:', r.ok ? 'ok' : 'failed')
} catch (e) {
  console.log('ui-review-r4r 异常:', e && e.message)
}

return { done: true, note: 'UI 收尾：r3 报告补写 + r4 研发收官 + r4 收官盘点' }
