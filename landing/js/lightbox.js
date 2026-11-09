/**
 * 截图灯箱：点胶片上的某一格，画面从那一格的实际位置连续放大到灯箱位（接片），关闭时收回原处。
 * 大图用 DOM 图片走合成层，不额外开 WebGL 上下文；胶片本体由编排层压暗退焦。
 */

const OPEN_MS = 560;
const CLOSE_MS = 420;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function createLightbox({ root, items, reduced, onIndex, onOpenChange }) {
  const scrim = root.querySelector('.lb__scrim');
  const shot = root.querySelector('.lb__shot');
  const image = root.querySelector('.lb__img');
  const title = root.querySelector('.lb__title');
  const meta = root.querySelector('.lb__meta');
  const counter = root.querySelector('.lb__counter');
  const bar = root.querySelector('.lb__bar');
  const closeBtn = root.querySelector('.lb__close');
  const prevBtn = root.querySelector('.lb__prev');
  const nextBtn = root.querySelector('.lb__next');
  const ring = [closeBtn, prevBtn, nextBtn];

  let index = -1;
  let openedIndex = -1;
  let origin = null;
  let lastFocus = null;
  let anim = null;
  let closing = false;

  const isOpen = () => index >= 0;

  function targetRect() {
    const r = shot.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /** 从 from 矩形连续变到灯箱终态；两个矩形同比例，用居中位移 + 缩放就能精确对上。 */
  function splice(from, to, ms, reverse) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const s = from.width / to.width;
    const near = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(4)})`;
    const far = 'translate(0, 0) scale(1)';
    anim?.cancel();
    anim = shot.animate(
      reverse ? [{ transform: far }, { transform: near }] : [{ transform: near }, { transform: far }],
      { duration: ms, easing: reverse ? 'cubic-bezier(0.5, 0, 0.75, 0)' : EASE, fill: 'forwards' }
    );
    return anim;
  }

  /** 灯箱内换过页后，原来那一格已不是当前画面，收回时改为就地缩小淡出。 */
  function settleRect() {
    const to = targetRect();
    return { left: to.left + to.width * 0.07, top: to.top + to.height * 0.07, width: to.width * 0.86, height: to.height * 0.86 };
  }

  function paint(i) {
    const item = items[i];
    image.src = item.src;
    image.alt = item.alt;
    title.textContent = item.title;
    meta.textContent = item.meta;
    counter.textContent = `${String(i + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
    onIndex?.(i);
  }

  function open(i, fromRect, trigger) {
    if (closing) return;
    const already = isOpen();
    index = ((i % items.length) + items.length) % items.length;
    if (!already) lastFocus = trigger || document.activeElement;
    paint(index);
    if (already) {
      // 灯箱内换页：只做一次横向过片，不重跑接片
      if (index !== openedIndex) origin = null;
      if (!reduced) {
        image.animate(
          [{ opacity: 0.2, transform: 'translateX(22px)' }, { opacity: 1, transform: 'none' }],
          { duration: 360, easing: EASE }
        );
      }
      return;
    }
    openedIndex = index;
    root.hidden = false;
    root.classList.add('is-open');
    document.documentElement.classList.add('lb-open');
    onOpenChange?.(true);
    const to = targetRect();
    origin = fromRect || { left: to.left + to.width * 0.14, top: to.top + to.height * 0.14, width: to.width * 0.72, height: to.height * 0.72 };
    if (!reduced) {
      splice(origin, to, OPEN_MS, false);
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out', fill: 'backwards' });
      bar.animate(
        [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
        { duration: 460, delay: 130, easing: EASE, fill: 'backwards' }
      );
    }
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen() || closing) return;
    closing = true;
    root.classList.remove('is-open');
    const finish = () => {
      anim?.cancel();
      anim = null;
      root.hidden = true;
      document.documentElement.classList.remove('lb-open');
      index = -1;
      closing = false;
      onOpenChange?.(false);
      if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    };
    if (reduced) {
      finish();
      return;
    }
    const back = splice(origin || settleRect(), targetRect(), CLOSE_MS, true);
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' });
    bar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    back.finished.then(finish, finish);
  }

  function step(delta) {
    if (isOpen()) open(index + delta);
  }

  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  root.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    else if (event.key === 'Tab') {
      // 灯箱里只有三个可聚焦控件，焦点锁在里面；退出后还给触发的格子
      const at = ring.indexOf(document.activeElement);
      event.preventDefault();
      ring[(at + (event.shiftKey ? ring.length - 1 : 1) + ring.length) % ring.length].focus();
    }
  });

  return { open, close, step, isOpen, get index() { return index; } };
}