/**
 * IKanBot 双 agent 迭代 · R51
 *
 * 第一刀：收 R50 复验留的三个小尾巴（毛利口径标注、工作台「定金」字样、sweep 探针进 git 重钉基线）。
 * 第二刀：M2 鉴权第一片——users 表、登录/token、actor 留痕、桌面远端模式登录卡片、401 统一处理。
 * 流程：研发实现 → 使用者实跑复验 → 打回则研发返工（互相监督）。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r51-yanfa.md'
const verifyReport = fb + '/2026-11-07-r51-verify.md'
const prevVerify = fb + '/2026-11-07-r50-verify.md'

// ---------- 阶段一：研发实现 ----------
const dev = await runs.run('r51-dev', {
  label: '研发实现 R51：三个小尾巴 + M2 鉴权第一片',
  agent: 'yanfa',
  cwd: root,
  timeoutMs: 4500000,
  task: `你是 IKanBot 的研发。今天是 2026-11-07，后端化施工第 R51 轮。
工作目录 ${root}（macOS）。上一轮 R50 已通过复验（HEAD 276bca4），使用者留了三个小尾巴，她的复验报告在
${prevVerify}——**先读它**，三个小尾巴的细节都在里面。

【第一刀：收三个小尾巴（先做，小步提交）】
1. 毛利口径标注（她复验时发现毛利数字旁缺口径说明的那条）
2. 工作台「定金」字样（她点名不对的那处）
3. sweep 探针收进 git（上次因为放在 gitignore 的 out/ 里，搬机就丢了；挪到 scripts/ 下入库，
   重钉基线并写进 docs/backend-plan.md——旧绝对值 233.031/91.641 正式作废）
每条修完照旧 TDD：能写断言的先写断言（比如字样、口径标注文案），纯工具挪动写不进断言的说明原因。

【第二刀：M2 鉴权第一片】
docs/backend-plan.md 第五节的既定方向：用户名+密码登录、签发 token、actor 从 token 取、
第一版「能登录 = 全部权限」，不做多租户不做角色。本轮落地的最小闭环：
1. schema 迁移加 users 表（MIGRATIONS 追加 version N+1，绝不改历史迁移）。密码哈希用 node 内置
   crypto.scrypt——server 不为这个引原生依赖（argon2/bcrypt 要编译），随机盐 + 时序安全的比较函数。
   首个用户怎么来（服务端启动时 users 表为空的引导方式，或 CLI 脚本）你定，但要把决策和操作步骤
   写进 backend-plan.md 记账，不能只有代码里看得懂。
2. 服务端：POST /api/auth/login 签 token（HMAC 自签即可，node 内置就能做；若引 jsonwebtoken 这类
   纯 JS 轻依赖要说明理由），除 /api、/healthz、auth 外全部路由挂校验中间件，401 统一中文报错
   「请先登录」；actor 从 token 注入请求上下文，order_events 的 actor 改用服务端认定的身份，
   不再信桌面传的（这是留痕的真实性，重点测试）。
3. 桌面远端模式：设置页「数据来源」卡片升级——远端模式要求已登录（地址 + 用户名 + 密码 → 登录换
   token 存 safeStorage，登录态过期/401 时各页面统一提示重新登录，不白屏不假死）；本地模式完全
   不受影响，一行不改。模式切换、探活、覆盖率这些已有能力不许退化。
4. REMOTE_ROUTES 里已登记的 90 个通道行为不变；本轮不新增业务路由。
测试：服务端断言锁「登录发 token / 错密码拒 / 无 token 401 / actor 来自 token 而不是请求体」；
mode 测试锁「远端模式带 token 走通原有通道、不带 token 被拒」；e2e 全绿不许掉。

纪律：
- 全程 TDD（owner 全局规则）：先红后绿，测试与实现同一提交。
- 验收门槛：npm run test:all 全绿、npm run typecheck 零错误、bash scripts/sweep.sh 与本轮重钉的基线一致。
- 提交照现有风格，小步多次（参考 git log 最近 10 条）。**不要 push**。
- 动了界面就 bash scripts/shot.sh 实拍（绝不要直接跑 electron，会卡死会话）。
- 报告纪律：写了「做了」的必须真验过；每条标「已做并验过 / 已做但没验 / 没做（原因）」。
  一次 edit 调用可改多处，没有 multi_edit。
- 报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + 关键决策（哈希/token/首用户引导）+ 没做什么。`
})

if (!dev.ok) {
  return { round: 'R51', stage: 'dev', ok: false, runId: dev.runId, output: dev.output }
}

// ---------- 阶段二：使用者复验 ----------
const verify = await runs.run('r51-verify', {
  label: '使用者实跑复验 R51',
  agent: 'waizhuan',
  cwd: root,
  timeoutMs: 2700000,
  task: `你是周文娟（使用者）。研发刚做完 R51，他的报告在 ${devReport}。先读它和你的上一份
${prevVerify}，但别信他写的，自己验。工作目录 ${root}（Mac）。

本轮他说做了两件事：
1. 你上轮留的三个小尾巴：毛利口径标注、工作台「定金」字样、sweep 探针入库重钉基线。
2. 远端模式要登录了：设置页填服务器地址 + 用户名 + 密码才能用远端；登录状态存在本机安全存储；
   登录过期会提示重新登录而不是白屏；本地模式完全不受影响。另外单据事件里记的操作人改成
   服务器认定的身份，桌面端说了不算。

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数，跟他报告对——他写全绿你跑不出全绿就打回。
2. 三个小尾巴逐条亲验：字样和标注用 bash scripts/shot.sh 实拍看（npm run seed 先重建演示数据）；
   探针 ls 一下 scripts/ 里在不在、git ls-files 里进没进。
3. 鉴权按你的方式走一遍：本地模式照常用（建单、收款、出 PI），确认完全没被折腾；
   远端模式不登录就用——被拒的话提示你看不看得懂；登录后走通客户页/工作台/建单；
   两台「窗口」同时用（开两个标签页模拟）确认互不干扰。
4. 操作人留痕：建一张单再去订单历史/事件里看，操作人是不是真的记了登录的人，
   而不是空白或者谁都能随便填的名字。
5. 他报告里标「已做并验过」的每条，挑最要命的两条亲手点。
6. 新发现照实写，特别是「登录这个动作烦不烦、提示看不懂的地方」——你是每天要用的人。

报告写到 ${verifyReport}，结构照抄你上一份。最后一行必须是且只能是：
VERDICT: 通过
VERDICT: 打回
（打回就下一行列原因，最多三条，按要命程度排序。）
最终回复：报告路径 + VERDICT + 一句话结论。`
})

// ---------- 阶段三：打回则返工 ----------
const verdictText = String(verify.output || '')
if (verdictText.indexOf('VERDICT: 打回') >= 0) {
  const fix = await runs.run('r51-fix', {
    label: '研发按复验报告返工',
    resume: dev.runId,
    cwd: root,
    timeoutMs: 2700000,
    task: `使用者把 R51 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节，每条打回原因对应：怎么修的、怎么验的），
最终回复：修了几条、各套件通过数、还有什么没修。`
  })
  return {
    round: 'R51',
    dev: dev.ok,
    verify: verify.ok,
    rework: fix.ok,
    devReport,
    verifyReport,
    output: fix.output
  }
}

return {
  round: 'R51',
  dev: dev.ok,
  verify: verify.ok,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
