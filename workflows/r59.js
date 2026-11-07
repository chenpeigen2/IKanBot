/**
 * IKanBot 双 agent 迭代 · R59（新基线：旧机 R50-R58 已落地，v0.5.0 已发布）
 *
 * 第一刀：两个小尾巴在新基线上重判收尾（毛利口径标注、「定金」字样、sweep 探针入库 + macOS 化）。
 * 第二刀：M2 鉴权第一片（stash@{0} 里有研发被中断的半成品当起点）。
 * 流程：研发实现 → 使用者实跑复验 → 打回则研发返工。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r59-yanfa.md'
const verifyReport = fb + '/2026-11-07-r59-verify.md'

// ---------- 阶段一：研发实现 ----------
const dev = await runs.run('r59-dev', {
  label: '研发实现 R59：小尾巴重判 + M2 鉴权第一片',
  agent: 'yanfa',
  cwd: root,
  timeoutMs: 5400000,
  task: `你是 IKanBot 的研发。今天是 2026-11-07，第 R59 轮。工作目录 ${root}（macOS）。

**重要背景：主干刚大换血。** 旧电脑上做的 R50–R58（9 个提交）已整体落到主干并发布了 v0.5.0
（HEAD f2dc841，领先 origin 已同步）。这批提交覆盖面很大（e2e 2290 项、schema v22、
客户聚合三通道后端已搬完 90/119、状态标签体系在 R54/R58 重做过）。
动手前先 git log --oneline -12 和 docs/backend-plan.md 里 R50~R58 的记账，弄清新基线长什么样，
**不要凭你记忆里的旧主干写代码**。

基线我已验过：typecheck 0 错、e2e 2290/0、双模式 107、数据层 56、HTTP 冒烟 161，全绿。

【第一刀：三个小尾巴在新基线上重判（先做，逐条小提交）】
这些是上一条分支线上复验留的，主干换了，**先重判还成不成立，成立才做**：
1. 毛利口径标注：旧线 R53/R58 已动过客户统计与标签体系，先查现在毛利数字旁还有没有缺口径说明。
   若旧线已覆盖，写明「已被 R5x 覆盖」即可，不重复做。
2. 工作台「定金」字样：旧线 R54 把「paid」改叫「定金已收」、标签收进 shared/types。重判工作台待收
   那一格现在还会不会被读成已收定金；会才改。
3. sweep 探针入库 + macOS 化：这条确定还要做——主干上 scripts/sweep.sh 还是 Windows 味（taskkill、
   MSYS_NO_PATHCONV），探针 out/probe-sweep.js 在 gitignore 里、搬机即丢。backup/mac-r50-round 分支上
   有我们改好的版本（19a8be5：探针进 scripts/、sweep.sh 清 Windows 残留、backend-plan 记账），可以
   cherry-pick 或照着重做，但 backend-plan.md 的记账条目要按新基线重写（旧条目讲的是另一条线的上下文），
   基线数值在 macOS 上重测重钉。

【第二刀：M2 鉴权第一片】
git stash list 里有一条「R51 auth WIP」（v23 users 迁移 + scrypt + HMAC token 的测试开头），
是主干换血前写到一半的。git stash show -p 看内容，能 apply 就 apply（冲突就当参考重写）。
目标不变（docs/backend-plan.md 第五节），最小闭环：
1. schema 迁移加 users 表（现在 LATEST_DB_VERSION 是 v22，追加 v23，绝不改历史迁移）。
   密码哈希用 node 内置 crypto.scrypt（随机盐 + timingSafeEqual），server 不为这个引原生依赖。
   首个用户的引导方式（服务端启动时 users 表为空怎么办 / CLI 脚本）你定，
   决策和操作步骤写进 backend-plan.md 记账。
2. 服务端：POST /api/auth/login 签 HMAC token（node 内置即可，引纯 JS 轻依赖要说明理由）；
   除 /api、/healthz、auth 外全路由挂校验，401 统一中文「请先登录」；actor 从 token 注入，
   order_events 的操作人改用服务端认定的身份，不再信桌面传的（这是留痕真实性，重点测试）。
3. 桌面远端模式：设置页「数据来源」卡片升级——远端要求已登录（地址+用户名+密码 → token 存
   safeStorage，过期/401 统一提示重新登录，不白屏不假死）；本地模式一行不改。
   已有的模式切换、探活、覆盖率不许退化。本轮不新增业务路由。
测试：服务端锁「登录发 token / 错密码拒 / 无 token 401 / actor 来自 token 而不是请求体」；
mode 测试锁「远端带 token 走通、不带被拒」；e2e 全绿不许掉。

纪律：
- 全程 TDD（owner 全局规则）：先红后绿，测试与实现同一提交。
- 验收门槛：npm run test:all 全绿、npm run typecheck 零错误、sweep 与本轮重钉的基线一致。
- 提交照现有风格，小步多次，**不要 push**。
- 动了界面就 bash scripts/shot.sh 实拍（绝不要直接跑 electron，会卡死会话）。
- 报告纪律：写了「做了」的必须真验过；每条标「已做并验过 / 已做但没验 / 没做（原因）」。
  一次 edit 调用可改多处，没有 multi_edit。
- 报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + 关键决策 + 没做什么。`
})

if (!dev.ok) {
  return { round: 'R59', stage: 'dev', ok: false, runId: dev.runId, output: dev.output }
}

// ---------- 阶段二：使用者复验 ----------
const verify = await runs.run('r59-verify', {
  label: '使用者实跑复验 R59',
  agent: 'waizhuan',
  cwd: root,
  timeoutMs: 2700000,
  task: `你是周文娟（使用者）。研发刚做完 R59，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了两件事：
1. 检查并收尾了之前留的小尾巴：毛利数字旁边有没有写清口径、工作台「定金」那一格会不会被读歪、
   版面探针收进了 git（以后换电脑不再丢基线）。
2. 远端模式要登录了：地址+用户名+密码登录才能用远端；登录过期提示重新登录不白屏；
   本地模式完全不受影响；单据事件里的操作人改成服务器认定的身份。

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对——他写全绿你跑不出全绿就打回。
2. 小尾巴逐条亲验：npm run seed 重建演示数据后 bash scripts/shot.sh 实拍工作台、订单详情、客户页，
   毛利和定金两处用你自己的眼睛读——如果研发写「旧线已覆盖不用改」，你也去看一眼确认真的覆盖了。
3. 鉴权按你的方式走一遍：本地模式照常用（建单、收款、出 PI）确认没被折腾；
   远端不登录就用——被拒的提示你看得懂吗；登录后走通客户页/工作台/建单。
4. 操作人留痕：建一张单去订单历史/事件里看操作人是不是真记了登录的人。
5. 他报告里「已做并验过」的每条挑最要命的两条亲手点；新发现照实写。

报告写到 ${verifyReport}，结构照抄 docs/feedback/2026-11-07-r50-verify.md。最后一行必须是且只能是：
VERDICT: 通过
VERDICT: 打回
（打回就下一行列原因，最多三条，按要命程度排序。）
最终回复：报告路径 + VERDICT + 一句话结论。`
})

// ---------- 阶段三：打回则返工 ----------
const verdictText = String(verify.output || '')
if (verdictText.indexOf('VERDICT: 打回') >= 0) {
  const fix = await runs.run('r59-fix', {
    label: '研发按复验报告返工',
    resume: dev.runId,
    cwd: root,
    timeoutMs: 2700000,
    task: `使用者把 R59 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节，每条打回原因对应：怎么修的、怎么验的），
最终回复：修了几条、各套件通过数、还有什么没修。`
  })
  return {
    round: 'R59',
    dev: dev.ok,
    verify: verify.ok,
    rework: fix.ok,
    devReport,
    verifyReport,
    output: fix.output
  }
}

return {
  round: 'R59',
  dev: dev.ok,
  verify: verify.ok,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
