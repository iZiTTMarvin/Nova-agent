import { describe, expect, it } from 'vitest'
import { validateVisualizationHtml } from '../../../../src/runtime/visualizations/validateVisualizationHtml'
import { MAX_VISUALIZATION_HTML_BYTES } from '../../../../src/shared/visualization'

describe('validateVisualizationHtml', () => {
  it('data 属性中的标签和追问只是文字，导航与资源中的 HTML 仍拒绝', async () => {
    expect(await validateVisualizationHtml('<button data-label="data:text/html,example" data-prompt="data:text/html,example">文字</button>')).toEqual([])
    for (const html of ['<img src="data:text/html,example">', '<a href="data:text/html,example">打开</a>']) {
      expect(await validateVisualizationHtml(html)).not.toEqual([])
    }
  })
  it('完全内联的页面通过：data URL、页内引用、外部导航链接与内联脚本均可用', async () => {
    const html = `<!doctype html>
<html><head><style>body { background: url("data:image/png;base64,AAAA") } .dot { fill: var(--viz-accent) }</style></head>
<body>
  <svg><defs><circle id="dot" r="4"/></defs><use href="#dot"/></svg>
  <img src="data:image/png;base64,AAAA" srcset="data:image/png;base64,AA,AA 1x, data:image/png;base64,BB 2x">
  <a href="https://example.com/docs">文档</a>
  <script>const rows = [1, 2, 3]; document.body.append(String(rows))</script>
</body></html>`
    expect(await validateVisualizationHtml(html)).toEqual([])
  })

  it.each([
    ['外部脚本', '<script src="https://cdn.example.com/d3.js"></script>', '<script src='],
    ['外部样式表', '<link rel="stylesheet" href="https://cdn.example.com/x.css">', '<link href='],
    ['CSS @import', '<style>@import url("https://fonts.example.com/x.css");</style>', '@import'],
    ['行内样式远程 url()', '<div style="background: url(https://example.com/bg.png)"></div>', 'CSS url('],
    ['协议相对的远程图片', '<img src="//example.com/a.png">', '<img src='],
    ['srcset 中的远程候选', '<img srcset="data:image/png;base64,AA 1x, https://example.com/b.png 2x">', 'srcset'],
    ['SVG 远程引用', '<svg><image href="https://example.com/a.png"/></svg>', 'href='],
    ['嵌套页面', '<iframe src="https://example.com"></iframe>', '<iframe>'],
    ['改写基址', '<base href="https://example.com/">', '<base>'],
    ['自动跳转', '<meta http-equiv="refresh" content="0;url=https://example.com">', 'refresh'],
    ['外部表单', '<form action="https://example.com/submit"></form>', '<form action='],
    ['模块静态导入', '<script type="module">import * as d3 from "https://cdn.example.com/d3.js"</script>', 'import "'],
    ['动态导入', '<script>import("https://cdn.example.com/x.js")</script>', 'import "'],
    ['联网取数', '<script>fetch("https://api.example.com/data").then(r => r.json())</script>', '不能联网'],
    ['嵌套 HTML 文档', '<a href="data:text/html,<script>alert(1)</script>">x</a>', '嵌套 HTML']
  ])('拒绝%s并给出可操作原因', async (_label, html, fragment) => {
    const violations = await validateVisualizationHtml(`<!doctype html><body>${html}</body>`)
    expect(violations.join('\n')).toContain(fragment)
  })

  it('空文档与超限体积直接拒绝', async () => {
    expect(await validateVisualizationHtml('   ')).toEqual(['html 为空'])
    const oversized = await validateVisualizationHtml(`<p>${'x'.repeat(MAX_VISUALIZATION_HTML_BYTES)}</p>`)
    expect(oversized).toHaveLength(1)
    expect(oversized[0]).toContain('超过 2 MiB 上限')
  })

  it.each([
    [':root 自带调色板', '<style>:root{--bg:#0f1419;--surface:#1a2332}</style>'],
    ['body 写死背景色', '<style>body{background:#0f1419}</style>'],
    ['html 行内颜色', '<html style="background:#fff"><body>x</body></html>'],
    ['rgb() 写法', '<style>:root{--fg:rgb(230,237,243)}</style>'],
    ['颜色关键字', '<style>body{color:white}</style>'],
    ['hsl() 写法', '<style>:root{--accent:hsl(30 90% 55%)}</style>'],
    ['oklch() 写法', '<style>:root{--bg:oklch(20% 0.02 250)}</style>'],
    ['带属性的根选择器', '<style>:root[data-theme=dark]{--bg:#000}</style>'],
    ['媒体查询里的根调色板', '<style>@media (prefers-color-scheme:dark){html body{background:#000}}</style>']
  ])('拒绝%s：写死的颜色不会跟随深浅色主题', async (_label, html) => {
    const violations = await validateVisualizationHtml(`<!doctype html>${html}`)
    expect(violations.join('\n')).toContain('自带调色板')
    expect(violations.join('\n')).toContain('var(--viz-bg)')
  })

  it('主题变量（含兜底色）、后代规则与非根规则里的颜色、非颜色字面量都不受影响', async () => {
    const html = `<!doctype html><html><head><style>
      :root{--radius:12px;--gap:8px;--brand-font:"Black";--mask:url("#clip")}
      body{background:var(--viz-bg, #fff);color:var(--viz-fg, rgb(20, 20, 20))}
      body .card{background:#1a2332}
      body > header{border-bottom:1px solid #ddd}
      .card{background:#1a2332;border:1px solid var(--viz-border)}
      .dot{fill:var(--viz-accent)}
    </style></head><body><p>x</p></body></html>`
    expect(await validateVisualizationHtml(html)).toEqual([])
  })

  it('拒绝超过 8 个步骤平铺在单排胶囊条或缺乏阶段与图形画布的纯文字翻页器，放行分阶段泳道工作台', async () => {
    const crammedButtons = Array.from({ length: 16 }, (_, i) => `<button type="button">${i + 1}. 步骤</button>`).join('')
    const crammedHtml = `<!doctype html><body><div class="steps-bar">${crammedButtons}</div><div class="viz-card">正文</div></body>`
    const crammedViolations = await validateVisualizationHtml(crammedHtml)
    expect(crammedViolations.join('\n')).toContain('步骤或标签平铺过多')
    expect(crammedViolations.join('\n')).toContain('.viz-phases')

    const scriptSteps = Array.from({ length: 12 }, (_, i) => `{ step: ${i + 1}, title: '步骤${i + 1}' }`).join(',')
    const textOnlyDeckHtml = `<!doctype html><body><div id="bar"></div><div class="viz-card" id="detail"></div><script>const steps = [${scriptSteps}];</script></body>`
    const deckViolations = await validateVisualizationHtml(textOnlyDeckHtml)
    expect(deckViolations.join('\n')).toContain('多步骤可视化缺少阶段分组与图形画布')

    const structuredWorkbenchHtml = `<!doctype html><body>
      <div class="viz-workbench">
        <div class="viz-phases">
          <button class="viz-phase" data-active="true"><span class="viz-phase-kicker">阶段 1</span><span class="viz-phase-title">输入接纳</span></button>
          <button class="viz-phase"><span class="viz-phase-kicker">阶段 2</span><span class="viz-phase-title">模型推理</span></button>
          <button class="viz-phase"><span class="viz-phase-kicker">阶段 3</span><span class="viz-phase-title">工具执行</span></button>
          <button class="viz-phase"><span class="viz-phase-kicker">阶段 4</span><span class="viz-phase-title">状态落盘</span></button>
        </div>
        <div class="viz-split">
          <div class="viz-canvas"><div class="viz-lanes"><div class="viz-lane"><span class="viz-lane-label">Renderer</span><div class="viz-lane-nodes">${crammedButtons}</div></div></div></div>
          <div class="viz-inspector"><div class="viz-title">步骤详情</div></div>
        </div>
      </div>
      <script>const steps = [${scriptSteps}];</script>
    </body></html>`
    expect(await validateVisualizationHtml(structuredWorkbenchHtml)).toEqual([])
  })

  it.each([
    ['覆写内置 .viz-split 为双栏', '<style>.viz-split { grid-template-columns: 1.8fr 1fr; }</style>', '覆写内置布局类'],
    ['自定义 2fr 1fr 非对称双栏', '<style>.sandbox-layout { display: grid; grid-template-columns: 2fr 1fr; }</style>', '固定比例或定宽分栏布局'],
    ['自定义 65% 35% 百分比双栏', '<style>.sandbox-layout { display: grid; grid-template-columns: 65% 35%; }</style>', '固定比例或定宽分栏布局'],
    ['自定义 460px 1fr 定宽双栏', '<style>.sandbox-layout { display: grid; grid-template-columns: 460px 1fr; }</style>', '固定比例或定宽分栏布局'],
    ['行内 2fr 1fr 固定双栏', '<div style="display:grid;grid-template-columns:2fr 1fr"></div>', '行内固定双栏布局'],
    ['flex 定宽 460px 分栏', '<style>.left-col { flex: 0 0 460px; }</style>', '固定比例或定宽分栏布局']
  ])('拒绝会破坏窄卡阅读节奏的布局写法：%s', async (_label, snippetHtml, expectedText) => {
    const violations = await validateVisualizationHtml(`<!doctype html><body>${snippetHtml}</body>`)
    expect(violations.join('\n')).toContain(expectedText)
    expect(violations.join('\n')).toContain('.viz-split')
  })

  it('放行自适应 .viz-grid、repeat(auto-fit, ...) 与内置 .viz-split', async () => {
    const html = `<!doctype html><html><head><style>
      .custom-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
    </style></head><body>
      <div class="viz-workbench">
        <div class="viz-kpis"><div class="viz-card"><div class="viz-stat"><span class="viz-stat-value">6</span><span class="viz-stat-label">声明依赖</span></div></div></div>
        <div class="viz-split">
          <div class="viz-canvas"><div class="viz-grid"><div class="viz-card">openai</div></div></div>
          <div class="viz-inspector"><div class="viz-title">详情</div></div>
        </div>
      </div>
    </body></html>`
    expect(await validateVisualizationHtml(html)).toEqual([])
  })
})
