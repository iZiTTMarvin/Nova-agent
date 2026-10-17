import { describe, expect, it } from 'vitest'
import { validateVisualizationHtml } from '../../../../src/runtime/visualizations/validateVisualizationHtml'
import { MAX_VISUALIZATION_HTML_BYTES } from '../../../../src/shared/visualization'

describe('validateVisualizationHtml', () => {
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
})
