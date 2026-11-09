/**
 * 正文显影：进入视口的元素按序曝光一次，标题走遮罩上推，条目按 --i 错峰。
 * 只做一次性 class 切换，连续动画交给 CSS 合成层；减弱动态与不支持观察器时直接落到终态。
 */
export function createReveal({ reduced }) {
  // 只有脚本真正跑起来才隐藏待显影元素；脚本失败时正文照常可见
  document.documentElement.classList.add('reveal-ready');
  const targets = [...document.querySelectorAll('[data-reveal]')];
  for (const el of targets) {
    const group = el.closest('[data-stagger]');
    if (group) {
      const kids = [...group.querySelectorAll('[data-reveal]')];
      el.style.setProperty('--i', kids.indexOf(el));
    }
  }
  if (reduced || !('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('is-in'));
    return { observe: () => {}, disconnect() {} };
  }
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
  targets.forEach(el => io.observe(el));
  return { observe: el => io.observe(el), disconnect: () => io.disconnect() };
}