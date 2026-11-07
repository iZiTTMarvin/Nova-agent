/**
 * 宣传页编排：一个 rAF 循环统一驱动烟雾背景、显示器推镜、演示进度条与胶片画廊。
 *
 * 档位由 <html> 的 is-cinema / is-static 决定：
 * - cinema：首屏与胶片段落钉住，滚动进度决定镜头位置；连续值只写 CSS 变量与 uniform，不进 DOM 状态。
 * - static（窄屏或减弱动态）：不钉住，显示器按容器宽度等比缩放，胶片退化为纵向截图列表。
 */
import { createNovaSim, CHAPTERS } from './js/sim.js';
import { createSmoke } from './js/smoke.js';
import { createStrip, PITCH } from './js/strip.js';

const root = document.documentElement;
const cinema = root.classList.contains('is-cinema');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = id => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const ramp = (v, a, b) => clamp((v - a) / (b - a));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

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

function layoutCinema(time, y) {
  const vw = innerWidth;
  const vh = innerHeight;
  const p = clamp((y - hero.offsetTop) / (hero.offsetHeight - vh));
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

/* ---------- 胶片 ---------- */

const stripSection = $('moments');
const frames = [...document.querySelectorAll('#strip-list .frame')];
let strip = null;
const stripView = { scroll: 0, target: 0, vel: 0, active: -1, introAt: 0 };

if (cinema) {
  strip = createStrip($('strip-gl'), frames.map(frame => frame.querySelector('img').getAttribute('src')));
  if (!strip) stripSection.classList.add('is-fallback');
}

const dots = frames.map((frame, i) => {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'strip__dot';
  dot.setAttribute('aria-label', `第 ${i + 1} 张：${frame.dataset.title}`);
  dot.addEventListener('click', () => scrollToFrame(i));
  $('strip-dots').appendChild(dot);
  return dot;
});

/** 胶片段落里滚动进度与帧序号互换：两端各留一段停留区。 */
function scrollToFrame(index) {
  const i = clamp(index, 0, frames.length - 1);
  const sp = 0.05 + (i / (frames.length - 1)) * 0.9;
  const top = stripSection.offsetTop + sp * (stripSection.offsetHeight - innerHeight);
  window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
}
$('strip-prev').addEventListener('click', () => scrollToFrame(stripView.active - 1));
$('strip-next').addEventListener('click', () => scrollToFrame(stripView.active + 1));

let swapTimer = 0;
function setActiveFrame(index) {
  if (index === stripView.active) return;
  stripView.active = index;
  dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
  const name = $('strip-name');
  const meta = $('strip-meta');
  name.classList.add('is-swapping');
  meta.style.opacity = '0';
  clearTimeout(swapTimer);
  swapTimer = setTimeout(() => {
    name.textContent = frames[index].dataset.title;
    meta.textContent = frames[index].dataset.meta;
    name.classList.remove('is-swapping');
    meta.style.opacity = '1';
  }, 230);
}

function updateStrip(now, dt) {
  const vh = innerHeight;
  const rect = stripSection.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > vh) return;
  if (!stripView.introAt && rect.top < vh * 0.55) stripView.introAt = now;
  const sp = clamp(-rect.top / (rect.height - vh));
  stripView.target = ramp(sp, 0.05, 0.95) * (frames.length - 1) * PITCH;
  const prev = stripView.scroll;
  // 系数按帧时长换算，60Hz 与 120Hz 屏上的跟手程度一致
  stripView.scroll += (stripView.target - stripView.scroll) * (1 - Math.exp(-dt * 5.3));
  const speed = ((stripView.scroll - prev) / dt) / 60;
  stripView.vel += (clamp(speed * 0.35, -0.07, 0.07) - stripView.vel) * (1 - Math.exp(-dt * 9.75));
  setActiveFrame(clamp(Math.round(stripView.scroll / PITCH), 0, frames.length - 1));
  const intro = stripView.introAt ? easeOutExpo(clamp((now - stripView.introAt) / 1600)) : 0;
  strip.render({ scroll: stripView.scroll - (1 - intro) * 7, vel: stripView.vel });
}

/* ---------- 背景 ---------- */

const smoke = createSmoke($('smoke'), { still: reduced });

function updateSmoke() {
  const vh = innerHeight;
  const sr = screenEl.getBoundingClientRect();
  smoke.params.light[0] = (sr.left + sr.width / 2) / innerWidth;
  smoke.params.light[1] = 1 - (sr.top + sr.height / 2) / vh;
  smoke.params.lightAmt = clamp(sr.bottom / vh);
  const st = stripSection.getBoundingClientRect();
  const enter = clamp((vh - st.top) / vh);
  const exit = clamp((vh - st.bottom) / (vh * 0.8));
  smoke.params.scene = cinema ? enter * (1 - exit) : 0;
  smoke.params.dim = clamp((vh - st.bottom) / vh) * 0.75;
}

// 影院档里主屏和胶片是钉住的全屏画面，导航直接浮在上面；其余正文区需要底衬
const chrome = $('chrome');
function updateChrome() {
  const solid = cinema ? stripSection.getBoundingClientRect().bottom < 96 : scrollY > 24;
  chrome.classList.toggle('is-solid', solid);
}

/* ---------- 主循环 ---------- */

let dirty = true;
addEventListener('scroll', () => { dirty = true; }, { passive: true });
addEventListener('resize', () => { dirty = true; if (!cinema) layoutStatic(); });
if (!cinema) layoutStatic();

// 滚轮一格就是一次 100px 左右的跳变；首屏推镜跟着平滑后的位置走，镜头才不会一顿一顿
let smoothY = scrollY;
let lastNow = 0;

function frame(now) {
  const t = now / 1000;
  const dt = lastNow ? Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000)) : 1 / 60;
  lastNow = now;
  smoothY += (scrollY - smoothY) * (1 - Math.exp(-dt * 14));
  if (Math.abs(scrollY - smoothY) < 0.3) smoothY = scrollY;
  if (cinema) layoutCinema(t, smoothY);
  if (strip) updateStrip(now, dt);
  if (tabs[sim.chapter]) tabs[sim.chapter].style.setProperty('--tab-p', sim.progress().toFixed(3));
  // 减弱动态下烟雾是静帧：只有滚动或尺寸变化才重画
  if (smoke && (!reduced || dirty)) {
    updateSmoke();
    smoke.draw(now);
  }
  if (dirty) updateChrome();
  dirty = false;
  rafId = requestAnimationFrame(frame);
}
let rafId = requestAnimationFrame(frame);

// 进入往返缓存（persisted）时浏览器会冻结整页，回来还要接着用，不能释放；只有真正卸载才收尾
addEventListener('pagehide', event => {
  if (event.persisted) return;
  cancelAnimationFrame(rafId);
  clearTimeout(swapTimer);
  simObserver?.disconnect();
  sim.stop();
  strip?.dispose();
  smoke?.dispose();
});
