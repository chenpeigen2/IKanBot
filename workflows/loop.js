/**
 * IKanBot 双 agent 迭代循环
 *
 * 使用者 agent（绍兴服装外贸业务员）↔ 研发 agent 交替迭代。
 * 每轮：使用者复验上一轮改动 + 找新问题 → 研发修复 → 再复验。
 * 产出：docs/feedback/round-N-*.md，以及轮次小结。
 *
 * 单独一轮失败不会中断整体循环（catch 后继续下一轮）。
 */

const root = 'D:/code/IKanBot'
const fb = `${root}/docs/feedback`
const MIN_ROUNDS = 12
const MAX_ROUNDS = 18

const rounds = []
let saturatedStreak = 0

for (let n = 1; n <= MAX_ROUNDS; n++) {
  const prev = n === 1 ? '2026-10-20-r1-waizhuan.md' : `2026-10-20-r${n - 1}-verify.md`
  const prevImpl = n === 1 ? '2026-10-20-r1-waizhuan.md' : `2026-10-20-r${n - 1}-yanfa.md`

  // ================= 使用者：复验 + 找新问题 =================
  let v
  try {
    v = await runs.run(`user-round-${n}`, {
      agent: 'waizhuan',
      cwd: root,
      timeoutMs: 1500000,
      task: `【第 ${n} 轮 · 使用者复验】

你上一轮的走查报告：${fb}/${prev}
研发上一轮的实现报告：${fb}/${prevImpl}
（如果 ${prevImpl} 不存在，说明研发那一轮超时或失败了，那你就把上一轮的成果当成"没做"来处理，自己重新验）

请**实际跑起来验**，不要只读代码：
1. 构建与造数据：
   - npm run build
   - npm run seed（会清空订单/客户/商品，重建演示数据）
   - 截图：**只用这个脚本**（自带超时和清理，不会卡死会话）：bash scripts/shot.sh <路由> <文件名>
     要先点开弹窗再截：bash scripts/shot.sh <路由> <文件名> '(()=>{...click()...})()'
   - **绝对不要直接跑 node_modules/.bin/electron .**（GUI 应用异常时不退出会永久卡住会话）
   - 看图用 read 工具读 out/shots/*.png
2. 验上一轮研发声称做完的事：**逐个点**，确认真的能用、真的省了你的事。信他的报告不如自己点一遍。
3. 找出**新问题**。这是本轮最重要产出：
   - 你现在用得顺手了吗？哪里还是会让你卡住半天？
   - 有没有新加的功能反而添乱了？
   - 有没有原来好用的地方被改坏了？（客户信息自动带到单据、收款自动改状态、款号自带尺码色表、金额自动重算——这些不能退化）
   - 有没有"看起来做了，其实没解决问题"的？
4. 判断**饱和度**：如果这一轮你找不到任何真实的新问题、上一轮的都验过了，就明确写"已饱和，本轮无新问题"。

写报告到 ${fb}/2026-10-20-r${n}-verify.md：
# 第 ${n} 轮 · 使用者复验

## 上一轮成果验收
（逐条：已解决 / 未解决 / 做歪了 + 你的证据）

## 本轮新发现的问题
（同痛点清单格式：场景 / 我现在的做法 / 痛在哪 / 想要什么 / 重要性）

## 饱和度判断
（明确写「已饱和，本轮无新问题」或「仍有 N 个待解决」）

## 给研发的话

最终回复给我：报告路径 + 本轮新问题数 + 饱和与否。`
    })
    console.log(`第 ${n} 轮 使用者复验:`, v.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`第 ${n} 轮 使用者复验异常:`, e && e.message)
    rounds.push({ round: n, phase: 'verify', ok: false, error: String(e && e.message) })
    // 注意：**不要 continue 跳过研发轮**。
    // 使用者超时往往只是没写完报告，报告文件通常已经落盘。
    // 跳过的��候那一轮的问题就全部搁浅了（��第 4 轮 7 条一条没修就是这个原因）。
    if (!v) v = { ok: false, output: '' }
  }

  if (v.ok && /已饱和/.test(v.output || '')) {
    saturatedStreak += 1
  } else {
    saturatedStreak = 0
  }

  // ================= 研发：修复 =================
  let d
  try {
    d = await runs.run(`dev-round-${n}`, {
      agent: 'yanfa',
      cwd: root,
      timeoutMs: 2400000,
      task: `【第 ${n} 轮 · 研发修复】

使用者的复验报告在 ${fb}/2026-10-20-r${n}-verify.md。**先读它**。

工作方式（重要，上一轮你超时了）：
- **一轮只做 3~5 件最要命的事**，做完立刻写报告，再考虑下一批。宁可少做，不要做到一半没写报告。
- 每做完一批就跑一次 npm run typecheck && npm run test:e2e，别攒到最后一起爆。

优先级（按这个顺序）：
1. 她打回的**未解决 / 做歪了**的问题
2. **算错钱**、**丢单据**、**数据兼容**这三类（财务和留痕风险最高）
3. 她新发现的**重要 / 致命**问题
4. 剩下"有点烦"的

铁律照旧：
- 改 schema 加迁移（MIGRATIONS 追加 version: N+1），绝不能改历史那条
- 新增能力打通 services → ipc/index.ts → preload/index.ts → src/shared/api.ts → 渲染进程
- typecheck 零错误；test:e2e 全绿且为新功能加断言
- 中文界面、中文注释和报错
- 不引入新依赖
- 跑起来截图自验，别只看代码就宣布完成

特别注意：
- 报价单和订单是两类东西，报表口径必须分开：草稿、以及未正式发出的报价，都不能进销售额/毛利/待收款
- 不要破坏已确认的设计（款号自带尺码色表、收款自动流转、出货独立状态线、一单多款号多SKU、一单多PL、A4中英双语、PI带主图PL不带、汇率手工填）

写报告到 ${fb}/2026-10-20-r${n}-yanfa.md：
- 逐条回应她的打回（已修 / 未修 + 原因）
- 这一轮做了什么（改了什么文件，界面上是哪个按钮/哪个页面）
- 自验方式与结果（typecheck / test:e2e 输出、截图）
- 还剩什么没做

最终回复给我：改动清单 + 测试结果 + 报告路径。`
    })
    console.log(`第 ${n} 轮 研发修复:`, d.ok ? 'ok' : 'failed')
  } catch (e) {
    console.log(`第 ${n} 轮 研发修复异常:`, e && e.message)
    rounds.push({ round: n, phase: 'dev', ok: false, error: String(e && e.message) })
    continue
  }

  rounds.push({
    round: n,
    verify: (v.output || '').slice(0, 400),
    dev: (d.output || '').slice(0, 400),
    saturated: /已饱和/.test(v.output || '')
  })

  // 连续两轮饱和则提前收尾
  if (saturatedStreak >= 2 && n >= MIN_ROUNDS) {
    console.log(`连续两轮饱和，在第 ${n} 轮收尾`)
    break
  }
  // 到达最小轮次前不因饱和退出
  if (n >= MIN_ROUNDS && saturatedStreak >= 2) break
}

// ================= 汇总 =================
const summary = [
  `# IKanBot 双 agent 迭代小结（共 ${rounds.length} 轮）`,
  '',
  '| 轮次 | 使用者新问题 | 研发修复 | 饱和 |',
  '|---|---|---|---|',
  ...rounds.map((r) => `| ${r.round} | ${r.saturated ? '无' : '有'} | ${r.ok === false ? '失败' : '完成'} | ${r.saturated ? '是' : '否'} |`),
  '',
  '各轮报告见 `docs/feedback/`。'
].join('\n')

return { rounds: rounds.length, saturatedStreak, summary }
