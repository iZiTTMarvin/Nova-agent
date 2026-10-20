import { describe, expect, it, vi } from 'vitest'
import {
  buildExportedVisualizationDocument,
  buildServedVisualizationDocument,
  resolveVisualizationDocument,
  VISUALIZATION_RESPONSE_CSP,
  type VisualizationSnapshotReader
} from '../../../../src/runtime/visualizations/visualizationDocument'
import type { VisualizationSnapshotRead } from '../../../../src/runtime/visualizations/VisualizationStore'
import { VISUALIZATION_BASE_STYLE } from '../../../../src/runtime/visualizations/visualizationStyles'
import {
  buildVisualizationFrameSrc,
  buildVisualizationUri,
  VISUALIZATION_THEME_TOKENS,
  type VisualizationTheme
} from '../../../../src/shared/visualization'

const SHA = 'b'.repeat(64)
const THEME: VisualizationTheme = {
  scheme: 'light',
  tokens: Object.fromEntries(VISUALIZATION_THEME_TOKENS.map(name => [name, '#0a0b0c'])) as VisualizationTheme['tokens']
}
const CONFIG = { theme: THEME, motionScale: 1, maxHeight: 720 }

function reader(snapshot: VisualizationSnapshotRead): VisualizationSnapshotReader & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => snapshot) }
}

describe('帧文档装配', () => {
  it('桥接内容紧跟 doctype、先于作者内容；作者的 html 属性仍可合并到根元素', () => {
    const document = buildServedVisualizationDocument('<!DOCTYPE html><html lang="en" class="dark"><body><p>hi</p></body></html>', CONFIG)
    expect(document.startsWith('<!DOCTYPE html><style>')).toBe(true)
    expect(document.indexOf('<script>')).toBeLessThan(document.indexOf('<html lang="en"'))
    expect(document.endsWith('<p>hi</p></body></html>')).toBe(true)
  })

  it('缺 doctype 时补齐标准模式并去掉 BOM', () => {
    const document = buildServedVisualizationDocument('\uFEFF<p>hi</p>', CONFIG)
    expect(document.startsWith('<!doctype html><style>')).toBe(true)
    expect(document).not.toContain('\uFEFF')
  })

  it('响应 CSP 不放行任何网络来源，并以 sandbox 兜底顶层打开', () => {
    expect(VISUALIZATION_RESPONSE_CSP).toContain("default-src 'none'")
    expect(VISUALIZATION_RESPONSE_CSP).toContain("form-action 'none'")
    expect(VISUALIZATION_RESPONSE_CSP).not.toMatch(/https?:|\*|'self'/)
    expect(VISUALIZATION_RESPONSE_CSP.endsWith('sandbox allow-scripts')).toBe(true)
  })

  it('导出文件用 meta CSP 保持离线、内嵌导出时的主题，不带 sandbox 以便独立打开', () => {
    const document = buildExportedVisualizationDocument('<!doctype html><p>x</p>', THEME)
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(document)?.[1]
    expect(policy).toContain("default-src 'none'")
    expect(policy).not.toContain('sandbox')
    expect(document).toContain('"bg":"#0a0b0c"')
  })

  it('帧与导出文件带同一份共享样式，产物不另起一套视觉语言', () => {
    const served = buildServedVisualizationDocument('<!doctype html><p>x</p>', CONFIG)
    const exported = buildExportedVisualizationDocument('<!doctype html><p>x</p>', THEME)
    for (const document of [served, exported]) {
      expect(document).toContain('.viz-card')
      expect(document).toContain('.viz-table')
      expect(document).toContain('var(--viz-series-1)')
    }
  })

  it('共享样式零特异性：每条规则都包在 :where() 里，作者自己的选择器始终优先', () => {
    const rules = VISUALIZATION_BASE_STYLE.split('}')
      .map(rule => rule.trim())
      .filter(Boolean)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.startsWith(':where(')).toBe(true)
    }
  })

  it('注入前缀只有桥脚本自身的换行：桥据此把产物报错行号换算回作者源码', () => {
    const author = '<html><body>\n<p>x</p>\n</body></html>'
    const document = buildServedVisualizationDocument(author, CONFIG)
    const prefix = document.slice(0, document.indexOf(author))
    const script = /<script>([\s\S]*)<\/script>/.exec(prefix)?.[1] ?? ''
    expect(script).not.toBe('')
    expect(prefix.split('\n').length).toBe(script.split('\n').length)
  })
})

describe('resolveVisualizationDocument', () => {
  const uri = buildVisualizationUri({ sessionId: 's1', sha256: SHA })

  it('快照可用时返回作者内容，并沿用帧地址里的主题与倍率', async () => {
    const source = reader({ status: 'ok', html: '<p>作者内容</p>' })
    const document = await resolveVisualizationDocument(
      source,
      buildVisualizationFrameSrc(uri, { theme: THEME, motionScale: 4, maxHeight: 500 })
    )
    expect(source.read).toHaveBeenCalledWith({ sessionId: 's1', sha256: SHA })
    expect(document).toContain('<p>作者内容</p>')
    expect(document).toContain('"status":"ok"')
    expect(document).toContain('"motionScale":4')
    expect(document).toContain('"maxHeight":500')
  })

  it('地址非法时不读存储，按缺失回应', async () => {
    const source = reader({ status: 'ok', html: '<p>不应读出</p>' })
    const document = await resolveVisualizationDocument(source, 'nova-viz://snapshot/s1/not-a-digest.html')
    expect(source.read).not.toHaveBeenCalled()
    expect(document).toContain('可视化快照不存在')
    expect(document).toContain('"status":"missing"')
  })

  it('快照损坏时返回带桥的状态文档', async () => {
    const document = await resolveVisualizationDocument(reader({ status: 'corrupt' }), uri)
    expect(document).toContain('可视化快照已损坏')
    expect(document).toContain('"status":"corrupt"')
  })
})
