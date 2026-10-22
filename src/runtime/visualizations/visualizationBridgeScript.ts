/**
 * 帧内桥运行时：注入在作者内容之前、先于作者脚本执行，以 window.nova 暴露给作者。
 * 职责：主题投影、内容高度上报、错误收集、外链转交宿主、慢动作调速。
 * 它是 shared/visualization/bridge.ts 协议在帧内的一端；运行在任意作者页面里，只用浏览器原生 API。
 * 独立打开（导出文件）时 window.parent === window：不发消息，只保留主题与 nova API。
 */
import {
  MAX_VISUALIZATION_ERROR_CHARS,
  MAX_VISUALIZATION_EVENT_DATA_CHARS,
  MAX_VISUALIZATION_EVENT_NAME_CHARS,
  VISUALIZATION_BRIDGE_VERSION,
  VISUALIZATION_EVENT_NAME_PATTERN,
  VISUALIZATION_THEME_TOKENS,
  type VisualizationDocumentStatus,
  type VisualizationTheme
} from '../../shared/visualization'

export interface VisualizationBridgeConfig {
  status: VisualizationDocumentStatus
  theme: VisualizationTheme | null
  motionScale: number
  maxHeight: number
}

const MAX_REPORTED_ERRORS = 20
/** 短于此时长的过渡（悬停变色等）不值得提供慢放 */
const NOTICEABLE_ANIMATION_MS = 300

// 运行时源码必须保持为纯文本：构建期转译或压缩会改写函数体，toString() 不可靠。
const BRIDGE_RUNTIME = String.raw`function (config, k) {
  'use strict';
  var host = window.parent;
  var embedded = host !== window;
  var root = document.documentElement;
  var eventNamePattern = new RegExp(k.eventNamePattern);
  var seq = 0;
  var post = function (kind, payload) {
    if (!embedded) return;
    seq += 1;
    try {
      host.postMessage({ v: k.version, kind: kind, id: 'a' + seq, seq: seq, payload: payload }, '*');
    } catch (error) {
      console.error('[nova] bridge message failed', error);
    }
  };

  var describe = function (value) {
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  };
  // 桥脚本与作者首行同处一行：作者行号 = 文档行号 − 桥脚本自身的换行数
  var injectedLines = document.currentScript ? document.currentScript.textContent.split('\n').length - 1 : 0;
  var reportedErrors = 0;
  var reportError = function (message) {
    var text = String(message || '').trim();
    if (!text || reportedErrors >= k.maxErrors) return;
    reportedErrors += 1;
    post('error', { message: text.slice(0, k.maxError) });
  };
  window.addEventListener('error', function (event) {
    if (!(event instanceof ErrorEvent)) return;
    var message = event.message || describe(event.error);
    // 作者自己的 ResizeObserver 回调改了布局：浏览器的良性告警，不是产物故障
    if (/^ResizeObserver loop/.test(message)) return;
    var line = event.filename === document.URL && event.lineno > injectedLines ? event.lineno - injectedLines : event.lineno;
    reportError(message + (line ? ' (' + line + ':' + event.colno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (event) {
    reportError('Unhandled rejection: ' + describe(event.reason));
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    reportError('Blocked ' + (event.blockedURI || 'inline resource') + ' by ' + event.effectiveDirective);
  });

  var freezeTheme = function (value) {
    if (!value || typeof value !== 'object' || !value.tokens || typeof value.tokens !== 'object') return null;
    return Object.freeze({
      scheme: value.scheme === 'dark' ? 'dark' : 'light',
      tokens: Object.freeze(Object.assign({}, value.tokens))
    });
  };
  var theme = freezeTheme(config.theme);
  var themeStyle = document.createElement('style');
  (document.head || root).appendChild(themeStyle);
  var applyTheme = function () {
    if (!theme) return;
    var declarations = '';
    k.tokens.forEach(function (name) {
      var value = theme.tokens[name];
      if (typeof value === 'string') declarations += '--viz-' + name + ':' + value + ';';
    });
    themeStyle.textContent = ':where(:root){' + declarations + 'color-scheme:' + theme.scheme + '}';
  };
  applyTheme();

  var listeners = new Map([['theme', new Set()], ['motionScale', new Set()]]);
  var notify = function (type, value) {
    listeners.get(type).forEach(function (listener) {
      try { listener(value); } catch (error) { reportError(describe(error)); }
    });
  };

  var motionScale = config.motionScale;
  var animated = false;
  var markAnimated = function () {
    if (animated) return;
    animated = true;
    post('animated', {});
  };
  // 记录作者自己的播放速率：反复切换慢放不会让速率累乘
  var rates = new WeakMap();
  var scaleAnimation = function (animation) {
    try {
      var state = rates.get(animation);
      var base = state && animation.playbackRate === state.applied ? state.base : animation.playbackRate;
      var applied = base / motionScale;
      rates.set(animation, { base: base, applied: applied });
      if (animation.playbackRate !== applied) animation.playbackRate = applied;
    } catch (error) {
      // 已移除的动画无需调速
    }
  };
  var isNoticeable = function (animation) {
    try {
      return animation.effect.getComputedTiming().activeDuration >= k.noticeableMs;
    } catch (error) {
      return false;
    }
  };
  var inspect = function (animations) {
    if (!animated && animations.some(isNoticeable)) markAnimated();
    if (motionScale !== 1) animations.forEach(scaleAnimation);
  };
  var documentAnimations = function () {
    return typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  };
  var onAnimationEvent = function (event) {
    if (animated && motionScale === 1) return;
    var target = event.target;
    if (target && typeof target.getAnimations === 'function') inspect(target.getAnimations({ subtree: true }));
  };
  document.addEventListener('animationstart', onAnimationEvent, true);
  document.addEventListener('transitionrun', onAnimationEvent, true);
  var nativeAnimate = Element.prototype.animate;
  if (typeof nativeAnimate === 'function') {
    Element.prototype.animate = function () {
      var animation = nativeAnimate.apply(this, arguments);
      inspect([animation]);
      return animation;
    };
  }
  var setMotionScale = function (value) {
    if (typeof value !== 'number' || !(value >= 1) || value === motionScale) return;
    motionScale = value;
    documentAnimations().forEach(scaleAnimation);
    notify('motionScale', value);
  };

  var mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(function () { schedule(); }) : null;
  var VIEWPORT_UNITS = { percent: 1, vh: 1, dvh: 1, svh: 1, lvh: 1 };
  // 高度或最小高度绑定视口（100vh / 100%）的页面会随帧高无限增长：测量时临时解除绑定，取内容本身的高度
  var pinnedToViewport = function (element) {
    if (!element) return false;
    if (typeof element.computedStyleMap === 'function') {
      var styles = element.computedStyleMap();
      var matched = ['height', 'min-height'].some(function (property) {
        var value = styles.get(property);
        if (!value || typeof value.unit !== 'string') return false;
        if (VIEWPORT_UNITS[value.unit]) return value.value >= 90;
        return value.unit === 'px' && window.innerHeight > 0 && Math.abs(value.value - window.innerHeight) <= 2;
      });
      if (matched) return true;
    }
    var inlineStyle = element.getAttribute && element.getAttribute('style');
    return typeof inlineStyle === 'string' && /(?:^|;)\s*(?:min-)?height\s*:\s*(?:9\d|100)(?:\.\d+)?(?:%|[dsl]?vh)(?![\w.])/i.test(inlineStyle);
  };
  var overflowHeight = 0;
  var overflowFlowHeight = -1;
  var measure = function () {
    var candidates = [root, document.body];
    if (document.body && document.body.children.length === 1 && document.body.firstElementChild) {
      candidates.push(document.body.firstElementChild);
    }
    var pinned = candidates.filter(pinnedToViewport);
    var saved = pinned.map(function (element) { return [element, element.getAttribute('style')]; });
    pinned.forEach(function (element) {
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('min-height', '0', 'important');
    });
    var flow = Math.ceil(root.getBoundingClientRect().height);
    var scrollHeight = root.scrollHeight;
    var overflowing = scrollHeight > root.clientHeight + 1;
    saved.forEach(function (entry) {
      if (entry[1] === null) entry[0].removeAttribute('style');
      else entry[0].setAttribute('style', entry[1]);
    });
    if (pinned.length > 0 && mutationObserver) mutationObserver.takeRecords();
    // 定位元素溢出不计入根元素盒高：记住溢出高度，直到文档流高度变化
    if (overflowing) {
      overflowHeight = scrollHeight;
      overflowFlowHeight = flow;
    } else if (flow !== overflowFlowHeight) {
      overflowHeight = 0;
    }
    return Math.max(flow, overflowHeight);
  };
  // 未超出上限时禁止滚动条：滚动条出现会改宽度、宽度又改高度，两者会互相振荡
  var applyOverflow = function (height) {
    var overflow = height > config.maxHeight ? '' : 'hidden';
    if (root.style.overflowY !== overflow) root.style.overflowY = overflow;
    if (mutationObserver) mutationObserver.takeRecords();
  };
  var reported = -1;
  var pending = false;
  var flush = function (force) {
    pending = false;
    var height = measure();
    applyOverflow(height);
    if (force || height !== reported) {
      reported = height;
      post('resize', { height: height });
    }
  };
  var run = function () { if (pending) flush(false); };
  // 不可见帧的 requestAnimationFrame 会被节流，定时器保证尺寸最终送达
  var schedule = function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(run);
    setTimeout(run, 100);
  };

  var setTheme = function (value) {
    var next = freezeTheme(value);
    if (!next || (theme && JSON.stringify(theme) === JSON.stringify(next))) return;
    theme = next;
    applyTheme();
    notify('theme', theme);
    schedule();
  };

  var openExternal = function (value) {
    var url;
    try { url = new URL(String(value), document.baseURI); } catch (error) { url = null; }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      reportError('nova.openExternal only accepts http(s) URLs');
      return false;
    }
    if (!embedded) {
      window.open(url.href, '_blank', 'noopener');
      return true;
    }
    post('open-external', { url: url.href });
    return true;
  };
  var emit = function (name, data) {
    if (typeof name !== 'string' || name.length > k.maxEventName || !eventNamePattern.test(name)) {
      reportError('nova.emit: event name must be 1-' + k.maxEventName + ' characters of letters, digits or _.:-');
      return false;
    }
    var serialized;
    try { serialized = JSON.stringify(data === undefined ? null : data); } catch (error) { serialized = undefined; }
    if (serialized === undefined || serialized.length > k.maxEventData) {
      reportError('nova.emit: data must be JSON within ' + k.maxEventData + ' characters');
      return false;
    }
    if (!embedded) {
      console.info('[nova.emit]', name, data);
      return true;
    }
    post('event', { name: name, data: JSON.parse(serialized) });
    return true;
  };
  var nova = Object.freeze({
    get theme() { return theme; },
    get motionScale() { markAnimated(); return motionScale; },
    emit: emit,
    openExternal: openExternal,
    on: function (type, listener) {
      if (!listeners.has(type) || typeof listener !== 'function') {
        reportError('nova.on supports "theme" and "motionScale" listeners');
        return function () {};
      }
      if (type === 'motionScale') markAnimated();
      listeners.get(type).add(listener);
      return function () { listeners.get(type).delete(listener); };
    }
  });
  Object.defineProperty(window, 'nova', { value: nova, writable: true, configurable: true, enumerable: false });

  if (embedded) {
    window.addEventListener('message', function (event) {
      if (event.source !== host) return;
      var data = event.data;
      if (!data || typeof data !== 'object' || data.v !== k.version) return;
      var payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
      if (data.kind === 'ack') {
        setTheme(payload.theme);
        setMotionScale(payload.motionScale);
        flush(true);
      } else if (data.kind === 'theme-change') {
        setTheme(payload.theme);
      } else if (data.kind === 'motion-scale') {
        setMotionScale(payload.motionScale);
      }
    });
    // 外链交给宿主用系统浏览器打开；帧本身不允许导航与弹窗
    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      var target = event.target;
      var anchor = target && typeof target.closest === 'function' ? target.closest('a, area') : null;
      var raw = anchor ? anchor.getAttribute('href') || anchor.getAttribute('xlink:href') : null;
      if (!raw) return;
      var url;
      try { url = new URL(raw, document.baseURI); } catch (error) { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      event.preventDefault();
      post('open-external', { url: url.href });
    });
    window.open = function (url) {
      openExternal(url);
      return null;
    };
  }

  var start = function () {
    var height = measure();
    if (embedded) applyOverflow(height);
    reported = height;
    post('ready', { status: config.status, initialHeight: height });
    if (!embedded) return;
    inspect(documentAnimations());
    if (typeof ResizeObserver === 'function') {
      var resizeObserver = new ResizeObserver(function () { schedule(); });
      resizeObserver.observe(root);
      if (document.body) resizeObserver.observe(document.body);
    }
    if (mutationObserver) {
      mutationObserver.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    window.addEventListener('load', schedule, true);
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, function () {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}`

export function buildVisualizationBridgeScript(config: VisualizationBridgeConfig): string {
  const constants = {
    version: VISUALIZATION_BRIDGE_VERSION,
    tokens: VISUALIZATION_THEME_TOKENS,
    eventNamePattern: VISUALIZATION_EVENT_NAME_PATTERN.source,
    maxEventName: MAX_VISUALIZATION_EVENT_NAME_CHARS,
    maxEventData: MAX_VISUALIZATION_EVENT_DATA_CHARS,
    maxError: MAX_VISUALIZATION_ERROR_CHARS,
    maxErrors: MAX_REPORTED_ERRORS,
    noticeableMs: NOTICEABLE_ANIMATION_MS
  }
  return `(${BRIDGE_RUNTIME})(${toScriptLiteral(config)},${toScriptLiteral(constants)});`
}

/** JSON 嵌进 <script>：转义 < 防止字符串里的 </script> 提前闭合标签 */
function toScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
