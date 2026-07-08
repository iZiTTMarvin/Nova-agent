# Motion & Hero Engines — 那一个奇观时刻 + 滚动骨架

> **中文说明**：一个 brand 页面靠**一个**技术精湛的视觉引擎赢得名声——不是五个，一个，做到 100%，通常在 hero。
> **何时加载**：造 hero 引擎、写 GSAP 滚动骨架、加动效词汇、处理 reduced-motion、框架集成时。`bolder`/`quieter`/`animate` 命令的主依据。
> **通用规则**：引擎挂在 `position:fixed; inset:0; z-index:0` 的 canvas；内容在 `z-index:5+`；渐进增强（删掉引擎页面仍完整可读）；只动 `transform`/`opacity`；`prefers-reduced-motion` 冻结到静止帧；canvas 做 DPR 适配。

命令语义：`bolder`=SPECTACLE+2 引擎升一档 · `quieter`=SPECTACLE−2 降档/简化 · `animate`=只加/换引擎不碰配色布局文案。三者都只改一件事，保留 substrate 与灵魂，然后重跑"spectacle 兑现"检查与 reduced-motion fallback。

---

## 五个引擎（按灵魂 + SPECTACLE dial 选）

| 引擎 | 用于 | 成本 | Gate |
|------|------|------|------|
| **A · Three.js + GLSL** | 3D 深度、粒子系统（星系/网络/DNA）、metaball、bloom | 重；lazy-load `three` | SPECTACLE ≥ 7 |
| **B · Canvas 2D** | 粒子、场、实时数据（K线/波形/火焰）、flow | 轻；DPR 适配 retina | 5–8 |
| **C · WebGL FBO shader** | 流体（Navier-Stokes）、reaction-diffusion、ray-march、虹彩 | 重；一个全屏 quad 多 pass | ≥ 8 且灵魂真关于涌现/物理 |
| **D · GSAP ScrollTrigger** | 滚动钉住叙事、水平 pan、parallax、reveal stagger | 中；最可复用的引擎 | 4–7 |
| **E · CSS-only** | 双层遮罩、CSS 3D、可变字体形变、`animation-timeline` | 免费；最佳性能 | 3–6 |

**拿不准选 D 或 E**——覆盖多数 brief，风险最低，永不卡。

**引擎纪律（强制）**：渐进增强（页面在引擎删除后完整可读，引擎是固定背景/hero 点缀，绝不承载内容）；60fps 或简化（中端设备测，低于 50fps 就砍粒子数/分辨率）；`prefers-reduced-motion` 强制（冻结静止帧或换静态 hero）；动机驱动（每个 ScrollTrigger/marquee/钉住节需一句话理由，"看起来酷"不是理由；每页最多 1 个 marquee）。

---

## 引擎 A — Three.js 粒子星系（骨架）

```js
import * as THREE from 'three';
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
camera.position.z = 600;
const COUNT = 22000;
const pos = new Float32Array(COUNT * 3);
for (let i = 0; i < COUNT; i++) {
  const r = Math.pow(Math.random(), 0.6) * 700, a = Math.random() * Math.PI * 2;
  pos[i*3] = Math.cos(a) * r; pos[i*3+1] = (Math.random()-0.5) * 80; pos[i*3+2] = Math.sin(a) * r;
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
const mat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#5fd4ff') } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `uniform float uTime; void main(){ vec3 p=position;
    float a=uTime*0.05; mat2 R=mat2(cos(a),-sin(a),sin(a),cos(a)); p.xz=R*p.xz;
    vec4 mv=modelViewMatrix*vec4(p,1.0); gl_PointSize=2.0*(300.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; void main(){ float d=length(gl_PointCoord-0.5);
    if(d>0.5) discard; gl_FragColor=vec4(uColor, 1.0-d*2.0); }`,
});
scene.add(new THREE.Points(geo, mat));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function loop(t){ mat.uniforms.uTime.value = t*0.001; renderer.render(scene, camera); if(!reduce) requestAnimationFrame(loop); }
requestAnimationFrame(loop);
addEventListener('resize', () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
```
可选滚动耦合：用 GSAP ScrollTrigger `scrub` 驱动 `camera.position.z` 或 `scene.rotation.y`。

## 引擎 B — Canvas 2D 火焰/余烬（骨架）

```js
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
let W, H, DPR = Math.min(devicePixelRatio, 2);
function resize(){ W=innerWidth; H=innerHeight; canvas.width=W*DPR; canvas.height=H*DPR; ctx.setTransform(DPR,0,0,DPR,0,0); }
resize(); addEventListener('resize', resize);
const N = 180, P = Array.from({length:N}, () => ({ x:Math.random()*W, y:H+Math.random()*H, vy:0.4+Math.random(), r:Math.random()*2+0.5, life:Math.random() }));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(){
  ctx.fillStyle = 'rgba(7,4,2,0.18)'; ctx.fillRect(0,0,W,H);      // 拖尾淡出，非全清
  for (const p of P){
    p.y -= p.vy; p.x += Math.sin(p.y*0.02)*0.4; p.life -= 0.004;
    if (p.y < -10 || p.life <= 0){ p.y=H+10; p.x=Math.random()*W; p.life=1; }
    const hue = 15 + p.life*30;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    ctx.fillStyle = `hsla(${hue},90%,${50+p.life*20}%,${p.life})`;
    ctx.shadowBlur = 12; ctx.shadowColor = `hsl(${hue},90%,55%)`; ctx.fill();
  }
  if (!reduce) requestAnimationFrame(frame);
}
frame();
```
实时数据变体（K线/波形）：保一个环形缓冲，每帧左滚，重算可见 min/max 做自适应刻度。

## 引擎 C — WebGL FBO（结构）

两个 float framebuffer 乒乓（read/write）；① 仿真 pass（fragment shader 读 read，advect/diffuse/solve，写 write，交换）；② 显示 pass（映射最终态到颜色）；③ 鼠标每帧注入 source。这是最容易发成卡顿的引擎——profile 它，中端低于 50fps 就把 FBO 分辨率减半，永远给 reduced-motion 一张静态渐变 poster。

## 引擎 D — GSAP ScrollTrigger（主力，canonical 骨架）

**Reveal stagger（最轻，优先于钉住）：**
```js
gsap.registerPlugin(ScrollTrigger);
gsap.utils.toArray('.reveal').forEach((el) => {
  gsap.from(el, { opacity: 0, y: 34, duration: 0.7, ease: 'power3.out',
    scrollTrigger: { trigger: el, start: 'top 80%', once: true } });
});
```
**Horizontal pan（钉 wrapper，scrub track）：**
```js
const track = document.querySelector('.otrack');
const distance = track.scrollWidth - innerWidth;
gsap.to(track, { x: -distance, ease: 'none',
  scrollTrigger: { trigger: '.pan-wrap', start: 'top top', end: () => `+=${distance}`,
    pin: true, scrub: 1, invalidateOnRefresh: true } });
```
**Sticky-stack（卡片钉住并随下一张到来缩小）：** 除最后一张外每张卡在 `start:'top top'` 钉住，用**下一张**卡的 scrub trigger 驱动当前卡的 `scale/opacity`。

**必避失败**：`start:'top center'` 代替 `'top top'`（中途触发，看着断裂）；漏 `invalidateOnRefresh`（resize 崩）；SPA 里漏 `ScrollTrigger.getAll().forEach(t=>t.kill())` 清理。

## 引擎 E — CSS-only（双层鼠标遮罩 + 原生滚动驱动）

```css
.layer-night { position:absolute; inset:0; background:url(reveal.jpg) center/cover;
  -webkit-mask: radial-gradient(circle 200px at -400px -400px, #000 40%, transparent 72%);
          mask: radial-gradient(circle 200px at -400px -400px, #000 40%, transparent 72%); will-change: mask; }
@keyframes rise { from { opacity:0; transform:translateY(40px) } to { opacity:1; transform:none } }
.reveal { animation: rise linear both; animation-timeline: view(); animation-range: entry 0% cover 35%; }
```
```js
addEventListener('pointermove', e => {
  const m = `radial-gradient(circle 220px at ${e.clientX}px ${e.clientY}px, #000 40%, transparent 72%)`;
  night.style.mask = m; night.style.webkitMask = m;
});
```
可变字体形变：滚动/hover 时动画 `font-variation-settings: 'wght' …, 'wdth' …`（需可变字体如 Roboto Flex）。

---

## 次级动效词汇（非 hero 引擎，可自由用于页面各处）

每个仍需动机 + reduced-motion fallback。不违反"一引擎"规则。

- **split-char reveal** — 每个字符包一个 masked span，stagger 上升入位（而非整行淡入）。按**字符**拆（CJK 无空格）。保留给少数关键标题，不是每个 `<h2>`。
- **magnetic button** — CTA 在自身范围内向光标微移几 px，pointerleave 弹回。用 `gsap.quickTo`。每页 1-2 个主 CTA，reduced-motion 下完全跳过。
- **curtain-wipe reveal** — 实底面板 `scaleX 1→0`（`transformOrigin` 一边）scrub 到滚动位置，露出下面内容。用于 before/after beat，别作普通 section 装饰默认。
- **scan-line sweep** — 细发光条在数据/图表块上随滚动扫过，把"测量"母题绑到 stats section。
- **inline typography image**（SOUL ≥ 8）— 标题内嵌一张窄竖裁图/方图当排版标点，`width:clamp(60px,8vw,140px); height:.85em; border-radius:999px`；display 字号才成立。

---

## Reduced Motion（不可选）

- 任何 `SPECTACLE/MOTION > 3` 的动效必须遵守 `prefers-reduced-motion`。
- Motion 库：`useReducedMotion()` 包裹，降级为静态。
- CSS：动画 gate 在 `@media (prefers-reduced-motion: no-preference)`，或提供 `reduce` 覆盖块禁用。
- 无限循环、parallax、scroll-hijack、magnetic 物理在 reduced-motion 下必须塌缩为静态/瞬时。

## 性能护栏

- 只动画 `transform`/`opacity`，绝不 `top/left/width/height`。`will-change` 稀疏用。
- grain/noise 滤镜只用于固定的 `pointer-events-none` 伪元素，绝不用于滚动容器（持续 GPU 重绘毁移动端 FPS）。
- 重引擎 lazy-load（Motion 不小，Three.js 大）；小单文件库（GSAP core+ScrollTrigger ~113KB）自托管；heavy 库用版本化 CDN import map。绝不引用一个没有文件的 `./lib/x.js`。
- Core Web Vitals：LCP < 2.5s（hero 图 `priority`/preload）、INP < 200ms、CLS < 0.1。

---

## 框架集成清单

**React/Next**：GSAP 用 `useGSAP()`/`gsap.context()`，卸载自动 `ctx.revert()`；Three.js lazy-import，`useEffect` 返回 `cancelAnimationFrame(rafId); renderer.dispose()`；启动任何 loop 前先 gate `useReducedMotion()`。
```js
import { useGSAP } from '@gsap/react';
useGSAP(() => {
  gsap.from('.hero-text', { opacity: 0, y: 40, duration: 1, ease: 'power3.out' });
}, { scope: containerRef });   // 卸载时自动 kill 所有 ScrollTrigger
```
**Vue 3 / Svelte**：`onMounted`/`onMount` setup，`onUnmounted`/`onDestroy` 里 `cancelAnimationFrame` + `renderer?.dispose()` + `ScrollTrigger.getAll().forEach(t=>t.kill())`。

**通用坑**：漏 `ScrollTrigger` kill → SPA 幻影触发；漏 `renderer.dispose()` → GPU 内存泄漏（最常见性能 bug）；`window.addEventListener('scroll',…)` 每帧驱动 = 帧率杀手；启动 canvas loop 不先 gate reduced-motion（要冻结，不是跳过）。

## 四个 ship-test（overdrive 思维）

1. **wow** — 没见过的人会有反应吗？
2. **removal** — 删掉引擎，体验明显变差吗？
3. **device** — 手机/Chromebook 上仍流畅吗？
4. **context** — 这奇观真服务这个品牌和受众，还是在炫技？

"removal"或"context"不过 → 奇观是装饰不是 finesse，砍掉或重做。
