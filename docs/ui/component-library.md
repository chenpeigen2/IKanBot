# UI 组件库

> 位置：`src/renderer/src/ui/`
> 规范来源：[design-system.md](design-system.md)
> 导入：`import { Button, Card, Field, ... } from '../ui'`

## 为什么要它

改造前全站散落着 **136 处内联 style**、**113 个 `className="btn"`**、**129 个 `className="field"`**、
**4 套各写各的颜色映射的状态标签**。同一件事有很多种写法，改一处要翻十个文件。

组件库把这些收敛到一处：**改一次，全站生效**。

## 组件清单

| 组件 | 替代了什么 | 关键能力 |
|---|---|---|
| `Button` | 113 处 `className="btn ..."` | `variant`（default/primary/ghost/danger/subtle）、`size`、`icon`、`block` |
| `Card` | 29 处 `card`/`card-head`/`card-body` | `title`、`actions`（标题右侧操作区）、`tight` |
| `Field` | 129 处 `field` | `label`、`hint`、`error`、`required`、`labelExtra` |
| `Input` / `Select` / `Textarea` | 裸 `<input>` + 内联样式 | `numeric`（右对齐、等宽数字）、`small` |
| `Alert` | 18 处 `alert info/warn/error` | `kind`（info/warn/error/success）——补上了原来缺的 danger 级 |
| `StatusTag` + 4 个业务标签 | 4 套各自硬编码的标签颜色 | **一张语义映射表**，颜色不跨维度复用 |
| `Row` / `Spacer` / `FieldRow` | 63 处 `row`+`spacer`、26 处 `field-row-3` | 栅格列数 1~4 |
| `KeyValue` | 订单详情条款区的两列排布 | `cols` |
| `TableWrap` / `DataTable` | 46 处 `table-wrap`+`table.data` | 横向滚动容器 |
| `Progress` | 自动更新下载进度 | `percent` + 标签 |

## 语义色映射表（唯一真源）

`StatusTag` 内部按这张表取色，**任何地方都不该再手写 `tag green`**：

| 语义 | class | 用于 |
|---|---|---|
| neutral | `grey` | 草稿、未备货、已作废、客户免单 |
| info | `blue` | 客户已确认、已备货、已转订单、已抵扣 |
| success | `green` | 已收款、已结清、已签收、已清关 |
| warning | `amber` | 待确认、部分收款、备货中、汇率未填 |
| danger | `red` | 已失效（需强调时） |

**出货维度一律 neutral + ✓**（形状区分），不抢绿色的"钱"语义——见 design-system §9.2。

## 工具类（替代内联 style）

| 类 | 用途 |
|---|---|
| `.col-num` / `.col-num-sm` / `.col-num-lg` | 表格数字列宽（88/68/110px），跨页面统一 |
| `.col-date` / `.col-tag` / `.col-action` | 日期列、标签列、操作列 |
| `.sec-top` / `.sec-head` | 区块上边距、小节标题行 |
| `.cell-input` / `.cell-input-sm` | 表格行内输入框 |
| `.tfoot-strong` | 表格合计行底色 |
| `.mt-1`~`.mt-4` / `.gap-1`/`.gap-2` | 常用间距 |

## 约定

1. **新增界面一律用组件**，不要新写 `className="btn ..."` 或 `className="field"`。
2. **改组件样式只改组件文件**，不要在页面里覆盖。
3. 组件里不做业务判断——状态 → 颜色的映射在 `StatusTag.tsx` 一处，页面只传状态值。
4. 组件不引入新依赖（只用 React + 现有 CSS 变量）。

## 检查清单（改完自查）

- [ ] 页面里没有新增 `className="btn` / `className="field`
- [ ] 表格数字列用 `.col-num*` 而不是内联 width
- [ ] 状态标签用 `StatusTag` 家族，而不是手写 `tag green`
- [ ] `npm run typecheck` 零错误
- [ ] `npm run test:e2e` 全绿
