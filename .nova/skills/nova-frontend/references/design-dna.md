# Design DNA — 让页面读作"昂贵"的物理层

> **中文说明**：一层薄薄的、一致应用的物理质感，是廉价页面和昂贵页面的主要差别。这里是带真实数值的配方，不是灵感。
> **何时加载**：铺 premium substrate 时（grain / vignette / 排版张力 / 色彩 token）；brand 和 product 两条路都要铺。
> **核心**：内部用 **OKLCH** 推理配色（发 hex 也行）；light + dark 一起设计、各自测对比，绝不只做反色。

---

## 1. Token 约定

每页声明一小组命名 token。

**Dark page（典型区间）：**
```css
:root {
  --bg:      #04060D;            /* 近黑，向品牌色相微调。区间 #020806–#0C0A08 */
  --surface: #0F0F16;            /* 比 bg 高一档 */
  --ink:     #EAEDF8;            /* 绝不纯白。区间 #E8D5B0（暖）– #F5F5F5 */
  --muted:   #7A7A90;            /* 次级文字 */
  --dim:     #4A4A5E;            /* 三级 / 发丝线 */
  --accent:  #6C63FF;            /* THE color，拥有整页 */
  --accent2: #FF3B8E;            /* 可选第二色，仅 duotone 灵魂用 */
  --border:  rgba(255,255,255,.07);
}
```
**Light page：**
```css
:root {
  --bg:   #F4F1E9;              /* 微调 off-white，绝不 #fff。区间 #EFEFED–#F8F6F2 */
  --ink:  #1A1714;             /* 近黑，绝不 #000 */
  --muted:#857F73;
  --dim:  #C0C0BE;
  --border: rgba(0,0,0,.07);
}
```

规则：任何地方都无 `#fff`/`#000`。中性色向品牌色相微调几个点（OKLCH chroma +0.005–0.015）。一个 accent，锁全页。

**硬数值下限（不可谈判）：**
- `ink` vs `bg` 对比 ≥ 7:1（正文）。`muted` vs `bg` ≥ 3.5:1。UI 组件/图标 ≥ 3:1。light 与 dark **各自独立测**，别假设一个模式的值在另一个也过。
- 主 accent chroma ≤ 0.23（OKLCH）；若 accent lightness > 0.78，chroma ≤ 0.18（防浅色 accent 荧光化）。
- accent vs 其"on-accent"前景（按钮文字）≥ 4.5:1。
- 避免浑浊中调 accent：lightness 0.45–0.72 且 chroma < 0.10 读作既非中性也非彩色——选一边。

**三段式命名约定（任何命名 token 必须三者齐全）：** `描述名 (hex) — 功能角色与约束`
```
Void (#04060D)       — 页面背景。近黑，向品牌色相微调。
Star Dust (#EAEDF8)  — 主文字。略冷；绝不纯白。
Pulse (#6C63FF)      — accent。拥有整页——非 duotone 不加第二 accent。
Iron (#4A4A5E)       — 仅发丝线与三级文字。
```
绝不只写 hex、只写名、或只写角色。三段式让 token 自解释，防止跨文件静默漂移。

---

## 2. Grain（强制）

固定的 SVG `feTurbulence` 噪点覆盖层。静态、~2KB 内联，但它是"这不是扁平 vector slop"最大的单一信号。
```css
body::before {
  content: ''; position: fixed; inset: 0; z-index: 1; pointer-events: none;
  opacity: .032;   /* .025–.05。暗页低，繁忙页高 */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```
`baseFrequency` 0.75=细（默认），0.9=粗粝；`numOctaves` 2=轻，4=更丰富。light 页保留，opacity 降到 `.02–.03`。

---

## 3. Vignette

暗色 hero 上的径向压暗——制造光学焦点，引导视线。
```css
.vig { position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse 90% 70% at 50% 46%, transparent 46%, rgba(4,6,13,.86) 100%); }
```
把焦点 `at {x}% {y}%` 移向 hero 主体所在。

---

## 4. 排版张力

观感是**紧、大、自信**。高字重对比做大部分功。
```css
h1 { font-size: clamp(56px, 9vw, 160px); letter-spacing: -.045em; line-height: .9; font-weight: 800; }
body { font-weight: 300; }        /* 与标题极端对比 */
.label { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; }  /* 小号大写元信息 */
.count { font-family: 'JetBrains Mono', monospace; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
```
- **display 字距下限 ≥ -0.04em**（impeccable 的高频缺陷）：默认 -0.05~-0.085em 会让字母粘连，读作局促。-0.02~-0.03em 对紧凑 grotesque 已够，-0.04em 是地板。
- **hero/display 字号天花板**：`clamp()` max ≤ 6rem（~96px）。再大是在喊，不是在设计。
- **标题内强调**：用**同家族**的斜体/粗体，绝不塞随机衬线词。
- **斜体降部间隙**：display 斜体含 `y g j p q` 时，`leading-none` 会裁掉降部。用 `line-height:1.1` 起 + `pb-1` 预留。
- `text-wrap: balance` 用于 h1–h3；`text-wrap: pretty` 用于长正文防孤字。行长 65–75ch。模块化 scale，步进比 ≥1.25（1.1× 的平 scale 读作浏览器默认=廉价）。

---

## 5. 色彩策略（先选承诺级别，再选颜色）

**先选策略，再选颜色。** 承诺轴四档：
1. **Restrained** — 微调中性 + accent ≤10%。（product 默认；品牌极简）
2. **Committed** — 一个饱和色承载 30–60% 表面。（多数品牌 hero）
3. **Full palette** — 3–4 个命名角色，各有意图地用。（campaign；product 数据可视化）
4. **Drenched** — 表面**就是**颜色。（brand hero、发布页）

SOUL dial 大致映射：1–3→Restrained，4–6→Committed，7–10→Full/Drenched。product 默认 Restrained 是地板；brand 有权用 Committed/Full/Drenched——用它们，别用中性色在边缘对冲。

**选主题的物理场景法**：dark vs light 从不是默认。不是"工具暗着酷"，不是"浅色更安全"。选之前写一句物理场景：谁用、在哪、什么环境光、什么心情。这句话逼不出答案就是不够具体，加细节直到逼出来。

**命名真实参照再选策略**："Klim `#ff4500` 橙 drench"、"Stripe 紫-on-白 restraint"、"Vercel 纯黑单色"。没命名的野心会退化成米色。palette 就是 voice——克制品牌和躁动品牌不该共享 palette 机制。别跨项目收敛。文化符号 palette 是明显拉力时，反向绕开——让文化解读来自排版/图片/文案，不是 palette。

**灰字在彩底上发灰** → 用背景自身色相的更深阴影，或文字色的透明度。**微调中性** → 向品牌色相加 0.005–0.015 chroma，别默认往暖/冷调"因为品牌感觉如此"。

---

## 6. Palette 家族（灵魂 → 色）

| 家族 | Bg | Accent | 灵魂 |
|------|----|--------|------|
| Cinematic cool | `#04060D` | cyan `#22e3ff` / magenta `#ff2d8e` | 天文、AI、crypto、音乐 |
| Phosphor mono | `#020806` | 霓虹绿 `#00DC50` only | 量化、安全、终端 |
| Warm heritage | `#070402` | 琥珀 `#C87820` + ember `#FF6820` | 威士忌、咖啡、火、craft |
| Gold luxury | `#0C0A08` | 金 `#B8922A` + `#E8C870` | 腕表、香水、fine dining |
| Editorial light | `#F8F6F2` | 锈红 `#A8331F`（单一） | 杂志、电影、出版 |
| Quiet luxury light | `#F0F0EE` | sage `#2D5A3D`（单一） | 建筑、酒店、wellness |
| Cold luxury | `#1A1B1E` | 铬 `#C4C8CC` + 烟 `#6B6F73` | EV、可穿戴、精密硬件（非米色的高端消费替代） |
| Forest | `#12180F` | 深绿 `#2F5233` + 骨白 `#E8E4D8` + 琥珀 accent | 户外、可持续、premium-craft（非米色） |
| Black and tan | `#0D0C0B` | 暖褐 `#C9A574` on 真近黑 | 皮具、男装、无米色传承 |
| Cobalt + cream | `#F5F2EA` | 饱和钴蓝 `#1E4FD8`（单一，无黄铜） | 高端消费浅色 |
| Terracotta + slate | `#2C2E33` | 暖锈 `#B4502E` on 冷石板 | 陶瓷、家居 |
| Swiss modern | `#FFFFFF` | 真黑 `#0A0A0A` + 红 `#FF3300` | 企业、印刷邻近、editorial-brutalist |
| Duotone neon | `#0A0A0F` | 电蓝 `#0066FF` + acid `#D4FF00` | 俱乐部、电竞、gaming |
| Trust SaaS | `#F8FAFC` | 蓝 `#2563EB` + 橙 `#EA580C` CTA | B2B SaaS、dashboard（克制，非紫） |
| Financial dark | `#020617` | signal 绿 `#22C55E` / 警报红 `#DC2626` | fintech dashboard、交易 |
| Analytics dashboard | `#F8FAFC` | 蓝 `#1E40AF` + 琥珀 `#D97706` | product—数据可视化、admin |
| Developer tool/IDE | `#0F172A` | slate `#1E293B` + run-绿 `#22C55E` | product—开发工具 |
| Clinical calm | `#ECFEFF` | cyan `#0891B2` + health-绿 `#059669` | product—医疗、wellness app |
| Authority navy | `#F8FAFC` | 藏青 `#1E3A8A` + 金 `#B45309` | product—法律、保险、gov 邻近 B2B |

**轮换纪律**：同品类连续 brief 绝不重复同一家族。当多个家族同等契合时，用轮换做 tiebreaker，但家族选择应从 brief 的具体品牌个性推出。

> **米色+黄铜+espresso 是 2026 饱和 AI 默认**。token 名 `--cream/--sand/--bone/--paper` 本身就是 tell。"温暖传统"brief → Cold luxury/Forest/Black-and-tan 或饱和品牌 body，不是近白暖 cream。完整禁 hex 与 AI 紫等价陷阱见 `anti-cheap.md` §2 色彩。

---

## 7. 字体配对（灵魂 → 字）

| 配对 | 灵魂/行业 | 备注 |
|------|-----------|------|
| Inter + JetBrains Mono | tech、fintech、科学 | 主力；mono 承载标签/指标 |
| Cormorant Garamond + Inter + JetBrains Mono | 奢侈、香水、腕表 | 高对比古典衬线，斜体强调 |
| Playfair Display + Spectral + Inter | 编辑、电影、期刊 | display 衬线 + 文本衬线；配灰度摄影 |
| Fraunces / EB Garamond + Inter | 传承、咖啡、威士忌、fine dining | 暖编辑重量（Fraunces 被滥用——要有理由） |
| Anton + Inter | 时装周、音乐、文化 | 超重 display，mix-blend 技巧 |
| Bebas Neue + Barlow | 运动、alpine、大胆 campaign | 窄体极端字重对比 |
| Raleway 100–900 + JetBrains Mono | 建筑、极简工作室 | 一家族跨巨大字重范围 |

> `Inter`/`Fraunces` 极好但被过度默认。有理由地用，别反射。sans-display（Geist, Cabinet Grotesk, PP Neue Montreal, Space Grotesk）是"高端现代"的强力、不那么累的默认。product UI 常常一个家族就够（well-tuned sans 承载标题/按钮/标签/正文/数据），不需要 display+body 配对。

**选字流程（每项目，绝不跳过）**：① 读 brief，写三个具体品牌 voice 词（物理实体词，不是"现代/优雅"）；② 列你会反射伸手的三个字体，命中 reflex-reject 就拒绝；③ 带着三个词浏览真实字库（Google Fonts、Pangram Pangram、Klim、Velvetyne），把品牌当**物理实体**找字（博物馆说明牌、1970s 终端手册、布料标签、演唱会海报）；④ 交叉检查——"优雅"不必衬线，"技术"不必 sans，"温暖"不是 Fraunces。最终选择若与最初反射重合，重来。

---

## 8. 高质感细节工具箱

制造"高端"，超越布局本身：
- **分层深度** — `engine(z0) · grain(z1) · vignette · content(z5)`。绝不单一扁平面。
- **带色投影** — `box-shadow: 0 0 80px rgba(0,0,0,.8)`；亮页把阴影向 bg 色相微调，绝不纯黑。
- **半透明边框** — `rgba(255,255,255,.07–.22)` / `rgba(0,0,0,.06–.08)`。硬 `#333` 线读作廉价。
- **backdrop 模糊** — nav 与玻璃 chip 上 `backdrop-filter: blur(8px)`（稀疏，配 1px 内边框做真实边缘折射）。
- **慷慨节奏** — `section { padding: 120px 52px; max-width: 1280px; margin: 0 auto; }`。对称间距，居中轴。
- **灰度摄影** — `filter: grayscale(1) contrast(1.06)`，编辑灵魂 hover 显色。
- **自定义缓动** — hover `transform: scale(1.04)`（非 1.1）配 `cubic-bezier(.16,1,.3,1)`。微妙读作昂贵。
- **reveal stagger** — `opacity 0→1`、`y 34→0`、`duration .7`、`ease power3.out`（绝不 `power1`——太快=廉价）。
- **语义 z-index scale** — dropdown→sticky→modal-backdrop→modal→toast→tooltip。绝不 `z-999`/`z-9999` 任意值。

---

## 9. 最小 Boilerplate

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  :root { --bg:#08080C; --ink:#EEEEF5; --muted:#7A7A90; --dim:#4A4A5E; --accent:#6C63FF; --border:rgba(255,255,255,.07); }
  html { scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--ink); font-family:'Inter',system-ui,sans-serif; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
  body::before { content:''; position:fixed; inset:0; z-index:1; pointer-events:none; opacity:.032;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
  .content { position:relative; z-index:5; }
  @media (prefers-reduced-motion: reduce) { *{animation:none!important;transition:none!important;} canvas{opacity:.55;} }
</style>
</head>
<body><div class="content"><!-- hero + sections --></div></body>
</html>
```
> 生产项目用 `next/font` 或自托管 `@font-face` + `font-display: swap`，别在生产用 `<link>` 引 Google Fonts。
