/**
 * IKanBot · R62 复验（独立段，限流重试版）
 * 研发成果已全部提交（8 个提交，HEAD 6268e8a）。本段只跑：复验 → 打回则返工。
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

// ---------- 复验（带重试，间隔加长到 5 分钟） ----------
const VERIFY_TASK = `你是周文娟（使用者）。研发刚做完 R62，他的报告在 ${devReport}。先读它，别信，自己验。
工作目录 ${root}（Mac）。

本轮他说做了：
1. 备份的权限错误不再漏「服务器内部错误」——上一轮你点名的账
2. 编辑已有订单的弹窗也带草稿暂存了（上轮只做了新建）
3. 并发第一片：两个窗口同时改同一条记录，后写的会被拦下并说「刚被别人改过」；
   收款双击/重试只落一笔

你要做的：
1. 实际跑 npm run build && npm run test:all，记通过/失败数跟他报告对。
2. 并发亲测（本轮的命）：两个窗口同时改同一张订单的价格，后保存的看到人话提示而不是悄悄覆盖；
   收款双击两下，账上只落一笔。
3. 草稿暂存：编辑一张已有订单改到一半，造 token 过期，重新登录后你的改动还在不在。
   （上一段尝试里你遇到过一次页面卡死：先判断是测试环境打架还是真 bug，真 bug 就写进报告打回。）
4. 备份照旧能备份能恢复，抽查。
5. 他报告「已做并验过」的每条挑最要命的两条亲手点；新发现照实写。

注意节奏：限流很紧，动作放慢、少开新进程，electron 实例用完立刻关（scripts/shot.sh 自带清理）。

报告写到 ${verifyReport}，结构照抄你上一份。报告最后一行必须是且只能是：
VERDICT: 通过
VERDICT: 打回
（打回就下一行列原因，最多三条，按要命程度排序。）
最终回复：报告路径 + VERDICT + 一句话结论。`

let verify = null
let verifyRunId = null
let verifyOk = false
for (let attempt = 0; attempt < 6; attempt++) {
  let launched = null
  try {
    if (verifyRunId) {
      launched = await runs.run('r62v-verify-a' + attempt, {
        resume: verifyRunId,
        cwd: root,
        timeoutMs: 2700000,
        task: `你上一段复验被打断（限流）。${CONTINUE_NOTE}
然后按你原来的 R62 复验清单继续验完，报告写到 ${verifyReport}，末行必须是 VERDICT: 通过 或 VERDICT: 打回。`
      })
    } else {
      launched = await runs.run('r62v-verify-a' + attempt, {
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
  delay(300000)
}

if (!verifyOk) {
  return { round: 'R62', stage: 'verify', ok: false, lastRunId: verify ? verify.runId : null, output: verify ? verify.output : '六次尝试均失败' }
}

// ---------- 打回则返工（带重试） ----------
const verdictText = String(verify.output || '')
if (verdictText.indexOf('VERDICT: 打回') >= 0) {
  let fix = null
  let fixOk = false
  for (let attempt = 0; attempt < 6; attempt++) {
    let launched = null
    try {
      launched = await runs.run('r62v-fix-a' + attempt, {
        agent: 'yanfa',
        cwd: root,
        timeoutMs: 2700000,
        task: CONTINUE_NOTE + `\n\n使用者把 R62 打回了，复验报告在 ${verifyReport}。先读它，逐条修复她打回的原因。
同样的纪律：TDD、npm run test:all 全绿、typecheck 零错误、照现有风格提交（不要 push）。
修完更新研发报告 ${devReport}（追加「返工」一节），回复：修了几条、各套件通过数、还有什么没修。`
      })
      fix = launched
      if (fix.ok) { fixOk = true; break }
    } catch (e) {
      // 限流，等下一试
    }
    delay(300000)
  }
  return {
    round: 'R62',
    verify: verify.ok,
    rework: fixOk,
    devReport,
    verifyReport,
    output: fix && fix.ok ? fix.output : '返工六次尝试均失败或未完成'
  }
}

return {
  round: 'R62',
  verify: true,
  verdict: verdictText.indexOf('VERDICT: 通过') >= 0 ? '通过' : '未明确标注',
  devReport,
  verifyReport,
  output: verify.output
}
