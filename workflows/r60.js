/**
 * IKanBot 双 agent 迭代 · R60
 *
 * 小修：核销弹窗不居中、作废单按钮隐藏、seed/sweep 两条工具账、Linux rpm。
 * 大件：docs: 单据存档簇搬后端（M2 鉴权已就位，按计划与鉴权一起做）。
 * 收尾：复验通过后发小版本（AGENTS.md 规则二，由主管执行）。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r60-yanfa.md'
const verifyReport = fb + '/2026-11-07-r60-verify.md'

// ---------- 阶段一：研发实现 ----------
const dev = await runs.run('r60-dev', {
  label: '研发实现 R60：四件小修 + docs 单据存档簇搬后端',
  agent: 'yanfa',
  cwd: root,
  timeoutMs: 5400000,
  task: `你是 IKanBot 的研发。今天 2026-11-07，第 R60 轮。工作目录 ${root}（macOS）。
当前 HEAD 6868223（v0.5.1 已发布），四套测试全绿（e2e 2298 / 双模式 116 / 数据层 69 / HTTP 169）。
先读 AGENTS.md（本轮有两条规则和你直接相关：界面更新带截图证据、收尾发版由主管做），
再读 R59 的两份报告（docs/feedback/2026-11-07-r59-*.md）——本轮的活一半是从那里面来的。

【四件小修（先做，逐条独立小提交）】
1. **核销弹窗不居中**：长页面（订单详情收款页签）打开「登记短款核销」弹窗不在视口居中、
   顶部被 sticky 页头盖住（证据 docs/ui/r59/settle-modal.png）。疑似 .main .content 的 page-in
   动画 fill-mode: both 保留 transform，把 position:fixed 遮罩变成相对内容定位（Chromium
   containing-block 行为）。修法倾向 Modal 改 createPortal 到 body；动手前先确认根因，
   别只对这一个弹窗打补丁——所有 Modal 一起受益才算修好。这是界面变更：按 AGENTS.md 规则，
   修后截图进 docs/ui/r60/（同名场景重拍 settle-modal），并逐张配断言说明。
2. **作废/失效单详情页隐藏「生成 PI」「商业发票 CI」按钮**（r59 截图观察项）：
   拦截在存档那一步、能看不能存是设计使然，但按钮可见易误导。作废/失效态直接不渲染。
   同样按规则补截图证据。TDD：e2e 先写「作废单不出现这两个按钮」的失败断言（渲染层断言
   没有现成接缝就说明并选最近的缝），再改。
3. **seed 不重置计数器**：npm run seed 重建后 sqlite_sequence 不清，单号从中间开始
   （waizhuan 实测本次从 21 起）。修成真正的「重建演示数据」。配套修 sweep 工具账：
   sweep.sh 钉死窗口尺寸（比如 1600x1000，IKAN_SHOT 跑时显式设），基线重测重钉进
   docs/backend-plan.md 记账——waizhuan 报告里写了基线在她机器上漂 3 行的原因。
4. **Linux rpm 发布失败**：v0.5.1 的 Linux job 在「上传到 Release」挂了，deb/AppImage
   都传上了、rpm 和 latest-linux.yml 缺。用 .github/workflows 里以前那个 debug-e2e.yml 的
   手法（git 历史里有）起一次性诊断工作流抓 rpm 构建日志，修好后删掉诊断工作流。
   如果 rpm 短期修不动，发版时从 linux target 里去掉 rpm（deb/AppImage 够用）并把决策
   写进记账——不要让一个 rpm 每次发版都挂一个 job。

【大件：docs: 单据存档簇搬后端】
docs/backend-plan.md 的既定排序：打印与单据渲染（docs:）按 M2 的鉴权一起做——现在鉴权
第一片已落地（R59：token + 登录卡），条件成熟了。本轮把这簇通道搬完（以 electron/ipc/
index.ts 里 docs: 前缀的实际通道为准，先 grep 列清单，估计 saveDocFile / listDocVersions /
resolveDocPath/openFile / 删除等若干条）：
- PDF 字节走 HTTP 上传/下载（服务端落 docsDir 目录，沿用「版本只增不减」语义）；
  R42 的路径安全语义（resolveDocPath 的盘符接回/拒 opened）服务端同样要守
- images:baseDir 走 sendSync 旁路没进 REMOTE_ROUTES 是 R46 挂账，一并收编
- mode 测试锁双模式：同一份单据在两个模式下存档/列表/打开逐字节一致；远端模式无 token 被拒
- 远端模式下「存档读数不拖垮整页」的 R57 拆腿不许退化
- 覆盖率从 90/119 往上涨，设置页与记账同步
- 时间账红线：docs 版本时间戳的 UTC/本地日界问题（R46 挂账 #2）别再踩
若 90 分钟内搬不完，停在干净的中间点（已搬的通道全绿、记账写清搬到哪），不要留半截。

纪律：
- 全程 TDD：先红后绿，测试与实现同一提交。小修各自独立提交，大件按通道分提交。
- 验收门槛：npm run test:all 全绿、typecheck 零错误、sweep 与新钉基线一致。
- 提交照现有风格。**不要 push**（发版由主管做）。
- 报告纪律：写了「做了」的必须真验过；每条标「已做并验过 / 已做但没验 / 没做（原因）」。
  一次 edit 可改多处，没有 multi_edit。
- 报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + docs 簇覆盖率变化 + 没做什么。`
})

if (!dev.ok) {
  return { round: 'R60', stage: 'dev', ok: false, runId: dev.runId, output: dev.output }
}

// ---------- 阶段二：使用者复验 ----------
const verify = await runs.run('r60-verify', {
  label: '使用者实跑复验 R60',
  agent: 'waizhuan',
  cwd: root,
  timeoutMs: 2700000,
  task: `你是周文娟（使用者）。研发刚做完 R60，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了：
1. 弹窗不再被页头盖住（就是你看截图抓到的那个「登记短款核销」 bug）
2. 作废/失效的单子详情页不再显示「生成 PI / 商业发票 CI」按钮
3. seed 重建后单号从头开始；sweep 基线钉了窗口尺寸
4. Linux 发布包修了（或砍了 rpm，看他报告怎么说）
5. 单据存档搬到了后端：远端模式下存档/预览/历史版本都走服务器，本地模式照旧

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对。
2. 弹窗：亲手在订单详情收款页签点开「登记短款核销」，弹窗居中、不被盖；再随手点开两三个别的
   弹窗（收款、新建订单）确认一起好了——他要是只修了一个弹窗，打回。
3. 存档：本地模式出一份 PI 存档、预览、看历史版本；切远端模式再来一遍，PDF 都能打开、
   版本号接着排不重排。「存档区报错不影响金额明细」那条 R57 老规矩抽查一下。
4. 作废一张单看详情页：按钮没了、话术还在不在。
5. seed 连跑两遍，单号都从同一个起点开始才算修好。
6. 他报告「已做并验过」的每条挑最要命的两条亲手点；新发现照实写。

报告写到 ${verifyReport}，结构照抄你上一份。最后一行必须是且只能是：
VERDICT: 通过
VERDICT: 打回
（打回就下一行列原因，最多三条，按要命程度排序。）
最终回复：报告路径 + VERDICT + 一句话结论。`
})

// ---------- 阶段三：打回则返工 ----------
const verdictText = String(verify.output || '')
if (verdictText.indexOf('VERDICT: 打回') >= 0) {
  const fix = await runs.run('r60-fix', {
    label: '研发按复验报告返工',
    resume: dev.runId,
    cwd: root,
    timeoutMs: 2700000,
    task: `使用者把 R60 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节，每条打回原因对应：怎么修的、怎么验的），
最终回复：修了几条、各套件通过数、还有什么没修。`
  })
  return {
    round: 'R60',
    dev: dev.ok,
    verify: verify.ok,
    rework: fix.ok,
    devReport,
    verifyReport,
    output: fix.output
  }
}

return {
  round: 'R60',
  dev: dev.ok,
  verify: verify.ok,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
