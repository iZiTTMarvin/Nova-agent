/**
 * run_code 工具测试：绑定解析、呈现模式闸门、curated output 与失败语义。
 * 沙箱用进程内 Code Runtime；嵌套派发用可断言的 stub 验证桥接契约。
 */
import { describe, expect, it } from 'vitest'
import { createRunCodeTool } from '../../../../src/runtime/tools/runCode'
import { resolveCodeModeToolBindings } from '../../../../src/runtime/code-mode/toolBindings'
import { InProcessCodeRuntime } from '../../../../src/runtime/code-mode'
import { ToolAvailability } from '../../../../src/runtime/tools/availability'
import type { ToolContext, NestedToolCallResult } from '../../../../src/runtime/tools/types'

function buildContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: process.cwd(),
    supportsVision: true,
    sessionId: 'session-1',
    mode: 'default',
    invocationRef: {
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'msg-1',
      toolCallId: 'tc_run_code'
    },
    ...overrides
  } as ToolContext
}

type DispatchStub = (input: { toolName: string; args: Record<string, unknown> }) => Promise<NestedToolCallResult>

function createTool(options: {
  presentation?: 'direct' | 'code-readonly'
  availability?: ToolAvailability | null
  dispatch?: DispatchStub
} = {}) {
  const dispatched: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const dispatch: DispatchStub =
    options.dispatch ??
    (async input => {
      dispatched.push(input)
      return {
        toolCallId: `nested-${dispatched.length}`,
        toolName: input.toolName,
        success: true,
        output: `output-of:${input.toolName}`
      }
    })
  const availability = options.availability ?? new ToolAvailability()
  if (!options.availability) {
    availability.bindRegisteredToolNames(['ls', 'read', 'grep', 'find', 'edit', 'bash', 'run_code'])
  }
  const tool = createRunCodeTool({
    getToolAvailability: () => availability,
    getPresentationMode: () => options.presentation ?? 'code-readonly',
    createCodeRuntime: () => new InProcessCodeRuntime()
  })
  const context = buildContext({
    dispatchNestedToolCall: dispatch
  })
  return { tool, context, dispatched, dispatch }
}

describe('run_code 工具', () => {
  it('成功路径：嵌套调用经派发口执行，curated output 只含 console 与 return', async () => {
    const { tool, context, dispatched } = createTool()
    const result = await tool.execute(
      {
        code: `
          console.log('exploring')
          const r = await tools.read({ path: 'a.ts' })
          return { found: r.output }
        `,
        description: '读取 a.ts'
      },
      context
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('[console]')
    expect(result.output).toContain('exploring')
    expect(result.output).toContain('[return]')
    expect(result.output).toContain('output-of:read')
    expect(dispatched).toEqual([{ toolName: 'read', args: { path: 'a.ts' } }])
  })

  it('direct 呈现模式下拒绝执行', async () => {
    const { tool, context } = createTool({ presentation: 'direct' })
    const result = await tool.execute({ code: 'return 1', description: 'x' }, context)
    expect(result.success).toBe(false)
    expect(result.error).toContain('code-readonly')
  })

  it('缺少 durable 调用身份或派发入口时 fail closed', async () => {
    const noRef = createTool()
    const refMissing = await noRef.tool.execute({ code: 'return 1', description: 'x' }, {
      ...noRef.context,
      invocationRef: undefined
    })
    expect(refMissing.success).toBe(false)
    expect(refMissing.error).toContain('durable')

    const noDispatch = createTool()
    const dispatchMissing = await noDispatch.tool.execute({ code: 'return 1', description: 'x' }, {
      ...noDispatch.context,
      dispatchNestedToolCall: undefined
    })
    expect(dispatchMissing.success).toBe(false)
    expect(dispatchMissing.error).toContain('统一执行流水线')
  })

  it('语法错误映射为 parse_error 且文案可自我修正', async () => {
    const { tool, context } = createTool()
    const result = await tool.execute({ code: 'const a = {', description: 'x' }, context)
    expect(result.success).toBe(false)
    expect(result.error).toContain('语法错误')
  })

  it('嵌套工具失败以 tool_failure 暴露工具名与原因', async () => {
    const { tool, context } = createTool({
      dispatch: async input => ({
        toolCallId: 'nested-1',
        toolName: input.toolName,
        success: false,
        output: '',
        error: '权限拒绝: 目录不可读'
      })
    })
    const result = await tool.execute(
      { code: 'await tools.grep({ pattern: "x" })', description: 'x' },
      context
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('工具调用失败')
    expect(result.error).toContain('grep')
    expect(result.error).toContain('权限拒绝')
  })

  it('代码可捕获嵌套失败并返回处理结果', async () => {
    const { tool, context } = createTool({
      dispatch: async input => ({
        toolCallId: 'n',
        toolName: input.toolName,
        success: false,
        output: '',
        error: 'no match'
      })
    })
    const result = await tool.execute(
      {
        code: `
          try {
            await tools.find({ pattern: '*.spec.ts' })
            return 'unexpected'
          } catch (e) {
            return { recovered: true, tool: e.toolName }
          }
        `,
        description: 'x'
      },
      context
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('"recovered": true')
    expect(result.output).toContain('"tool": "find"')
  })

  it('无输出时给出明确指引而不是空结果', async () => {
    const { tool, context } = createTool()
    const result = await tool.execute({ code: 'const a = 1', description: 'x' }, context)
    expect(result.success).toBe(true)
    expect(result.output).toContain('未产生输出')
  })

  it('curated output 合计受 maxModelOutputBytes 封顶', async () => {
    const { tool, context } = createTool({
      dispatch: async input => ({
        toolCallId: 'n',
        toolName: input.toolName,
        success: true,
        output: `${input.toolName}:${'x'.repeat(500)}`
      })
    })
    const result = await tool.execute(
      { code: `const r = await tools.read({ path: 'big' }); return r.output.repeat(200)`, description: 'x' },
      context
    )
    expect(result.success).toBe(true)
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 256)
  })
})

describe('resolveCodeModeToolBindings', () => {
  it('绑定 = nestable-readonly ∩ 激活集，按 Catalog 顺序稳定输出', () => {
    const bindings = resolveCodeModeToolBindings(
      'default',
      new Set(['ls', 'read', 'grep', 'find', 'code_context', 'edit', 'bash'])
    )
    expect(bindings).toEqual(['ls', 'read', 'grep', 'find', 'code_context'])
  })

  it('未激活的工具不进入 SDK（即使 Catalog 允许嵌套）', () => {
    const bindings = resolveCodeModeToolBindings('default', new Set(['ls', 'grep']))
    expect(bindings).toEqual(['ls', 'grep'])
  })

  it('direct-only 工具永不进入绑定', () => {
    const bindings = resolveCodeModeToolBindings('default', new Set(['ls', 'read', 'edit', 'bash', 'task', 'load_tools']))
    expect(bindings).toEqual(['ls', 'read'])
  })
})
