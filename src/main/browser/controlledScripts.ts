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

/**
 * 两段快照：dom 语义行（带 ref）在前，elements 动作细节（selector/rect）在后。
 * 预算作用于实际工作量：候选节点先数后取、分段快照、逐项让出页面线程。
 */
export function snapshotExpression(): string {
  return `(async () => {
  const injected = ${ENGINE};
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
  if (countCandidates(body, NODE_LIMIT) <= NODE_LIMIT) {
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
 * 动作前校验：可见/可用 + rAF 稳定帧，hitTest 时再做命中测试。
 * 返回 ok+坐标 或目标缺失/歧义/遮挡的明确错误。
 */
export function actionabilityExpression(selector: string, hitTest: boolean): string {
  return `(async () => {
${resolvePrelude(selector)}
    const states = await injected.checkElementStates(element, ['visible', 'enabled', 'stable']).catch(() => 'check-failed');
    if (states === 'error:notconnected') return { code: 'target_missing', detail: '目标已不在页面上' };
    if (states === 'check-failed') return { code: 'unavailable', detail: '无法检查目标状态' };
    if (states && typeof states === 'object' && states.missingState) {
      return { code: 'unsupported', detail: '目标状态不满足：' + states.missingState };
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { code: 'target_missing', detail: '目标没有可交互区域' };
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
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
    const text = ${JSON.stringify(text)};
    const view = element.ownerDocument.defaultView || window;
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
