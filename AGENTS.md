# IKanBot 项目规则

> 本文件对所有在本仓库工作的 agent 生效。Owner 全局规则（TDD 等）另行注入，优先级更高。

## 一、界面更新必须带截图证据（每次，无例外）

凡改动渲染层（`src/renderer/`、单据渲染 `src/shared/documents.ts`、`src/shared/ui*`），当轮必须：

1. **截图矩阵**：用 `bash scripts/shot.sh` 为每个**受影响的页面 × 交互状态**截图——
   弹窗、单据预览（PI/CI/报价/PL）、确认框、收款/核销对话框、状态标签、设置卡片，
   凡是按钮点得出来的状态都要有图；新增页面/弹窗必须全量截图。
2. **索引与对照**：每张图配一行说明——这是什么状态、对应 `scripts/e2e-test.ts` 里哪些断言
   （数据层断言没有画面，注明「无 UI 形态，证据为断言输出」即可）。
3. **入库位置**：截图提交进 `docs/ui/<轮次或主题>/`；**不放 `out/`**（那是 gitignore 的临时目录，搬机即丢）。
4. **README 同步**：`README.md` 的「界面与测试对照」一节同步更新索引链接。
5. **同一提交**：截图、索引、README 更新与界面实现放在同一提交里（测试与文档不落后于代码）。

看图用 read 工具直接读 png；截图一律走 `scripts/shot.sh`（自带超时清理），**绝不要直接跑 electron**，会把会话卡死。

## 二、每轮迭代收尾必须发小版本（每次，无例外）

复验 `VERDICT: 通过` 且提交落盘后，当轮收尾动作：

1. `npm version patch --no-git-tag-version`（0.5.1 → 0.5.2 → …）+ `chore: 版本号 X → Y` 提交
2. 打 tag `vY` 并 push main + tag，由 CI 构建发布 GitHub Release（Windows/macOS/Linux）
3. 发布前全量测试必须绿（`npm run test:all` + `typecheck`）；复验打回、返工未完成，不发版
4. 发布后核对 Release 资产齐不齐（安装包/便携版/latest.yml），缺了要记账
5. 不挪已发布的旧 tag；坏了就发下一个版本修

## 三、双 agent 迭代流程（既定）

- `yanfa`（研发）实现 → `waizhuan`（使用者）实跑复验 → 打回则返工；流水线脚本在 `workflows/`。
- 报告写 `docs/feedback/<日期>-r<N>-yanfa.md` / `-verify.md`；复验报告末行 `VERDICT: 通过` 或 `VERDICT: 打回`。
- 每轮记账进 `docs/backend-plan.md`，照现有条目风格。
- 报告纪律：写了「做了」的必须真验过；每条标「已做并验过 / 已做但没验 / 没做（原因）」。
