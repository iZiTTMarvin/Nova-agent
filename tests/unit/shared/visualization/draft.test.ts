import { describe, expect, it } from 'vitest'
import { compileVisualizationDraft } from '../../../../src/shared/visualization/draft'

const FULL_DRAFT = `## 请求如何到达主进程

先看调用方向，再看每一步发生了什么。

\`\`\`flow direction=col selected=Preload
CLI -> Preload: 用户提问
Preload -> Main: 类型化 invoke
Main -> SessionStore: 校验并写入
\`\`\`

\`\`\`sequence
Agent -> Model: messages + tools
Model --> Agent: tool_call
Agent ->> ReadTool: read(path)
\`\`\`

## 状态与层级

\`\`\`tree
Agent 循环
  模型调用
  工具执行
    只读工具
独立 Owner
  权限
\`\`\`

\`\`\`timeline current=执行
接收 | 校验输入
执行 | 模型与工具交替
提交 | 写入终态
\`\`\`

## 比较与数据

\`\`\`comparison
维度 | 直读数据库 | 先查缓存
平均延迟 | 38 ms | 4 ms
改造成本 | 低 | 中
\`\`\`

\`\`\`kv
唯一写入者 | VisualizationStore
失败行为 | 不写快照
\`\`\`

\`\`\`callout tone=warning title=注意边界
缓存只是可删除的投影。
\`\`\`

\`\`\`code lang=ts file=src/runtime/example.ts:12
const receipt = await store.publish(draft)
if (!receipt.ok) return
\`\`\`

\`\`\`chart type=bar unit=ms
场景 | 延迟
数据库 | 38
缓存 | 4
\`\`\`

\`\`\`chart type=line unit=次
轮次 | 数据库 | 缓存
第 1 轮 | 120 | 0
第 2 轮 | 60 | 60
\`\`\`

\`\`\`chart type=area
轮次 | 请求
第 1 轮 | 12
第 2 轮 | 8
\`\`\``

function ok(source: string): string {
  const result = compileVisualizationDraft(source, { mode: 'final' })
  if (result.status !== 'ok') throw new Error(JSON.stringify(result))
  return result.html
}

describe('compileVisualizationDraft', () => {
  it('同输入字节级确定，所有静态组件使用同一入口', () => {
    const first = compileVisualizationDraft(FULL_DRAFT, { mode: 'final' })
    const second = compileVisualizationDraft(FULL_DRAFT, { mode: 'final' })
    expect(first).toEqual(second)
    if (first.status !== 'ok') throw new Error(JSON.stringify(first))
    expect(first.panelCount).toBe(3)
    for (const marker of ['viz-draft-flow', 'viz-draft-sequence', 'viz-draft-tree', 'viz-draft-timeline', 'viz-draft-table', 'viz-draft-kv', 'viz-draft-callout', 'viz-draft-code', 'viz-draft-chart']) {
      expect(first.html).toContain(marker)
    }
    expect(first.html).toContain('data-current="true"')
    expect(first.html).toContain('data-label="直读数据库"')
  })

  it('flow 单链路渲染为静态纵向节点与相邻连线说明，不生成无用途按钮或重复边列表', () => {
    const html = ok(`## 正常路径：从 title/draft 到快照 URI\n\n\`\`\`flow direction=col selected=草稿编译\n调用参数 -> 标题归一化: 折叠空白、80 字符截断\n标题归一化 -> 草稿编译: title 或 draft 为空直接失败\n草稿编译 -> HTML 安全校验: 编译诊断为空才继续\nHTML 安全校验 -> 副作用 fencing: 外链与联网全部拦下\n副作用 fencing -> 发布快照: 已取消或代际失效则抛错\n发布快照 -> 原子写盘: sha256 就是地址\n原子写盘 -> 返回 JSON 结果: presented / title / uri / bytes\n\`\`\``)
    expect(html).toContain('data-direction="col"')
    expect(html).toContain('data-flow-layout="chain"')
    expect(html).toContain('viz-draft-flow__steps')
    expect(html).not.toContain('viz-draft-flow__edges')
    expect(html).not.toContain('data-viz-select')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<script>')
    expect(html.match(/class="viz-node viz-draft-flow__node"/g)).toHaveLength(8)
    expect(html.match(/class="viz-draft-flow__connector"/g)).toHaveLength(7)
    expect(html).toContain('data-viz-node="草稿编译" data-active="true"')
    expect(html.indexOf('调用参数')).toBeLessThan(html.indexOf('折叠空白、80 字符截断'))
    expect(html.indexOf('折叠空白、80 字符截断')).toBeLessThan(html.indexOf('标题归一化'))
  })

  it('flow 分支、汇合与环保留真实有向关系，不伪造单链且不遗漏或重复节点与边', () => {
    const branchMerge = ok(`## 分支汇合\n\n\`\`\`flow direction=col\n请求入口 -> 命中缓存: 已缓存\n请求入口 -> 查询数据库: 未命中\n命中缓存 -> 返回响应: 4 ms\n查询数据库 -> 返回响应: 38 ms\n\`\`\``)
    expect(branchMerge).toContain('data-flow-layout="graph"')
    expect(branchMerge).not.toContain('viz-draft-flow__steps')
    expect(branchMerge).not.toContain('<button')
    expect(branchMerge.match(/data-viz-node=/g)).toHaveLength(4)
    expect(branchMerge.match(/class="viz-draft-flow__edge-item"/g)).toHaveLength(4)
    expect(branchMerge).toContain('已缓存')
    expect(branchMerge).toContain('38 ms')

    const cycle = ok(`## 重试环\n\n\`\`\`flow direction=row\n草稿编译 -> 安全校验: 产物 HTML\n安全校验 -> 草稿编译: 违规打回\n安全校验 -> 快照发布: 通过\n\`\`\``)
    expect(cycle).toContain('data-direction="row"')
    expect(cycle).toContain('data-flow-layout="graph"')
    expect(cycle.match(/data-viz-node=/g)).toHaveLength(3)
    expect(cycle.match(/class="viz-draft-flow__edge-item"/g)).toHaveLength(3)
  })

  it('flow 分组按声明归属静态节点，边不会把节点复制到最后一组', () => {
    const html = ok(`## 分层\n\n\`\`\`flow selected=Main\n@group 入口层\nCLI\nPreload\n@group 主进程\nMain\nSessionStore\nCLI -> Preload: 提问\nPreload -> Main: invoke\nMain -> SessionStore: 写入\n\`\`\``)
    const lanes = html.match(/<div class="viz-lane">/g) ?? []
    expect(lanes).toHaveLength(2)
    expect(html.indexOf('入口层')).toBeLessThan(html.indexOf('主进程'))
    expect(html).not.toContain('<button')
    expect(html.match(/data-viz-node="Main"/g)).toHaveLength(1)
    expect(html).toContain('data-viz-node="Main" data-active="true"')
  })

  it('未分组长流程在草稿行给出拆分建议，分组流程不受平铺上限影响', () => {
    const edges = Array.from({ length: 9 }, (_, index) => `N${index} -> N${index + 1}`).join('\n')
    const result = compileVisualizationDraft(`## 长链路\n\n\`\`\`flow\n${edges}\n\`\`\``, { mode: 'final' })
    expect(result).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({
        line: 3,
        code: 'flat-flow-too-many-nodes',
        message: expect.stringContaining('拆成多个 flow'),
        correctExample: expect.stringContaining('```flow')
      })]
    })
    if (result.status === 'invalid') expect(result.issues[0].correctExample).not.toContain('.viz-')

    const grouped = `## 分组\n\n\`\`\`flow\n@group 全部节点\n${Array.from({ length: 10 }, (_, index) => `N${index}`).join('\n')}\n${edges}\n\`\`\``
    expect(compileVisualizationDraft(grouped, { mode: 'final' }).status).toBe('ok')
  })

  it('正文只支持文本和简单列表，原始 HTML 被结构化拒绝', () => {
    const result = compileVisualizationDraft('## 安全\n\n<img src=x onerror=alert(1)>', { mode: 'final' })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues).toContainEqual(expect.objectContaining({ line: 3, code: 'raw-html-forbidden', correctExample: expect.any(String) }))

    const inlineCode = ok('## 安全\n\n`<noscript>` 只是标签名，不是原始 HTML。')
    expect(inlineCode).toContain('`&lt;noscript&gt;` 只是标签名')
  })

  it('组件文本、属性和代码分别转义，不能闭合模板或注入事件', () => {
    const html = ok(`## 安全\n\n\`\`\`code lang=ts file="a.ts:1"
const attack = "</script><img src=x onerror=alert(1)> & 中文"
\`\`\`

\`\`\`ask id=safe-ask
是否继续？
" 继续 & 深入 | </button><script>alert(1)</script>
\`\`\``)
    expect(html).not.toContain('</script><img')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot; 继续 &amp; 深入')
    expect(html).toContain('&lt;/button&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toMatch(/<[^>]+\son\w+=/)
  })

  it('preview 只输出已由下一面板封口的完整面板，残缺尾部保持待写', () => {
    const source = `## 已完成\n\n第一段。\n\n\`\`\`kv\n状态 | 完整\n\`\`\`\n\n## 正在生成\n\n\`\`\`flow direction=col\nA -> B`
    const result = compileVisualizationDraft(source, { mode: 'preview' })
    expect(result).toMatchObject({ status: 'preview', completePanelCount: 1, diagnostics: [] })
    if (result.status !== 'preview') return
    expect(result.html).toContain('已完成')
    expect(result.html).toContain('状态')
    expect(result.html).not.toContain('正在生成')
    expect(result.html).not.toContain('<script')
  })

  it('preview 不显示唯一且尚未封口的尾部面板', () => {
    const result = compileVisualizationDraft('## 第一段\n\n仍在写', { mode: 'preview' })
    expect(result).toEqual({ status: 'preview', html: null, completePanelCount: 0, diagnostics: [] })
  })

  it('一次返回全部独立错误并按源码位置稳定排序', () => {
    const result = compileVisualizationDraft(`## 错误\n\n\`\`\`flow direction=diagonal\nbroken\n\`\`\`\n\n\`\`\`comparison\n只有一列\n也不够\n\`\`\`\n\n##`, { mode: 'final' })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-flow-direction', 'invalid-flow-edge', 'comparison-columns', 'panel-title-required']))
    expect(result.issues.every(item => item.message && item.code)).toBe(true)
    const positions = result.issues.map(item => [item.line, item.column ?? 0])
    expect(positions).toEqual([...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]))
  })

  it('非法和空输入不返回 HTML', () => {
    for (const source of ['', '没有面板', '##', '## 空组件\n\n```unknown\nx\n```']) {
      const result = compileVisualizationDraft(source, { mode: 'final' })
      expect(result.status).toBe('invalid')
      expect(result).not.toHaveProperty('html')
    }
  })

  it('树深度、节点、边与源码总量有界', () => {
    const deep = `## 深度\n\n\`\`\`tree\n${Array.from({ length: 10 }, (_, index) => `${' '.repeat(index * 2)}节点 ${index}`).join('\n')}\n\`\`\``
    expect(compileVisualizationDraft(deep, { mode: 'final' })).toMatchObject({ status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'tree-too-deep' })]) })
    const manyEdges = `## 边\n\n\`\`\`flow\n${Array.from({ length: 121 }, (_, index) => `A${index} -> B${index}`).join('\n')}\n\`\`\``
    expect(compileVisualizationDraft(manyEdges, { mode: 'final' })).toMatchObject({ status: 'invalid' })
    expect(compileVisualizationDraft(`## 大\n\n${'中'.repeat(64_000)}`, { mode: 'final' })).toMatchObject({ status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'draft-too-large' })]) })
  })

  it('表格列数、行宽和图表数值都可定位修复', () => {
    const source = `## 数据\n\n\`\`\`comparison\nA | B\n1 | 2 | 3\n\`\`\`\n\n\`\`\`chart type=line\n项目 | 数值\n甲 | not-a-number\n\`\`\``
    const result = compileVisualizationDraft(source, { mode: 'final' })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'comparison-row-width', line: 5 }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-chart-value', line: 10 }))
  })

  it('比较表兼容外竖线和 Markdown 分隔行', () => {
    const html = ok('## 比较\n\n```comparison\n| 维度 | 浏览器侧 | 工件侧 |\n|---|---|---|\n| 数据形态 | DOM 状态 | 落盘记录 |\n```')
    expect(html.match(/<th\b/g) ?? []).toHaveLength(3)
    expect(html).not.toContain('>---<')
  })

  it('面板中的标准 Markdown 表格确定性编译为 comparison，保留列数与错误行号校验', () => {
    const source = '## 三条路径\n\n| 路径 | 结果 |\n|---|---|\n| 编译失败 | 不发布 |\n| 校验失败 | 不发布 |\n| 成功 | 快照 URI |'
    const html = ok(source)
    expect(html).toContain('<table class="viz-table viz-draft-table">')
    expect(html.match(/<td\b/g)).toHaveLength(6)
    expect(html).not.toContain('>---<')
    expect(compileVisualizationDraft(`${source}\n| 多余 | 数据 | 列 |`, { mode: 'final' })).toMatchObject({
      status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'comparison-row-width', line: 8 })])
    })
  })

  it('Unicode、CRLF 和特殊数值不会破坏确定性或产生非有限坐标', () => {
    const html = ok('## Unicode 😀\r\n\r\n```chart type=line unit=次\r\n项目 | 数值\r\n零 | 0\r\n一 | -0\r\n```')
    expect(html).toContain('Unicode 😀')
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(ok('## Unicode 😀\n\n```chart type=line unit=次\n项目 | 数值\n零 | 0\n一 | -0\n```')).toBe(html)
  })

  it('面板、代码和选项上限失败时不抛栈', () => {
    const panels = Array.from({ length: 25 }, (_, index) => `## 面板 ${index}`).join('\n\n')
    expect(compileVisualizationDraft(panels, { mode: 'final' })).toMatchObject({ status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'too-many-panels' })]) })
    const code = `## 代码\n\n\`\`\`code\n${Array.from({ length: 121 }, (_, index) => `const v${index} = ${index}`).join('\n')}\n\`\`\``
    expect(compileVisualizationDraft(code, { mode: 'final' })).toMatchObject({ status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'code-too-long' })]) })
  })

  it('Before/After/Changes 使用固定选项卡语义，preview 不含固定脚本', () => {
    const source = `## 迁移\n\n\`\`\`comparison views=Before,After,Changes\n维度 | 旧方式\n写入者 | 多处\n---\n维度 | 新方式\n写入者 | 单一 Owner\n---\n维度 | 变化\n恢复 | 可对账\n\`\`\``
    const final = compileVisualizationDraft(source, { mode: 'final' })
    expect(final.status).toBe('ok')
    if (final.status !== 'ok') return
    expect(final.html).toContain('role="tablist"')
    expect(final.html.match(/data-viz-view-panel=/g)).toHaveLength(3)
    expect(final.html).toContain('data-viz-view-panel="1" hidden')
    expect(final.html).toContain('event.isTrusted')
    expect(final.html).not.toMatch(/eval\(|new Function|fetch\(|WebSocket/)

    const preview = compileVisualizationDraft(`${source}\n\n## 尾部\n\n正在写`, { mode: 'preview' })
    expect(preview.status).toBe('preview')
    if (preview.status !== 'preview') return
    expect(preview.html).toContain('Before')
    expect(preview.html).not.toContain('<script')
  })

  it('脚本分隔符和 Unicode 行分隔符只存在文本节点，不进入固定脚本', () => {
    const marker = '</script>\u2028\u2029<script>alert(1)</script>'
    const html = ok(`## 安全\n\n\`\`\`ask id=safe\n继续？\n选项 | ${marker}\n\`\`\`\n\n\`\`\`remark id=note title=${marker}\n\`\`\``)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).not.toContain(marker)
    expect(scripts[0]).not.toContain('\u2028')
    expect(scripts[0]).not.toContain('\u2029')
  })

  it('固定 seed fuzz 不抛异常、不越过输入上限且成功结果可重复', () => {
    let seed = 0x4e4f5641
    const alphabet = ['#', '`', '\\', '"', '<', '>', '|', '-', ' ', '\n', '\r', '中', '😀', '\u2028', '\u2029', 'f', 'l', 'o', 'w', '=']
    for (let sample = 0; sample < 300; sample += 1) {
      let source = ''
      const length = sample % 17 === 0 ? 2_000 : 240
      for (let index = 0; index < length; index += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        source += alphabet[seed % alphabet.length]
      }
      for (const mode of ['final', 'preview'] as const) {
        const first = compileVisualizationDraft(source, { mode })
        const second = compileVisualizationDraft(source, { mode })
        expect(first).toEqual(second)
        expect(first.status).toMatch(/^(ok|preview|invalid)$/)
        if (first.status === 'ok') {
          expect(first.html).not.toContain('<script src')
          expect(first.html).not.toContain('<iframe')
          expect(first.html).not.toContain('<form')
        }
      }
    }
  })
})
