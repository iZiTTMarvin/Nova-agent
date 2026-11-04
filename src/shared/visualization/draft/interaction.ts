const DRAFT_INTERACTION_RUNTIME = String.raw`function () {
  'use strict';
  document.addEventListener('click', function (event) {
    if (!event.isTrusted || event.button !== 0 || event.defaultPrevented) return;
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var view = target.closest('[data-viz-view]');
    if (view) {
      var views = view.closest('.viz-draft-views');
      if (!views) return;
      var index = view.getAttribute('data-viz-view') || '';
      views.querySelectorAll('[data-viz-view]').forEach(function (button) {
        var active = button.getAttribute('data-viz-view') === index;
        button.setAttribute('aria-selected', String(active));
        button.classList.toggle('is-active', active);
      });
      views.querySelectorAll('[data-viz-view-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-viz-view-panel') !== index;
      });
      return;
    }

    var ask = target.closest('[data-viz-ask]');
    if (ask) {
      var label = ask.getAttribute('data-label') || '';
      var prompt = ask.getAttribute('data-prompt') || '';
      if (!label.trim() || !prompt.trim() || label.length > 240 || prompt.length > 1000) return;
      if (window.nova) window.nova.emit('ask', { label: label, prompt: prompt });
      return;
    }

    var remark = target.closest('[data-viz-remark]');
    if (remark) {
      var block = remark.closest('[data-viz-block]');
      var input = block ? block.querySelector('[data-viz-remark-input]') : null;
      var blockId = block ? block.getAttribute('data-viz-block') || '' : '';
      var value = input ? input.value.trim() : '';
      if (!/^[A-Za-z][\w-]{0,63}$/.test(blockId) || !value || value.length > 1000) return;
      if (window.nova) window.nova.emit('remark', { blockId: blockId, text: value });
    }
  });
}`

export function buildVisualizationDraftInteractionScript(): string {
  return `(${DRAFT_INTERACTION_RUNTIME})();`
}
