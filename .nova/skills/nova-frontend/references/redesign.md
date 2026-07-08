# Redesign — Audit-First 重设计协议

> **中文说明**：改造已有页面时的专用流程——audit-first，绝不为单个抱怨推倒重来。
> **何时加载**：`redesign` 命令；brief 含 "redesign/improve/polish/fix/upgrade" 或现有 HTML/截图/URL。
> **核心**：先审计记录现状，再按杠杆优先级 targeted fix；保护规则内元素不动，除非明确批准。

---

## 1. 模式判定（第一步）

| 模式 | 条件 | 做法 |
|------|------|------|
| **greenfield** | 无现有站点，或 full overhaul 已批准 | 从 Design Read + dial 基线走完整 craft 流程 |
| **redesign-preserve** | 现代化但不破品牌 | audit first → 提取 brand token → 渐进演化 |
| **redesign-overhaul** | 新 visual language + 现有内容 | visual 当 greenfield；**保留内容与 IA** |

**模糊时问一句**：*"Should this redesign preserve the existing brand, or are we starting visually from scratch?"*

检测到 redesign 信号时：**不要立刻生成新代码**。进入 §2 审计。

触发信号：现有 HTML/CSS/JS、"redesign/improve/polish/fix/upgrade"、live page URL 或截图。

---

## 2. 审计清单（动手前记录）

Document 当前状态，**先记 failure，暂不 fix**：

### 2.A 品牌与 token
- [ ] Primary / accent colors、type stack、logo treatment、radii
- [ ] 现有 dial 读数（推断 SOUL / SPECTACLE / DENSITY）——这是起点，不是基线
- [ ] SEO baseline：ranking pages、meta titles、structured data、OG cards（**SEO migration 是 #1 redesign 风险**）

### 2.B 信息架构与内容
- [ ] Page tree、primary nav、key conversion paths
- [ ] Content blocks：什么存在、什么在工作、什么是 filler
- [ ] **Patterns to preserve**：signature interactions、recognisable hero、copy voice
- [ ] **Patterns to retire**：AI-slop tells、broken layouts、dead links、generic stock、perf traps

### 2.C 七类扫描（对照现有页）

**Typography**
- [ ] Display heading 负 tracking + line-height < 1.0？
- [ ] Heading vs body weight contrast（如 800 vs 300）？
- [ ] 孤字？需 `text-wrap: balance` / `pretty`？
- [ ] Mixed-family emphasis（sans 标题塞 serif 词）？
- [ ] 字体选择有 stated reason 还是 reflex-default？

**Color & Substrate**（见 `design-dna.md`）
- [ ] 纯 `#fff`/`#000`？neutral 未 tint？
- [ ] Grain 层缺失？
- [ ] Accent 跨 section 漂移？
- [ ] 硬 `#333` border 而非 translucent？
- [ ] Default beige+brass palette？

**Layout & Rhythm**
- [ ] 同一 layout family >2 次？
- [ ] Eyebrow count > ceil(sections/3)？
- [ ] Hero >4 text elements？
- [ ] Nav >80px？
- [ ] 多列 section 有 mobile collapse 声明？

**Components & Interaction States**
- [ ] Card grid CTA 垂直 misalign？
- [ ] Loading 缺失（spinner-only 或无）？
- [ ] Empty = blank void？
- [ ] Error 缺 fix instruction？
- [ ] Pricing table 列 feature 列表 Y 不对齐？

**Data & Numbers**（product register，见 `product-ui.md`）
- [ ] 表数字未右对齐 `tabular-nums`？
- [ ] Icon-button / 圆形元素缺 optical compensation？
- [ ] 图表 3D、旋转标签、pie >5 slices？
- [ ] Color 作唯一 data signal？

**Motion**（见 `motion-engines.md`）
- [ ] `window.addEventListener('scroll', …)` 每帧驱动？
- [ ] 无 `prefers-reduced-motion` fallback？
- [ ] Reveal 用 `power1.out`/linear？
- [ ] >1 marquee？

**Strategic Omissions**
- [ ] 无 custom 404？
- [ ] Footer 缺 legal links？
- [ ] 无 skip-to-content？
- [ ] Placeholder data（"Jane Doe"、lorem）残留？
- [ ] Dead-end user flows？

---

## 3. 保留规则（Protection Rules）

任何 edit 前声明：
- **Must not change**：用户/客户视为 identity-defining 的元素（logo、hero copy、brand color、working sections）。
- **Scope boundary**："fix only X" vs "full redesign within existing structure"。

**违反保护规则需 explicit user approval。**

### 默认静默禁止改动（除非明确批准）
- URL structure / route slugs
- Primary nav labels
- Form field names 或 order（破坏 analytics + autofill）
- Brand logo / wordmark
- Existing legal / consent / cookie copy
- Information architecture（page tree、anchor IDs）

### 其他保留原则
- 已有 purple 品牌 stays purple（有意图执行，非 LILA 默认替换）。
- Copy voice 保留，除非要求 rewrite。Visual modernisation ≠ content rewrite。
- 不 regression 已有 a11y wins（focus、alt、keyboard、contrast）。
- 不重命名 downstream tracking 依赖的 button、form fields、section IDs。

---

## 4. 现代化 Lever 优先级

按序应用——**brief 满足即停**：

| 序 | Lever | 理由 |
|----|-------|------|
| 1 | **Typography** — font swap、tracking、line-height、weight contrast | 最大 visual lift，零 structural risk |
| 2 | **Spacing & rhythm** — section padding、vertical rhythm | 显著 polish，低风险 |
| 3 | **Color recalibration** — tinted neutrals、translucent borders、accent lock | 第二大 immediate impact |
| 4 | **Motion layer** — SPECTACLE-appropriate micro-interactions | 动机驱动，非 GSAP-for-show |
| 5 | **Hero & key-section recomposition** — 用 `patterns.md` 词汇重组 top-of-funnel | 中高风险 |
| 6 | **Full block replacement** — 仅当 block unsalvageable | 最高风险 |

Identify 负责 complaint 的 module，**只调那个**——never full-rebuild for single complaint。

---

## 5. 决策树

```
IA + content + SEO sound?
  ├─ YES → targeted evolution（Lever 1–4）~70% value @ ~40% risk
  └─ NO  → visual debt structural?
            ├─ YES → full redesign + strict content preservation
            └─ Brand itself changing? → greenfield
```

---

## 6. Never-Silent 规则

以下变更 **必须 explicit approval + 等待 green light**：
- 移除 section
- 改 primary font family
- 改 accent color
- 重构 nav 或 IA
- Step 3 标记为 protected 的任何变更

State change + reason，然后 wait。

---

## 7. 迭代反馈映射

| 用户说 | 动作 |
|--------|------|
| "too plain / boring" | SPECTACLE +2，引擎升一档（见 `motion-engines.md`） |
| "wrong vibe" | 重跑 persona 选择（`style-personas.md`） |
| "feels generic" | 命名并拒绝当前 soul，选 non-obvious persona |
| "change the colors" | 重跑 `design-dna.md` color strategy，maintain accent lock |
| "feels slow / heavy" | 降 SPECTACLE，切 Engine E（CSS-only），减 particle |
| "needs mobile" | 每多列 section 声明 collapse；`min-h-dvh`；44px touch |

---

## 8. Post-Fix 验证

Fix 后跑 `preflight.md` 完整清单——redesign 过 audit 但 fail preflight = 未完成。

额外：
- [ ] **Regressions**：每个 section 测，不只 touched 的。
- [ ] **Before/after delta**：一句话说最大 improvement；说不出 = fix 太 diffuse。
- [ ] **Scope kept**：只改了 Step 3  agreed 范围。

Commerce/product 页面额外跑 `commerce-ui.md` §8 或 `product-ui.md` §12 preflight。
