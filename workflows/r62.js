/**
 * IKanBot 双 agent 迭代 · R62（限流重试模板版）
 *
 * 小修：备份 EACCES 漏口（core/backup.ts:143 错误重包）、编辑已有订单的草稿暂存。
 * 大件：M4 并发第一片——写冲突检测（CAS/409 人话）+ 收款幂等。
 * 收尾：复验通过后发 v0.5.4（主管按 AGENTS.md 规则二执行）。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r62-yanfa.md'
const verifyReport = fb + '/2026-11-07-r62-verify.md'

function delay(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 忙等：沙箱没有 setTimeout，只能占线程等限流窗口过去
  }
  return true
}

const CONTINUE_NOTE = `【重要】这不是第一次启动：之前的尝试可能在工作区留下半成品（也许已提交几步、也许有未提交改动）。
先 git log --oneline -8 和 git status 自查进度，做完的不要重做，接着往下做。`

// ---------- 阶段一：研发实现（带重试） ----------
const DEV_TASK = `你是 IKanBot 的研发。今天 2026-11-07，第 R62 轮。工作目录 ${root}（macOS）。
基线 v0.5.3 发布后（HEAD 以 git log 为准），四套测试起步全绿（e2e 2313 / 双模式 140 / 数据层 69 / HTTP 202）。
先读 AGENTS.md 和 R61 两份报告（docs/feedback/2026-11-07-r61-*.md）。

【两件小修（先做，独立小提交）】
1. **备份 EACCES 漏口（复验留下的必修账）**：备份接口的文件权限错误还在漏「服务器内部错误」，
   根因已指到 core/backup.ts:143 的错误重包——那里把原始错误吞了。修成统一人话（说清路径与该找谁），
   并把 r60/r61 两轮的 EACCES 断言合并成一套「权限错误一律人话」的锁死断言。TDD。
2. **编辑已有订单弹窗的草稿暂存**：R61 只做了新建订单（录单主场景），编辑已有订单的弹窗
   改到一半 token 过期同样不该丢。沿用同一套本地暂存机制，行为对齐：改动即暂存、保存成功才清。
   TDD + 截图证据进 docs/ui/r62/。

【大件：M4 并发第一片】
docs/backend-plan.md 第四节的既定方向，本轮落最小闭环：
1. **写冲突检测**：订单/商品/客户等热表写路径加乐观锁——按库内 updated_at 做条件更新
   （UPDATE … WHERE id=? AND updated_at=?），affected 0 行即「别人刚改过」→ 409 + 中文话术
   「这条记录刚被别人改过，请刷新后再试」。桌面两个窗口同改一单，后写者可见提示（mode/e2e 可测的缝）。
   SQLite 与未来的 MySQL 都要能表达这套语义（transact 内复查而不是前端预检）。
2. **收款幂等**：收款/退款入口收 request_id（可空），同 id 重放直接返回第一次的结果不再落第二笔
   （防双击与重试）。服务端落 request_id 表或唯一索引，双击收款只落一笔——e2e/mode 断言锁死。
   桌面端生成 request_id 并随请求带上。
3. 记账：M4 完成度、剩余（row_version 大字段方案、列表页「有人正在改」弱提示）写进 backend-plan.md。
搬不完停干净中间点，不要留半截。

纪律：全程 TDD（先红后绿，测试与实现同一提交）；npm run test:all 全绿 + typecheck 零错误 + sweep 与基线一致；
界面变更按 AGENTS.md 截图进 docs/ui/r62/ 并更新索引；提交照现有风格，**不要 push**；
报告纪律：写了「做了」的必须真验过，每条标「已做并验过 / 已做但没验 / 没做（原因）」；
一次 edit 可改多处，没有 multi_edit。
报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + M4 完成度 + 没做什么。`

let dev = null
let devRunId = null
let devOk = false
for (let attempt = 0; attempt < 5; attempt++) {
  let launched = null
  try {
    if (devRunId) {
      launched = await runs.run('r62-dev-a' + attempt, {
        resume: devRunId,
        cwd: root,
        timeoutMs: 5400000,
        task: `你上一段工作被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R62 任务清单继续做完（纪律不变：TDD、npm run test:all 全绿、typecheck 零错误、不要 push）。
完成或到干净中间点就更新报告 ${devReport}，回复：报告路径 + 各套件通过数 + M4 完成度 + 没做什么。`
      })
    } else {
      launched = await runs.run('r62-dev-a' + attempt, {
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
    if (devRunId) { devRunId = null }
  }
  delay(180000)
}

if (!devOk) {
  return { round: 'R62', stage: 'dev', ok: false, lastRunId: dev ? dev.runId : null, output: dev ? dev.output : '五次尝试均失败' }
}

// ---------- 阶段二：使用者复验（带重试） ----------
const VERIFY_TASK = `你是周文娟（使用者）。研发刚做完 R62，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了：
1. 备份的权限错误不再漏「服务器内部错误」——上一轮你点名的账
2. 编辑已有订单的弹窗也带草稿暂存了（上轮只做了新建）
3. 并发第一片：两个窗口同时改同一条记录，后写的会被拦下并说「刚被别人改过」；
   收款双击/重试只落一笔

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对。
2. 并发亲测（这是本轮的命）：开两个窗口（或两个标签页）同时改同一张订单的价格，后保存的那个
   要看到人话提示而不是悄悄覆盖；收款双击两下，账上只落一笔；网络重试（断网重连）不重复收款。
3. 草稿暂存：编辑一张已有订单改到一半，造 token 过期，重新登录后你的改动还在不在。
4. 备份照旧能备份能恢复（上轮验过，这轮抽查）。
5. 他报告「已做并验过」的每条挑最要命的两条亲手点；新发现照实写。

报告写到 ${verifyReport}，结构照抄你上一份。报告最后一行必须是且只能是：
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
      launched = await runs.run('r62-verify-a' + attempt, {
        resume: verifyRunId,
        cwd: root,
        timeoutMs: 2700000,
        task: `你上一段复验被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R62 复验清单继续验完，报告写到 ${verifyReport}，末行必须是 VERDICT: 通过 或 VERDICT: 打回。`
      })
    } else {
      launched = await runs.run('r62-verify-a' + attempt, {
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
  delay(180000)
}

if (!verifyOk) {
  return { round: 'R62', stage: 'verify', dev: true, ok: false, lastRunId: verify ? verify.runId : null, output: verify ? verify.output : '五次尝试均失败' }
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
        launched = await runs.run('r62-fix-a' + attempt, {
          resume: fixRunId,
          cwd: root,
          timeoutMs: 2700000,
          task: `使用者把 R62 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节），回复：修了几条、各套件通过数、还有什么没修。`
        })
      } else {
        launched = await runs.run('r62-fix-a' + attempt, {
          agent: 'yanfa',
          cwd: root,
          timeoutMs: 2700000,
          task: CONTINUE_NOTE + `\n\n使用者把 R62 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
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
    delay(180000)
  }
  return {
    round: 'R62',
    dev: true,
    verify: verify.ok,
    rework: fixOk,
    devReport,
    verifyReport,
    output: fix && fix.ok ? fix.output : '返工五次尝试均失败或未完成'
  }
}

return {
  round: 'R62',
  dev: true,
  verify: true,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
