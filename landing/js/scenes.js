/**
 * 正文的滚动联动：
 * - [data-focus]：声明文字逐字「跟焦」，进入视口时由虚到实；
 * - [data-drift]：特写画面随滚动在框内缓慢推移。
 * 元素位置只在布局变化时量一次，逐帧只写 CSS 变量，不读布局；减弱动态时直接落到终态。
 */
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

function splitChars(el) {
  const text = el.textContent.trim();
  const chars = Array.from(text);
  el.setAttribute('aria-label', text);
  el.textContent = '';
  const fragment = document.createDocumentFragment();
  chars.forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'focus__c';
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--i', i);
    span.textContent = ch;
    fragment.appendChild(span);
  });
  el.appendChild(fragment);
  el.style.setProperty('--n', chars.length);
  el.style.setProperty('--p', 0);
  el.classList.add('is-split');
}

export function createScenes({ reduced }) {
  const focusItems = [...document.querySelectorAll('[data-focus]')].map(el => ({ el, top: 0, height: 0, p: -1 }));
  const driftItems = [...document.querySelectorAll('[data-drift]')].map(el => ({
    el,
    amount: Number(el.dataset.drift) || 12,
    top: 0,
    height: 0,
    v: Number.NaN
  }));

  for (const item of focusItems) splitChars(item.el);

  // 液态玻璃场景卡：平时三张保持完全一致，仅在悬停时浮起并随鼠标视角偏转
  for (const deck of document.querySelectorAll('[data-deck]')) {
    const cards = [...deck.querySelectorAll('[data-card]')];
    const state = cards.map(() => ({ rx: 0, ry: 0, tx: 0, ty: 0, gx: 50, gy: 20, tgx: 50, tgy: 20 }));
    let raf = 0;

    const tick = () => {
      let moving = false;
      for (let i = 0; i < cards.length; i++) {
        const s = state[i];
        s.rx += (s.tx - s.rx) * 0.18;
        s.ry += (s.ty - s.ry) * 0.18;
        s.gx += (s.tgx - s.gx) * 0.2;
        s.gy += (s.tgy - s.gy) * 0.2;
        cards[i].style.setProperty('--rx', `${s.rx.toFixed(2)}deg`);
        cards[i].style.setProperty('--ry', `${s.ry.toFixed(2)}deg`);
        cards[i].style.setProperty('--gx', `${s.gx.toFixed(1)}%`);
        cards[i].style.setProperty('--gy', `${s.gy.toFixed(1)}%`);
        if (Math.abs(s.tx - s.rx) > 0.04 || Math.abs(s.ty - s.ry) > 0.04 || Math.abs(s.tgx - s.gx) > 0.1 || Math.abs(s.tgy - s.gy) > 0.1) {
          moving = true;
        }
      }
      raf = moving ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => { if (!raf && !reduced) raf = requestAnimationFrame(tick); };

    const setActive = activeIndex => {
      cards.forEach((c, i) => {
        const on = i === activeIndex;
        c.classList.toggle('is-on', on);
        if (!on) {
          state[i].tx = 0;
          state[i].ty = 0;
          state[i].tgx = 50;
          state[i].tgy = 20;
        }
      });
      kick();
    };

    cards.forEach((card, i) => {
      card.addEventListener('pointerenter', () => setActive(i));
      card.addEventListener('pointerleave', () => setActive(-1));
      card.addEventListener('focus', () => setActive(i));
      card.addEventListener('blur', () => setActive(-1));
      if (!reduced) {
        card.addEventListener('pointermove', event => {
          if (!card.classList.contains('is-on')) setActive(i);
          const r = card.getBoundingClientRect();
          const px = clamp((event.clientX - r.left) / r.width);
          const py = clamp((event.clientY - r.top) / r.height);
          state[i].ty = (px - 0.5) * 14;
          state[i].tx = (0.5 - py) * 12;
          state[i].tgx = px * 100;
          state[i].tgy = py * 100;
          kick();
        }, { passive: true });
      }
    });
  }

  function measure() {
    const y = scrollY;
    // 位移会改变包围盒，先归零再量
    for (const item of driftItems) {
      item.el.style.setProperty('--dy', '0px');
      item.v = Number.NaN;
    }
    for (const item of [...focusItems, ...driftItems]) {
      const r = item.el.getBoundingClientRect();
      item.top = r.top + y;
      item.height = r.height;
    }
  }

  function settle() {
    for (const item of focusItems) item.el.style.setProperty('--p', 1);
    for (const item of driftItems) item.el.style.setProperty('--dy', '0px');
  }

  function update(y, vh) {
    if (reduced) return;
    for (const item of focusItems) {
      const rel = item.top - y;
      // 顶边升到视口 88% 处开始对焦，升到 26% 处全部清晰
      const p = clamp((vh * 0.88 - rel) / (vh * 0.62));
      if (Math.abs(p - item.p) < 0.002) continue;
      item.p = p;
      item.el.style.setProperty('--p', p.toFixed(3));
    }
    for (const item of driftItems) {
      const t = (y + vh - item.top) / (vh + item.height);
      if (t < -0.1 || t > 1.1) continue;
      const v = Math.round((clamp(t) - 0.5) * 2 * item.amount * 4) / 4;
      if (v === item.v) continue;
      item.v = v;
      item.el.style.setProperty('--dy', `${-v}px`);
    }
  }

  if (reduced) settle();
  return { measure, update, reduced };
}
