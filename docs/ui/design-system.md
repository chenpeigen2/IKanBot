# IKANBot 设计规范（v1）

> 面向"每天在电脑前坐 8 小时处理上百行表格"的外贸业务员。
> 目标不是好看，是**看一天不累、找东西不费眼睛**。
> 本文件是施工图：所有值都是 CSS 变量，研发只允许引用变量，不允许再写裸值。
> 落地方式：在 `src/renderer/src/styles.css` 的 `:root` 里定义本文件的变量，
> 其余选择器一律改成 `var(--xxx)`。

---

## 0. 使用原则（硬约束）

1. **不加动效、不加渐变、不加装饰性阴影。** 唯一保留的动效是 toast 入场 0.16s 和 focus 光晕。
2. **一屏内抢眼颜色不超过 3 种。** 状态色只用于状态，不用于装饰。
3. **状态不能只靠颜色区分**（色弱/低质量屏幕）：tag 必须"颜色 + 文字"双编码，文字本身说清状态。
4. **数字列右对齐，表头也右对齐。** 同一列在全系统位置一致。
5. **同一个概念在全系统只有一种控件形态**（状态要么是 tag，要么是 select，不能同屏两种）。

---

## 1. 间距刻度（spacing scale）

只用 4 的倍数。新增间距一律先查表，表里没有就往上取整。

| 变量 | 值 | 用途（唯一） |
|---|---|---|
| `--space-0` | 0px | 复位 |
| `--space-1` | 4px | 图标与文字间隙、tag 上下内边距、chip 内小间隙 |
| `--space-2` | 8px | 按钮之间的间隙、卡片内元素间距、table 行内两个元素的间隙 |
| `--space-3` | 12px | 表头上下内边距、字段组（label+控件）之间的纵向间距、抽屉/弹窗 body 内边距 |
| `--space-4` | 16px | 卡片内容内边距、表格单元格左右内边距、区块之间的纵向间距 |
| `--space-5` | 20px | 页面内容区上下内边距、`.content` 的 padding-y |
| `--space-6` | 24px | 页面内容区左右内边距、topbar 左右内边距 |
| `--space-8` | 32px | 空状态上下留白、报表大区块分隔 |

**当前散值 → 目标值映射（照此改）**

| 现值 | 出现位置 | 改成 |
|---|---|---|
| 2px | `.tag` padding-y、`.chip` padding | `var(--space-1)` |
| 3px | `.tabs` gap、`.timeline-dot` 偏移 | `var(--space-1)` / 保留 3px 定位用（属几何，不属间距） |
| 4px | `.chip-list` gap、`.stat-value` letter-spacing | `var(--space-1)` |
| 5px | `.chip-list` gap、`.btn` gap | `var(--space-1)` |
| 6px | `.btn` padding、`.field-row` gap、`.alert` padding | `var(--space-1)`~`var(--space-2)`（按钮内边距见 §5 按钮规范） |
| 7px | `.tab` 相关、`.sku-matrix` | `var(--space-2)` |
| 9px | `.toolbar` gap、`.tab` padding-x、`.field` margin-bottom | `var(--space-2)` / `var(--space-3)` |
| 10px | `.nav` padding、`.card-head` gap、`.img-grid` gap | `var(--space-2)` / `var(--space-3)` |
| 12px | `.card-head` padding、`.field` margin-bottom、`.table` th padding-y | `var(--space-3)` |
| 13px | `.btn` padding-x、`.tag` padding-x | `var(--space-3)` |
| 14px | `.modal-head` padding、`.stat-grid` gap | `var(--space-4)` |
| 15px | `.stat` padding-y | `var(--space-4)` |
| 16px | `.card-body` padding、`.table` td padding-x | `var(--space-4)` |
| 17px | `.stat` padding-x、`.modal-head` padding-x | `var(--space-4)` |
| 18px | `.card` margin-bottom、`.content` padding、`.modal-body` padding | `var(--space-4)` / `var(--space-5)` |
| 20px | `.content` padding-y、`.toast-wrap` 偏移 | `var(--space-5)` |
| 22px | `.doc-preview` padding、`.modal-head` font-size | `var(--space-5)`（字号见 §2） |
| 24px | `.modal-mask` padding、`.content` padding-x | `var(--space-6)` |
| 44px | `.empty` padding-y | `var(--space-8)` |

---

## 2. 字号层级（type scale）

**统一到整数，禁止 13.5 / 12.5 / 11.5 / 14.5 / 9.5 这类半像素**——半像素在 Windows 缩放 125% 时会发虚，业务员一天看 8 小时会累。

| 变量 | 值 | 行高 | 用途 |
|---|---|---|---|
| `--text-xs` | 11px | 16px | 时间戳、单元格副说明（"含运费保险"）、状态圆点旁的数字 |
| `--text-sm` | 12px | 18px | 所有 label、表头 th、`.hint` 辅助说明、`.stat-label`、`.stat-hint` |
| `--text-base` | 13px | 20px | 正文：表格 td、按钮、输入框、tag、导航项 |
| `--text-md` | 14px | 20px | 卡片标题（`.card-head h2/h3`）、分区小标题（`h3`） |
| `--text-lg` | 16px | 24px | 弹窗标题、品牌名 |
| `--text-xl` | 18px | 24px | 页面主标题（`.topbar h1`） |
| `--text-display` | 24px | 30px | 统计卡大数字（`.stat-value`） |
| `--text-display-sm` | 20px | 26px | 统计卡小数字（`.stat-value.small`）、单据标题 |

**行高变量**

| 变量 | 值 | 用途 |
|---|---|---|
| `--lh-tight` | 1.2 | 大数字、标题 |
| `--lh-normal` | 1.5 | 正文、表格、按钮 |
| `--lh-loose` | 1.6 | 备注、多行说明 |

**半像素全量替换表**

| 现值 | 位置 | 改成 |
|---|---|---|
| 13.5px | `body`、`.nav-item`、`.price-calc .total`、内联 `fontSize: 13.5`（`Customers.tsx:274,418`、`EditOrderModal.tsx:326,380`） | `var(--text-base)`（13px） |
| 14.5px | `.modal-head` | `var(--text-lg)`（16px） |
| 12.5px | `.timeline-main`、`.sku-matrix`、`.sku-matrix input`、`.price-calc`、内联 `fontSize: 12.5` | `var(--text-base)`（13px） |
| 11.5px | `.brand-sub`、`.sidebar-foot`、`.stat-hint`、`.tag`、`.reminder-sub`、`.picker-meta`、`.hint`、`.nav-badge` | `var(--text-sm)`（12px） |
| 10px | `.img-thumb .primary-mark`、内联 `fontSize: 10`（`OrderDetail.tsx:859`、`Orders.tsx` 含运费保险） | `var(--text-xs)`（11px） |
| 25px | `.stat-value` | `var(--text-display)`（24px） |
| 20px | `.stat-value.small` | `var(--text-display-sm)` |
| 17px | `.topbar h1` | `var(--text-xl)`（18px） |
| 16px | `.brand-name` | `var(--text-lg)` |
| 14px | `.card-head h2/h3`、`.tab` | `var(--text-md)` / `.tab` 用 `var(--text-base)` |
| 13px | `.btn`、input/select/textarea、`table.data`、`.timeline-main`、`.picker-main`、`.reminder-title`、`.toast` | `var(--text-base)` |
| 12px | `label`、`table.data th`、`.stat-label`、`.sku-matrix th`、`.timeline-time`(11→12) | `var(--text-sm)` |
| 11px | `.timeline-time`、`.nav-badge`、`.img-thumb .thumb-bar button` | `var(--text-xs)` |

**打印单据（.doc-page）单独一套，不受上面约束**，因为要 1:1 印到 A4：
`9.5pt`（kv、terms、sign-area）、`9pt`（note-block、subtotal）、`10pt`（doc-meta）、`11pt`（正文、doc-title-cn）、`17pt`（doc-title）。**打印单据的字号一栏保持现状，不要动。**

---

## 3. 色彩 token

### 3.1 表面与文字

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#f4f6f9` | 应用底色 |
| `--surface` | `#ffffff` | 卡片、弹窗、表单区 |
| `--surface-2` | `#f8fafc` | 表头背景、小计/合计行背景、`.price-calc` 背景 |
| `--surface-3` | `#eef1f6` | 灰色 tag 背景、表格行分隔线、chip 灰底 |
| `--border` | `#e2e6ee` | 卡片/输入框/分隔线 |
| `--border-strong` | `#cfd6e3` | 输入框边框、按钮边框 |
| `--divider` | `#eef1f6` | 表格行分隔（比 `--border` 更弱） |
| `--text` | `#1c2333` | 正文 |
| `--text-dim` | `#667085` | 次要文字、label、表头（对比度 4.97:1，合格） |
| `--text-faint` | `#5c6878` | **改值**：辅助文字、日期列、"共 N 条"（原 `#98a2b3` 仅 2.58:1，不合格） |
| `--text-inverse` | `#ffffff` | 深色底上的文字 |

### 3.2 语义色

| 变量 | 值 | 用途 |
|---|---|---|
| `--accent` | `#2f6fed` | 主色：主按钮、选中态、链接、焦点 |
| `--accent-hover` | `#2158c9` | 主按钮 hover、浅蓝底上的文字 |
| `--accent-soft` | `#eaf1fe` | 浅蓝底（tag blue、焦点光晕、chip 底） |
| `--success` | `#0f6b4c` | **改值**（原 `#12855f` 在浅绿底上只有 4.09:1） |
| `--success-soft` | `#e4f5ee` | 浅绿底 |
| `--warning` | `#8a5200` | **改值**（原 `#b26a00` 在浅黄底上只有 3.82:1） |
| `--warning-soft` | `#fdf2dd` | 浅黄底 |
| `--danger` | `#a53024` | **改值**（原 `#c0392b` 略偏浅） |
| `--danger-soft` | `#fdeceb` | 浅红底 |
| `--neutral-soft` | `#eef1f6` | 灰色 tag 底 |
| `--neutral-text` | `#5a6577` | 灰色 tag 文字 |

### 3.3 暗色侧边栏

| 变量 | 值 | 用途 |
|---|---|---|
| `--sidebar-bg` | `#131a2a` | 侧边栏底 |
| `--sidebar-text` | `#b9c2d4` | 导航文字（9.7:1） |
| `--sidebar-text-dim` | `#8b97ad` | **改值**（原 `#6f7c94` 仅 4.12:1），用于品牌副标题与底部版本号 |
| `--sidebar-border` | `rgba(255,255,255,0.07)` | 侧边栏分隔线 |
| `--sidebar-active-bg` | `rgba(47,111,237,0.16)` | 选中项底色 |

### 3.4 状态色（tag）唯一映射表

**同一状态在全系统只允许用这一套颜色，不允许出现 `className="tag blue"` 之外的自由色。**

| 语义 | 底色 | 文字 | 用于 |
|---|---|---|---|
| neutral | `--neutral-soft` | `--neutral-text` | 草稿、未备货、已作废、已豁免 |
| info | `--accent-soft` | `--accent-hover` | 客户已确认、已备货、已转订单 |
| success | `--success-soft` | `--success` | 已收款、已结清、已签收、已放行 |
| warning | `--warning-soft` | `--warning` | 待确认、部分收款、备货中、汇率未填 |
| danger | `--danger-soft` | `--danger` | 已失效、作废（需要强调时） |

**状态色之外的"提醒圆点"（`.reminder-dot`）当前有 5 个硬编码色**（`styles.css:649-663`：`--amber` / `--red` / `--accent` / `#7c3aed` / `#0891b2`）**必须全部换成上表五色**，紫色和青色没有语义来源，是纯粹的视觉噪音。

**状态不能只靠颜色**：每个状态 tag 必须自带中文状态词（现有 `.tag` 已经是文字，OK），但同一屏里若两个状态只靠颜色区分（如"待确认"黄 vs "备货中"黄），必须补充区分手段（见 §5 tag 规范）。

---

## 4. 圆角 / 阴影 / 边框 token

| 变量 | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | chip、小角标、图片缩略图内标记 |
| `--radius-md` | 6px | **默认圆角**：按钮、输入框、select、tag、alert、picker 列表 |
| `--radius-lg` | 8px | 卡片、tabs 容器（`--radius` 的现值改名为 `--radius-lg`） |
| `--radius-xl` | 10px | 弹窗（现 `.modal` 硬编码 10px、`.modal-foot` 圆角 10px） |
| `--radius-pill` | 999px | 圆形圆点（`.reminder-dot`、`.timeline-dot`）—— 不要用 50% 混用 |
| `--shadow-1` | `0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.08)` | 卡片、统计卡（现 `--shadow`） |
| `--shadow-2` | `0 8px 28px rgba(16,24,40,0.14)` | 弹窗、toast（现 `--shadow-lg`） |
| `--focus-ring` | `0 0 0 3px var(--accent-soft)` | 输入框焦点唯一光晕 |

**禁用**：不给任何元素加装饰性阴影；`.doc-page` 的 `0 3px 16px rgba(0,0,0,0.3)` 是打印预览的纸张投影，保留。

**边框**
- 1px 通用边框：`--border`
- 1px 输入框/按钮边框：`--border-strong`
- 1px 表格行分隔：`--divider`
- 不允许出现 1.5px / 2px 边框（除 `.img-thumb.primary` 的 2px 焦点环，改用 `--focus-ring` 语义）

---

## 5. 组件规范

### 5.1 按钮 `.btn`

| 变体 | 用途 | 规格 |
|---|---|---|
| 默认 `.btn` | 次要操作（导出 Excel、搜索、关闭） | 高 28px，padding `var(--space-1) var(--space-3)`，字号 `--text-base`，圆角 `--radius-md`，边框 `--border-strong` |
| `.btn.primary` | 唯一主操作（新建、保存、生成） | 同上 + 底 `--accent`，文字 `--text-inverse` |
| `.btn.danger` | 破坏性操作（删除、作废） | 文字 `--danger`，边框 `#e8c4c0` → 改 `--danger-soft` 描边 |
| `.btn.ghost` | 行内文字操作（编辑、删除、预览） | 无边框无底，hover 底 `--surface-3` |
| `.btn.sm` | 表格行内 | 高 22px，padding `var(--space-0) var(--space-2)`，字号 `--text-sm` |

**铁律**
- 同一组操作里，**按钮变体不得超过 2 种**。禁止"2 个描边按钮 + 2 个纯文字链接"混排（订单详情顶部栏现在是 `商业发票 CI`(描边) + `生成 PI`(主) + `作废此单`(文字) + `删除订单`(红文字) 4 种形态）。
- **危险操作统一为 `.btn.ghost.danger`**，不要再单独写红色文字链接。
- 按钮组顺序：主操作在最右（靠右对齐，`.modal-foot` 已 `justify-content: flex-end`）。
- 主按钮文案必须是动词短语（"保存" / "生成装箱单"），不要用"确定"。

### 5.2 输入框 / 下拉 `input, select, textarea`

| 项 | 规格 |
|---|---|
| 高度 | 28px（单行）；padding `var(--space-1) var(--space-2)`；字号 `--text-base`；圆角 `--radius-md`；边框 `--border-strong` |
| 焦点 | 边框 `--accent` + `--focus-ring`，**只有这一种焦点表现** |
| 宽度 | **默认 `width: 100%` 只在表单栅格内生效**；工具栏、表格内、卡片头部的控件必须显式限宽 |
| 工具栏内 select | 宽 160px（与 `.toolbar .search` 的 260px 配套） |
| 表格内 select | 高 22px（= `.btn.sm` 高度），字号 `--text-sm`，`padding: 0 4px`，`width: auto` |
| 弹窗内 select | 宽 100%（在栅格列内），高 28px |

**当前 bug（必改）**：`select.sm` 这个类在 `styles.css` 里**不存在**（`.btn.sm` 只作用于按钮），所以 `Quotations.tsx:171,185` 和 `Samples.tsx:208` 的表格内下拉继承了全局 `width:100%` + 13px + 6px/9px padding，导致：
- 报价列表的"状态""结果"下拉被撑成 160px 宽的大块；
- 打样单列表的"状态"下拉被挤成 30px 宽、只剩一个箭头（`out/shots/samples.png` 第 10 列）。

**改法**：新增
```css
select.sm {
  height: 22px; padding: 0 4px; font-size: var(--text-sm);
  width: auto; min-width: 64px; border-radius: var(--radius-md);
}
```
并把 `Samples.tsx:142` 的"全部状态"筛选下拉加 `style={{ width: 160 }}`（和 `Orders.tsx:72` 一致），目前它是 1160px 满宽。

### 5.3 表格 `table.data`

| 项 | 规格 |
|---|---|
| 表头 th | 高 36px，padding `var(--space-2) var(--space-3)`，底 `--surface-2`，字 `--text-sm` + 600，`--text-dim`，`white-space: nowrap` |
| 数据 td | padding `var(--space-2) var(--space-3)`，字号 `--text-base`，底色 `--surface`，分隔线 `--divider` |
| 行高 | 单行 36px；**长文本必须换行或省略，不得把行撑到 3 行**（见 §5.3.1） |
| hover | 底 `--surface-2`（`#fafbfd` → 与表头同族，现状 `#fafbfd` 与 `#f8fafc` 差一个值，统一为 `--surface-2`） |
| 数字列 | `td.num` 右对齐 + `font-variant-numeric: tabular-nums`；**表头也要加 `.num`** |
| 长文本列 | `max-width` 必设，超出 `text-overflow: ellipsis` + `title` 属性；客户名列上限 220px |
| 操作列 | 最后一列，表头留空；操作按钮用 `.btn.sm.ghost` |
| 横向滚动 | 表格列数上限 **12 列**。超过 12 列必须收进"列设置"或把次要列挪到详情页 |
| 容器 | `.table-wrap` 必须给出 `max-width: 100%`；表格外层不允许出现"表格内滚动 + 页面滚动"双滚动条 |

#### 5.3.1 当前必须修的三处
1. `Orders.tsx:116-128` 订单表 **13 列** + 截图 `out/shots/orders.png` 在 1400px 宽下**已出现横向滚动条**。1366px 笔记本上更严重。→ 目标：≤ 11 列。候选合并：`PI号`（次要，鼠标悬停或进详情看）、`含费用合计`（与 `货值` 合并成一列"货值 / 含费用"）、`预计出货`（与 `创建日期` 合并成"时间"列）。
2. `Samples.tsx:168-180` 打样单表 **14 列**，且表头是双行（`样品费<br/>应收客户`），行高被撑到 68px。→ 目标：≤ 11 列，双行表头去掉（副说明改 `title` 或 tooltip）。
3. `Quotations.tsx:149-157` 报价表 7 列但"状态/结果"用下拉而非 tag，与订单列表的 tag 形态不一致（见 §5.6）。

### 5.4 卡片 `.card`

- 圆角 `--radius-lg`，边框 `--border`，阴影 `--shadow-1`，`margin-bottom: var(--space-4)`。
- `.card-head` padding `var(--space-3) var(--space-4)`，底部 1px `--border`，标题 `--text-md`/650。
- `.card-body` padding `var(--space-4)`；表格类卡片用 `.card-body.tight`（0 padding）。
- **禁止卡片套卡片**：全系统只允许一层卡片。当前"客户与条款"卡片里又嵌了一个带边框的白框（`OrderDetail.tsx:600` 的内联 `border: 1px solid #e2e6ee`），要去掉内层边框，改用 `--divider` 分隔线。
- 内联硬编码 `border: '1px solid #e2e6ee'`（`OrderDetail.tsx:560,600`、`Quotations.tsx:677`、`Samples.tsx:381`）统一换成 `.table-wrap` 或新类 `.boxed`（`border:1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-3)`）。

### 5.5 统计卡 `.stat`

- 一排 4 张（`.stat-grid`，gap `var(--space-3)`）。
- padding `var(--space-4)`；标签 `--text-sm` `--text-dim`；数字 `--text-display`/700/tabular-nums；辅助说明 `--text-sm` `--text-faint`。
- **同一排 4 张卡的数字字号必须一致**（现工作台"在途订单"25px、"待收款金额"20px，混用）。
- **颜色语义化，不是"每张卡一个颜色"**：
  - 默认 `--text`（中性）
  - `--accent`（进行中/主指标）
  - `--success`（已完成/正向金额）
  - `--warning`（需关注/待收）
  - `--danger`（逾期/异常）
  - **同一屏最多 2 张卡上色**（R3 已收紧为 **1 张**，且强调色只用 `--accent`，见 §9.1）。当前工作台 4 张卡用了 蓝/黄/黑/绿 4 种，报表页也是 4 种 → 一屏 4 个抢眼色，等于没有重点。
- 数字缺失统一显示 `--`（`--text-faint`），不要用 `0.00` 冒充"没数据"。

### 5.6 状态标签 `.tag` 与状态控件

- 高度 20px，padding `0 var(--space-2)`，字号 `--text-sm`/600，圆角 `--radius-pill`，`line-height: 20px`，`white-space: nowrap`。
- 颜色严格按 §3.4 映射表。
- **同一状态在全系统只能有一种形态**。当前违规：
  - 订单列表用 tag（`PaymentTag`/`ShipTag`），报价列表用 select（`Quotations.tsx:171,185`），打样单列表用 select（`Samples.tsx:208`）。
  - 订单详情页顶部用 tag 显示"已收款 / 备货中"，右侧"状态推进"卡片又用 select 显示同样的两个状态 —— **同屏两种形态**。
  - **改法**：列表一律 tag（只读），可编辑状态的地方一律在详情页/编辑弹窗里用 select。列表里要改状态就点进详情改。
- 状态 tag 必须**双编码**：颜色 + 文字已足够；但"已收款"与"已结清"都用绿色时，靠文字区分，不要合并成同一个绿 tag。
- tag 内不混装图标符号，`⚠ 汇率未填` 改为纯文字"汇率未填"（`Samples.tsx:199`）。

### 5.7 弹窗 `.modal`

| 项 | 规格 |
|---|---|
| 宽度 | 默认 640px（`.modal`）；`.wide` 1000px；`.xwide` 1240px |
| 圆角 | `--radius-xl`；`.modal-foot` 圆角与其一致（现在硬编码 10px） |
| 头部 | padding `var(--space-3) var(--space-4)`，标题 `--text-lg`/650，下边框 `--border`，关闭按钮 `.btn.ghost.sm` |
| 主体 | padding `var(--space-4)`（现 18px → 16px）；`overflow-y: auto` |
| 底部 | padding `var(--space-3) var(--space-4)`，底色 `--surface-2`（现 `#fbfcfe` → 统一 `--surface-2`），右上边框 `--border`，按钮右对齐 |
| 遮罩 | `rgba(16,24,40,0.42)`，不变 |
| 按钮 | 右对齐，次操作在左、主操作在最右；主操作只能有 1 个 |

**当前违规**
- 关闭按钮文案不统一：PI 预览弹窗底部是"关闭"（`OrderDetail.tsx`），其他弹窗是"取消"（`EditOrderModal`、`Products`、`Quotations`）。→ 统一：**取消 / 关闭 二选一，全系统用"取消"；预览类弹窗的次要按钮叫"关闭"并放在最左**（即：预览弹窗 = 关闭 / 另存为 PDF / 存到系统，取消按钮不使用）。
- 弹窗内**字段栅格行高不齐**：`新建订单` / `新建报价单` 里"币种 / 汇率 / 贸易术语"一行，汇率字段因为带 hint 和日期输入，行高比另外两列高，导致下一行"装运港"整体下移 30px（见 `out/shots/modal-neworder.png`、`modal-quo.png`）。→ 改法：把"汇率日期"从"汇率"字段里拆出来单独成一行，或把 hint 移到 label 的 `title` 上；同一栅格行的字段必须**顶部对齐、控件基线对齐**。
- 弹窗内**三层滚动条**（`新建装箱单`：`out/shots/modal-pl.png` 里 modal-body 滚动 + 箱规表 160px 滚动 + SKU 汇总 180px 滚动）→ 内嵌滚动区只保留 1 个，SKU 汇总去掉 `maxHeight`。

### 5.8 空状态 `.empty`

- 规格：padding `var(--space-8) var(--space-5)`，居中，字号 `--text-base`，色 `--text-dim`（**不是** `--text-faint`，`--text-faint` 在白底只有 2.58:1）。
- 文案两段式：**第一句说结论，第二句说下一步**，两句都要有。
  - 有数据但筛选为空：`当前筛选条件下没有订单（关键词：xxx）。单子没丢——把搜索框或状态页签清空就能看到全部。`（现状已符合，保留）
  - 完全没有数据：`还没有订单。点右上角「新建订单」开始录入。`（现状已符合，保留）
- **需修正**：`Reports.tsx:119` 的 `还没有数据` 只有一句，没有下一步指引；`Dashboard.tsx:88` 的 `暂无待办事项，一切顺利` 缺主语（"没有待办事项"）；`Dashboard.tsx:157` 的 `还没有订单，先去建一个` 与订单页的 `还没有订单。点右上角「新建订单」开始录入。` 措辞不统一。
- 空状态**必须区分"加载中"和"没数据"**：现在用同一个 `.empty` 类，`Dashboard.tsx:86` / `Reports.tsx:117` 写"加载中…"，字号色值与"没数据"完全一样，闪烁时容易误判为空。建议"加载中"用 `--text-faint`，"没数据"用 `--text-dim`。

### 5.9 Toast `.toast`

- 位置：右下角，距边 `var(--space-5)`（20px，现状不变）。
- 底色 `--text`（`#1c2333`），文字 `--text-inverse`；错误态底色 `--danger`。
- padding `var(--space-3) var(--space-4)`，圆角 `--radius-md`，阴影 `--shadow-2`，字号 `--text-base`。
- 成功 2.6s / 失败 5.2s 自动消失（现状 `ui.tsx` 保持）。
- **文案要带对象和结果**：`订单已作废，记录全部保留`（现状合格）；不要用"操作成功"这种无信息文案。
- toast 宽度上限 420px（现状），`white-space: pre-line` 保留（拦截类报错带换行）。

### 5.10 表格内的"主数据"写法

- 金额：统一 `USD 7,575.00`（`money()` 已在 `ui.tsx` 统一，**保持**）。
- 同一格里不塞两个语义：现在订单列表"含费用合计"格里塞了主值 + "含运费保险"副注（`Orders.tsx:139-147`），把该格撑成两行、行高从 36px 变 52px。→ 副注改 `title` 提示或放到表头（表头加 `<br/>` 副说明也可以，但要和其它表的表头统一）。
- 数量与单位：统一 `900 件`（中文单位跟在数字后、空格分隔）；不要出现 `USD 0.00 / 3 件` 这种"金额 / 数量"挤在一格（工作台"最近订单"表"金额"列现状）。
- 金额缺失统一 `—`（`--text-faint`），不要 `0.00`。

### 5.11 导航与图标

- **侧边栏图标不用 unicode 字符**。现状 `App.tsx:15-22` 用 `◧ ✎ ▤ ✂ ▣ ☰ ▦ ⚙` 8 个字符当图标，字形大小/基线各不相同（截图里"打样单"的 `✂` 比"订单"的 `▤` 高出 3px），且 `⚙` 明显偏大。
  - 改法：改用同一套**线性 SVG 图标**（16×16，stroke 1.5px，`currentColor`），装进 `.nav-icon`（宽 16px、高 16px、`display:flex; align-items:center`）。
  - 若这一轮来不及换 SVG，**降级方案**：全部去掉图标，只留文字，靠 `gap` 调整——但不能再保留 8 个 Unicode 字符。
- 导航项高度：`padding: var(--space-2) var(--space-4)`，字号 `--text-base`，左侧 3px 选中条用 `--accent`。
- 侧边栏底部版本号用 `--sidebar-text-dim`（改值后 5.9:1）。

### 5.12 打印单据 `.doc-page`

- A4 210mm × 297mm，padding 14mm/13mm，正文 11pt，`--mono` 不用。
- 表格线统一 `1px solid #333`，表头底 `#f0f0f0`。
- **表头与数据列必须同一对齐方式**：现在 `Amount / 金额` 表头左对齐（`styles.css` `.doc-page th` 无 `.num`），数据右对齐（`td.num`）→ 打印出来表头和数字不在一条竖线上。改法：给 `th` 也加 `.num`（`.doc-page th.num { text-align: right }`）。
- **小计列不要中英拼在一个字符串里**：现在是 `小计 1875.00`（PI/PL/报价单三张都有），中文与数字挤在一起且不参与数字右对齐。改法：小计只放数字（`1875.00`），表头写 `Sub-total / 小计`。
- 合计行（TOTAL / 合计）的单元格必须与上方表头列一一对应（现在 PI 的合计行数量落在 Amount 列上）。

---

## 6. 变量总表（直接贴进 `:root`）

```css
:root {
  /* 间距 */
  --space-0: 0px;  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px;

  /* 字号 */
  --text-xs: 11px;   --text-sm: 12px;   --text-base: 13px; --text-md: 14px;
  --text-lg: 16px;   --text-xl: 18px;   --text-display: 24px;
  --text-display-sm: 20px;
  --lh-tight: 1.2;   --lh-normal: 1.5;  --lh-loose: 1.6;

  /* 表面 / 文字 */
  --bg: #f4f6f9;          --surface: #ffffff;
  --surface-2: #f8fafc;   --surface-3: #eef1f6;
  --border: #e2e6ee;      --border-strong: #cfd6e3;  --divider: #eef1f6;
  --text: #1c2333;        --text-dim: #667085;        --text-faint: #5c6878;
  --text-inverse: #ffffff;

  /* 语义色 */
  --accent: #2f6fed;      --accent-hover: #2158c9;    --accent-soft: #eaf1fe;
  --success: #0f6b4c;     --success-soft: #e4f5ee;
  --warning: #8a5200;     --warning-soft: #fdf2dd;
  --danger: #a53024;      --danger-soft: #fdeceb;
  --neutral-soft: #eef1f6; --neutral-text: #5a6577;

  /* 侧边栏 */
  --sidebar-bg: #131a2a;  --sidebar-text: #b9c2d4;
  --sidebar-text-dim: #8b97ad;
  --sidebar-border: rgba(255,255,255,0.07);
  --sidebar-active-bg: rgba(47,111,237,0.16);

  /* 圆角 / 阴影 */
  --radius-sm: 4px;  --radius-md: 6px;  --radius-lg: 8px;
  --radius-xl: 10px; --radius-pill: 999px;
  --shadow-1: 0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.08);
  --shadow-2: 0 8px 28px rgba(16,24,40,0.14);
  --focus-ring: 0 0 0 3px var(--accent-soft);

  --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}
```

---

## 7. 检查清单（每轮改完自查）

- [ ] 全站没有 13.5 / 12.5 / 11.5 / 14.5 px 字号
- [ ] 全站没有 5 / 7 / 9 / 15 / 17 / 22 px 间距
- [ ] 全站没有硬编码 `#xxxxxx` 颜色（打印单据 `.doc-page` 除外）
- [ ] 每一排统计卡数字字号一致、颜色不超过 2 种
- [ ] 数字列表头与数据同为右对齐
- [ ] 同一状态在列表里只有一种形态（tag 或 select）
- [ ] 所有 `select` 在工具栏/表格内宽度受控
- [ ] 表格列数 ≤ 12，1366px 宽下不出现横向滚动条
- [ ] 文字对比度 ≥ 4.5:1（`--text-faint` 及其所有用法）
- [ ] 没有 Unicode 字符当图标
- [ ] 弹窗内最多两层滚动

---

## 8. R2 增补（2026-10-21）

R1 落地后新增/修订的 4 条规则。

### 8.1 表格内边距（修订 §5.4）

| 位置 | R1 | **R2** | 说明 |
|---|---|---|---|
| `table.data th/td` 左右 | `--space-3` (12px) | **`--space-2` (8px)** | 13 列表省 104px，是消除横向滚动条的主力 |
| `.content` 左右 | `--space-6` (24px) | **`--space-4` (16px)** | 内容区多出 16px 可用宽度 |
| `table.data th/td` 上下 | `--space-2` (8px) | `--space-2` (8px) | 不变，行高 38~39px |

> 实测：订单表 1292 → 1188px，打样单表 1402 → 1290px（容器 1166 → 1182px）。

### 8.2 表格操作列（新增）

```css
.cell-actions { display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end; }
.link { color: var(--accent); font-size: var(--text-base); cursor: pointer;
        white-space: nowrap; background: none; border: none; padding: 0; font-family: inherit; }
.link:hover { text-decoration: underline; }
.link.danger { color: var(--danger); }
```

规则：
1. 操作列**必须有 gap**（`--space-3` = 12px）。禁止把两个文字链直接拼在一起渲染成「编辑删除」。
2. **≥3 个操作**的列，主机位留 1 个文字链，其余收进 `⋯` 菜单（复用 `ui.tsx` 的 `Menu` 组件）。4 个操作挤一列是打样单表横向溢出的主因。
3. 破坏性操作（删除/作废）用 `.link.danger`，**永远放在菜单的最后一项**。

### 8.3 键值清单 `.kv-grid`（新增，替代「拿计算框装条款」）

```css
.kv-grid { display: grid; grid-template-columns: 120px 1fr;
           column-gap: var(--space-4); row-gap: var(--space-2); align-items: baseline; }
.kv-grid > .k { font-size: var(--text-sm); color: var(--text-dim); }
.kv-grid > .v { font-size: var(--text-base); color: var(--text); text-align: left; }
```

规则：
1. **标签列固定 120px，值列左对齐。** 长文本一律左对齐，右对齐只用于「同一列内长度完全相同」的纯数字（金额表）。
2. `.price-calc`（金额计算框，`justify-content: space-between`）**只用于金额计算**（工作台本月收款、样品费合计）。**不要**拿它装字段清单——它会把值推到行尾，长文本列会形成锯齿。

### 8.4 栅格等高（新增）

```css
.grid-2.grid-top { align-items: start; }
```

规则：**左右两列内容长度天然不等时，必须用 `.grid-top`**，不要让 Grid 默认的 `stretch` 把短的那张卡拉成和长卡一样高。典型场景：订单详情的「客户与条款」15 行 vs「状态推进」2 块（实测空白 348px = 68%）。

### 8.5 空值口径（新增）

| 语义 | 写法 | 颜色 |
|---|---|---|
| 没有数据 / 不适用 | `—`（em dash） | `--text-faint` |
| 真的是 0 | `0.00` / `CNY 0.00` | `--text` |

**禁止用 `CNY 0.00` 表示「没录」**——业务员分不清"这单还没录货值"和"这单货值真的是 0"。

### 8.6 R2 检查清单增补

- [ ] 表格列在 1366px 宽下**不出现横向滚动条**（`table.scrollWidth ≤ .table-wrap.clientWidth`）
- [ ] 所有列表页操作列用了 `.cell-actions`，相邻操作**有可见间隔**
- [ ] 操作 ≥3 个的列已收进 `⋯` 菜单
- [ ] 字段清单用 `.kv-grid`，**值列左对齐**
- [ ] 左右两列内容不等长的栅格用了 `.grid-top`
- [ ] 全站「没有数据」只写 `—`，只有真 0 才写 `0.00`
- [ ] 打印单据：合计行的**列槽数 = 表头列数**（PI/报价单 9 列合计行 `colspan="5"`；CI 8 列 `colspan="4"`，不要动）

---

## 9. R3 增补（2026-10-21）

来源：`docs/feedback/2026-10-21-ui-r3-review.md`。本节只增补颜色语义与语言两类规则，不改 §1~§8 已有的间距/字号刻度。

### 9.1 统计卡上色：一屏最多 1 张强调卡，强调色只用 `--accent`

```css
/* styles.css — 删掉 .stat.green / .stat.red，保留 .stat.accent；.stat.amber 只给「需要今天动手」的卡 */
.stat.accent .stat-value { color: var(--accent); }
.stat.amber  .stat-value { color: var(--warning); }
```

规则：

1. **默认全黑**（继承 `--text`）。数字不需要被"装饰"。
2. **一屏最多 1 张**卡上色（`styles.css:501` 的注释原本写 2 张，R3 收紧为 1 张）。
3. 强调色**只用 `--accent` 蓝**。不要再造橙色、绿色、红色版统计卡。
4. **同一个语义跨页必须同色**：「已收到的钱」在订单详情、在报表、在工作台必须是同一个颜色。「待收」同理。

### 9.2 状态色按维度分家：一个颜色不得跨维度复用

```ts
// ui.tsx
const PAY_TAG  = { draft:'grey', sent:'amber', confirmed:'blue', partial:'amber',
                    paid:'green', settled:'green', expired:'red', void:'grey' }
const SHIP_TAG = { not_prepared:'grey', preparing:'amber', packed:'blue',
                    shipped:'blue', cleared:'green', delivered:'green' }   // ← R3：全部改 'grey'
```

规则：

1. **收款维度**用 `PAY_TAG`，**出货维度**用 `SHIP_TAG`，**两套不得共用同一个颜色 class**。
2. R3 默认方案：**只有收款维度上色，出货维度一律 `.tag.grey`（中性底灰）**；出货进度靠**文字**区分（未备货 / 备货中 / 已装箱 / 已发出 / 已清关 / 已签收）。
3. 若业务坚持出货维度也要颜色，另开一套 `.tag.ship-*` class，**不得复用** `.tag.green` / `.tag.blue`。
4. 目标指标：**一屏最多 3 种 tag 底色**（收款 3 种 + 出货中性灰 1 种）。

### 9.3 编号列：`.mono` + `--text`，`.faint` 不用于编号

规则：

1. 列表页的**编号类列**（订单号 / PI 号 / 报价号 / 样品单号 / 款号 / 客户 PO）一律 `.mono` + `--text`。
2. **`.faint` 只用于真·次要信息**（创建日期等）。PI 号这类**唯一对账标识**不得弱化。
3. 可点性由整行 hover 底色（`table.data tbody tr.clickable:hover`）承担，**编号本身不用蓝色链接**——整行可点 + 蓝字 = 双重强调。
4. 截断用 `.cell-clip` / `.clip-100` + `title`，且**截断点要避开区分位**（PI 号要能看到后 2~3 位）。
5. 次要联系方式（国家 / 邮箱 / 电话 / 地址）统一用 `--text-dim`（`#667085`），**同组信息必须同色同档**，不要一列灰一列黑。

### 9.4 表单 label 一律中文

1. **应用内**（弹窗、表单页）的 label **只用中文**。
2. **中英双语只允许出现在 4 种外发打印件**：PI / PL / CI / 报价单（`documents.ts`）。
3. 同一弹窗内不得一半双语一半中文。

### 9.5 表格状态列一律只读 tag

1. 列表页的**状态列一律只读 `.tag`**（20px 高、pill 圆角）；改状态去详情页。
2. 可编辑控件（`<select>`）**不进列表页状态列**。
3. `.select.sm` 的 `min-width` ≥ **80px**，原生箭头不贴字。

### 9.6 统计卡副行多值时不要用中点挤

副行出现两个以上数值时，用 flex + `gap: var(--space-3)`（12px）或直接拆行；**禁止**用 `金额 · 金额` 的中点写法把两个数字挤在一行。

### 9.7 R3 检查清单增补

- [ ] 工作台 / 报表 / 订单详情三个页面的统计卡上色规则一致（同一语义同色）
- [ ] 一屏只有 1 个强调色（其它数值全黑）
- [ ] 绿色只出现在「收款」维度；出货维度不与收款共用颜色
- [ ] 所有编号列灰度一致，且不是 `.faint`
- [ ] 应用内 label 全中文；只有 4 种打印件双语
- [ ] 列表页状态列没有下拉框
- [ ] 输入框里没有硬切掉尾巴的长文本（改宽度，不是改内容）
