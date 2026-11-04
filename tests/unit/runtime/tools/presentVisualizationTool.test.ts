import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPresentVisualizationTool } from '../../../../src/runtime/tools/present_visualization'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { VisualizationStore } from '../../../../src/runtime/visualizations/VisualizationStore'
import { MAX_VISUALIZATION_TITLE_CHARS, parseVisualizationResult } from '../../../../src/shared/visualization'
import { compileVisualizationDraft } from '../../../../src/shared/visualization/draft'

const DRAFT = '## 请求链路\n\n```flow\nCLI -> Preload: 用户提问\nPreload -> Main: 类型化调用\n```'

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
  it.each([DRAFT, '## 三种路径\n\n| 路径 | 结果 |\n|---|---|\n| 编译失败 | 不发布 |\n| 校验失败 | 不发布 |\n| 成功 | URI |'])('草稿编译通过后发布快照，结果只携带地址引用 %#', async draft => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute({ title: '  调用\n链路  ', draft }, context())

    expect(result.success).toBe(true)
    const presentation = parseVisualizationResult(result.output)
    const compiled = compileVisualizationDraft(draft, { mode: 'final' })
    if (compiled.status !== 'ok') throw new Error('测试草稿无效')
    expect(presentation).toMatchObject({ title: '调用 链路', bytes: Buffer.byteLength(compiled.html, 'utf8') })
    expect(result.output).not.toContain('用户提问')
    expect(result.output).not.toContain('<main')
    expect(await store.read(presentation!.address)).toEqual({ status: 'ok', html: compiled.html })
  })

  it('工具 schema 只接纳 title 与 draft，不提供 HTML 分支', () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    expect(tool.parameters).toMatchObject({ required: ['title', 'draft'], additionalProperties: false })
    expect(tool.parameters).toHaveProperty('properties.draft')
    expect(tool.parameters).not.toHaveProperty('properties.html')
  })

  it('超长标题截断而不拒绝调用', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute({ title: '图'.repeat(200), draft: DRAFT }, context())
    const title = parseVisualizationResult(result.output)!.title
    expect(Array.from(title)).toHaveLength(MAX_VISUALIZATION_TITLE_CHARS)
    expect(title.endsWith('…')).toBe(true)
  })

  it('原始 HTML 被当作草稿拒绝，不写快照', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute(
      { title: '图表', draft: '## 图表\n\n<script src="https://cdn.example.com/chart.js"></script>' },
      context()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('raw-html-forbidden')
    expect(result.error).toContain('草稿 3')
    expect(result.error).toContain('不要改写成 HTML')
    expect(await snapshotCount()).toBe(0)
  })

  it('一次返回多个可定位错误与正确示例，不写快照', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute(
      { title: '全景图', draft: '## 全景图\n\n```flow\nbroken\n```\n\n```comparison\n只有一列\n```' },
      context()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid-flow-edge')
    expect(result.error).toContain('comparison-columns')
    expect(result.error).toContain('正确示例')
    expect(result.error).toContain('重新调用 present_visualization')
    expect(await snapshotCount()).toBe(0)
  })

  it.each([
    ['缺少标题', { draft: DRAFT }, context()],
    ['缺少 draft', { title: '图' }, context()],
    ['旧 html 参数', { title: '图', html: '<p>旧输入</p>' }, context()],
    ['没有会话', { title: '图', draft: DRAFT }, context({ sessionId: undefined })],
    ['会话 ID 非法', { title: '图', draft: DRAFT }, context({ sessionId: '../s1' })]
  ])('%s时失败', async (_label, args, toolContext) => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const result = await tool.execute(args, toolContext)
    expect(result.success).toBe(false)
    expect(await snapshotCount()).toBe(0)
  })

  it('存储不可用时失败', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => null })
    const result = await tool.execute({ title: '图', draft: DRAFT }, context())
    expect(result).toMatchObject({ success: false, error: '当前会话无法展示可视化。' })
  })

  it('执行已取消时不写快照', async () => {
    const tool = createPresentVisualizationTool({ getStore: () => store })
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ title: '图', draft: DRAFT }, context({ abortSignal: controller.signal }))).rejects.toThrow('已取消')
    expect(await snapshotCount()).toBe(0)
  })
})
