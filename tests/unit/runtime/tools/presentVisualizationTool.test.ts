import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPresentVisualizationTool } from '../../../../src/runtime/tools/present_visualization'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { VisualizationStore } from '../../../../src/runtime/visualizations/VisualizationStore'
import { MAX_VISUALIZATION_TITLE_CHARS, parseVisualizationResult } from '../../../../src/shared/visualization'

const HTML = '<!doctype html><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

let sessionsDir: string
let store: VisualizationStore

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), 'nova-viz-tool-'))
  store = new VisualizationStore(sessionsDir)
})

afterEach(async () => {
  await rm(sessionsDir, { recursive: true, force: true })
})

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: sessionsDir, sessionId: 's1', ...overrides } as ToolContext
}

async function snapshotCount(): Promise<number> {
  try {
    return (await readdir(path.join(sessionsDir, 's1', 'visualizations'))).length
  } catch {
    return 0
  }
}

describe('present_visualization', () => {
  it('校验通过后发布快照，结果只携带地址引用', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute({ title: '  调用\n链路  ', html: HTML }, context())

    expect(result.success).toBe(true)
    const presentation = parseVisualizationResult(result.output)
    expect(presentation).toMatchObject({ title: '调用 链路', bytes: Buffer.byteLength(HTML, 'utf8') })
    expect(result.output).not.toContain('<svg')
    expect(await store.read(presentation!.address)).toEqual({ status: 'ok', html: HTML })
  })

  it('超长标题截断而不拒绝调用', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute({ title: '图'.repeat(200), html: HTML }, context())
    const title = parseVisualizationResult(result.output)!.title
    expect(Array.from(title)).toHaveLength(MAX_VISUALIZATION_TITLE_CHARS)
    expect(title.endsWith('…')).toBe(true)
  })

  it('外联资源被拒绝时返回可修正的原因，不写快照', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute(
      { title: '图表', html: '<script src="https://cdn.example.com/chart.js"></script>' },
      context()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('外部脚本不可用')
    expect(result.error).toContain('重新调用 present_visualization')
    expect(await snapshotCount()).toBe(0)
  })

  it.each([
    ['缺少标题', { html: HTML }, context()],
    ['缺少 html', { title: '图' }, context()],
    ['没有会话', { title: '图', html: HTML }, context({ sessionId: undefined })],
    ['会话 ID 非法', { title: '图', html: HTML }, context({ sessionId: '../s1' })]
  ])('%s时失败', async (_label, args, toolContext) => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute(args, toolContext)
    expect(result.success).toBe(false)
    expect(await snapshotCount()).toBe(0)
  })

  it('存储不可用时失败', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => null })
    const result = await tool.execute({ title: '图', html: HTML }, context())
    expect(result).toMatchObject({ success: false, error: '当前会话无法展示可视化。' })
  })

  it('执行已取消时不写快照', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ title: '图', html: HTML }, context({ abortSignal: controller.signal }))).rejects.toThrow('已取消')
    expect(await snapshotCount()).toBe(0)
  })
})
