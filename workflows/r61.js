/**
 * IKanBot 双 agent 迭代 · R61（带限流重试版 v2）
 *
 * 小修：rpm 砍留决策、EACCES 人话、401 清假登录态、token 过期不丢草稿、docs:reveal 收尾。
 * 大件：backup: 备份簇搬后端。
 * 限流对策：每个阶段最多 5 次尝试；失败优先 resume 上一个 run（保留进度与记忆），
 * resume 不可用则冷启动并在任务书里声明「可能有半成品，先自查进度接着做」；两次尝试间隔 2~3 分钟。
 * 收尾：复验通过后发 v0.5.3（主管按 AGENTS.md 规则二执行）。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r61-yanfa.md'
const verifyReport = fb + '/2026-11-07-r61-verify.md'

// 上一段被限流打断的研发 run（备份簇桌面接线进行中）
const interruptedDevRun = '3b79f196-5a6d-4a18-baff-1a1764cb8bf2'

// 沙箱里没有 setTimeout（host globals 被禁），只能忙等限流窗口过去
function delay(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 忙等
  }
  return true
}

const CONTINUE_NOTE = `【重要】这不是第一次启动：之前的尝试可能在工作区留下半成品（也许已提交几步、也许有未提交改动）。
先 git log --oneline -8 和 git status 自查进度，做完的不要重做，接着往下做。`

// ---------- 阶段一：研发实现（带重试） ----------
const DEV_TASK = `你是 IKanBot 的研发。今天 2026-11-07，第 R61 轮。工作目录 ${root}（macOS）。
当前基线 42fe909 起步（你可能已推进到更后面），四套测试起步全绿（e2e 2302 / 双模式 128 / 数据层 69 / HTTP 188）。
先读 AGENTS.md 和 R60 两份报告（docs/feedback/2026-11-07-r60-*.md），本轮一半的活从那里来。

【五件小修（逐条独立小提交）】
1. Linux rpm 砍留决策落地：从 electron-builder.yml 的 linux target 去掉 rpm，保留 deb + AppImage，
   release 工作流与归档清单同步，backend-plan.md 记账写明决策与理由；删掉没用的 debug-rpm.yml。
2. EACCES 人话：文件权限错误裸奔成「服务器内部错误」→ 服务端错误映射成中文（说清哪个路径、找谁）。TDD。
3. 401 清假登录态：远端调用收到 401 时清 safeStorage 登录态、设置页回未登录、提示重新登录。TDD。
4. token 过期不丢草稿：录单到一半过期，草稿至少本地暂存，重登后续上。方案自定，写进记账。
5. docs:reveal 整目录远端浏览：做掉或正式决策不做写进记账，不留半死入口。

【大件：backup: 备份簇搬后端】
以 electron/ipc/index.ts 里 backup: 前缀实际通道为准（先 grep 列清单）：
- 远端模式备份 = 服务器侧打包（库 + docsDir），沿用「按天 + 失败回滚」（R36）与排队/去重（R43）口径；
  桌面远端只做转发与进度展示；autoBackupOnStart 定时器远端模式不跑，设置页文案说清
- 恢复远端版：整库导入 + 文件替换 + 失败回滚；恢复期间别人在录单先给人话报错「恢复期间请全员停手」，
  完整并发留 M4/M5
- mode 测试锁双模式：备份/恢复后行数与金额合计一致；R36/R43 的排队与回滚断言不许退化
90 分钟内搬不完就停在干净中间点（已搬通道全绿 + 记账写清进度），不要留半截。

纪律：全程 TDD（先红后绿，测试与实现同一提交）；npm run test:all 全绿 + typecheck 零错误 + sweep 与基线一致；
界面变更按 AGENTS.md 截图进 docs/ui/r61/ 并更新索引；提交照现有风格，**不要 push**；
报告纪律：写了「做了」的必须真验过，每条标「已做并验过 / 已做但没验 / 没做（原因）」；
一次 edit 可改多处，没有 multi_edit。
报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + backup 簇覆盖率变化 + 没做什么。`

let dev = null
let devRunId = interruptedDevRun
let devOk = false
for (let attempt = 0; attempt < 5; attempt++) {
  let launched = null
  try {
    if (devRunId) {
      launched = await runs.run('r61-dev-a' + attempt, {
        resume: devRunId,
        cwd: root,
        timeoutMs: 5400000,
        task: `你上一段工作被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R61 任务清单继续做完（纪律不变：TDD、npm run test:all 全绿、typecheck 零错误、不要 push）。
完成或到干净中间点就更新报告 ${devReport}，回复：报告路径 + 各套件通过数 + backup 簇覆盖率变化 + 没做什么。`
      })
    } else {
      launched = await runs.run('r61-dev-a' + attempt, {
        agent: 'yanfa',
        cwd: root,
        timeoutMs: 5400000,
        task: CONTINUE_NOTE + '\n\n' + DEV_TASK
      })
    }
    dev = launched
    if (dev.ok) { devOk = true; break }
    devRunId = dev.runId
  } catch (e) {
    // resume 不可用（如 run 不可续）→ 下一次改冷启动；限流 → 等 3 分钟
    if (devRunId) { devRunId = null } else { devRunId = interruptedDevRun === null ? null : null }
  }
  await delay(180000)
}

if (!devOk) {
  return { round: 'R61', stage: 'dev', ok: false, lastRunId: dev ? dev.runId : null, output: dev ? dev.output : '五次尝试均失败' }
}

// ---------- 阶段二：使用者复验（带重试） ----------
const VERIFY_TASK = `你是周文娟（使用者）。研发刚做完 R61，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了：
1. Linux 发布包砍了 rpm（deb/AppImage 保留）——你不用验这个，CI 的事
2. 文件权限错误不再显示「服务器内部错误」，改成能看懂的人话
3. 后端换秘钥后桌面不再挂着假「已登录」，会请你重新登录
4. 录单到一半 token 过期，草稿不会丢
5. 备份搬到了后端：远端模式的备份/恢复走服务器，本地模式照旧

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对。
2. 备份亲测（钱的凭据，最要命）：本地模式备份一份、能列出来、能恢复（seed 前后对比单数和金额）；
   切远端模式再来一遍——备份是服务器打的包、列表和恢复都走服务器；
   恢复失败的回滚老规矩（R36/R43 断言他报告说没退化，你抽一条亲手造个失败试试）。
3. 401 那条按他报告的场景自己造一遍：换秘钥（或等过期）→ 点任何远端操作 → 假「已登录」消失、
   提示重新登录 → 重登后接着用。
4. 草稿不丢：录单填一半，让他造的过期条件发生，看你的单子还在不在、能不能续上。
5. 他报告「已做并验过」的每条挑最要命的两条亲手点；新发现照实写。

报告写到 ${verifyReport}，结构照抄你上一份。最后一行必须是且只能是：
VERDICT: 通过
VERDICT: 打回
（打回就下一行列原因，最多三条，按要命程度排序。）
最终回复：报告路径 + VERDICT + 一句话结论。`

let verify = null
let verifyRunId = null
let verifyOk = false
for (let attempt = 0; attempt < 5; attempt++) {
  let launched = null
  try {
    if (verifyRunId) {
      launched = await runs.run('r61-verify-a' + attempt, {
        resume: verifyRunId,
        cwd: root,
        timeoutMs: 2700000,
        task: `你上一段复验被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R61 复验清单继续验完，报告写到 ${verifyReport}，末行 VERDICT: 通过 或 VERDICT: 打回。`
      })
    } else {
      launched = await runs.run('r61-verify-a' + attempt, {
        agent: 'waizhuan',
        cwd: root,
        timeoutMs: 2700000,
        task: CONTINUE_NOTE + '\n\n' + VERIFY_TASK
      })
    }
    verify = launched
    if (verify.ok) { verifyOk = true; break }
    verifyRunId = verify.runId
  } catch (e) {
    if (verifyRunId) { verifyRunId = null }
  }
  await delay(180000)
}

if (!verifyOk) {
  return { round: 'R61', stage: 'verify', dev: true, ok: false, lastRunId: verify ? verify.runId : null, output: verify ? verify.output : '五次尝试均失败' }
}

// ---------- 阶段三：打回则返工（带重试） ----------
const verdictText = String(verify.output || '')
if (verdictText.indexOf('VERDICT: 打回') >= 0) {
  let fix = null
  let fixRunId = dev.runId
  let fixOk = false
  for (let attempt = 0; attempt < 5; attempt++) {
    let launched = null
    try {
      if (fixRunId) {
        launched = await runs.run('r61-fix-a' + attempt, {
          resume: fixRunId,
          cwd: root,
          timeoutMs: 2700000,
          task: `使用者把 R61 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节），回复：修了几条、各套件通过数、还有什么没修。`
        })
      } else {
        launched = await runs.run('r61-fix-a' + attempt, {
          agent: 'yanfa',
          cwd: root,
          timeoutMs: 2700000,
          task: CONTINUE_NOTE + `\n\n使用者把 R61 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新研发报告 ${devReport}（追加「返工」一节），回复：修了几条、各套件通过数、还有什么没修。`
        })
      }
      fix = launched
      if (fix.ok) { fixOk = true; break }
      fixRunId = fix.runId
    } catch (e) {
      if (fixRunId) { fixRunId = null }
    }
    await delay(180000)
  }
  return {
    round: 'R61',
    dev: true,
    verify: verify.ok,
    rework: fixOk,
    devReport,
    verifyReport,
    output: fix && fix.ok ? fix.output : '返工五次尝试均失败或未完成'
  }
}

return {
  round: 'R61',
  dev: true,
  verify: true,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
