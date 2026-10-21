/**
 * IKanBot · UI 优化 4 轮
 *
 * UI 审查官（ui-reviewer）↔ 研发（yanfa）交替迭代。
 * 第 1 轮审查官除出报告外，还要产出设计规范 docs/ui/design-system.md（研发照着改）。
 * 每轮：审查（含复审）→ 研发实现。
 */

const root = 'D:/code/IKanBot'
const fb = `${root}/docs/feedback`
const START = 1
const ROUNDS = 4

const rounds = []

for (let n = START; n < START + ROUNDS; n++) {
  const prevReport = n === 1 ? '' : `${fb}/2026-10-21-ui-r${n - 1}-review.md`
  const prevImpl = n === 1 ? '' : `${fb}/2026-10-21-ui-r${n - 1}-yanfa.md`

  // ================= UI 审查官：审查 / 复审 =================
  let rv
  try {
    rv = await runs.run(`ui-review-r${n}`, {
      agent: 'ui-reviewer',
      cwd: root,
      timeoutMs: 1800000,
      task: `【UI 优化 · 第 ${n} 轮 · 审查${n > 1 ? '与复审' : ''}】

${n === 1 ? `这是第一轮。你要做两件事：

**A. 产出设计规范 \`docs/ui/design-system.md\`**（这是本轮最重要的产出，研发会照着改）：
   - spacing scale（4 的倍数体系，每个值写清用途）
   - 字号层级（正文/次要/标签/大数字/小字 + 行高）
   - 色彩 token（语义命名 + 色值，含状态色）
   - 圆角 / 阴影 / 边框 token
   - 组件规范：按钮、输入框、表格、卡片、tag、弹窗、空状态、toast
   设计规范要能直接当施工图用，别写成"应该更统一"这种废话。

**B. 写审查报告**（见下方格式）。` : `这是第 ${n} 轮。

1. **先复审上一轮**（读 ${prevReport} 和 ${prevImpl}）：研发声称改的，逐条对照**重新截图**确认真的改了、没改坏别的页面。
   - 改好了 → 标"已解决"并给证据截图
   - 没改 / 改歪 / 改坏别处 → 标"未解决"并说明差在哪（附新旧对比图）
2. **再审一遍全部页面**（不要只盯着上一轮那几条）。上一轮的问题被改掉后，常常暴露出新的不一致——你的职责是抓出来。
3. 挑出**这一轮最该做的 3~5 件**（按收益/成本排），写成明确的施工图（给 CSS 变量名、给具体值、给具体位置）。`}

**必看的页面**（一个都不能漏，截图看）：
/ 、/orders、/orders/1（5 个页签：商品明细/收款记录/装箱单/操作历史/验货装柜照，用 IKAN_SHOT_JS 点页签）、/quotations、/samples、/products、/customers、/reports、/settings，以及各类弹窗和打印单据（pi.html / pl.html / ci.html / quotation.html）。

**截图方法**：
bash scripts/shot.sh <路由> <文件名>            # 60s 超时 + 自动清理
bash scripts/shot.sh /orders/1 x '(()=>{const t=[...document.querySelectorAll(".tab")].find(x=>x.textContent.includes("收款记录")); if(t) t.click()})()'
看图用 read 工具读 out/shots/*.png。

**必须读样式表** \`src/renderer/src/styles.css\`（约 1200 行）做横向比对：间距刻度、字号层级、色彩 token、圆角阴影、状态标签。

**报告写到** ${fb}/2026-10-21-ui-r${n}-review.md，格式：
一、总体印象 / 二、系统性问题（跨页面，每条含 现象+量化依据+为什么是问题+改法）/ 三、单页问题（同结构）/ 四、优先级表 / 五、这一轮建议研发做哪 3~5 件。

**纪律**：每条必须指到具体位置（文件+行号或类名）+ 量化依据；一次只提 5~8 条最重要的；不许建议动效/渐变/加阴影；不许建议改业务逻辑。
**时间 30 分钟**：做不完就写"审到哪些页、剩什么"，报告写完就算完成。`
    })
    console.log(`ui-r${n} 审查:`, rv.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`ui-r${n} 审查异常:`, e && e.message)
    rv = { ok: false, output: '' }
  }

  // ================= 研发：实现 =================
  let dv
  try {
    dv = await runs.run(`ui-dev-r${n}`, {
      agent: 'yanfa',
      cwd: root,
      timeoutMs: 2400000,
      task: `【UI 优化 · 第 ${n} 轮 · 研发实现】

先读 UI 审查官的报告：${fb}/2026-10-21-ui-r${n}-review.md
${n === 1 ? '另外先读设计规范：docs/ui/design-system.md —— 照着它改，这是本轮改动的主线。' : `另外读上一轮的实施报告：${prevImpl}，确认上一轮改了什么、哪些还没做完。`}

**这一轮做什么**：审查官在报告「五、这一轮我建议研发做哪 3~5 件」里点名的，**全部做完**。做不完的写进报告的"没做的"。

**工作方式**：
- 优先**先落 token 再改组件**：把设计规范里的 spacing / 字号 / 色彩 / 圆角 / 阴影写成 \`styles.css\` 顶部的 CSS 变量，
  再把散落的硬编码值（现在的 #7c3aed、#0891b2、各处 6/8/9/10/12/14/15px）替换成 var(--xxx)。
  **这一步做完，后面的组件改动就是"引用规范"而不是"重新设计"。**
- 改动集中在 \`src/renderer/src/styles.css\` 和 \`src/renderer/src/pages/*.tsx\`，
  **不要动业务逻辑**（services / money.ts / documents.ts 的计算一律不许碰）。
- 一条一条改，改一条截一张图对比（用 bash scripts/shot.sh，**绝对不要裸跑 electron**，会挂死会话）。
- 改完跑 \`npm run typecheck\`（零错误）+ \`npm run test:e2e\`（当前基线 379 项全过，**不许红**）。
  UI 改动如果影响不了测试，那是正常的，但你要说明为什么。
- 最后自己**逐页重新截图**确认没改坏别的页面（审查官下轮会复审，你不想被退回来）。

**报告写到** ${fb}/2026-10-21-ui-r${n}-yanfa.md：
- 逐条回应审查官的清单（已做/未做+原因）
- 新增或修改的 CSS 变量清单（名字 + 值 + 用途）
- 改了哪些文件、哪些页面
- 改前改后对比截图路径（**每条改动都要有图**）
- typecheck / test:e2e 结果
- 明确列出"没做的"和原因

**时间 40 分钟。** 宁可这轮只做完 3 条做透，也不要 8 条都做一半——审查官复审时看得出来的。`
    })
    console.log(`ui-r${n} 研发:`, dv.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`ui-r${n} 研发异常:`, e && e.message)
    dv = { ok: false, output: '' }
  }

  rounds.push({
    round: n,
    reviewOk: rv.ok,
    devOk: dv.ok
  })
}

const summary = [
  `# UI 优化 4 轮小结`,
  '',
  '| 轮次 | UI 审查 | 研发实现 |',
  '|---|---|---|',
  ...rounds.map((r) => `| r${r.round} | ${r.reviewOk ? '完成' : '失败'} | ${r.devOk ? '完成' : '失败'} |`),
  '',
  '报告见 docs/feedback/，设计规范见 docs/ui/design-system.md。'
].join('\n')

return { rounds: rounds.length, roundsDetail: rounds, summary }
