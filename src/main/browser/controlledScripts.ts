/**
 * 只在受控隔离世界里运行的固定脚本。
 * 选择器与文本都经 JSON 写入，页面内容不能改写脚本结构。
 */

const ENGINE = 'globalThis.__novaBrowserInjected'

export const DOCUMENT_EXPRESSION = `(() => {
  const nameOf = (element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (element.getAttribute('type') === 'password') {
        return element.getAttribute('placeholder') || element.getAttribute('name') || '';
      }
      return element.getAttribute('placeholder') || element.getAttribute('name') || '';
    }
    return (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || tag === 'INPUT') return 'textbox';
    return tag.toLowerCase();
  };
  const selectorFor = (element) => {
    if (element.id) {
      const idSelector = '#' + CSS.escape(element.id);
      if (document.querySelectorAll(idSelector).length === 1) return 'css=' + idSelector;
    }
    const name = element.getAttribute('name');
    if (name) {
      const named = element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      if (document.querySelectorAll(named).length === 1) return 'css=' + named;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (same.indexOf(node) + 1) + ')');
      node = parent;
    }
    return parts.length ? 'css=body > ' + parts.join(' > ') : '';
  };
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim();
  const summary = text.slice(0, 2000);
  const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]'))
    .filter((element) => element.getAttribute('type') !== 'hidden');
  const interactive = [];
  for (const element of nodes) {
    if (interactive.length >= 200) break;
    const selector = selectorFor(element);
    if (!selector) continue;
    interactive.push({
      ref: 'e' + (interactive.length + 1),
      role: roleOf(element).slice(0, 80),
      name: nameOf(element).slice(0, 200),
      selector
    });
  }
  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    summary,
    truncated: text.length > summary.length || nodes.length > interactive.length,
    viewport: {
      width: Math.max(0, Math.round(window.innerWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || 0))
    },
    scrollY: Math.round(window.scrollY || 0),
    interactive
  };
})()`

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

export function queryExpression(selector: string): string {
  return `(() => {
    const injected = ${ENGINE};
    if (!injected || typeof injected.parseSelector !== 'function' || typeof injected.querySelectorAll !== 'function') {
      return { error: 'missing-engine' };
    }
    const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    const count = matches.length;
    if (count !== 1) return { count };
    const rect = matches[0].getBoundingClientRect();
    return {
      count,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height
    };
  })()`
}

export function fillExpression(selector: string, text: string): string {
  return `(() => {
    const injected = ${ENGINE};
    if (!injected || typeof injected.parseSelector !== 'function') return { error: 'missing-engine' };
    const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    if (matches.length !== 1) return { count: matches.length };
    const element = matches[0];
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
    const injected = ${ENGINE};
    if (!injected || typeof injected.parseSelector !== 'function') return { error: 'missing-engine' };
    const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    if (matches.length !== 1) return { count: matches.length };
    const element = matches[0];
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
    const injected = ${ENGINE};
    if (!injected || typeof injected.parseSelector !== 'function') return { error: 'missing-engine' };
    const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    if (matches.length !== 1) return { count: matches.length };
    matches[0].focus();
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
