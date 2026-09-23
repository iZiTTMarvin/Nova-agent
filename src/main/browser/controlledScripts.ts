/**
 * 只在受控隔离世界里运行的固定脚本。
 * 选择器与文本都经 JSON 写入，页面内容不能改写脚本结构。
 * 快照与定位复用注入脚本（incrementalAriaSnapshot / generateSelectorSimple），不自研引擎。
 */

const ENGINE = 'globalThis.__novaBrowserInjected'

/** 单次可交互项上限 */
export const BROWSER_SNAPSHOT_ITEM_LIMIT = 200
/** 页面提取遍历候选节点上限 */
export const BROWSER_SNAPSHOT_NODE_LIMIT = 2000
/** 语义输出字节上限 */
export const BROWSER_SNAPSHOT_TEXT_BYTES = 16 * 1024
/** 页面线程上的观察时间预算 */
export const BROWSER_SNAPSHOT_TIME_MS = 1500
/** 截图前等待字体、可见图片与绘制机会的预算上限 */
export const BROWSER_CAPTURE_READY_BUDGET_MS = 1_500

/**
 * 两段快照：dom 语义行（带 ref）在前，elements 动作细节（selector/rect）在后。
 * 预算作用于实际工作量：候选节点先数后取、分段快照、逐项让出页面线程。
 */
export function snapshotExpression(focus?: { readonly role: string; readonly name: string }): string {
  return `(async () => {
  const injected = ${ENGINE};
  const focus = ${JSON.stringify(focus ?? null)};
  if (!injected || typeof injected.incrementalAriaSnapshot !== 'function' || typeof injected.parseSelector !== 'function' || typeof injected.generateSelectorSimple !== 'function') {
    return { error: 'missing-engine' };
  }
  const body = document.body;
  if (!body) return { error: 'empty-document' };
  const ITEM_LIMIT = ${BROWSER_SNAPSHOT_ITEM_LIMIT};
  const NODE_LIMIT = ${BROWSER_SNAPSHOT_NODE_LIMIT};
  const TEXT_BYTES = ${BROWSER_SNAPSHOT_TEXT_BYTES};
  const TIME_MS = ${BROWSER_SNAPSHOT_TIME_MS};
  const started = Date.now();
  const overTime = () => Date.now() - started > TIME_MS;
  // MessageChannel 让出事件循环：不受隐藏页定时器节流影响
  const yieldPage = () => new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const byteLength = (text) => (encoder ? encoder.encode(text).length : text.length * 2);
  const limits = [];
  let truncated = false;

  const countCandidates = (root, cap) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    walker.nextNode();
    let seen = 0;
    while (walker.nextNode()) {
      seen += 1;
      if (seen > cap) return seen;
    }
    return seen;
  };

  const quickSelector = (element, name) => {
    const unique = (selector) => {
      try {
        return injected.querySelectorAll(injected.parseSelector(selector), document).length === 1;
      } catch {
        return false;
      }
    };
    const id = element.id;
    if (id) {
      const byId = 'css=#' + CSS.escape(id);
      if (unique(byId)) return byId;
    }
    if (name) {
      const byText = 'text=' + JSON.stringify(name);
      if (unique(byText)) return byText;
    }
    return '';
  };

  const sections = [];
  let scope = { kind: 'full' };
  let focusRoot = null;
  if (focus) {
    try {
      const selector = 'internal:role=' + focus.role + '[name=' + JSON.stringify(focus.name) + 's]';
      const matches = injected.querySelectorAll(injected.parseSelector(selector), document);
      let reason = null;
      if (overTime()) reason = 'time-budget';
      else if (document.querySelector('iframe')) reason = 'unsupported';
      else if (matches.length === 0) reason = 'missing';
      else if (matches.length !== 1) reason = 'ambiguous';
      else if (countCandidates(matches[0], NODE_LIMIT) > NODE_LIMIT) reason = 'node-budget';
      else if (overTime()) reason = 'time-budget';
      if (reason) scope = { kind: 'full_fallback', reason };
      else { focusRoot = matches[0]; scope = { kind: 'focused' }; }
    } catch { scope = { kind: 'full_fallback', reason: 'unsupported' }; }
  }
  if (overTime()) {
    limits.push('time-budget');
    truncated = true;
  } else if (focusRoot) {
    sections.push(focusRoot);
  } else if (countCandidates(body, NODE_LIMIT) <= NODE_LIMIT) {
    sections.push(body);
  } else {
    limits.push('node-budget');
    truncated = true;
    let budget = NODE_LIMIT;
    for (const child of Array.from(body.children)) {
      if (budget <= 0 || overTime()) {
        if (overTime()) limits.push('time-budget');
        break;
      }
      const size = countCandidates(child, budget);
      if (size > budget) continue;
      sections.push(child);
      budget -= size;
    }
  }

  const parseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) return { role: '', name: '' };
    const rest = trimmed.slice(2);
    const match = /^([^"\\[]*)\\s*(?:"((?:[^"\\\\]|\\\\.)*)")?/.exec(rest);
    if (!match) return { role: '', name: '' };
    return {
      role: (match[1] || '').trim().slice(0, 60),
      name: match[2] !== undefined ? match[2].slice(0, 120) : ''
    };
  };

  const elements = [];
  const domParts = [];
  let usedBytes = 0;
  let itemCount = 0;

  for (const section of sections) {
    if (overTime()) {
      limits.push('time-budget');
      truncated = true;
      break;
    }
    const aria = injected.incrementalAriaSnapshot(section, { mode: 'ai' });
    if (aria.iframeRefs && aria.iframeRefs.length > 0 && !limits.includes('subframes')) {
      limits.push('subframes');
    }
    const lines = String(aria.full || '').split('\\n');
    const kept = [];
    let cut = false;
    for (const line of lines) {
      const refMatch = /\\[ref=(e\\d+)\\]/.exec(line);
      if (!refMatch) {
        kept.push(line);
        continue;
      }
      if (elements.length >= ITEM_LIMIT) {
        if (!limits.includes('item-budget')) {
          limits.push('item-budget');
          truncated = true;
        }
        cut = true;
        break;
      }
      const ref = refMatch[1];
      const described = parseLine(line);
      const found = injected.querySelectorAll(injected.parseSelector('aria-ref=' + ref), document);
      let selector = '';
      if (found.length === 1) {
        selector = quickSelector(found[0], described.name);
        if (!selector) {
          try { selector = injected.generateSelectorSimple(found[0]) || ''; } catch { selector = ''; }
        }
      }
      if (!selector) continue;
      const rect = found[0].getBoundingClientRect();
      elements.push({
        ref,
        role: described.role,
        name: described.name,
        selector: String(selector).slice(0, 400),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
      kept.push(line);
      itemCount += 1;
      if (itemCount % 25 === 0) {
        if (overTime()) {
          limits.push('time-budget');
          truncated = true;
          cut = true;
          break;
        }
        await yieldPage();
      }
    }
    const text = kept.join('\\n');
    usedBytes += byteLength(text);
    if (usedBytes > TEXT_BYTES) {
      limits.push('size-budget');
      truncated = true;
      const room = Math.max(0, TEXT_BYTES - (usedBytes - byteLength(text)));
      const roomLines = [];
      let roomBytes = 0;
      for (const line of kept) {
        const lineBytes = byteLength(line) + 1;
        if (roomBytes + lineBytes > room) break;
        roomBytes += lineBytes;
        roomLines.push(line);
      }
      domParts.push(roomLines.join('\\n'));
      break;
    }
    domParts.push(text);
    if (cut) break;
  }

  // 截断后 dom 可能少了尾部语义行：elements 只保留 dom 里仍存在的 ref，维持一一对应
  const finalDom = domParts.join('\\n');
  const presentRefs = new Set();
  let refScan;
  const refPattern = /\\[ref=(e\\d+)\\]/g;
  while ((refScan = refPattern.exec(finalDom)) !== null) presentRefs.add(refScan[1]);
  const keptElements = elements.filter((item) => presentRefs.has(item.ref));

  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    viewport: {
      width: Math.max(0, Math.round(window.innerWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || 0)),
      devicePixelRatio: Number(window.devicePixelRatio || 1)
    },
    scrollY: Math.round(window.scrollY || 0),
    dom: finalDom,
    elements: keptElements,
    truncated,
    limits,
    scope,
  };
})()`
}

export const READY_EXPRESSION = `(() => ({
  href: String(location.href || ''),
  readyState: String(document.readyState || '')
}))()`

export function injectExpression(source: string): string {
  const options = JSON.stringify({
    browserName: 'chromium',
    customEngines: [],
    isUnderTest: false,
    sdkLanguage: 'javascript',
    stableRafCount: 1,
    testIdAttributeName: 'data-testid'
  })
  return `(() => {
    const module = {};
    ${source}
    globalThis.__novaBrowserInjected = new (module.exports.InjectedScript())(globalThis, ${options});
    return true;
  })()`
}

/** 解析选择器到唯一目标：多匹配时唯一可见者优先，否则拒绝 */
function resolvePrelude(selector: string): string {
  return `  const injected = ${ENGINE};
  if (!injected || typeof injected.parseSelector !== 'function' || typeof injected.querySelectorAll !== 'function') {
    return { error: 'missing-engine' };
  }
  const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
  if (matches.length === 0) return { code: 'target_missing', detail: '目标已不在页面上' };
  let element = matches[0];
  if (matches.length > 1) {
    const visible = matches.filter((item) => {
      try { return injected.elementState(item, 'visible').matches; } catch { return false; }
    });
    if (visible.length === 0) return { code: 'target_missing', detail: '匹配目标都不可见' };
    if (visible.length > 1) return { code: 'target_ambiguous', detail: '目标不唯一' };
    element = visible[0];
  }`
}

/**
 * 敏感输入字段（密码、一次性验证码）标记检查：在实际解析到的目标上实时读取，
 * 覆盖观察之后字段类型改变的情况；这类字段交给用户手动处理。
 */
const SENSITIVE_FIELD_GUARD = `  const sensitiveReason = (element, view) => {
    if (!(element instanceof view.HTMLInputElement)) return null;
    const type = String(element.type || 'text').toLowerCase();
    if (type === 'password') return 'password';
    const tokens = String(element.getAttribute('autocomplete') || '').toLowerCase().split(/[\\s,]+/);
    if (tokens.includes('one-time-code')) return 'one-time-code';
    return null;
  };`

/**
 * 动作前校验：可见/可用 + rAF 稳定帧，hitTest 时再做命中测试。
 * 点击目标按「窗口 + 全部裁剪祖先」的交集判定是否可见，必要时滚入，
 * 点击点取最终交集中心；返回 ok+坐标 或目标缺失/歧义/遮挡的明确错误。
 */
export function actionabilityExpression(selector: string, hitTest: boolean): string {
  const viewport = `    const viewportWidth = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 0));
    const viewportHeight = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 0));`
  const clipHelpers = hitTest
    ? `    // 目标可能布局在窗口内却被内部滚动容器裁剪：交集要沿祖先裁剪区收缩
    const clippedIntersection = (rect) => {
      let left = Math.max(rect.left, 0);
      let top = Math.max(rect.top, 0);
      let right = Math.min(rect.right, viewportWidth);
      let bottom = Math.min(rect.bottom, viewportHeight);
      let node = element.parentElement;
      while (node) {
        if (node.nodeType === 1) {
          const style = window.getComputedStyle(node);
          const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
          const clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
          if (clipsX || clipsY) {
            const box = node.getBoundingClientRect();
            if (clipsX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
            if (clipsY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
          }
        }
        node = node.parentElement;
      }
      return { left, top, right, bottom };
    };`
    : ''
  const scrollIntoView = hitTest
    ? `    const before = clippedIntersection(element.getBoundingClientRect());
    if (before.right - before.left < 1 || before.bottom - before.top < 1) {
      try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch {
        element.scrollIntoView();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!element.isConnected) return { code: 'target_missing', detail: '滚动后目标已不在页面上' };
    }
`
    : ''
  const point = hitTest
    ? `    const visible = clippedIntersection(rect);
    if (visible.right - visible.left < 1 || visible.bottom - visible.top < 1) {
      return { code: 'target_missing', detail: '目标没有出现在可见区域内' };
    }
    const point = {
      x: visible.left + (visible.right - visible.left) / 2,
      y: visible.top + (visible.bottom - visible.top) / 2
    };`
    : `    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };`
  return `(async () => {
${resolvePrelude(selector)}
${hitTest ? viewport + clipHelpers : ''}
${scrollIntoView}    const states = await injected.checkElementStates(element, ['visible', 'enabled', 'stable']).catch(() => 'check-failed');
    if (states === 'error:notconnected') return { code: 'target_missing', detail: '目标已不在页面上' };
    if (states === 'check-failed') return { code: 'unavailable', detail: '无法检查目标状态' };
    if (states && typeof states === 'object' && states.missingState) {
      return { code: 'unsupported', detail: '目标状态不满足：' + states.missingState };
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { code: 'target_missing', detail: '目标没有可交互区域' };
${point}
${hitTest ? `    const hit = injected.expectHitTarget(point, element);
    if (hit !== 'done') {
      return {
        code: 'target_occluded',
        detail: hit && hit.hitTargetDescription ? '点击点被 ' + hit.hitTargetDescription + ' 遮挡' : '点击点被遮挡'
      };
    }
` : ''}    return { code: 'ok', x: point.x, y: point.y, width: rect.width, height: rect.height };
  })()`
}

export function fillExpression(selector: string, text: string): string {
  return `(() => {
${resolvePrelude(selector)}
${SENSITIVE_FIELD_GUARD}
    const text = ${JSON.stringify(text)};
    const view = element.ownerDocument.defaultView || window;
    const sensitive = sensitiveReason(element, view);
    if (sensitive) {
      return {
        code: 'unsupported',
        detail: sensitive === 'password' ? '密码字段需要用户手动填写' : '验证码字段需要用户手动填写'
      };
    }
    element.focus();
    try {
      if (typeof view.DataTransfer === 'function' && typeof view.ClipboardEvent === 'function') {
        const data = new view.DataTransfer();
        data.setData('text/plain', text);
        const paste = new view.ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
          composed: true
        });
        if (!element.dispatchEvent(paste)) return { count: 1, used: 'prevented' };
      }
    } catch {
      // 页面没有剪贴板构造器时走下面的赋值
    }
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (typeof setter === 'function') setter.call(element, text);
    else element.value = text;
    element.dispatchEvent(new view.InputEvent('input', { bubbles: true, data: text, inputType: 'insertFromPaste' }));
    return { count: 1, used: 'fallback' };
  })()`
}

export function selectExpression(selector: string, values: readonly string[]): string {
  return `(() => {
${resolvePrelude(selector)}
    const view = element.ownerDocument.defaultView || window;
    if (!(element instanceof view.HTMLSelectElement)) return { error: 'not-select' };
    const wanted = new Set(${JSON.stringify(values)});
    let chosen = 0;
    for (const option of Array.from(element.options)) {
      const match = wanted.has(option.value) || wanted.has(option.label);
      option.selected = match;
      if (match) chosen += 1;
    }
    if (chosen === 0) return { error: 'no-option' };
    element.dispatchEvent(new view.Event('input', { bubbles: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    return { count: 1, value: element.value };
  })()`
}

export function focusExpression(selector: string): string {
  return `(() => {
${resolvePrelude(selector)}
${SENSITIVE_FIELD_GUARD}
    const view = element.ownerDocument.defaultView || window;
    const sensitive = sensitiveReason(element, view);
    if (sensitive) {
      return { code: 'unsupported', detail: '密码或验证码字段上的按键需要用户手动完成' };
    }
    element.focus();
    return { count: 1 };
  })()`
}

export function scrollExpression(direction: 'up' | 'down', amount: 'page' | 'half-page'): string {
  const distance = amount === 'page' ? 'viewport' : 'Math.max(1, Math.round(viewport / 2))'
  const delta = direction === 'down' ? 'distance' : '-distance'
  return `(() => {
    const scrolling = document.scrollingElement || document.documentElement;
    const before = Math.round(window.scrollY || (scrolling && scrolling.scrollTop) || 0);
    const viewport = Math.max(1, Math.round(window.innerHeight || (scrolling && scrolling.clientHeight) || 0));
    const distance = ${distance};
    const delta = ${delta};
    window.scrollBy(0, delta);
    let after = Math.round(window.scrollY || (scrolling && scrolling.scrollTop) || 0);
    if (after === before && scrolling) {
      scrolling.scrollTop = before + delta;
      after = Math.round(window.scrollY || scrolling.scrollTop || 0);
    }
    return { before, after };
  })()`
}

/**
 * 截图就绪探测：视口尺寸有效、字体加载完成、视口内可见图片加载完，再等两帧绘制机会。
 * 只看当前视口内的资源；加载失败的图片不等。探测立即返回，等待节奏由驱动控制。
 */
export function captureReadinessProbeExpression(): string {
  return `(() => new Promise((resolve) => {
    const finish = (ready, reason) => resolve({ novaCaptureReadiness: true, ready: ready === true, reason: reason || null });
    const viewportWidth = Math.max(0, Math.round(window.innerWidth || document.documentElement.clientWidth || 0));
    const viewportHeight = Math.max(0, Math.round(window.innerHeight || document.documentElement.clientHeight || 0));
    if (viewportWidth < 1 || viewportHeight < 1) {
      finish(false, 'viewport');
      return;
    }
    let reason = null;
    if (document.fonts && document.fonts.status !== 'loaded') {
      reason = 'fonts';
    } else {
      for (const image of document.images) {
        if (image.complete) continue;
        const rect = image.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) continue;
        reason = 'images';
        break;
      }
    }
    if (reason) {
      finish(false, reason);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => finish(true, null)));
  }))()`
}
