# 反廉价黑名单 — Anti-Slop

> **中文说明**：这是本技能最重要的 reference——把三套方法论里"让 AI 页面一眼被认出很廉价"的所有信号合并去重。
> **何时加载**：任何交付前必扫；`audit` 命令的主依据；感觉页面"很 AI"时对照排查。
> **核心哲学**：大多数条目是"模型不假思索伸手就用的默认"。修法几乎从来不是"加更多"，
> 而是"说出这个反射、拒绝它、承诺一个有意图的选择"。
> 每条格式：**信号 → 改用什么**。分级：`[HARD BAN]` 无例外的发布阻断项；其余为默认拒绝、有理由才可覆盖。

---

## 0. 两个高度的反射检查（先于一切）

说出明显默认还不够——避开第一反射后，还有第二反射埋在下一层。两个高度都查：

- **一阶**：能从**品类本身**猜出主题+配色吗？"咖啡 → 暖米色 + 黄铜衬线"、"AI SaaS → 紫辉光 + Inter"。是 → 第一训练反射。重做场景与配色策略，直到答案不再从品类显而易见。
- **二阶**：能从**品类 + 你的反参照**猜出吗？"不做 SaaS 米色的 AI 工具 → 编辑体排版"、"不做藏青+金的 fintech → 终端原生暗色"、"不做米色的 craft 品牌 → 牛血红 + Cormorant"。第一反射躲开了，第二个没躲开——这才是坑住细致工作的陷阱。

两个答案都不明显才算过。当前饱和的二阶 lane（用一个要能说出为什么这个 brief 真需要它）：编辑体排版（衬线 + 米色 + 巨字）、phosphor 终端暗色、bone 底 Helvetica 极简、AI 紫辉光。

---

## 1. 无例外禁用 — `[HARD BAN]`（发布阻断，无覆盖）

- `[HARD BAN]` **Em-dash（`—`）与 en-dash（`–`）作分隔/花活**——正文里的戏剧性停顿、破折号 bullet、旁白。#1 最常违反的 tell。用句号、逗号，或重构句子。范围用连字符（`2018-2026`）。仅代码内允许（不影响可见文案）。
- `[HARD BAN]` **div 拼假截图**——手搭的"产品预览"/假 dashboard/假任务列表/假终端。用真截图、生成图、真迷你组件，或编辑级摄影。
- `[HARD BAN]` **渐变文字**（`background-clip:text` + gradient）作默认花活。用单色，靠字重/字号强调。（例外：刻意的 duotone 灵魂手法，用两个锁定的强调色。）
- `[HARD BAN]` **AI 紫/蓝辉光**——紫色渐变按钮、霓虹网格背景、发光 CTA 作默认。用中性底 + 一个高对比强调色。特别禁 `#6366f1`（通用靛蓝，AI UI 最滥用 hex）。（例外：brief 明确要紫色，且有意图地执行。）
- `[HARD BAN]` **假精确数字**——`92%`、`4.1×`、`48k`、`5.8mm` 为凑规格感编造。用真实数据、标注 mock，或删掉。
- `[HARD BAN]` **侧边条边框**——卡片/列表/callout 上 `border-left`/`border-right` > 1px 的彩色装饰条。改用完整边框、背景微调、前导图标，或什么都不加。
- `[HARD BAN]` **每个 section 都有 eyebrow**——标题上方那个小号大写宽字距标签（`ABOUT`/`OUR PROCESS`/`THE HARDWARE`），出现在 55-95% 的 AI 产出里。**每 3 个 section 最多 1 个**。机械检查：数小号大写字距标签，`> ceil(sections/3)` 即失败。

---

## 2. AI Tell（默认拒绝；有明确理由才可覆盖）

### 布局与节奏
- **编号 section 标记**——`01·About / 02·Process / 03·Pricing` 作默认骨架。仅用于真实序列（真 3 步流程、时间线）。否则删。
- **完全相同的卡片网格**——6 张同尺寸 icon+标题+段落卡。改：变化 tile 尺寸、`repeat(auto-fit, minmax(280px,1fr))`、交替全宽行、给 2-3 格真实视觉变化（图/渐变/图案）。
- **section 布局重复**——同一布局家族出现两次以上。一个家族最多出现两次；8 段页面 ≥4 个家族；连续 image+text zigzag 最多 2 个。
- **split-header**——左大标题 + 右小解释段作 section 头。改：垂直堆叠，一个聚焦信息；只有右列真承载视觉/交互元素时才用分栏。
- **hero-metric 模板**——大数字 + 小标签 + 辅助 stats + 渐变强调。SaaS 陈词。
- **文字溢出容器**——长标题词 + 大 clamp + 窄网格导致平板/移动端标题溢出。每个断点测标题文案；溢出就降 clamp max 或改文案。

### 视觉与 CSS
- **glassmorphism 作默认装饰**。仅稀有且有目的时用；用时加 1px 内边框 + 内阴影做真实边缘折射，并给 `prefers-reduced-transparency` 的实底 fallback。
- **hero = 文字 + 渐变色块**。色块不是 hero 视觉。用真引擎（见 `motion-engines.md`）或真图。
- **纯 `#fff`/`#000`**、硬 `#333` 边框、亮底纯黑投影。改：向品牌色微调的中性、半透明边框、色相匹配的投影。
- **混用圆角体系**——方形布局里的圆按钮等。选一套圆角刻度并锁死。
- **按钮对比失败**——白底白字、`bg-white` CTA 配 `text-white`、透明/无边框按钮融进背景、照片上无 backdrop 的 ghost 按钮。审每个 CTA：文字 vs 按钮底 ≥4.5:1（18px+ 粗体 ≥3:1）；照片上 ghost 加 scrim/`backdrop-filter:blur()`/1px 描边。
- **表单对比失败**——近白输入框上的近白占位符、白页上浮白表单卡、比 4.5:1 更浅的 helper/error。审每个 input/占位符/focus ring/helper/error 对其所在 section 背景。
- **CTA 换行**——桌面端按钮文案换到 2+ 行 = 破损。缩短文案（主 CTA ≤3 词）或加宽按钮。
- **重复 CTA 意图**——"Get in touch" + "Contact us" + "Let's talk" 同页。每个意图全站一个标签。

#### Codex 特有高频缺陷（match-and-refuse，改结构重写）
- **`border:1px solid X` + `box-shadow` 模糊 ≥16px 同元素**（ghost-card 幽灵卡）。二选一：单实边框，或 ≤8px 模糊的定义阴影，别都当装饰。
- **卡片/section/input `border-radius: 24/28/32/40px+`**。过度圆角。卡片顶到 12-16px；pill 仅用于 tag/按钮。
- **手绘/涂鸦风 SVG 插画**——class 如 `loose-sketch`/`doodle`/`wavy`；`feTurbulence`/`feDisplacementMap` "纸张颗粒"滤镜；5-30 路径的粗糙场景。读作业余，不是俏皮。渲染不出真实资产就不放插画。
- **`repeating-linear-gradient(...)` 条纹背景**。`body:before` 或 section 底的斜条纹是纯装饰。别用。
- **装饰性网格背景**——`linear-gradient(...1px, transparent 1px)` + `background-size` 的双轴网格覆盖，除非表面真是画布/地图/蓝图/测量工具。
- **meta-批评文案**——命名一个概念再叠反讽修饰，或立稻草人再"纠正"。直接做出具体主张。

#### Gemini 特有缺陷（硬禁）
- **绝不在 hover 时动画 `<img>`**——包括图片 `:hover` 上任何 `transform`，以及 Tailwind 的 `.group:hover .group-hover:scale/rotate/translate` 经父 hover 动画子图。加了零信息，读作"AI 因为能动就动了"。卡片要 hover 反馈就动卡片的背景/边框/阴影，绝不动图片、绝不经图片父级。

### 排版
- **反射默认字体盲目伸手**：`Inter, Fraunces, Instrument Serif, Playfair, Cormorant, Space Grotesk, Syne, DM Sans, Newsreader, Lora, IBM Plex *, Space Mono, Outfit, Plus Jakarta Sans`。都是好字体，都被滥用。**有理由**可用；否则轮换到不那么累的 sans-display（Geist, Cabinet Grotesk, PP Neue Montreal, GT Walsheim, ABC Diatype）。
- **因"创意/高端"就用衬线**。"创意 brief = 衬线"是顶级 tell。默认 sans-display；只有真编辑/奢侈/传承且能说出为什么这个衬线配这个品牌时才用。
- **混家族强调**——把衬线词塞进 sans 标题。用同家族的斜体/粗体。
- **mono 当"技术感"的懒惰简写**、全大写正文。少用、有意图地用。

### 色彩
- **米色 + 黄铜 + espresso** 用于任何 craft/heritage/artisan brief。2026 饱和默认。禁作默认的 hex 家族：
  - bg：`#f5f1ea #f7f5f1 #fbf8f1 #efeae0 #ece6db #faf7f1 #e8dfcb`
  - accent：`#b08947 #b6553a #9a2436 #9c6e2a #bc7c3a #7d5621`
  - text：`#1a1714 #1a1814 #1b1814`
  - token 名 `--cream --sand --bone --paper --flour --linen --parchment` 本身就是 tell。
  → 轮换：**Cold Luxury**（银灰+铬+烟）、**Forest**（深绿+骨白+琥珀）、**Black and Tan**（真近黑+暖褐，无米色）、**Cobalt + Cream**（饱和蓝+单一中性，无黄铜）、**Terracotta + Slate**（暖锈+冷灰）、**Olive + Brick + Paper**、或**纯单色 + 一个饱和 pop**。连续 brief 绝不重复同一暖 craft 配色。
- **LILA 法则 — AI 紫/蓝辉光**及其通用靛蓝表亲。tech/SaaS/AI brief 禁作默认：整个家族（紫蓝渐变按钮、发光霓虹网格、`#5E6AD2` 式"Linear 克隆"）；特禁懒惰强调色 `#6366f1`。→ 中性底（Zinc/Slate/Stone 或微调近黑）+ 一个高对比、刻意选的强调色。
- **2026 米色 body 陷阱**——整个暖中性带（OKLCH L 0.84-0.97, C<0.06, hue 40-100）无论叫什么都读作 cream/sand/paper。别把"温暖传统/杂志暖/编辑克制"翻译成近白暖调 bg——那正是 AI 动作。选：饱和品牌色作 body（terracotta/oxblood/近黑）、chroma 0 的真 off-white，或明显是品牌自己的深中调。温暖靠 accent+排版+图片承载，不靠 body bg。
- **其他品类默认配色**——fintech→藏青+金；wellness→鼠尾草绿+米色；fintech-dashboard→`#020617` 近黑+无品牌色相的通用红绿状态。品类本身能预测配色就重做（见 §0）。
- **accent 漂移**——暖灰站在第 7 节冒出蓝 CTA。色彩锁：一个 accent 拥有整页。
- **主题中途翻转**——暗页里夹一个暖纸 section。一个主题锁死（除非刻意的一次性滚动主题切换）。
- **饱和爆炸**——accent chroma 推到读作霓虹/廉价。默认保持主色饱和克制（HSL <80%，或 OKLCH chroma ≤0.23；lightness 高时 ≤0.18 防荧光）。

### 内容与文案
- **eyebrow 塞满、buzzword 文案**；俏皮但错的文字游戏；假工匠标签；假诗意 micro-meta（"elegant nothing"）。重读每个可见字符串，把破损/不清/AI 俏皮的换成朴素功能句。
- **营销 buzzword 家族**——`streamline · empower · supercharge · leverage · unleash · transform · seamless · world-class · enterprise-grade · next-generation · cutting-edge · elevate · unlock · revolutionize`。选具体名词+动词讲产品**字面上做什么**（"导入你的 Figma 文件"胜过"无缝赋能你的工作流"）。
- **格言腔**——"严肃陈述 + 短促否定"的反复节奏（"不是工具，是系统。" / "更少噪音，更多信号。"）。一句是钩子，三句+就是 tell。三个以上就重写成具体陈述。
- **按钮/链接标签不说动作**——"OK"、"Submit"、"点这里"、5 个"了解更多"。用动词+宾语（"保存修改"、"删除项目"）；链接文字独立可懂。
- **"Jane Doe"占位数据**、遗留 lorem ipsum。用真实具体内容、locale 合适的名字。
- **长列表 / 20 行规格表每行一条发丝线**。分成 2-3 组、每规格一卡、scroll-snap pill，或"top 5 + 查看全部"。
- **引用超过 3 行**、署名只有名字（`— Sarah`）。≤3 行，名字+角色+公司，真排版引号。

### 图片
- **图片隐含的 brief 上零图片**（食品/酒店/时尚/旅行/产品）。是 bug 不是极简。真/生成摄影；即使克制编辑感也需 2-3 张真图。搜品牌的**物理实体**（"刮痕木桌上的手工意面"胜过"意大利食物"）；一张决定性照片胜过五张平庸的；alt 文本是 voice 的一部分。无本地资产用可验证的 stock（Unsplash `images.unsplash.com/photo-{id}?auto=format&fit=crop&w=1600&q=80`，**引用前验证 URL 能解析**，猜的 ID 常 404）。绝不用彩色 `<div>` 占位替代。
- **手绘装饰 SVG 插画**作默认。图标用图标库；品牌标记只用简单 monogram。
- **纯文字 wordmark** 做"trusted by" logo 墙。用真 SVG logo（Simple Icons `cdn.simpleicons.org/{slug}`）或生成 monogram。只放 logo——下面不印品类标签。

---

## 3. 动效 Tell

- **声称有 motion 却没有**——`SPECTACLE 7` 却是静态页。发能跑的动效或降 dial。
- **无动机动画**——因为 GSAP 在手就到处 GSAP。每个动画一句话说清理由（层级/叙事/反馈/状态），否则删。
- **每页 >1 个 marquee**。选 marquee 真正服务的那一节，其余换布局。
- **`window.addEventListener('scroll', …)`** 每帧驱动动画/React state。改 `ScrollTrigger`、`IntersectionObserver`、Motion `useScroll`、CSS `animation-timeline: view()`。
- **reveal 用 `power1.out`/线性缓动**（太快=廉价）。改 `power3.out`/`cubic-bezier(.16,1,.3,1)`/spring。
- **无 `prefers-reduced-motion` fallback**。强制；冻结到静止帧。
- **卡顿引擎**——粒子数太高、FBO 分辨率太高、断掉的 ScrollTrigger。中端设备 profile；低于 50fps 就简化。
- **product 特有**：不传达状态的装饰动效（hover 弹跳/橡皮筋）→ 只用 `ease-out` 的阴影/透明度反馈。product 过渡 150-250ms，用户在 flow 中，别让他们等编排。

---

## 4. 30 秒自查（发布前诚实作答）

1. **说出 anti-default 了吗？** 识别并打败了这个 brief 的懒惰审美？
2. **一个 accent 锁死？** 每节同一 accent？
3. **eyebrow 数 ≤ ceil(sections/3)？**
4. **≥4 个布局家族？** 没有家族出现超过两次？
5. **图片隐含处有真图？**
6. **spectacle 兑现**（若声称）？维持 60fps？有 reduced-motion fallback？
7. **文案干净？** 无 em-dash、无假数字、无 AI 俏皮串？
8. **对比 AA？** 含按钮、占位符、focus ring？

任一"否" = 未完成的活。

---

## 5. AI slop 测试（终极判据）

若有人能毫不犹豫说"这是 AI 做的"，就失败了。标准是**独特性**——访客该问"这怎么做出来的？"，而不是"哪个 AI 做的？"。
- **brand register**：restraint without intent 现在读作平庸，不是精致。要有 POV、明确受众、敢冒一点怪。
- **product register**：失败模式不是平淡，是"无目的的怪"——过度装饰的按钮、不匹配的表单控件、多余动效、标签处用 display 字体、为标准任务发明奇怪 affordance。标准是"赢得的熟悉感"——工具消失进任务里。
