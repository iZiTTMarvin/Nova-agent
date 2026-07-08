# Pre-Flight — 发布前检查清单

> **中文说明**：说"完成"前必跑的最终 gate——合并 substrate、反廉价、spectacle、a11y、战略遗漏与自评循环。
> **何时加载**：任何交付前；`audit` 命令；craft/redesign 最后一步。
> **核心**：任一 **hard 规则** 不过 = 发破损活；soft 可 skip 但必须说 why。

---

## A. 方向与灵魂（hard）

- [ ] **Design Read 已提交**（行业 · soul · register · SPECTACLE · hero-engine）。
- [ ] **Anti-default 已命名**——lazy aesthetic 已识别并 beat。
- [ ] **一 soul、一 accent，锁全页**。无 drift；非 duotone-by-design 不加第二 accent。
- [ ] **Theme 锁死**——暗页内无 warm-paper section（除非 deliberate 一次性 scroll 主题切换）。
- [ ] **Register 匹配**——brand = bold/spectacle；product/commerce 走对应 reference，别用 brand 规则做 dashboard。

---

## B. Premium Substrate（hard）

- [ ] **Grain** 层存在（`opacity .02–.05`）。
- [ ] **无纯 `#fff`/`#000`**；neutral 向品牌 hue tint。
- [ ] **Translucent borders** only；无硬 `#333` 线；投影 hue-tinted（亮底非纯黑 shadow）。
- [ ] **Display type tension**——`clamp()` size、负 tracking、line-height .86–.95、weight contrast vs light body。
- [ ] **分层 z-index**（engine · grain · vignette · content）。

细节见 `design-dna.md`。

---

## C. Spectacle（SPECTACLE ≥ 7 时 hard）

- [ ] **Spectacle shown, not claimed**——真 working engine 存在（Three.js/Canvas/GLSL/ScrollTrigger pin）。
- [ ] **60fps 中端设备**（非 dev machine）。<50fps → 简化。
- [ ] **Canvas DPR-adapted**（retina 不 blur）。
- [ ] **渐进增强**——删 engine 页面仍完整可读。
- [ ] **`prefers-reduced-motion`** 冻结 still frame / static hero。
- [ ] **动机驱动 motion**——每个动画一句话理由。≤1 marquee。

**验证两 pass**（不要只 claim）：
1. **Static**：代码里存在真实 engine import/init + reduced-motion gate；声称 SPECTACLE 8 却是 static gradient blob = hard fail。
2. **Runtime**（有 browser 时）：打开页面确认 hero 有 real pixels（非白屏、非 flat `background-color`）；reduced-motion emulate 后仍是 composed static frame。无法跑 browser 则 explicit 声明，fallback static pass，禁止 silent claim。

四个 ship-test 见 `motion-engines.md`：wow · removal · device · context。

---

## D. 布局纪律（hard）

- [ ] **Hero 入视口**——headline ≤2 行，subtext ≤20 词，CTA 无 scroll 可见；max 4 text elements。
- [ ] **Nav** 单行，≤80px。
- [ ] **Eyebrow count ≤ ceil(sections/3)**（机械数 `uppercase tracking` 小标签）。
- [ ] **≥4 layout families**（长页）；无 family >2 次；≤2 连续 image+text zigzag。
- [ ] **Mobile collapse** 每多列 section 声明；375px 无横向 scroll；`min-h-[100dvh]` 非 `100vh`。

---

## E. 反廉价扫描（hard）

跑 `anti-cheap.md` §4 三十秒自查，逐项：

- [ ] 说出 anti-default？一 accent 锁死？
- [ ] Eyebrow ≤ ceil(sections/3)？
- [ ] ≥4 layout families？
- [ ] 图片隐含 brief 有真图？
- [ ] Spectacle 兑现（若声称）？60fps？reduced-motion？
- [ ] 文案干净？（生成页面可见文案**禁用 em-dash `—`**；用句号、逗号或重构）
- [ ] 对比 AA？（含 button、placeholder、focus ring）

额外 hard items：
- [ ] 无 div 假 screenshot / 假 dashboard。
- [ ] 无 gradient-text / AI-purple 默认 / 假精确数字。
- [ ] 无 banned beige+brass default；无 identical card grid；无编号 `01·02·03`（除非真序列）。
- [ ] Logo wall 用 real SVG logo，非 text wordmark。
- [ ] 字体选择有 reason，非 blind Inter/Fraunces/Instrument Serif。

---

## F. 文案自审（hard）

- [ ] 重读每个 visible string。无 broken grammar、unclear referents、AI-cute wordplay。
- [ ] 一页一 copy register。
- [ ] Quotes ≤3 行，完整 attribution（名字+角色+公司）。
- [ ] 一 intent 一 CTA 标签（nav/hero/footer 不重复同 intent）。

---

## G. 无障碍（hard）

- [ ] 对比 WCAG AA——body ≥4.5:1，large ≥3:1。含 **button over photo**（scrim/stroke）、placeholder、helper/error、focus ring。
- [ ] 每个 interactive 有 visible focus；keyboard 可达 nav + CTA。
- [ ] Button text desktop 单行；无 wrapped CTA。
- [ ] Touch targets ≥44px。Form label 在 input 上方（非 placeholder-as-label）。

---

## H. 性能（soft）

- [ ] 只动画 `transform`/`opacity`；`will-change` 稀疏。
- [ ] 重 engine lazy-load。响应式图（WebP/AVIF、`srcset`）。CLS < 0.1。
- [ ] Core Web Vitals  plausible：LCP < 2.5s，INP < 200ms。

---

## I. 战略遗漏（soft，但区分 prototype vs 真交付）

- [ ] **Custom 404**——framework default 不可接受于 brand page。
- [ ] **Legal links**（Privacy、Terms）在 footer。
- [ ] **Skip-to-content**（`<a href="#main" class="sr-only focus:not-sr-only">`）满足 WCAG 2.4.1。
- [ ] **Back navigation**——每页从至少一页可达，无 dead-end flow。
- [ ] **无 placeholder 残留**（"Jane Doe"、lorem、`email@example.com`）。
- [ ] **表单校验接好**——blur 校验；错误说 cause + fix。

---

## J. Register 专属附加

**Product**（`product-ui.md` §12）：
- [ ] IA ≤3、表/图表/表单/五态、component vocabulary、dark mode 独立测。

**Commerce**（`commerce-ui.md` §8）：
- [ ] §7 反暗黑模式清单 absent；PDP/PLP/cart/checkout 各 gate。

**Redesign**（若适用，`redesign.md` §8）：
- [ ] 无 regression；scope kept；before/after delta 一句话。

---

## K. 自评循环（最后跑，说"done"前）

生成 **5 个针对本次产出的尖锐问题**，每个用代码/文案里**具体证据**作答。**"yes" 无证据 = 未验证 = 失败。**

**模板（填入实际产出）：**

1. **Engine check**："我 shipped 了 working `[engine type]`，还是 hero 处 gradient blob/placeholder？" → [证据：引用 canvas init、ScrollTrigger config 或截图描述]
2. **Soul check**："选的 persona `[name]` 是否在 palette、typeface、motion 中可见，还是 drift 回 generic？" → [证据：具体 hex、font-family、effect 代码行]
3. **HARD BAN sweep**："生成页面文案含 em-dash 吗？eyebrow 是否 >1-in-3 sections？有假数字吗？" → [证据：数 eyebrow 个数、grep 结果或逐段引用]
4. **Substrate check**："grain、type tension、translucent borders 是否每 section 都有，还是只有 hero？" → [证据：CSS token / `body::before` / border 值]
5. **Dial honesty**："页面实际是否 SPECTACLE=[n] DENSITY=[n]，还是 under-deliver committed dial？" → [证据：engine 存在与否、信息密度描述]

任一答案暴露 failure → fix 再 ship。

---

## 交付阻断摘要

以下任一 = **禁止说"完成"**：
- Design Read 未出 / anti-default 未命名
- Hard ban 命中（em-dash 于**生成页面文案**、假 screenshot、AI 紫默认、fabricated urgency 于 commerce…）
- SPECTACLE ≥7 无 working engine 或无 reduced-motion fallback
- Eyebrow 超限 / accent 漂移 / 对比 AA 失败
- 自评 5 问任一 "yes" 无 concrete evidence
