---
name: nova-frontend
name_zh: 前端高质量设计
description: Anti-slop, high-craft frontend design: landing pages, brand sites, portfolios, dashboards, product/admin UI, commerce (PDP/PLP/checkout). Reads the brief, sets register + dials, loads references on demand. Never looks AI-templated. Triggers on premium / landing page / dashboard / redesign / give it a soul / /nova-frontend.
argument-hint: "[craft|audit|redesign|bolder|quieter|soul|animate|densify] [目标]"
user-invocable: true
---

# nova-frontend — 技术精湛 · 灵魂鲜明 · 从不廉价

> 一个把"防 AI slop"做到极致的前端设计技能。融合三套生产级方法论：先读懂 brief，
> 定 register 与 dial，再按需加载深层 reference。目标是产出**一眼看不出是 AI 套模板**的界面。
>
> **核心机制**：本技能的深层规则拆分在 `<%= skillDirectory %>/references/` 下。
> SKILL.md 只是路由表 + 常驻底线。**每个阶段只用 `read` 工具读取当下需要的那一个 reference 文件**，
> 不要一次性全读进来。所有规则都是**上下文相关的**——先读 brief，再挑适用的拉进来。
> 一套方法对所有 brief 产出同一个页面，就是失败。

---

## 如何使用（执行顺序）

1. **§0 读懂 brief**：判定 register（brand / product / commerce）与灵魂方向，输出一行 Design Read。
2. **§1 定三个 dial**：SOUL / SPECTACLE / DENSITY，从 brief 推断，不要默默用基线。
3. **两条路都要**：铺 §3 的 premium substrate（读 `design-dna.md`）——这层物理质感让 dashboard 也不廉价。
4. **分流**：
   - **brand** → 挑一个灵魂（`style-personas.md`）+ 造**一个** hero 引擎（`motion-engines.md`）。
   - **product** → 组件系统 + 数据密度（`product-ui.md`）。
   - **commerce** → PDP/PLP 骨架 + 反暗黑模式（`commerce-ui.md`）。
5. **组装页面**，动效必须被动机驱动。
6. **发布前**跑 §6 反廉价扫描（`anti-cheap.md`）+ 完整 pre-flight（`preflight.md`）。

### Reference 路由表（用 `read` 按需加载，路径前缀 `<%= skillDirectory %>/references/`）

| 何时加载 | 文件 |
|---------|------|
| 铺 premium substrate（grain / 排版张力 / OKLCH 色彩 / palette+字体表） | `design-dna.md` |
| brief 指向真实设计系统（Fluent/Carbon/Material/shadcn/GOV.UK…）——附安装命令与官方文档 | `design-systems.md` |
| 造 hero 引擎、GSAP 滚动骨架、动效词汇、reduced-motion、框架集成 | `motion-engines.md` |
| dashboard / admin / 数据表 / 图表 / 表单 / 交互状态（product register） | `product-ui.md` |
| 商品详情 PDP / 列表 PLP / 购物车 / 结账 + 反暗黑模式（commerce register） | `commerce-ui.md` |
| 挑灵魂 / persona，或选字流程与 reflex-reject 字体表 | `style-personas.md` |
| 需要模式名词汇（hero/nav/scroll/gallery 等）或 Apple Liquid Glass 诚实近似 | `patterns.md` |
| 改造已有页面（audit-first，不是推倒重来） | `redesign.md` |
| 完整反廉价黑名单（发布前必扫） | `anti-cheap.md` |
| 最终发布前检查清单 | `preflight.md` |

---

## §0 读懂 Brief（先于一切）

多数 AI 设计之所以差，是因为模型跳过读题、直接套一个默认审美。别这样。

### 0.A 判定 register（这一步分流后面所有决策）

- **brand** — 设计**就是**产品：landing page、品牌站、发布页、作品集、hero 页。要大胆、有观点、有奇观。走灵魂 + hero 引擎路线。
- **product** — 设计**服务于**产品：dashboard、admin、分析、数据表、app 外壳、设置。为清晰 / 密度 / 可用性优化。走组件系统路线。仍然从不廉价（继承 substrate + 反廉价黑名单）。
- **commerce** — 混合态：按具体页面的任务分流：卖**单个 hero 商品**的 PDP 偏 brand（挑灵魂但保持规格/评价/信任信号的高密度）；**多 SKU 的 PLP/市场**偏 product（高密度、低 spectacle）。拿不准就问一句："这页是卖一个产品的氛围，还是帮人比较筛选很多个？"

**先读项目记忆**：若项目根有 `PRODUCT.md` / `DESIGN.md`，先读，它**覆盖**你的猜测。已有品牌色/字体时——身份保留优先，reflex-reject 列表只对全新决策生效。

### 0.B 生成一行 Design Read（写代码前必出）

格式：`Design Read: {行业} · {2-3词灵魂} · register={brand|product|commerce} · SPECTACLE={n} · hero-engine={类型}`

例：`Design Read: 深空天文 · 电影感+庄严 · register=brand · SPECTACLE=8 · hero-engine=Three.js 粒子星系`

**输出 Design Read 后先停，等用户确认方向或纠偏，再进 §1。** 除非用户已明确说"直接做"。

### 0.C brief 模糊时，只问一个问题，别瞎猜

一个尖锐的问题胜过五轮错误默认。问那个最能改变产出的："这该偏克制编辑感，还是极致奇观？" / "离开 10 秒后你希望访客记住什么？"问完等答案。

### 0.D Anti-Default 纪律（最常被考的 AI tell）

先说出这个 brief 的**懒惰默认**，再打败它："咖啡品牌 → 默认是暖米色 + 黄铜衬线。我拒绝它，改用 {x}，因为 {理由}。"
**两个高度都要查**：一阶（能从**行业本身**猜出主题+配色吗？"AI SaaS → 紫色辉光 + Inter"）；二阶（能从**行业+你的反参照**猜出吗？"不做 SaaS 米色的 AI 工具 → 编辑体排版"）。两个答案都不明显才算过。完整 reflex 列表见 `anti-cheap.md` §0。

---

## §1 三个 Dial

从 Design Read 明确设定，别默默用基线。它们驱动下游一切。

| Dial | 1–3 | 4–6 | 7–10 |
|------|-----|-----|------|
| **SOUL** — 个性/品牌化程度 | 中性、安全、系统默认 | 有清晰 vibe | 独一无二、不可复制的身份 |
| **SPECTACLE** — 视觉引擎的技术野心（本技能的招牌 dial） | 纯静态 + CSS | GSAP 滚动、Canvas 2D 点缀 | Three.js/GLSL/WebGL-FBO hero、生成式、滚动钉住的电影感 |
| **DENSITY** — 每屏信息量 | 通透、一屏一个想法 | 平衡 | 编辑级、数据密集 |

**快速预设**（有更强信号立刻覆盖）：landing(无其他线索) `SOUL7/SPEC6/DEN4` · agency/creative landing `8/8/3` · 高端消费 `8/5/3` · portfolio `8/6/3` · editorial `8/4/6` · tech/AI/SaaS 营销 `6/7/5` · B2B/企业 `4/3/6` · dashboard/analytics（product）`4/2/9` · PDP `6/4/6` · PLP `3/2/8` · public-sector/信任优先 `3/2/5`。

**"SPECTACLE 声称即兑现"（强制）**：若 `SPECTACLE ≥ 7`，页面必须真有一个能跑的视觉引擎（真实 Three.js/Canvas/GLSL/滚动钉住），能优雅降级，中端设备维持 60fps。声称 8 却发一个渐变色块 = 破损。做不出就把 dial 降到 4，发一个打磨到位的静态页。永远别半吊子做个会卡/断裂的引擎。

---

## 常驻底线（即使不读任何 reference 也必须遵守）

这些是三套方法论里最高频、最致命的 tell。**下面每一条都是发布阻断项**，完整清单在 `anti-cheap.md`：

1. **Em-dash（`—`）完全禁用**——标题、eyebrow、pill、正文、引用、署名、按钮、alt 文本，一个都不许有。这是 #1 AI tell。用句号、逗号或重构句子。en-dash（`–`）当分隔符同禁；范围用连字符（`2018-2026`、`€40-80k`）。
2. **禁 div 假截图**——不用 `<div>` 拼假 dashboard/假任务列表/假终端。用真截图、生成图、真组件预览，或干脆不放。
3. **禁渐变文字**（`background-clip:text` + gradient）作默认花活。用单色，靠字重/字号强调。
4. **禁 AI 紫/蓝辉光**——紫色渐变按钮、霓虹网格背景、发光 CTA 作默认。用中性底 + 一个高对比强调色。`#6366f1`（通用靛蓝）是 AI UI 最被滥用的 hex，别默认伸手。
5. **禁假精确数字**——`92%`、`4.1×`、`5.8mm` 之类为凑规格感编造的。要么有真实来源，要么标注 mock，要么删掉。
6. **eyebrow 限量**——标题上方那个小号大写宽字距标签，每 3 个 section 最多 1 个（hero 算 1 个）。机械检查：数 `uppercase tracking` 小标签数量，超过 `ceil(sectionCount/3)` 就失败。
7. **禁纯 `#fff`/`#000`**、硬 `#333` 边框、亮底上的纯黑投影。用向品牌色微调的中性色、半透明边框、带色相的投影。
8. **一个强调色锁全页**——暖灰站不能在第 7 节冒出蓝色 CTA。选定即锁死，发布前逐组件审。
9. **禁默认品类配色**——craft/heritage 的米色+黄铜、AI/SaaS 的紫辉光——先命名、再拒绝。
10. **图片隐含的 brief 必须有真图**（餐厅/酒店/时尚/旅行/食品/产品）——零图片是 bug 不是极简。纯文本 + 渐变色块不是 hero。

---

## 命令（可选精确入口；自然语言也会触发）

首词匹配命令则按该命令流程走；不匹配但意图清晰也路由过去；无参数则推荐 2-3 个最高价值命令让用户确认，别自动跑。

| 命令 | 类别 | 做什么 | 主要 reference |
|------|------|--------|---------------|
| `craft [brief]` | 构建 | 完整流程：Design Read → dial → substrate → 引擎 → 组装（默认） | 全部 |
| `audit [目标]` | 评估 | **只读**诊断：跑反廉价 + spectacle-shown + pre-flight，输出问题列表，**不改代码** | `anti-cheap.md` `preflight.md` |
| `redesign [目标]` | 迭代 | 升级已有页面，audit-first，绝不为单个抱怨推倒重来 | `redesign.md` |
| `bolder [目标]` | 精修 | SPECTACLE +2，引擎升一档（Canvas→Three.js） | `motion-engines.md` |
| `quieter [目标]` | 精修 | SPECTACLE −2，降到 GSAP/CSS-only，压掉过载 | `motion-engines.md` |
| `soul [目标]` | 精修 | 页面"感觉很通用"时重挑 persona | `style-personas.md` |
| `animate [目标]` | 增强 | 只加/换 hero 引擎，只动动效，不碰配色/布局/文案 | `motion-engines.md` |
| `densify [目标]` | 增强 | 调 DENSITY ±，增删内容 | `product-ui.md` |

---

## 发布前

说"完成"之前，必须跑 `anti-cheap.md` 的反廉价扫描 + `preflight.md` 的完整检查清单。任一硬规则不过 = 发的是破损的活，先修再交付。
