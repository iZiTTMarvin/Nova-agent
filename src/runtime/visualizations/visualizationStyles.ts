/**
 * 可视化帧的共享样式：主题底色与一套常用工具类。
 *
 * 选择器全部包在 :where() 里保持零特异性，作者自己的规则始终优先；只补工具类，不重置作者的排版与盒模型。
 * 内联卡片在聊天列里只有 380–766px 宽（--chat-content-max-width 为 48rem = 768px）：
 * 分栏默认单列上下堆叠，只有到展开视图（>=860px）才左右并排，避免内联窄卡被 65%/35% 双栏挤出局部密度失控。
 * 主舞台（.viz-canvas）在外层卡片内不再套第二层深色边框盒子，避免「卡片套灰框套表格套胶囊」的四层嵌套。
 * 对比表首列（标识/依赖名）与末列（状态/结论）默认不折行，中间说明列吃满剩余宽度并保持舒适行距；窄帧里带 data-label 的表逐行转卡片。
 * .viz-grid 带 align-items:start：网格默认拉伸同排格子，折叠态卡片会被撑成与最高卡片同高的空盒。
 * 拼成单行注入：桥脚本按自身换行数把报错行号换算回作者源码，样式多出的换行会让行号整体偏移。
 */
const SPLIT_SIDE_BY_SIDE_MIN_WIDTH = 860
const NARROW_MAX_WIDTH = 520

export const VISUALIZATION_BASE_STYLE = [
  ':where(*,*::before,*::after){box-sizing:border-box}',
  ':where(html){background:var(--viz-bg,Canvas);color:var(--viz-fg,CanvasText);font-family:var(--viz-font-sans,system-ui,sans-serif);font-size:16px;line-height:1.5}',
  ':where(body){margin:0;padding:16px;overflow-wrap:break-word;font-size:14px;line-height:1.6}',
  ':where(img,video){max-width:100%;height:auto}',
  ':where(svg[viewBox]){max-width:100%;height:auto}',
  ':where(pre){overflow-x:auto}',
  ':where(input[type="checkbox"],input[type="radio"]){inline-size:18px;block-size:18px;flex:none;margin:0;accent-color:var(--viz-accent);cursor:pointer}',
  ':where(label:has(>input[type="checkbox"],>input[type="radio"])){display:inline-flex;align-items:center;gap:8px;min-height:36px;cursor:pointer}',
  ':where(.viz-workbench){display:flex;flex-direction:column;gap:12px;min-width:0}',
  ':where(.viz-toolbar){display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between}',
  ':where(.viz-split){display:grid;gap:12px;grid-template-columns:minmax(0,1fr);align-items:start}',
  ':where(.viz-canvas){position:relative;min-width:0;padding:0;border:0;background:transparent;overflow-x:auto}',
  ':where(.viz-inspector){display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 16px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:color-mix(in srgb,var(--viz-surface) 75%,var(--viz-bg))}',
  ':where(.viz-phases){display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;border-bottom:1px solid var(--viz-border)}',
  ':where(.viz-phase){appearance:none;min-width:0;min-height:40px;display:flex;flex-direction:column;gap:2px;margin:0 0 -1px;padding:8px 10px 9px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--viz-muted);font:inherit;text-align:left;cursor:pointer;transition:color .15s,border-color .15s}',
  ':where(.viz-phase:hover){color:var(--viz-fg)}',
  ':where(.viz-phase[data-active="true"],.viz-phase.is-active,.viz-phase[aria-selected="true"]){color:var(--viz-fg);border-bottom-color:var(--viz-accent)}',
  ':where(.viz-phase-kicker){overflow:hidden;font-size:.75rem;color:var(--viz-muted);font-variant-numeric:tabular-nums;white-space:nowrap;text-overflow:ellipsis}',
  ':where(.viz-phase-title){font-size:.875rem;font-weight:500;line-height:1.35;color:inherit;overflow-wrap:anywhere;text-wrap:balance}',
  ':where(.viz-phase[data-active="true"],.viz-phase.is-active,.viz-phase[aria-selected="true"]) :where(.viz-phase-title){font-weight:650}',
  ':where(.viz-phase[data-active="true"],.viz-phase.is-active,.viz-phase[aria-selected="true"]) :where(.viz-phase-kicker){color:var(--viz-accent)}',
  ':where(.viz-flow){display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}',
  ':where(.viz-flow-step){appearance:none;position:relative;display:grid;grid-template-columns:24px minmax(0,1fr);column-gap:10px;align-items:start;width:100%;padding:10px 12px;border:1px solid transparent;border-radius:var(--viz-radius);background:none;color:var(--viz-fg);font:inherit;text-align:left;cursor:pointer;transition:background .15s,border-color .15s}',
  ':where(.viz-flow>.viz-flow-step:not(:last-child))::after{content:"";position:absolute;left:23px;top:34px;bottom:-9px;width:1px;background:var(--viz-border)}',
  ':where(.viz-flow-step:hover){background:color-mix(in srgb,var(--viz-fg) 5%,transparent)}',
  ':where(.viz-flow-step[data-active="true"],.viz-flow-step.is-active,.viz-flow-step[aria-current="step"]){background:color-mix(in srgb,var(--viz-accent) 12%,var(--viz-bg))}',
  ':where(.viz-flow-step[data-active="true"],.viz-flow-step.is-active,.viz-flow-step[aria-current="step"])>:where(.viz-node-step){background:var(--viz-accent);color:var(--viz-on-accent)}',
  ':where(.viz-flow-step>.viz-node-step){position:relative;z-index:1;margin-top:1px}',
  ':where(.viz-flow-title){display:block;font-size:1rem;font-weight:600;line-height:1.4}',
  ':where(.viz-flow-meta){display:block;margin-top:3px;color:var(--viz-muted);font-size:.75rem;line-height:1.5}',
  ':where(.viz-lanes){display:flex;flex-direction:column;gap:8px}',
  ':where(.viz-lane){display:grid;gap:8px 12px;grid-template-columns:minmax(80px,112px) minmax(0,1fr);align-items:center;padding:10px 12px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-bg)}',
  ':where(.viz-lane-label){font-size:.75rem;font-weight:600;color:var(--viz-muted);letter-spacing:.02em}',
  ':where(.viz-lane-nodes){display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;justify-content:center;min-width:0}',
  ':where(.viz-node){appearance:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:7px 10px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface);color:var(--viz-fg);font:inherit;font-size:.875rem;line-height:1.35;text-align:left;cursor:pointer;transition:border-color .14s,background .14s,transform .14s}',
  ':where(.viz-lane-nodes>.viz-node){flex:0 0 min(160px,100%);width:min(160px,100%);min-height:40px;justify-content:center;text-align:center;overflow-wrap:anywhere}',
  ':where(.viz-node:hover){border-color:color-mix(in srgb,var(--viz-accent) 60%,var(--viz-border));transform:translateY(-1px)}',
  ':where(.viz-node[data-active="true"],.viz-node.is-active){border-color:var(--viz-accent);background:color-mix(in srgb,var(--viz-accent) 15%,var(--viz-surface));font-weight:600}',
  ':where(.viz-node-step){display:inline-flex;flex:none;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--viz-accent) 18%,var(--viz-bg));color:var(--viz-accent);font-size:.75rem;font-weight:600;font-variant-numeric:tabular-nums}',
  ':where(.viz-arrow){color:var(--viz-muted);font-size:.875rem;user-select:none}',
  ':where(.viz-card){display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 16px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface);transition:border-color .14s,background .14s}',
  ':where(.viz-card[data-active="true"],.viz-card.is-active){border-color:var(--viz-accent);background:color-mix(in srgb,var(--viz-accent) 10%,var(--viz-surface))}',
  ':where(.viz-card-head){display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
  ':where(.viz-title){font-size:1rem;font-weight:600;line-height:1.4}',
  ':where(.viz-muted){color:var(--viz-muted)}',
  ':where(.viz-note){margin:0;color:var(--viz-muted);font-size:.875rem;line-height:1.6}',
  ':where(.viz-grid){display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));align-items:start}',
  ':where(.viz-kpis){display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));align-items:stretch}',
  ':where(.viz-row){display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  ':where(.viz-stat){display:flex;flex-direction:column;gap:2px;min-width:0}',
  ':where(.viz-stat-label){color:var(--viz-muted);font-size:.75rem}',
  ':where(.viz-stat-value){font-size:1.25rem;font-weight:650;line-height:1.25;font-variant-numeric:tabular-nums}',
  ':where(.viz-badge){display:inline-flex;flex:none;align-items:center;align-self:flex-start;min-height:24px;padding:2px 9px;border:1px solid var(--viz-border);border-radius:999px;background:var(--viz-surface);font-size:.75rem;line-height:1.5;white-space:nowrap}',
  ':where(.viz-badge[data-tone="success"]){color:var(--viz-success);border-color:color-mix(in srgb,var(--viz-success) 35%,var(--viz-border));background:color-mix(in srgb,var(--viz-success) 12%,transparent)}',
  ':where(.viz-badge[data-tone="warning"]){color:var(--viz-warning);border-color:color-mix(in srgb,var(--viz-warning) 35%,var(--viz-border));background:color-mix(in srgb,var(--viz-warning) 12%,transparent)}',
  ':where(.viz-badge[data-tone="danger"]){color:var(--viz-danger);border-color:color-mix(in srgb,var(--viz-danger) 35%,var(--viz-border));background:color-mix(in srgb,var(--viz-danger) 12%,transparent)}',
  ':where(.viz-file-ref){display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 8px;border:1px solid var(--viz-border);border-radius:6px;background:var(--viz-bg);font-family:var(--viz-font-mono,monospace);font-size:.75rem;color:var(--viz-accent);overflow-wrap:anywhere}',
  ':where(.viz-kv){display:grid;gap:6px 12px;grid-template-columns:minmax(56px,auto) minmax(0,1fr);margin:0;font-size:.875rem;align-items:baseline}',
  ':where(.viz-kv dt){color:var(--viz-muted);font-weight:500}',
  ':where(.viz-kv dd){margin:0;color:var(--viz-fg);overflow-wrap:anywhere}',
  ':where(.viz-code){margin:0;padding:10px 12px;border:1px solid var(--viz-border);border-radius:calc(var(--viz-radius) - 2px);background:var(--viz-bg);font-family:var(--viz-font-mono,monospace);font-size:.875rem;line-height:1.55;overflow-x:auto;white-space:pre-wrap}',
  ':where(.viz-search){min-width:0;min-height:36px;padding:6px 12px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-bg);color:var(--viz-fg);font:inherit;font-size:.875rem}',
  ':where(.viz-search input){width:100%;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;outline:none}',
  ':where(.viz-meter){height:8px;border-radius:999px;background:color-mix(in srgb,var(--viz-border) 70%,transparent);overflow:hidden}',
  ':where(.viz-meter>span){display:block;height:100%;border-radius:999px;background:var(--viz-accent)}',
  ':where(.viz-btn){appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 14px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface);color:var(--viz-fg);font:inherit;font-size:.875rem;font-weight:500;line-height:1.35;cursor:pointer}',
  ':where(.viz-btn:hover){background:var(--viz-bg)}',
  ':where(.viz-btn-primary){border-color:transparent;background:var(--viz-accent);color:var(--viz-on-accent)}',
  ':where(.viz-btn:focus-visible,.viz-node:focus-visible,.viz-phase:focus-visible,.viz-flow-step:focus-visible){outline:2px solid var(--viz-accent);outline-offset:1px}',
  ':where(.viz-controls){display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:10px 0}',
  ':where(.viz-table){width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.55}',
  ':where(.viz-table th){text-align:left;font-weight:600;color:var(--viz-muted)}',
  ':where(.viz-table th,.viz-table td){padding:10px 12px;border-bottom:1px solid var(--viz-border);vertical-align:top}',
  ':where(.viz-table th:first-child,.viz-table td:first-child){padding-left:0;font-weight:600;white-space:nowrap}',
  ':where(.viz-table th:last-child,.viz-table td:last-child){padding-right:0}',
  ':where(.viz-s1){color:var(--viz-series-1);fill:var(--viz-series-1)}',
  ':where(.viz-s2){color:var(--viz-series-2);fill:var(--viz-series-2)}',
  ':where(.viz-s3){color:var(--viz-series-3);fill:var(--viz-series-3)}',
  ':where(.viz-s4){color:var(--viz-series-4);fill:var(--viz-series-4)}',
  ':where(.viz-s5){color:var(--viz-series-5);fill:var(--viz-series-5)}',
  ':where(.viz-s6){color:var(--viz-series-6);fill:var(--viz-series-6)}',
  `@media (min-width:${SPLIT_SIDE_BY_SIDE_MIN_WIDTH}px){:where(.viz-split){grid-template-columns:minmax(0,1fr) minmax(260px,34%)}:where(.viz-split>.viz-inspector){position:sticky;top:12px}}`,
  `@media (max-width:${NARROW_MAX_WIDTH}px){:where(body){padding:12px}:where(.viz-lane){grid-template-columns:minmax(0,1fr)}:where(.viz-phase-kicker){display:none}:where(.viz-phase){padding:8px 6px 9px}:where(.viz-phase-title){font-size:.875rem}:where(.viz-table th:first-child,.viz-table td:first-child){white-space:normal}` +
    ':where(.viz-table:has(td[data-label])) :where(thead){display:none}' +
    ':where(.viz-table:has(td[data-label]),.viz-table:has(td[data-label]) tbody,.viz-table:has(td[data-label]) tr){display:block}' +
    ':where(.viz-table:has(td[data-label]) tr){margin:0 0 8px;padding:4px 10px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface)}' +
    ':where(.viz-table td[data-label]){display:grid;grid-template-columns:minmax(64px,34%) minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:0}' +
    ':where(.viz-table td[data-label])::before{content:attr(data-label);color:var(--viz-muted);font-weight:500}' +
    ':where(.viz-table:not(:has(td[data-label])) th,.viz-table:not(:has(td[data-label])) td){overflow-wrap:anywhere}}',
  '@media (prefers-reduced-motion:reduce){:where(.viz-phase,.viz-flow-step,.viz-node){transition:none}}'
].join('')
