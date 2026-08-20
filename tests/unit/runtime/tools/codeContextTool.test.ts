import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import {
  CODE_CONTEXT_LIMITS,
  EMPTY_CODE_INDEX_COVERAGE,
  type CodeContextPack,
  type CodeContextQueryPort
} from '../../../../src/runtime/code-graph'
import {
  CODE_CONTEXT_TOOL_DESCRIPTION,
  createCodeContextTool
} from '../../../../src/runtime/tools/codeContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createReadyPack(): CodeContextPack {
  return Object.freeze({
    status: 'ready',
    revision: 7,
    summary: 'ready · understand · verifyToken 定义于 auth.ts:1；返回 1 条直接关系',
    intent: 'understand',
    anchors: Object.freeze([{
      kind: 'function',
      name: 'verifyToken',
      path: 'auth.ts',
      startLine: 1,
      endLine: 3,
      score: 1
    }]),
    relations: Object.freeze([{
      type: 'calls',
      from: 'session.ts:openSession',
      to: 'auth.ts:verifyToken',
      confidence: 'confirmed',
      resolver: 'same_file',
      sourceFile: 'session.ts',
      sourceLine: 4,
      depth: 1
    }]),
    recommendedReads: Object.freeze([{
      path: 'auth.ts',
      startLine: 1,
      endLine: 23,
      reason: 'function 定义'
    }]),
    coverage: Object.freeze({
      ...EMPTY_CODE_INDEX_COVERAGE,
      eligibleFiles: 2,
      indexedFiles: 2
    }),
    warnings: Object.freeze([])
  })
}

describe('code_context 工具契约', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function createContext(overrides: Partial<ToolContext> = {}): ToolContext {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-code-context-tool-'))
    roots.push(sessionsDir)
    return {
      workingDir: process.cwd(),
      readState: createReadState(),
      supportsVision: false,
      sessionId: 'session-code-context',
      artifactStore: new ArtifactStore(sessionsDir),
      ...overrides
    }
  }

  it('description 与 schema 字节级稳定，不嵌入运行时信息', () => {
    const tool = createCodeContextTool({ getQueryPort: () => null })
    const definitionBefore = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters
    })
    const definitionAfter = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters
    })

    expect(tool.description).toBe(CODE_CONTEXT_TOOL_DESCRIPTION)
    expect(definitionAfter).toBe(definitionBefore)
    expect(definitionAfter).not.toContain('ready')
    expect(definitionAfter).not.toContain('revision')
    expect(definitionAfter).not.toContain(process.cwd())
    const intentSchema = tool.parameters.properties?.intent
    expect(isRecord(intentSchema) ? intentSchema.enum : undefined).toEqual([
      'locate',
      'understand',
      'impact'
    ])
  })

  it('索引运行状态只影响查询结果，不参与工具注册', async () => {
    let port: CodeContextQueryPort | null = null
    const tool = createCodeContextTool({ getQueryPort: () => port })
    const unavailable = await tool.execute({ query: 'verifyToken' }, createContext())
    port = { query: async () => createReadyPack() }
    const ready = await tool.execute(
      { query: 'verifyToken', intent: 'understand' },
      createContext()
    )

    expect(tool.name).toBe('code_context')
    const unavailablePack: unknown = JSON.parse(unavailable.output)
    const readyPack: unknown = JSON.parse(ready.output)
    expect(isRecord(unavailablePack) ? unavailablePack.status : undefined).toBe('unavailable')
    expect(isRecord(readyPack) ? readyPack.status : undefined).toBe('ready')
  })

  it('输出是单行紧凑 JSON，关键字段在前且受预算约束', async () => {
    const tool = createCodeContextTool({
      getQueryPort: () => ({ query: async () => createReadyPack() })
    })
    const result = await tool.execute(
      { query: 'verifyToken', intent: 'understand' },
      createContext()
    )

    expect(result.success).toBe(true)
    expect(result.output).not.toContain('\n')
    expect(result.output.slice(0, 200)).toContain('ready · understand')
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(
      CODE_CONTEXT_LIMITS.targetBytes
    )
    const parsed: unknown = JSON.parse(result.output)
    expect(isRecord(parsed)).toBe(true)
    if (!isRecord(parsed)) throw new Error('代码上下文输出不是对象')
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['status', 'revision', 'summary', 'intent'])
    expect(parsed.status).toBe('ready')
    expect(parsed.revision).toBe(7)
    expect(result.artifactId).toBeUndefined()
  })

  it('超过硬上限的最终文本由 OutputSink 落盘并留下可续读指针', async () => {
    const oversizedPack: CodeContextPack = Object.freeze({
      ...createReadyPack(),
      warnings: Object.freeze(Array.from(
        { length: 120 },
        (_, index) => `${index}:${'x'.repeat(240)}`
      ))
    })
    const context = createContext()
    const tool = createCodeContextTool({
      getQueryPort: () => ({ query: async () => oversizedPack })
    })
    const result = await tool.execute({ query: 'verifyToken' }, context)

    expect(result.success).toBe(true)
    expect(result.artifactId).toBeDefined()
    expect(result.output).toContain('artifact://')
    expect(result.truncationMeta?.truncated).toBe(true)
    if (!result.artifactId || !context.artifactStore) {
      throw new Error('超限代码上下文未生成 artifact')
    }
    const fullText = await context.artifactStore.read(
      'session-code-context',
      result.artifactId
    )
    const parsed: unknown = JSON.parse(fullText)
    expect(isRecord(parsed) ? parsed.status : undefined).toBe('ready')
    expect(Buffer.byteLength(fullText, 'utf8')).toBeGreaterThan(
      CODE_CONTEXT_LIMITS.hardBytes
    )
  })

  it('查询端未就绪时返回可恢复降级结果，不污染 readState', async () => {
    const context = createContext()
    const before = context.readState.getStats()
    const tool = createCodeContextTool({ getQueryPort: () => null })
    const result = await tool.execute({ query: 'auth' }, context)

    expect(result.success).toBe(true)
    const parsed: unknown = JSON.parse(result.output)
    expect(isRecord(parsed) ? parsed.status : undefined).toBe('unavailable')
    expect(isRecord(parsed) ? parsed.warnings : undefined).toEqual([
      '代码索引查询端尚未就绪；请继续使用 grep/read'
    ])
    expect(context.readState.getStats()).toEqual(before)
  })

  it('flow 不进入 schema，幻觉调用时仍返回显式 unavailable', async () => {
    const tool = createCodeContextTool({ getQueryPort: () => null })
    const result = await tool.execute(
      { query: 'request flow', intent: 'flow' },
      createContext()
    )

    expect(result.success).toBe(true)
    const parsed: unknown = JSON.parse(result.output)
    expect(isRecord(parsed) ? parsed.status : undefined).toBe('unavailable')
    expect(isRecord(parsed) ? parsed.intent : undefined).toBe('flow')
    expect(isRecord(parsed) ? parsed.summary : undefined).toContain('当前版本不提供多跳代码流')
  })

  it('无效输入和取消都以工具失败结束', async () => {
    const tool = createCodeContextTool({
      getQueryPort: () => ({
        query: async () => {
          const error = new Error('已取消')
          error.name = 'AbortError'
          throw error
        }
      })
    })
    const invalid = await tool.execute({ query: '   ' }, createContext())
    const escapedScope = await tool.execute(
      { query: 'auth', scope: '../outside' },
      createContext()
    )
    const cancelled = await tool.execute({ query: 'auth' }, createContext())

    expect(invalid).toEqual({ success: false, output: '', error: '代码查询不能为空' })
    expect(escapedScope.success).toBe(false)
    expect(escapedScope.error).toContain('必须位于工作区内')
    expect(cancelled).toEqual({ success: false, output: '', error: '代码上下文查询已取消' })
  })
})
