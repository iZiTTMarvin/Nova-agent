# Style Personas — 灵魂矩阵与选字流程

> **中文说明**：本技能的价值是灵魂多样性——同一方法对不同 brief 产出视觉上无关的页面。
> **何时加载**：brand register 挑灵魂时；`soul` 命令；页面"感觉很通用"需重挑 persona。
> **核心**：先命名行业 lazy default，再选 beat 它的 persona；饱和 lane 命名再拒绝，绝不连续重复。

---

## 1. 使用流程

1. 命名行业。
2. 命名该行业的 **lazy default**（一阶 + 二阶反射，见 `anti-cheap.md` §0）。
3. 选 beat 它的 persona。
4. 锁 palette + type + accent（具体 hex/配对见 `design-dna.md` §6/§7，此处不重抄）。
5. 选匹配的 hero 引擎（见 `motion-engines.md`）。

**Anti-default 一行**：*"The default for {industry} is {lane}. I'm rejecting it for {persona} because {reason}."*

---

## 2. Persona 矩阵

| Persona | 适合行业 | Palette 家族 | 字体配对 | Hero 引擎 | 招牌效果 |
|---------|----------|--------------|----------|-----------|----------|
| **Cinematic Tech** | 天文、AI、neural、crypto、deep-tech | cinematic cool（cyan/magenta on near-black） | Inter + JetBrains Mono | A · Three.js particles | additive-blend glow, scroll-coupled camera |
| **Phosphor Terminal** | quant/fintech、安全、infra、dev-tools | phosphor mono（single neon-green） | JetBrains Mono-forward + Inter | B · Canvas data viz | CRT scanlines, flicker, live ticker |
| **Editorial Publication** | 杂志、电影、期刊、摄影 | editorial light（cream/ink） | Playfair + Spectral + Inter | D · GSAP scroll-reveal | grayscale photography, ruled hairlines, drop-cap |
| **Warm Heritage** | 威士忌、咖啡、craft、蒸馏 | warm heritage（amber/copper/ember） | Fraunces / EB Garamond + Inter | B · Canvas fire/particles | ember particles, letterpress weight, vignette |
| **Gold Luxury** | 腕表、香水、fine dining、珠宝 | gold luxury（dual-gold on near-black） | Cormorant Garamond + JetBrains Mono | D · GSAP scrub + parallax | gold gradient text（duotone）, slow reveals |
| **Brutal Typographic** | 时装周、音乐、文化、streetwear | bone/black + one hot accent | Anton / Bebas + Inter | E · CSS mix-blend / D · GSAP | oversized type, `mix-blend-mode: difference`, outline+fill |
| **Quiet Luxury Minimal** | 建筑、酒店、wellness、设计工作室 | quiet light（off-white/forest sage） | Raleway 100–900 + JetBrains Mono | E · CSS mask/parallax | dual-layer reveal, extreme weight range, max whitespace |
| **Organic / Botanical** | 花艺、护肤、食品、可持续 | earth + blush, lighter | Spectral + Inter | B · Canvas organic particles | soft particle drift, grayscale-to-color hover |
| **Electric Nightlife** | 俱乐部、节庆、gaming、esports | duotone neon on black | Anton / Space Grotesk + mono | A/B · particles + glitch | glitch, japanese-char rain, neon bloom |
| **Scientific Emergence** | 研究、仿真、生成艺术、data-art | violet/cyan on deep black | Space Grotesk + JetBrains Mono | C · WebGL FBO | fluid / reaction-diffusion / ray-march |

挑最近 persona，用 brief 弯曲——禁止 verbatim 抄整行。

---

## 3. 饱和 Lane 警告

不是 banned，但是 **training-data defaults**。无 stated reason 伸手 = 品牌 invisible。轮换；**绝不连续两个 brief 同一 lane**。

- **Editorial-typographic** — display serif（常 italic）+ 小 mono 标签 + ruled separators + 单色 restraint + 无 imagery。Stripe-adjacent、Notion-adjacent 品牌全在这。除非 brief **真的是** publication，否则 beat it。
- **Beige-brass craft** — 暖 cream bg + brass/clay/oxblood + espresso text。任何 artisan/heritage/cookware brief 的反射。禁 hex 家族见 `anti-cheap.md` §2 色彩。
- **AI-purple glow** — 紫/蓝渐变、发光按钮、neon mesh bg。任何 AI/SaaS brief 的反射。

---

## 4. 色彩策略阶梯（persona 视角）

与 `design-dna.md` §5 呼应——此处从 persona 选 lane 角度精简：

| 级别 | 描述 | SOUL 映射 | 典型 persona |
|------|------|-----------|--------------|
| **Restrained** | 微调中性 + accent ≤10% | 1–3 | Quiet Luxury、product 邻近 |
| **Committed** | 一饱和色占 30–60% 表面 | 4–6 | 多数 brand hero |
| **Full** | 3–4 命名色角色，各有意图 | 7–8 | Electric Nightlife、campaign |
| **Drenched** | 表面**就是**颜色 | 9–10 | Cinematic Tech launch、Gold Luxury hero |

选一级，整页 commit。命名真实参照再选（"Klim `#ff4500` drench"、"Stripe 紫-on-white restraint"）——未命名野心退化成 beige。

---

## 5. 选字流程（四步，每项目必做）

已有品牌 committed 字体时，**身份保留优先**；reflex-reject 仅对全新决策生效。

### Step 1：读 brief，写三个 voice 词
不是 "modern/elegant"，而是物理实体词："warm and mechanical and opinionated"、"calm and clinical and careful"。

### Step 2：列三个反射字体，命中则拒绝
Reflex-reject 清单（training-data defaults，ban list，往远处找）：

Fraunces · Newsreader · Lora · Crimson · Crimson Pro · Crimson Text · Playfair Display · Cormorant · Cormorant Garamond · Syne · IBM Plex Mono · IBM Plex Sans · IBM Plex Serif · Space Mono · Space Grotesk · Inter · DM Sans · DM Serif Display · DM Serif Text · Outfit · Plus Jakarta Sans · Instrument Sans · Instrument Serif

### Step 3：带三个词浏览真实字库
Google Fonts、Pangram Pangram、Future Fonts、Adobe Fonts、ABC Dinamo、Klim、Velvetyne。把品牌当**物理实体**找字：博物馆 caption、1970s 终端手册、布料标签、演唱会海报、mid-century diner 收据。拒绝第一个 "looks designy" 的。

### Step 4：交叉检查
"Elegant" 不必 serif。"Technical" 不必 sans。"Warm" 不是 Fraunces。最终选择与 Step 2 反射重合 → **重来**。

---

## 6. 排版规则（persona 层）

- **Display weight contrast 是最便宜的 premium 信号**。极端 weight（800/900）对 light body（300）。同家族或 deliberate pairing，禁止 random。
- **Scale ratio ≥ 1.25**。平 1.1 ladder = 浏览器 default = 廉价。
- **Body 行长 65–75ch**。heading `text-wrap: balance`；段落 `pretty`。
- **Mono 用于 data/labels**（metrics、timestamp、code、eyebrow）——但 obey eyebrow cap（`anti-cheap.md` §1）。
- 有理由可用 reflex 字体；盲目伸手是 tell。 doubt 时轮换 less-tired sans-display（Geist, Cabinet Grotesk, PP Neue Montreal, GT Walsheim, ABC Diatype）。

---

## 7. Brand Slop Test（persona 选定后）

若有人毫不犹豫说 "AI made that" = 失败。标准是**独特性**——访客问 "how was this made?" 不是 "which AI?"

**第二 slop test：aesthetic lane**。commit 前命名参照。Klim specimen page 是一 lane；Stripe-minimal 是另一；Liquid-Death acid-maximalism 是另一。非 editorial brief 上 drift 进 editorial-magazine aesthetic = register 内 register 错误。

**逆向测试**：一句话描述你即将做的页面，像竞品描述 theirs。若那句话 fit 品类 modal landing page → restart。

---

## 8. Brand 权限（product 没有的）

- 野心 first-load motion（reveal、typographic choreography 赚到位；不是每 section fade-on-scroll）。
- Single-purpose viewport（一 fold 一 dominant idea，长 scroll，deliberate pacing）。
- Unexpected color strategies（palette IS voice）。
- Section 级 art direction（叙事需要时不同 section 不同 visual world；voice 一致 > treatment 一致）。

Brand bans 与 permissions 完整版交叉见 `anti-cheap.md`；具体 palette hex 与字体配对表见 `design-dna.md` §6/§7。
