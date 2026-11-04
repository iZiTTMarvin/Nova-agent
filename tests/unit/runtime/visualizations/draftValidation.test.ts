import { describe, expect, it } from 'vitest'
import { compileVisualizationDraft } from '../../../../src/shared/visualization/draft'
import { validateVisualizationHtml } from '../../../../src/runtime/visualizations/validateVisualizationHtml'

describe('草稿与快照发布校验的契约', () => {
  it('短草稿中大量重复图表也必须在编译期报告展开体积超限', () => {
    const source = `## 重复图表\n\n${'```chart\n项目 | 数值\n样本 | 1\n```\n\n'.repeat(1800)}`
    expect(source.length).toBeLessThan(64_000)
    expect(compileVisualizationDraft(source, { mode: 'final' })).toMatchObject({
      status: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ line: 1, code: 'compiled-output-too-large', correctExample: expect.any(String) })])
    })
    expect(compileVisualizationDraft(`${source}\n## 后续面板\n\n`, { mode: 'preview' })).toMatchObject({
      status: 'preview', html: null, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'compiled-output-too-large' })])
    })
  })
  it('固定 seed 的合法组件产物全部通过发布校验', async () => {
    let seed = 0x4e4f5641
    const texts = ['普通文字', 'data:text/html;charset=utf-8,example', '<noscript>', '" & 中文 😀', 'https://example.com', 'url(remote)', '</script>']
    for (let sample = 0; sample < 140; sample++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const value = texts[seed % texts.length]
      const blocks = [
        `flow\n${value} -> 终点: 说明`,
        `sequence\n${value} -> 终点: 返回`,
        `tree\n${value}\n  子节点`,
        `timeline\n开始 | ${value} | 说明`,
        `comparison\n${value} | 方案\n内容 | 数据`,
        `kv\n名称 | ${value}`,
        `callout title="提示"\n${value}`,
        `code lang=ts\nconst text = ${JSON.stringify(value)}`,
        `chart type=line\n${value} | 数值\n条目 | 2`,
        `ask id=follow-up\n继续吗？\n${value} | ${value}`,
        'remark id=note'
      ]
      const source = `## 场景 ${sample}\n\n${blocks.map(block => `\`\`\`${block}\n\`\`\``).join('\n\n')}`
      const result = compileVisualizationDraft(source, { mode: 'final' })
      expect(result.status, source).toBe('ok')
      if (result.status === 'ok') expect(await validateVisualizationHtml(result.html), source).toEqual([])
    }
  })
})
