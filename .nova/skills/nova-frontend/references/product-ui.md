# Product UI — Dashboard / Admin / 数据应用

> **中文说明**：product register 的完整规则——dashboard、admin、分析、数据表、app 外壳、设置页为清晰/密度/可用性优化。
> **何时加载**：register=product 时；`densify` 命令；任何 dashboard/admin/数据表/图表/表单任务。
> **核心**：SPECTACLE 1–4、DENSITY 6–9；奇观不是目标，工艺仍是。继承 substrate + 反廉价黑名单（见 `design-dna.md`、`anti-cheap.md`）。

---

## 1. Product Register 哲学

**Product slop test**：不是"会不会被说 AI 做的"。熟悉感在这里常常是优点。测试是：熟悉该品类最佳工具（Linear、Figma、Notion、Stripe）的用户能否直接信任这个界面，还是在每个 subtly-off 的组件前停顿？

失败模式不是平淡，而是**无目的的怪**：过度装饰按钮、不匹配的表单控件、多余动效、标签处用 display 字体、为标准任务发明奇怪 affordance。标准是**赢得的熟悉感**——工具消失进任务里。

---

## 2. Layout Shell 与信息架构

**标准 shell**：sidebar（桌面 240px / 折叠 60px 仅图标 / 移动 drawer）+ topbar（56–64px：面包屑、页面操作、用户菜单）+ content（`max-width: 1400px`，`repeat(auto-fit, minmax(280px, 1fr))` 网格）。

- **Nav IA**：顶层 ≤8 项；分组 main / config / account（account 钉底部）；组间 24px。图标 **+** 标签始终（禁止 icon-only）。选中态必须明显（左条或 bg fill）。
- **深度 ≤3 级**。深度 ≥3 时显示面包屑；每级可点击，当前级 dimmed。
- **移动 bottom-nav ≤5 项**，标签始终可见。
- **首屏有存在理由**：关键指标/状态无需滚动或交互即可读到。

---

## 3. 数据表

- **对齐**：数字/百分比/货币 **右对齐**（`tabular-nums`）；文本/日期 **左对齐**；状态 badge 左或中。不可谈判——眼睛靠这个扫量级。
- **列宽**：id/time/status 固定 80–120px；name/description 用 `1fr`；数字列窄。桌面禁止横向滚动。
- **行密度（三档锁一档）**：compact 32–36px（100+ 行）· normal 40–48px · comfortable 56–64px。移动最小 44px。
- **排序**：可排序列 hover 显示箭头；激活 = 粗 header + ▲/▼ + `aria-sort`。
- **筛选**：表上方；反映 "N results"；一键 clear-all。
- **分页**：10/25/50/100 每页；显示 "N total, X–Y shown"；当前页高亮。
- **空状态**：图标 + "no data" + 原因/下一步 + CTA——禁止空白网格。
- **Loading**：骨架行匹配真实行高（预留空间、消灭 CLS），禁止居中 spinner 独占。

---

## 4. 图表选择

按数据回答的问题选，不是按好看选：

| 问题 | 图表 | 避免 |
|------|------|------|
| 时间趋势 | line / area（单系列）；multi-line（≤4 系列） | 用 stacked bar 表趋势 |
| 类别对比 | bar；标签长时用 horizontal bar | >5 类用 pie |
| 部分占整体 | pie/donut（≤5 片）；比例随时间用 100% stacked | 3D pie（永远禁） |
| 分布 | histogram, box plot | pie |
| 相关性 | scatter；第三变量 = bubble size | line |
| 排名 | horizontal bar；排名变化用 slope | vertical bar（标签裁切） |
| 层级/流向 | treemap, sankey | pie |
| 地理 | choropleth / bubble map | 单放 table |
| 日历活动 | calendar heatmap | line |

**规则**：≤5–6 色可访问 palette（禁止纯红绿配对作唯一信号，加 texture/pattern）；网格线低对比；数据 ≥3:1、标签 ≥4.5:1；图例可见且可交互；hover/tap tooltip；**无 3D、无旋转轴标签**；空图表 → "no data"，禁止空白。

---

## 5. 表单

- **Label 在输入框上方**（默认，移动友好）；仅密集设置屏左对齐。禁止 placeholder 当 label。
- **必填标记**（`*` 或 "(required)"）；label 12–14px、weight 500；`htmlFor` 匹配 `id`。
- **Blur 校验**（及时、不 nag）；提交时列全部错误；on-change 仅用于实时检查（如用户名可用性）。
- **错误在字段下方**，红字 + `aria-invalid` + `aria-describedby`，说清**原因 + 修法**（"Password needs 8+ chars" 不是 "Invalid"）。
- **六态全发**：default / hover / focus（2px accent ring）/ disabled / error / success。
- **分组**：`fieldset` + `legend`，组间 24–32px。多步：步骤指示 + 进度，每步校验。

---

## 6. 五种交互状态（必须全部实现）

- **Loading**：视图/表用 skeleton（匹配最终形状）；按钮提交才用小 spinner。>~300ms 必须有反馈。
- **Empty**：图标/插画 + "缺什么 + 为什么 + 下一步" + CTA。有构图，不是 void。
- **Error**：字段级（输入下方）· 表单级（顶部列问题+位置）· 全局/网络（toast 或居中，带 retry）。
- **Success**：`aria-live="polite"` toast 3–5s，或页面级确认含关键事实（订单号、时间戳）+ 下一步。
- **Disabled**：`opacity: .5; cursor: not-allowed; pointer-events: none`。用于条件未满足，不是 mystery。

---

## 7. 组件系统

标准组件清单：**Button · Input · Label · Form · Select · Checkbox · Radio · Textarea · Switch · Calendar · Slider**（输入）· **Card · Tabs · Accordion · Table · Breadcrumb**（布局）· **Dialog · AlertDialog · Drawer · Popover · Command(⌘K)**（overlay）· **Toast · Alert · Progress · Skeleton**（反馈）· **Avatar · Badge**（展示）。

- **Modal 纪律**：编辑优先 inline 或 Drawer；Dialog 用于确认/小表单；AlertDialog 用于破坏性操作。禁止嵌套 modal；禁止 <300px dialog。
- **词汇一致性（发布前 audit）**：一个 intent 一个 button variant（default/outline/destructive）；一套 card padding；一套 icon size；一套 radius scale；语义色 token（`text-foreground`、`bg-muted`）禁止硬编码 hex；间距只在 4px 网格上。

---

## 8. 认知负荷

- **削减无关负荷**：模糊 nav、含糊标签（"Options" → "Display settings"）、视觉 clutter、不一致模式、冗余步骤、重复信息。
- **结构化内在负荷**：多步步骤指示；**渐进披露**（高级筛选折叠、罕见操作收起、可选字段分组）；合理默认/示例。
- **工作记忆 ≤4–5 选择/屏**；表屏 10–20 行；nav 深度 ≤3。
- **Nielsen 启发式**作 review rubric（每项 0–4）：状态可见 · 匹配真实世界 · 用户控制与 undo · 一致性 · 错误预防 · 识别优于回忆 · 灵活/快捷 · 极简设计 · 错误恢复 · 帮助。<20/40 → 重做。

---

## 9. Product Token 与密度

三层 token：**primitive**（`--blue-600:#2563EB`、`--space-4:1rem`）→ **semantic**（`--color-primary`、`--spacing-section`）→ **component**（`--button-padding`、`--card-padding`）。

Palette 起点见 `design-dna.md` §6（Trust SaaS、Financial dark、Analytics dashboard 等）。按产品域选，不是默认——不是每个 dashboard 都是 Trust SaaS 蓝橙。

- **间距**：4px 基（4/8/12/16/24/32/48）。比 marketing 更密。永远 token，禁止 hardcode。
- **字号刻度（fixed rem，非 `clamp()`）**：12 / 14 / 16 / 18 / 20 / 24px。product 用户在固定 DPI 屏上；靠改列数响应，不靠字号（表必须对齐）。
- **Radius/elevation**：锁一套 scale。多数组件 md radius + md shadow；cards lg+lg；inputs sm，shadow 仅 focus；modal lg + xl shadow。
- **UI 字体**：高可读 sans（`-apple-system, 'Segoe UI', Roboto, Inter, sans-serif`）；data/code 用 mono。UI 标签无 serif/script。dark mode 独立测，不是反色。

### 排版精度（product substrate 补充）

- **防孤字**：heading 用 `text-wrap: balance`；多行正文 `text-wrap: pretty`。
- **Card CTA 底对齐**：card grid 里 CTA 必须 bottom-lock——card 用 `display:flex; flex-direction:column`，CTA 上 `margin-top:auto`。
- **定价表 baseline**：并排 plan 对比时，feature 列表 Y 坐标跨列对齐。用匹配 `min-height` 或 `align-items:start` + 描述块固定 padding。
- **光学补偿**：数学居中 ≠ 视觉居中。play 按钮、icon-button 内图标、圆形 avatar 首字母加 1–2px `translateY` 或不对称 padding。

---

## 10. 动效（product 专属）

- **150–250ms** 大多数过渡。用户在 flow 中，别让他们等编排。
- **动效传达状态**，不是装饰。状态变化、反馈、loading、reveal——仅此而已。
- **无编排式 page-load 序列**。product 加载进任务；用户不想看它 load。

---

## 11. Product 反模式（补充黑名单）

- **装饰动效**不传达状态（hover 弹跳/橡皮筋）→ 只用 `ease-out` 阴影/透明度反馈。
- **UI 标签/按钮/数据用 display/serif 字体** → system sans。
- **重造标准控件**（custom checkbox div）→ 标准可访问组件。
- **Modal-first** 处理一切 → inline / drawer 优先。
- **组件词汇不一致**（同一 action 不同 look）→ 锁 variant。
- **Spinner-only loading** 引发布局 shift → skeleton。
- **图表/状态仅用颜色作信号** → 加 icon/text/pattern。

完整反廉价清单见 `anti-cheap.md` §3 product 特有项。

---

## 12. Product Pre-Flight

- [ ] IA ≤3 级，sidebar ≤8 分组项，首屏关键信息可见。
- [ ] 表：对齐规则、锁定行密度、sort/filter/pagination、empty + skeleton。
- [ ] 图表：类型匹配问题、legend + tooltip、无 3D、可访问 palette；颜色非唯一信号。
- [ ] 表单：label 在上、必填标记、blur 校验、错误在下含修法。
- [ ] 五态全发（loading/empty/error/success/disabled）。
- [ ] 组件词汇一致；modal 节制；token 非 hardcode。
- [ ] dark mode 对比独立测；触摸目标 ≥44px。
- [ ] 仍过 substrate + 反廉价黑名单（dashboard 不是廉价的借口）。

完整发布清单见 `preflight.md`；commerce 结账表单细节亦引 `commerce-ui.md`。
