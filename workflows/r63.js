/**
 * IKanBot 双 agent 迭代 · R63（限流重试模板版）
 *
 * 大件一：M4 第二片——row_version + 列表页「有人正在改」弱提示。
 * 大件二：SQLite 方言六处清账（MySQL 适配的前置，R46 技术账）。
 * 收尾：复验通过后发 v0.5.5（主管按 AGENTS.md 规则二执行）。
 */

const root = '/Users/chenpeigen/code/IKanBot'
const fb = root + '/docs/feedback'
const devReport = fb + '/2026-11-07-r63-yanfa.md'
const verifyReport = fb + '/2026-11-07-r63-verify.md'

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
const DEV_TASK = `你是 IKanBot 的研发。今天 2026-11-07，第 R63 轮。工作目录 ${root}（macOS）。
基线 v0.5.4 发布后（HEAD 以 git log 为准），四套测试起步全绿（以 R62 复验报告的数字为准）。
先读 AGENTS.md、docs/backend-plan.md 第四/十节和 R62 两份报告（docs/feedback/2026-11-07-r62-*.md）。

【大件一：M4 第二片】
R62 已落乐观锁（updated_at CAS + 409 人话）与收款幂等（request_dedup v24）。本轮按计划补：
1. **row_version**：热表（订单/商品/客户/打样/报价）加 row_version BIGINT（v25 迁移，绝不改历史迁移），
   读时带出、写时校验并自增；与 R62 的 updated_at CAS 二选一收口成一套（留一套并说清为什么），
   桌面与服务端同一语义。
2. **列表页「有人正在改」弱提示**：列表/详情对「最近 N 秒内别人写过且你手里的快照已旧」的行给
   弱提示（不阻断，刷新即消）。方案自定（基于 row_version 差异即可，不做长连接），写进记账。
3. M4 完成度在 backend-plan.md 收口：哪些算完成、哪些明确留 M5。

【大件二：SQLite 方言六处清账（MySQL 适配前置，R46 技术账）】
backend-plan.md「搬后端前必须先解的技术账」第 1 条列了六处方言（以文件里的清单为准，先逐条核对现状）：
core/next-no.ts 与 core/settings.ts 的 ON CONFLICT DO UPDATE、core/orders.ts 的 last_insert_rowid()
与 GROUP_CONCAT(DISTINCT …)、core/money.ts 的 strftime(…,'localtime')、core/quotations.ts 的
INSERT OR IGNORE。逐条改成 core 内不出现 SQLite 专有语法：Db 接口加最小的新原语（如 upsert、
lastInsertId、groupConcat、业务日函数），SQLite/MySQL（MySQL 侧可先留 TODO 实现 + 报错不静默）
两个 Db 实现各自给实现；现有断言全部保持绿。GROUP_CONCAT 那处特别注意 MySQL group_concat_max_len
默认 1024 会静默截断——新原语必须在 MySQL 侧设 session 变量或换聚合方式，并把这条写进测试注释。
时间账（R46 挂账 #2：UTC 存储与 localDate 比较的跨日假失败）如尚未清，一并清掉。
改不动或风险超出本轮的，停手写记账，不要硬改。

纪律：全程 TDD（先红后绿，测试与实现同一提交）；npm run test:all 全绿 + typecheck 零错误 + sweep 与基线一致；
界面变更按 AGENTS.md 截图进 docs/ui/r63/ 并更新索引（README 内嵌图那节不动，增量走链接）；
提交照现有风格，**不要 push**；报告纪律照旧（每条标「已做并验过 / 已做但没验 / 没做（原因）」）。
报告写到 ${devReport}。最终回复：报告路径 + 各套件通过数 + 方言六处逐条结论 + M4 收口状态 + 没做什么。`

let dev = null
let devRunId = null
let devOk = false
for (let attempt = 0; attempt < 5; attempt++) {
  let launched = null
  try {
    if (devRunId) {
      launched = await runs.run('r63-dev-a' + attempt, {
        resume: devRunId,
        cwd: root,
        timeoutMs: 5400000,
        task: `你上一段工作被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R63 任务清单继续做完（纪律不变：TDD、npm run test:all 全绿、typecheck 零错误、不要 push）。
完成或到干净中间点就更新报告 ${devReport}，回复：报告路径 + 各套件通过数 + 方言六处逐条结论 + M4 收口状态 + 没做什么。`
      })
    } else {
      launched = await runs.run('r63-dev-a' + attempt, {
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
  return { round: 'R63', stage: 'dev', ok: false, lastRunId: dev ? dev.runId : null, output: dev ? dev.output : '五次尝试均失败' }
}

// ---------- 阶段二：使用者复验（带重试） ----------
const VERIFY_TASK = `你是周文娟（使用者）。研发刚做完 R63，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了：
1. 「有人正在改」弱提示：别人刚写过的单子，你手里的旧快照页面上会有弱提示，刷新即消
2. 数据库方言清理：为以后换 MySQL 铺路（这部分你看不到界面，抽查测试数字即可）

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对。
2. 弱提示亲测：两个窗口改同一张订单，另一个窗口的页面出现提示没有？刷新后消失没有？
   提示的文案你读得懂吗、会不会被打扰（它是弱提示，不该弹窗拦你）。
3. 409 老规矩抽查：后保存的被拦时话术是否还是那句人话，别被 row_version 改坏了。
4. 收款幂等抽查：双击收款还是只落一笔。
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
      launched = await runs.run('r63-verify-a' + attempt, {
        resume: verifyRunId,
        cwd: root,
        timeoutMs: 2700000,
        task: `你上一段复验被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R63 复验清单继续验完，报告写到 ${verifyReport}，末行必须是 VERDICT: 通过 或 VERDICT: 打回。`
      })
    } else {
      launched = await runs.run('r63-verify-a' + attempt, {
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
  return { round: 'R63', stage: 'verify', dev: true, ok: false, lastRunId: verify ? verify.runId : null, output: verify ? verify.output : '五次尝试均失败' }
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
        launched = await runs.run('r63-fix-a' + attempt, {
          resume: fixRunId,
          cwd: root,
          timeoutMs: 2700000,
          task: `使用者把 R63 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新你的报告 ${devReport}（追加「返工」一节），回复：修了几条、各套件通过数、还有什么没修。`
        })
      } else {
        launched = await runs.run('r63-fix-a' + attempt, {
          agent: 'yanfa',
          cwd: root,
          timeoutMs: 2700000,
          task: CONTINUE_NOTE + `\n\n使用者把 R63 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
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
    round: 'R63',
    dev: true,
    verify: verify.ok,
    rework: fixOk,
    devReport,
    verifyReport,
    output: fix && fix.ok ? fix.output : '返工五次尝试均失败或未完成'
  }
}

return {
  round: 'R63',
  dev: true,
  verify: true,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
