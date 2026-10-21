/**
 * IKanBot 双 agent · 第 7~12 轮迭代（共 6 轮）
 *
 * 接续：前 5 轮循环因 Token 429 中断，第 6 轮由协调员收尾（N23~N34，见
 * docs/feedback/2026-10-20-r6-yanfa-coordinator.md）。
 *
 * 每轮：使用者复验上一轮 + 找新问题 → 研发修复。
 * 单轮失败不中断整体循环。
 */

const root = 'D:/code/IKanBot'
const fb = `${root}/docs/feedback`
const START = 7
const ROUNDS = 6 // 第 7~12 轮

const rounds = []

for (let n = START; n < START + ROUNDS; n++) {
  // 上一轮的两份报告
  const prevVerify = n === START ? '2026-10-20-r6-yanfa-coordinator.md' : `2026-10-21-r${n - 1}-verify.md`
  const prevDev = n === START ? '2026-10-20-r5-verify.md' : `2026-10-21-r${n - 1}-yanfa.md`

  // ================= 使用者：复验 + 找新问题 =================
  let v
  try {
    v = await runs.run(`user-r${n}`, {
      agent: 'waizhuan',
      cwd: root,
      timeoutMs: 1500000,
      task: `【第 ${n} 轮 · 使用者复验】

先读这两份：
1. ${fb}/2026-10-20-r6-yanfa-coordinator.md —— 上一批 8 条（N23 打样费进应收、N24 打样转订单、N25 寄出/签收日期、N26 404、N31 删报价拦截、N32 删客户中文报错、N33 打样三笔分明、N34 存档每版可打开）是协调员替研发做完的，**没有经过你复验，这是本轮第一优先级**。
2. ${fb}/${prevVerify} —— 你上一轮的报告（第 1 轮走查是 2026-10-20-r1-waizhuan.md，找历史问题看它）。

任务：
1. **逐条验收那 8 条**（N23~N34）：每条实际点一遍，已解决/未解决/做歪了，给证据。
   重点点法：
   - 打样单页：新建一张，看有没有 寄出/签收日期、工厂打样费、币种/汇率/汇率日期、收款标记（未收/已收/下单抵扣/免单）、三笔分明展示（样品费应收/快递费垫付/工厂成本/公司净垫）
   - 没填汇率的未收单应该存不了；列表该亮「⚠ 汇率未填」
   - 打样单「转订单」按钮 → 弹窗「不抵扣直接转」/「样品费抵扣」→ 转完跳订单、明细带过去、抵扣的订单里有负费用行
   - 工作台「待收款」应该包含未收打样费；打样费超阈值该有青色圆点的催收提醒
   - 删已转订单的报价单 → 中文报错；删有订单的客户 → 中文报错「有 N 个订单」
   - 订单详情「操作历史」页签最下面的「单据存档」表 → 每行「打开」直接看 PDF、「所在文件夹」定位到文件
   - 手输一个错地址（如 #/xyz）→ 404 页不是白屏
2. **跑三个不变量**（你 agent 定义里那三条）：待收三处一个数、毛利三处一致、PI/CI/报价单/PL 合计一致。
3. **找新问题**：新功能有没有添乱？原来好用的有没有坏？把新的按老格式写出来。
4. 判断饱和度（明确写「已饱和，本轮无新问题」或「仍有 N 个待解决」）。

验证方法照旧：
- npm run build；演示数据（注意：npm run seed 会清空订单/客户/商品并重建，跑它）
- 截图只用 bash scripts/shot.sh <路由> <文件名>（60 秒超时+自动清理，**绝对不要裸跑 electron**）
- 看图用 read 工具读 out/shots/*.png；查库用 node -e "...node-sqlite3-wasm..."

写报告到 ${fb}/2026-10-21-r${n}-verify.md（格式沿用你之前的：逐条验收表 / 本轮新发现 / 饱和度判断 / 给研发的话）。
**时间只有 25 分钟**：8 条验收 + 三不变量做不完就写「验到哪儿、剩什么」，报告写完就算完成。`
    })
    console.log(`r${n} 使用者复验:`, v.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`r${n} 使用者复验异常:`, e && e.message)
    v = { ok: false, output: '' }
  }

  // ================= 研发：修复 =================
  let d
  try {
    d = await runs.run(`dev-r${n}`, {
      agent: 'yanfa',
      cwd: root,
      timeoutMs: 2400000,
      task: `【第 ${n} 轮 · 研发修复】

先读使用者的复验报告：${fb}/2026-10-21-r${n}-verify.md
（如果它因超时没写完，看有没有落盘；没有就把上一轮报告 ${fb}/${prevDev} 里未解决的条目当任务清单）

工作方式（纪律）：
- **一轮只做 3~5 件最要命的**，做完一批立刻跑 typecheck + test:e2e 并写报告，再做下一批。宁可少做，不要超时丢在半路。
- **报告里写「已做」的必须自己点过、能截图证明**；写「没做」的必须真没做。做不完写明原因+下轮做。
- 铁律：改 schema 加迁移不改历史；新增能力打通 services → ipc → preload → shared/api.ts → 渲染进程；中文界面；不引新依赖。
- **金额口径唯一真源**（你 agent 定义里的铁律）：待收/毛利/合计只准有一个计算入口，改任何一处就 grep 所有消费方核对，一致性写成断言锁死。
- 截图只用 bash scripts/shot.sh <路由> <文件名>（绝对不要裸跑 electron，会挂死会话）。

优先级：
1. 使用者打回的（未解决/做歪了）——尤其三不变量对不上的地方
2. 算错钱/丢单据/数据兼容类
3. 她新发现的重要/致命问题
4. 「有点烦」的顺手做

写报告到 ${fb}/2026-10-21-r${n}-yanfa.md：逐条回应（已修/未修+原因）、改了什么文件+界面上哪个按钮、自验方式与结果（typecheck/test:e2e 数字、截图路径）、还剩什么没做。
**时间只有 40 分钟。**`
    })
    console.log(`r${n} 研发修复:`, d.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`r${n} 研发修复异常:`, e && e.message)
    d = { ok: false, output: '' }
  }

  rounds.push({
    round: n,
    verifyOk: v.ok,
    devOk: d.ok,
    saturated: /已饱和/.test(v.output || '')
  })
}

// ================= 汇总 =================
const summary = [
  `# 第 7~12 轮迭代小结（共 ${rounds.length} 轮）`,
  '',
  '| 轮次 | 使用者复验 | 研发修复 | 饱和 |',
  '|---|---|---|---|',
  ...rounds.map(
    (r) => `| ${r.round} | ${r.verifyOk ? '完成' : '失败'} | ${r.devOk ? '完成' : '失败'} | ${r.saturated ? '是' : '否'} |`
  ),
  '',
  '各轮报告见 docs/feedback/。'
].join('\n')

return { rounds: rounds.length, roundsDetail: rounds, summary }
