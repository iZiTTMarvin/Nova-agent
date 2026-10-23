/**
 * 预览帧内接收脚本：把宿主推送的流式 HTML 原位同步到预览文档。
 *
 * 预览文档的 CSP 只放行 nonce 脚本，作者内容里的脚本与内联事件本就不会执行；
 * 这里仍剔除会请求资源或改变文档行为的标签，让预览保持干净。比对按下标进行：
 * 模型只在尾部追加，已有节点保持原实例，滚动位置与正在播放的过渡不受影响。
 * 高度测量交给桥脚本，本脚本不上报。
 */
import { VISUALIZATION_BRIDGE_VERSION } from '../../shared/visualization'

// 运行时源码必须保持为纯文本：构建期转译或压缩会改写函数体，toString() 不可靠。
const PREVIEW_RUNTIME = String.raw`function (version) {
  'use strict';
  if (window.parent === window) return;
  var STRIP_SELECTOR = 'script, style, link, meta, base, iframe, object, embed';
  var FADE_MS = 160;
  var styleTag = null;

  var prefersReducedMotion = function () {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {
      return false;
    }
  };

  // 淡入时长低于桥脚本的可感知阈值（300ms），不会触发宿主的慢放提示
  var fadeIn = function (element) {
    if (typeof element.animate !== 'function' || prefersReducedMotion()) return;
    try {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS });
    } catch (error) {
      // 动画失败只影响观感
    }
  };

  var syncAttributes = function (live, next) {
    var kept = {};
    for (var i = 0; i < next.attributes.length; i += 1) {
      var attribute = next.attributes[i];
      kept[attribute.name] = true;
      if (live.getAttribute(attribute.name) !== attribute.value) {
        live.setAttribute(attribute.name, attribute.value);
      }
    }
    for (var j = live.attributes.length - 1; j >= 0; j -= 1) {
      if (!kept[live.attributes[j].name]) live.removeAttribute(live.attributes[j].name);
    }
  };

  var sync = function (live, next) {
    var nextChildren = next.childNodes;
    var index = 0;
    for (; index < nextChildren.length; index += 1) {
      var wanted = nextChildren[index];
      var current = live.childNodes[index];
      if (!current) {
        var appended = document.importNode(wanted, true);
        live.appendChild(appended);
        if (appended.nodeType === 1) fadeIn(appended);
        continue;
      }
      if (current.nodeType !== wanted.nodeType || (current.nodeType === 1 && current.tagName !== wanted.tagName)) {
        live.replaceChild(document.importNode(wanted, true), current);
        continue;
      }
      if (current.nodeType === 3 || current.nodeType === 8) {
        if (current.nodeValue !== wanted.nodeValue) current.nodeValue = wanted.nodeValue;
        continue;
      }
      if (current.nodeType === 1) {
        syncAttributes(current, wanted);
        sync(current, wanted);
      }
    }
    while (live.childNodes.length > nextChildren.length) {
      live.removeChild(live.lastChild);
    }
  };

  var apply = function (html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var css = '';
    var styles = parsed.querySelectorAll('style');
    for (var i = 0; i < styles.length; i += 1) css += styles[i].textContent || '';
    if (!styleTag) {
      styleTag = document.createElement('style');
      (document.head || document.documentElement).appendChild(styleTag);
    }
    if (styleTag.textContent !== css) styleTag.textContent = css;
    var nextBody = parsed.body;
    stripDisallowed(nextBody);
    syncAttributes(document.body, nextBody);
    sync(document.body, nextBody);
  };

  // 会请求资源或改变文档行为的标签一律剔除，原位比对与降级替换共用
  var stripDisallowed = function (root) {
    var stripped = root.querySelectorAll(STRIP_SELECTOR);
    for (var k = 0; k < stripped.length; k += 1) {
      if (stripped[k].parentNode) stripped[k].parentNode.removeChild(stripped[k]);
    }
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.v !== version || data.kind !== 'preview-html') return;
    var payload = data.payload;
    if (!payload || typeof payload.html !== 'string') return;
    try {
      apply(payload.html);
    } catch (error) {
      // 原位比对失败时整棵替换；再失败则放弃本次推送，旧画面保留
      try {
        var fallback = new DOMParser().parseFromString(payload.html, 'text/html');
        stripDisallowed(fallback.body);
        var imported = document.importNode(fallback.body, true);
        document.body.replaceChildren.apply(document.body, Array.prototype.slice.call(imported.childNodes));
      } catch (ignored) {
        // 等待下一次推送
      }
    }
  });
}`

export function buildVisualizationPreviewScript(): string {
  return `(${PREVIEW_RUNTIME})(${VISUALIZATION_BRIDGE_VERSION});`
}
