/**
 * 可视化帧的共享样式：主题底色与一套常用工具类。
 *
 * 选择器全部包在 :where() 里保持零特异性，作者自己的规则始终优先；只补工具类，不重置作者的排版与盒模型。
 * .viz-grid 带 align-items:start：网格默认拉伸同排格子，折叠态卡片会被撑成与最高卡片同高的空盒。
 * 拼成单行注入：桥脚本按自身换行数把报错行号换算回作者源码，样式多出的换行会让行号整体偏移。
 */
export const VISUALIZATION_BASE_STYLE = [
  ':where(html){background:var(--viz-bg,Canvas);color:var(--viz-fg,CanvasText);font-family:var(--viz-font-sans,system-ui,sans-serif);line-height:1.5}',
  ':where(body){margin:0;padding:16px}',
  ':where(.viz-card){padding:12px 14px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface)}',
  ':where(.viz-title){font-size:.95rem;font-weight:600}',
  ':where(.viz-muted){color:var(--viz-muted)}',
  ':where(.viz-note){color:var(--viz-muted);font-size:.85rem}',
  ':where(.viz-grid){display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:start}',
  ':where(.viz-row){display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  ':where(.viz-stat){display:flex;flex-direction:column;gap:2px}',
  ':where(.viz-stat-label){color:var(--viz-muted);font-size:.8rem}',
  ':where(.viz-stat-value){font-size:1.3rem;font-weight:600;font-variant-numeric:tabular-nums}',
  ':where(.viz-badge){display:inline-flex;align-items:center;padding:1px 8px;border:1px solid var(--viz-border);border-radius:999px;background:var(--viz-surface);font-size:.78rem}',
  ':where(.viz-btn){appearance:none;min-height:28px;padding:6px 12px;border:1px solid var(--viz-border);border-radius:var(--viz-radius);background:var(--viz-surface);color:var(--viz-fg);font:inherit;cursor:pointer}',
  ':where(.viz-btn:hover){background:var(--viz-bg)}',
  ':where(.viz-btn-primary){border-color:transparent;background:var(--viz-accent);color:var(--viz-on-accent)}',
  ':where(.viz-controls){display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0}',
  ':where(.viz-table){width:100%;border-collapse:collapse;font-size:.9rem}',
  ':where(.viz-table th){text-align:left;font-weight:600;color:var(--viz-muted)}',
  ':where(.viz-table th,.viz-table td){padding:6px 8px;border-bottom:1px solid var(--viz-border)}',
  ':where(.viz-s1){color:var(--viz-series-1);fill:var(--viz-series-1)}',
  ':where(.viz-s2){color:var(--viz-series-2);fill:var(--viz-series-2)}',
  ':where(.viz-s3){color:var(--viz-series-3);fill:var(--viz-series-3)}',
  ':where(.viz-s4){color:var(--viz-series-4);fill:var(--viz-series-4)}',
  ':where(.viz-s5){color:var(--viz-series-5);fill:var(--viz-series-5)}',
  ':where(.viz-s6){color:var(--viz-series-6);fill:var(--viz-series-6)}'
].join('')
