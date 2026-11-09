/**
 * 宣传页编排：一个 rAF 循环统一驱动烟雾背景、显示器推镜、演示进度条、胶片放映机与导航状态。
 *
 * 档位由 <html> 的 is-cinema / is-static 决定：
 * - cinema：只有首屏钉住由滚动推镜；胶片是一屏高的放映机，截图恒速环绕、不受滚动影响，滚轮直接穿透去正文。
 * - static（窄屏或减弱动态）：不钉住，显示器按容器宽度等比缩放，胶片退化为纵向截图列表。
 * 场景离屏即停：不写样式、不发 draw call；正文区烟雾降到四分之一分辨率、30fps。
 */
import { createNovaSim, CHAPTERS } from './js/sim.js';
import { createSmoke } from './js/smoke.js';
import { createStrip, PITCH, pointInQuad, quadBounds } from './js/strip.js';
import { createLightbox } from './js/lightbox.js';
import { createReveal } from './js/reveal.js';
import { createScenes } from './js/scenes.js';

const root = document.documentElement;
const cinema = root.classList.contains('is-cinema');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = id => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const ramp = (v, a, b) => clamp((v - a) / (b - a));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// 系数按秒换算，60Hz 与 120Hz 屏上的跟手程度一致
const damp = (current, target, dt, rate) => current + (target - current) * (1 - Math.exp(-dt * rate));

/* ---------- 演示 ---------- */

const sim = createNovaSim($('nova-sim'));
const tabs = CHAPTERS.map((chapter, i) => {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'demo-tab';
  button.innerHTML = `<span>0${i + 1}</span>${chapter.label}`;
  button.addEventListener('click', () => (reduced ? sim.show(i) : sim.play(i)));
  li.appendChild(button);
  $('demo-tabs').appendChild(li);
  return button;
});

sim.on('chapter', index => {
  tabs.forEach((tab, i) => {
    tab.toggleAttribute('aria-current', i === index);
    if (i === index) tab.setAttribute('aria-current', 'step');
    tab.style.setProperty('--tab-p', i < index ? 1 : 0);
  });
  $('demo-caption').textContent = CHAPTERS[index].caption;
});
sim.on('done', index => tabs[index]?.style.setProperty('--tab-p', 1));

let simObserver = null;
if (reduced) {
  sim.show(3);
} else {
  // 显示器离开视口时暂停脚本，回来接着播
  let started = false;
  simObserver = new IntersectionObserver(entries => {
    const visible = entries.some(entry => entry.isIntersecting);
    if (visible && !started) { started = true; sim.play(0); }
    else if (visible) sim.resume();
    else sim.pause();
  }, { threshold: 0.15 });
  simObserver.observe($('demo'));
}

/* ---------- 显示器 ---------- */

const hero = $('top');
const monitor = $('monitor');
const screenEl = $('demo');
const copy = $('hero-copy');
const bar = $('demo-bar');
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

if (cinema) {
  window.addEventListener('pointermove', event => {
    pointer.tx = (event.clientX / innerWidth) * 2 - 1;
    pointer.ty = (event.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
}

function layoutStatic() {
  const wrap = $('monitor-wrap');
  const s = wrap.clientWidth / 1392;
  monitor.style.transform = `scale(${s})`;
  wrap.style.height = `${1008 * s}px`;
}

let heroTop = 0;
let heroSpan = 1;
function measureHero() {
  heroTop = hero.offsetTop;
  heroSpan = Math.max(1, hero.offsetHeight - innerHeight);
}

function layoutCinema(time, y) {
  const vw = innerWidth;
  const vh = innerHeight;
  const p = clamp((y - heroTop) / heroSpan);
  const d = easeInOut(ramp(p, 0.03, 0.5));
  const idle = 1 - d;

  pointer.x += (pointer.tx - pointer.x) * 0.05;
  pointer.y += (pointer.ty - pointer.y) * 0.05;

  // 起点：右侧斜放的整机；终点：屏幕正对镜头并铺满视口（机身溢出画外，像钻进了屏幕）
  const s0 = Math.min((vw * 0.5) / 1392, (vh * 0.8) / 1008);
  const s1 = Math.min((vw * 0.9) / 1280, (vh - 200) / 800);
  const x0 = vw * 0.715;
  const y0 = vh * 0.5;
  const x1 = vw / 2;
  const y1 = 78 + (vh - 78 - 122) / 2;
  const s = s0 + (s1 - s0) * d;
  const x = x0 + (x1 - x0) * d;
  const cy = y0 + (y1 - y0) * d + Math.sin(time * 0.7) * 6 * idle;
  const ry = (-17 + Math.sin(time * 0.45) * 1.3 + pointer.x * 3) * idle;
  const rx = (5 + Math.cos(time * 0.38) * 0.9 - pointer.y * 2) * idle;
  const rz = 0.8 * idle;
  monitor.style.transform =
    `translate3d(${(x - 696).toFixed(1)}px, ${(cy - 456).toFixed(1)}px, 0) rotateY(${ry.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${s.toFixed(4)})`;
  monitor.style.setProperty('--glass', (1 - 0.78 * d).toFixed(3));
  monitor.style.setProperty('--halo', (1 - 0.55 * d).toFixed(3));
  monitor.style.setProperty('--bezel', (1 - ramp(d, 0.55, 0.95)).toFixed(3));

  const copyFade = ramp(p, 0.02, 0.2);
  copy.style.setProperty('--copy-o', (1 - copyFade).toFixed(3));
  copy.style.setProperty('--copy-x', (-90 * copyFade).toFixed(1));
  copy.style.visibility = copyFade >= 1 ? 'hidden' : 'visible';

  const barO = ramp(p, 0.4, 0.52);
  bar.style.setProperty('--bar-o', barO.toFixed(3));
  bar.style.setProperty('--bar-pe', barO > 0.5 ? 'auto' : 'none');
}

/* ---------- 胶片放映机 ---------- */

const stripSection = $('moments');
const stripCanvas = $('strip-gl');
const frames = [...document.querySelectorAll('#strip-list .frame')];
const items = frames.map(frame => ({
  src: frame.querySelector('img').getAttribute('src'),
  alt: frame.querySelector('img').alt,
  title: frame.dataset.title,
  meta: frame.dataset.meta
}));

// 恒速环绕：每个槽位约 4.2 秒，悬停、点击与换章都不改变速度；只有灯箱打开或手动暂停才停
const SPEED = PITCH / 4.2;
const mod = (n, m) => ((n % m) + m) % m;

const reel = {
  scroll: 0,
  active: -1,
  hover: frames.map(() => 0),
  hoverIndex: -1,
  hoverSlot: 0,
  dim: 1,
  playing: !reduced,
  visible: false,
  swapTimer: 0
};

let strip = null;
let stripObserver = null;
if (cinema) {
  strip = createStrip(stripCanvas, items.map(item => item.src));
  if (!strip) stripSection.classList.add('is-fallback');
}

const playBtn = $('strip-play');
function paintPlayButton() {
  playBtn.setAttribute('aria-pressed', String(reel.playing));
  playBtn.dataset.state = reel.playing ? 'playing' : 'paused';
  playBtn.querySelector('.strip__play-label').textContent = reel.playing ? '暂停' : '继续';
}
paintPlayButton();
playBtn.addEventListener('click', () => {
  reel.playing = !reel.playing;
  paintPlayButton();
});

function setActiveFrame(index) {
  reel.active = index;
  $('strip-count').textContent = `${String(index + 1).padStart(2, '0')} / ${String(frames.length).padStart(2, '0')}`;
  const name = $('strip-name');
  const meta = $('strip-meta');
  name.classList.add('is-swapping');
  meta.classList.add('is-swapping');
  clearTimeout(reel.swapTimer);
  reel.swapTimer = setTimeout(() => {
    name.textContent = items[index].title;
    meta.textContent = items[index].meta;
    name.classList.remove('is-swapping');
    meta.classList.remove('is-swapping');
  }, reduced ? 0 : 220);
}

/** 灯箱里换页时，让胶片定位到离当前位置最近的那一格，关闭后从那里接着转。 */
function alignReel(index) {
  const slot = Math.round(reel.scroll / PITCH);
  const n = frames.length;
  const delta = mod(index - mod(slot, n) + n / 2, n) - n / 2;
  reel.scroll = (slot + delta) * PITCH;
}

const lightbox = createLightbox({
  root: $('lightbox'),
  items,
  reduced,
  onIndex: i => { if (strip) alignReel(i); }
});

function openFrame(i, rect, trigger) {
  lightbox.open(i, rect, trigger);
}

// 指针命中用与着色器同一套投影反算出的四角判断，命中帧微放大并提示可点开
let pointerPos = null;
stripCanvas.addEventListener('pointermove', event => {
  const r = stripCanvas.getBoundingClientRect();
  pointerPos = { x: event.clientX - r.left, y: event.clientY - r.top };
}, { passive: true });
stripCanvas.addEventListener('pointerleave', () => { pointerPos = null; }, { passive: true });
stripCanvas.addEventListener('click', () => {
  if (!strip || reel.hoverIndex < 0) return;
  const quad = strip.frameQuad(reel.hoverSlot, reel.hover[reel.hoverIndex]);
  if (!quad) return;
  const box = quadBounds(quad);
  const r = stripCanvas.getBoundingClientRect();
  openFrame(reel.hoverIndex, { left: box.left + r.left, top: box.top + r.top, width: box.width, height: box.height }, stripCanvas);
});
stripCanvas.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openFrame(mod(Math.round(reel.scroll / PITCH), frames.length), null, stripCanvas);
  }
});

// 静态档与无 WebGL 兜底：列表里的截图同样能点开看大图
for (const [i, frame] of frames.entries()) {
  const img = frame.querySelector('img');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'frame__open';
  button.setAttribute('aria-label', `放大查看：${items[i].title}`);
  img.replaceWith(button);
  button.appendChild(img);
  button.addEventListener('click', () => {
    const r = img.getBoundingClientRect();
    openFrame(i, { left: r.left, top: r.top, width: r.width, height: r.height }, button);
  });
}

if (strip) {
  stripObserver = new IntersectionObserver(entries => {
    reel.visible = entries.some(entry => entry.isIntersecting);
  }, { threshold: 0.05 });
  stripObserver.observe(stripSection);
}

function updateReel(dt) {
  if (!strip || !reel.visible) return;
  const open = lightbox.isOpen();
  if (reel.playing && !open) reel.scroll += SPEED * dt;

  const mid = Math.round(reel.scroll / PITCH);
  const centered = mod(mid, frames.length);
  if (centered !== reel.active) setActiveFrame(centered);

  let hit = -1;
  let hitSlot = 0;
  if (pointerPos && !open) {
    for (let slot = mid - 3; slot <= mid + 3; slot++) {
      const index = mod(slot, frames.length);
      const quad = strip.frameQuad(slot, reel.hover[index]);
      if (quad && pointInQuad(quad, pointerPos.x, pointerPos.y)) { hit = index; hitSlot = slot; break; }
    }
  }
  if (hit !== reel.hoverIndex) {
    reel.hoverIndex = hit;
    stripCanvas.style.cursor = hit >= 0 ? 'zoom-in' : 'default';
  }
  if (hit >= 0) reel.hoverSlot = hitSlot;
  for (let i = 0; i < reel.hover.length; i++) {
    reel.hover[i] = damp(reel.hover[i], i === hit ? 1 : 0, dt, 12);
  }
  reel.dim = damp(reel.dim, open ? 0.34 : 1, dt, 9);

  strip.render({ scroll: reel.scroll, hover: reel.hover, dim: reel.dim });
}

/* ---------- 背景 ---------- */

const smoke = createSmoke($('smoke'), { still: reduced });
let smokeAt = 0;

function updateSmoke(now) {
  const vh = innerHeight;
  const sr = screenEl.getBoundingClientRect();
  smoke.params.light[0] = (sr.left + sr.width / 2) / innerWidth;
  smoke.params.light[1] = 1 - (sr.top + sr.height / 2) / vh;
  smoke.params.lightAmt = clamp(sr.bottom / vh);
  const st = stripSection.getBoundingClientRect();
  const enter = clamp((vh - st.top) / vh);
  const exit = clamp((vh - st.bottom) / (vh * 0.8));
  smoke.params.scene = cinema ? enter * (1 - exit) : 0;
  smoke.params.dim = clamp((vh - st.bottom) / vh);
  // 正文只剩低频暖墨在漂，降到四分之一分辨率、30fps；首屏与胶片保持满档
  const quiet = st.bottom < 0;
  smoke.params.scale = quiet ? 0.28 : 0.5;
  if (quiet && now - smokeAt < 33) return;
  smokeAt = now;
  smoke.draw(now);
}

/* ---------- 导航 ---------- */

const chrome = $('chrome');
const navLinks = [...chrome.querySelectorAll('.chrome__nav a')];
const navSections = navLinks.map(link => document.querySelector(link.getAttribute('href')));
let navAt = -2;

const crt = $('crt');

function updateChrome() {
  const stripTop = stripSection.getBoundingClientRect().top;
  const solid = cinema ? stripTop < 96 : scrollY > 24;
  chrome.classList.toggle('is-solid', solid);
  // 扫描线与噪点属于显示器那一幕；到了截图和正文要撤掉，否则文字与细节会发糊
  crt.classList.toggle('is-clean', stripTop < innerHeight * 0.7);
  let at = -1;
  for (let i = 0; i < navSections.length; i++) {
    const el = navSections[i];
    if (el && el.getBoundingClientRect().top <= innerHeight * 0.42) at = i;
  }
  if (at === navAt) return;
  navAt = at;
  navLinks.forEach((link, i) => {
    if (i === at) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
}

const reveal = createReveal({ reduced });
const scenes = createScenes({ reduced });

// 特写图点开同一个灯箱；起点矩形收成截图比例的同心框，接片动画才不会变形
for (const el of document.querySelectorAll('[data-open]')) {
  el.addEventListener('click', () => {
    const r = el.getBoundingClientRect();
    const width = Math.min(r.width, r.height * 1.6);
    const height = width / 1.6;
    openFrame(Number(el.dataset.open), { left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height }, el);
  });
}

/* ---------- 主循环 ---------- */

let dirty = true;
let heroVisible = true;
addEventListener('scroll', () => { dirty = true; }, { passive: true });
let scenesY = -1;
function remeasure() {
  dirty = true;
  measureHero();
  scenes.measure();
  scenesY = -1;
  if (!cinema) layoutStatic();
}
addEventListener('resize', remeasure, { passive: true });
remeasure();
document.fonts?.ready.then(remeasure);
// 正文里的图片按需加载，到位后整页高度会变，位置要重新量
addEventListener('load', remeasure);

// 滚轮一格就是一次 100px 左右的跳变；首屏推镜跟着平滑后的位置走，镜头才不会一顿一顿
let smoothY = scrollY;
let lastNow = 0;

function frame(now) {
  const t = now / 1000;
  const dt = lastNow ? Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000)) : 1 / 60;
  lastNow = now;
  smoothY = damp(smoothY, scrollY, dt, 14);
  if (Math.abs(scrollY - smoothY) < 0.3) smoothY = scrollY;
  if (cinema) {
    heroVisible = smoothY < heroTop + heroSpan + innerHeight * 0.6;
    if (heroVisible) layoutCinema(t, smoothY);
  }
  updateReel(dt);
  if (smoothY !== scenesY) {
    scenesY = smoothY;
    scenes.update(smoothY, innerHeight);
  }
  if (heroVisible && tabs[sim.chapter]) tabs[sim.chapter].style.setProperty('--tab-p', sim.progress().toFixed(3));
  // 减弱动态下烟雾是静帧：只有滚动或尺寸变化才重画
  if (smoke && (!reduced || dirty)) updateSmoke(now);
  if (dirty) updateChrome();
  dirty = false;
  rafId = requestAnimationFrame(frame);
}
let rafId = requestAnimationFrame(frame);

// 进入往返缓存（persisted）时浏览器会冻结整页，回来还要接着用，不能释放；只有真正卸载才收尾
addEventListener('pagehide', event => {
  if (event.persisted) return;
  cancelAnimationFrame(rafId);
  clearTimeout(reel.swapTimer);
  simObserver?.disconnect();
  stripObserver?.disconnect();
  reveal.disconnect();
  sim.stop();
  strip?.dispose();
  smoke?.dispose();
});
