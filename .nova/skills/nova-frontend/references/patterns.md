# Patterns — 模式词汇表 + Liquid Glass 诚实近似

> **中文说明**：这是词汇表不是库——模型该"知道这些模式名"以便沟通与设计时想到；实现骨架在 `motion-engines.md`。
> **何时加载**：需要 hero/nav/scroll/gallery 等模式名时；Apple Liquid Glass web 近似；组件级 3D 选型。
> **核心**：英文模式名 + 一句描述；默认 CSS 3D 层，Three.js 仅真实渲染对象；"一页一个 3D 时刻"。

---

## 1. 词汇表用法

模式名用于 brief 沟通、Design Read、section 规划。**不是**逐条实现的 checklist。Hero 引擎实现见 `motion-engines.md`；glassmorphism 默认禁令见 `anti-cheap.md` §2。

**动画库选择**（同一组件树内禁止混用）：
- **Motion (`motion/react`)** — UI / Bento / state-change 默认。
- **GSAP + ScrollTrigger** — 全页 scrolltelling、scroll hijack。隔离在 dedicated leaf + cleanup。
- **Three.js / WebGL** — canvas 背景与 3D scene。同样隔离规则。

---

## 2. Hero Paradigms

- **Asymmetric Split Hero** — 一侧文字、一侧 asset，慷慨留白。
- **Editorial Manifesto Hero** — 大字、无 asset，近乎 poster。
- **Video / Media Mask Hero** — 文字作为 video 背景的 mask 镂空。
- **Kinetic-Type Hero** — 动画 typography 作 primary visual。
- **Curtain-Reveal Hero** — scroll 时 hero 像 curtain 分开。
- **Scroll-Pinned Hero** — hero 钉住，内容 scroll 其后。

---

## 3. Navigation & Menus

- **Mac OS Dock Magnification** — 边缘 nav，hover 图标 fluid scale。
- **Magnetic Button** — 向光标微移（见 `motion-engines.md` 次级词汇）。
- **Gooey Menu** — 子项像 viscous liquid  detach。
- **Dynamic Island** — morphing pill 承载 status / alerts。
- **Contextual Radial Menu** — 点击点展开圆形菜单。
- **Floating Speed Dial** — FAB spring 成 curved secondary actions。
- **Mega Menu Reveal** — 全屏 dropdown，stagger-fade content。

---

## 4. Layout & Grids

- **Bento Grid** — 不对称 tile 分组（Apple Control Center 式）。
- **Masonry Layout** — 错落 grid，无固定行高。
- **Chroma Grid** — border/tile 带 subtle animating gradients。
- **Split-Screen Scroll** — 两半 scroll 反向滑动。
- **Sticky-Stack Sections** — section pin 后 stack（见 `motion-engines.md` Engine D）。

---

## 5. Cards & Containers

- **Parallax Tilt Card** — 3D tilt 跟踪鼠标（§6 CSS 骨架）。
- **Spotlight Border Card** — cursor 下 border  illuminate。
- **Glassmorphism Panel** — 磨砂玻璃 + 内折射（稀有、有目的；`anti-cheap.md` 默认拒绝）。
- **Holographic Foil Card** — hover 虹彩 rainbow shift。
- **Tinder Swipe Stack** — 物理 card stack，swipe-away。
- **Morphing Modal** — button expand 成自身 dialog。

---

## 6. Scroll Animations

- **Sticky Scroll Stack** — cards stick 并物理 stack。
- **Horizontal Scroll Hijack** — 垂直 scroll → 水平 pan（`motion-engines.md` Engine D）。
- **Locomotive / Sequence Scroll** — video / 3D sequence 绑 scrollbar。
- **Zoom Parallax** — 中心背景图 scroll zoom。
- **Scroll Progress Path** — SVG line 随 scroll 绘制。
- **Liquid Swipe Transition** — 页面 transition 如 viscous liquid。

---

## 7. Galleries & Media

- **Dome Gallery** — 3D panoramic gallery。
- **Coverflow Carousel** — 3D carousel 带 angled edges（§6 CSS 骨架）。
- **Drag-to-Pan Grid** — 无界 draggable canvas。
- **Accordion Image Slider** — 窄 strip hover expand。
- **Hover Image Trail** — 鼠标留下 popping image trail。
- **Glitch Effect Image** — hover RGB-channel shift。

---

## 8. Typography & Text

- **Kinetic Marquee** — 无尽 text band，scroll 反向（每页 ≤1 marquee）。
- **Text Mask Reveal** — 巨型 type 作 video 透明窗。
- **Text Scramble Effect** — Matrix 式 decode on load/hover。
- **Circular Text Path** — 文字沿 spinning circle 弯曲。
- **Gradient Stroke Animation** — outlined text + running gradient（非 `background-clip:text` 正文花活）。
- **Kinetic Typography Grid** — 字母 dodge cursor。

---

## 9. Micro-Interactions & Effects

- **Particle Explosion Button** — success 时 CTA shatter 成 particles。
- **Liquid Pull-to-Refresh** — reload indicator 如 detach droplets。
- **Skeleton Shimmer** — placeholder 上 shifting light reflection。
- **Directional Hover-Aware Button** — fill 从 cursor 精确侧边进入。
- **Ripple Click Effect** — 从 click 坐标扩散 wave。
- **Animated SVG Line Drawing** — vector 实时 self-draw。
- **Mesh Gradient Background** — organic lava-lamp blobs。
- **Lens Blur Depth** — 背景 UI blur 聚焦 foreground action。

---

## 10. 组件级 3D（CSS vs Three.js）

Web 3D 分两 register——选错是 #1  mistake：

| | **CSS 3D（pseudo / 2.5D）** | **Three.js（real 3D）** |
|---|---|---|
| 是什么 | DOM 元素在 perspective 空间 rotate | mesh、camera、light、shader 渲染 WebGL |
| 成本 | 免费、无 deps | ~150KB gz，lazy-load，GPU-bound |
| 用于 | tilt card、flip card、coverflow、depth-parallax | product viewer、displacement plane、particle depth |
| SPECTACLE | 3–6 | 7–10 |

**默认 CSS 3D**，覆盖 ~80% "feel 3D" brief。**一页一个 3D 时刻**——tilt grid + coverflow + Three.js scene = noise。±8–14° tilt；±20°+ 读作 cheap CodePen。无 perspective 时页面仍完整可读。

### 10.A Perspective 基础

```css
.scene  { perspective: 900px; }              /* 700–1200 typical */
.card   { transform-style: preserve-3d; transition: transform .5s cubic-bezier(.2,.8,.2,1); }
.card > .lift { transform: translateZ(40px); }
```
`perspective` 在 **parent**；moving 元素及中间 ancestor 需 `transform-style: preserve-3d`。

### 10.B Pointer-tilt card

```js
card.addEventListener('pointermove', e => {
  const b = card.getBoundingClientRect();
  const px = (e.clientX - b.left) / b.width  - 0.5;
  const py = (e.clientY - b.top)  / b.height - 0.5;
  card.style.transform = `rotateY(${px * 12}deg) rotateX(${-py * 12}deg)`;
  card.style.setProperty('--gx', `${(px + 0.5) * 100}%`);
  card.style.setProperty('--gy', `${(py + 0.5) * 100}%`);
});
card.addEventListener('pointerleave', () => { card.style.transform = ''; });
```
```css
.card::after {
  content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  background: radial-gradient(circle at var(--gx,50%) var(--gy,50%),
              rgba(255,255,255,.18), transparent 45%); opacity:0; transition:opacity .3s;
}
.card:hover::after { opacity:1; }
```
`pointerleave` 用空 string reset，让 **CSS transition** ease home。touch 无 hover → skip 或 gate `deviceorientation`。

### 10.C Flip card

```css
.flip { perspective: 1000px; }
.flip-inner { transform-style: preserve-3d; transition: transform .7s cubic-bezier(.2,.8,.2,1); }
.flip:hover .flip-inner,
.flip:focus-within .flip-inner { transform: rotateY(180deg); }
.flip-face { position:absolute; inset:0; backface-visibility:hidden; }
.flip-back { transform: rotateY(180deg); }
```
`:focus-within` 同 gate，keyboard 可达。一 card 一 flip。

### 10.D Coverflow

```js
function layout(items, active) {
  items.forEach((el, i) => {
    const off = i - active;
    const sign = Math.sign(off), mag = Math.min(Math.abs(off), 3);
    el.style.transform =
      `translateX(${off * 56}%) translateZ(${-mag * 140}px) rotateY(${-sign * mag * 34}deg)`;
    el.style.zIndex = String(10 - mag);
    el.style.opacity = String(Math.max(0, 1 - mag * 0.28));
  });
}
```
Parent `perspective: 1400px`。click / arrow / drag 推进 `active`。

### 10.E Depth-parallax layers

```js
const layers = [...scene.querySelectorAll('[data-depth]')];
scene.addEventListener('pointermove', e => {
  const b = scene.getBoundingClientRect();
  const x = (e.clientX - b.left) / b.width  - 0.5;
  const y = (e.clientY - b.top)  / b.height - 0.5;
  for (const l of layers) {
    const d = +l.dataset.depth;
    l.style.transform = `translate3d(${x * d * -40}px, ${y * d * -40}px, ${d * 60}px)`;
  }
});
```
`translateZ` 分离于 2D parallax；scene 需 `perspective`。

Three.js 仅当 brief 真需要 rendered object（GLTF viewer、displacement plane）——setup/cleanup 见 `motion-engines.md` Engine A。`prefers-reduced-motion` 冻结 tilt/parallax；Three.js 显示 still poster。

---

## 11. Apple Liquid Glass — Web 诚实近似

**不要**把 random CSS snippet 当 official Apple Liquid Glass。

### 什么是 official
Apple 在 HIG 与 Developer Documentation 为 **Apple platforms** 记录 Liquid Glass。Native 实现属于 Apple platform API，**不是 public web CSS package**。无官方 `liquid-glass.css`。

### 什么是 web 近似
可用 `backdrop-filter`、透明背景、分层 border、highlight overlay、gradient、motion、强对比 fallback——但这是 **web glassmorphism / frosted-glass 近似**，不是 official Liquid Glass。**代码注释必须标注"近似，非 Apple 官方"**。默认装饰性 glass 禁令见 `anti-cheap.md`。

### CSS 骨架

```css
/* 近似，非 Apple 官方 — web frosted-glass approximation */
.liquid-glass-web-approx {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / .32);
  background:
    linear-gradient(135deg, rgb(255 255 255 / .30), rgb(255 255 255 / .08)),
    rgb(255 255 255 / .12);
  backdrop-filter: blur(24px) saturate(180%) contrast(1.05);
  -webkit-backdrop-filter: blur(24px) saturate(180%) contrast(1.05);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / .48),
    inset 0 -1px 0 rgb(255 255 255 / .12),
    0 18px 60px rgb(0 0 0 / .18);
}

.liquid-glass-web-approx::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background:
    radial-gradient(circle at 20% 0%, rgb(255 255 255 / .55), transparent 34%),
    linear-gradient(90deg, rgb(255 255 255 / .18), transparent 42%, rgb(255 255 255 / .14));
  pointer-events: none;
}

.liquid-glass-web-approx::after {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  border: 1px solid rgb(255 255 255 / .14);
  pointer-events: none;
}

@media (prefers-color-scheme: dark) {
  .liquid-glass-web-approx {
    border-color: rgb(255 255 255 / .18);
    background:
      linear-gradient(135deg, rgb(255 255 255 / .16), rgb(255 255 255 / .04)),
      rgb(15 23 42 / .42);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / .22),
      0 18px 60px rgb(0 0 0 / .42);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .liquid-glass-web-approx {
    background: rgb(255 255 255 / .96);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
```

`prefers-reduced-transparency` 浏览器支持不均——必须测。无 blur 时对比仍须足够。
