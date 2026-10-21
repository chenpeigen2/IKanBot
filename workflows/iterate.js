/**
 * IKanBot 双 agent 迭代工作流
 *
 * 使用者 agent（绍兴服装外贸业务员）↔ 研发 agent 直接对话式迭代。
 * 每一轮：使用者提痛点 → 研发实现 → 使用者复验 → 研发补漏 → 使用者终验。
 *
 * 运行： subagent({ workflow: "./workflows/iterate.js", cwd: "D:/code/IKanBot", async: true })
 */

const root = 'D:/code/IKanBot'
const feedbackDir = `${root}/docs/feedback`

const ROUNDS = 2

// ---------- 第 1 轮：使用者走查并提出痛点 ----------
const r1 = await runs.run('waizhuan-review', {
  agent: 'waizhuan',
  cwd: root,
  task: `这是第一次走查 IKanBot。请你：

1. 先实际把程序跑起来看界面（见 .pi/agents/waizhuan.md 里的截图方法），至少看这些页面：
   工作台 /、订单 /orders、订单详情 /orders/1（先跑 npm run seed 造演示数据）、商品库 /products、客户 /customers、报表 /reports、设置 /settings。
2. 再读代码，重点看：
   - src/renderer/src/pages/  —— 界面实际怎么实现的
   - src/shared/documents.ts —— PI / PL 单据长什么样
   - electron/services/orders.ts —— 订单和状态是怎么流转的
   - electron/services/dashboard.ts —— 报表和提醒怎么算的
3. 用你 11 年外贸业务员的脑子，把你一天里 12 件事（收询盘→打样→确认订单→报价→收定金→跟工厂→验货→订舱报关→装柜→收尾款→寄单据→对账退税）在这套系统里走一遍。

**关键**：你的活是"报价"发生在"下单"之前。在这套系统里，报价阶段你有没有东西可用？如果没有，这是不是一个真实痛点？请具体到场景地写出来。

把报告写到 ${feedbackDir}/2026-10-20-r1-waizhuan.md，格式：

# 第 1 轮 · 使用者走查报告

## 我用这套系统的一天（按时间顺序写，标出哪一步卡住了）
（自由写，像流水账一样，把卡点用 **【卡】** 标出来）

## 痛点清单
每条按这个格式：
### P1. 一句话标题
- **场景**：
- **我现在的做法**：
- **痛在哪**：
- **想要什么**：
- **重要性**：致命 / 很重要 / 有点烦

## 已经很够用的地方
（不要为了显得有产出而制造需求，这里写你真心觉得够用的功能）

## 给研发的话
（直接说，别绕）

写完在最终回复里把报告路径告诉我，并给一份 5 行以内的摘要。`
})

console.log('使用者走查完成:', r1.ok ? 'ok' : 'failed')

// ---------- 研发实现 ----------
const r2 = await runs.run('yanfa-implement', {
  agent: 'yanfa',
  cwd: root,
  task: `使用者 agent 的走查报告在 ${feedbackDir}/2026-10-20-r1-waizhuan.md。先读它。

你的任务：
1. 逐条判断她的痛点：**认 / 不认 / 她说错了**。不认的要写清楚理由，并给出你的替代方案。
2. 按重要性排序，挑出**这一轮能做完且收益最大**的一批（不要贪多全上，一次改太多她复验不动）。
3. 动手实现。严格遵守 .pi/agents/yanfa.md 里的铁律：
   - 改 schema 加迁移，不改历史
   - 新增能力打通 services → ipc → preload → shared/api.ts → 渲染进程
   - npm run typecheck 零错误
   - npm run test:e2e 全绿，并为新功能加断言
4. 自己跑起来截图自验，确认界面真的对（不要只看代码就宣布完成）。
5. 写报告到 ${feedbackDir}/2026-10-20-r1-yanfa.md，包含：
   - 她的痛点我的判断（认/不认，逐条）
   - 这一轮我做了什么（改了什么文件，每个功能在界面上是哪个按钮）
   - 自验方式与结果（typecheck / test:e2e 输出、截图）
   - 这一轮我没做的，以及为什么

最终回复里给我：改动的文件清单 + 测试结果 + 报告路径。`
})

console.log('研发实现完成:', r2.ok ? 'ok' : 'failed')

// ---------- 使用者复验 ----------
const r3 = await runs.run('waizhuan-verify', {
  agent: 'waizhuan',
  cwd: root,
  task: `研发 agent 的实现报告在 ${feedbackDir}/2026-10-20-r1-yanfa.md。

请去实际复验（跑起来、截图看、用 test:e2e）：
1. 他做的每一个功能，你**实际点一遍**，确认真的能用、真的省了你的事。
2. 逐条打回：哪些解决了、哪些没解决、哪些做歪了。
3. **提出你复验时新冒出来的需求**——这是最有价值的部分，真实使用中才会发现。
4. 如果他改的东西**影响了你原来的习惯**或者**引入了新麻烦**（比如某个按钮位置变了、数据被清空了、老数据打不开了），必须写出来。

写报告到 ${feedbackDir}/2026-10-20-r1-verify.md：
# 第 1 轮 · 使用者复验

## 逐条验收
- P1 → 已解决 / 未解决 / 做歪了（说明怎么歪的）

## 我复验时新发现的问题
（同痛点清单格式）

## 研发需要知道的坑
（你踩到的、以后要注意的）

最终回复给我报告路径 + 最关键的 3 条。`
})

console.log('使用者复验完成:', r3.ok ? 'ok' : 'failed')

// ---------- 研发补漏（第 2 轮） ----------
const r4 = await runs.run('yanfa-fix', {
  agent: 'yanfa',
  cwd: root,
  task: `使用者 agent 的复验报告在 ${feedbackDir}/2026-10-20-r1-verify.md。先读它。

任务：
1. 处理她打回的问题（未解决 / 做歪了 / 新发现）。
2. 特别注意她提到的"影响了原有习惯"和"数据兼容"问题——这类必须优先修，不能留到以后。
3. 按铁律实现，每改完跑 typecheck + test:e2e，自验截图。
4. 写报告到 ${feedbackDir}/2026-10-20-r2-yanfa.md：
   - 逐条回应她的打回
   - 这一轮做了什么、怎么自验
   - 还有哪些没做、为什么

最终回复给我改动清单 + 测试结果 + 报告路径。`
})

console.log('研发补漏完成:', r4.ok ? 'ok' : 'failed')

// ---------- 使用者终验 ----------
const r5 = await runs.run('waizhuan-final', {
  agent: 'waizhuan',
  cwd: root,
  task: `研发 agent 第二轮的报告在 ${feedbackDir}/2026-10-20-r2-yanfa.md。

做最终验收：
1. 实际把关键流程再走一遍（报价→下单→录商品→收款→出PI→出PL→报表）。
2. 明确回答一个问题：**这套系统现在能不能接住我真实的外贸日常？** 能/不能，不能的地方具体是什么。
3. 列出还剩下的问题，按重要性排。
4. 写报告到 ${feedbackDir}/2026-10-20-final.md。

最终回复给我：一份简明结论（能接住日常 / 还差什么）+ 报告路径。`
})

console.log('使用者终验完成:', r5.ok ? 'ok' : 'failed')

return {
  走查: r1.output,
  实现: r2.output,
  复验: r3.output,
  补漏: r4.output,
  终验: r5.output
}
