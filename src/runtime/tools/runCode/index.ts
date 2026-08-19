/**
 * run_code 工具：模型提交一段受限 JS，在 Code Runtime 沙箱中连续编排只读探索工具。
 * 嵌套调用经 ToolContext.dispatchNestedToolCall 重入统一执行流水线（权限/可用性/
 * 取消/截断全部生效）；中间结果留在沙箱内，只有 console 输出与 return 值作为
 * curated output 进入主上下文。仅在 code-readonly 呈现模式下可用。
 */
import type { ToolContext, ToolExecutor, ToolResult, NestedToolCallResult } from '../types'
import type { ToolAvailability } from '../availability'
import type {
  CodeRuntime,
  CodeRuntimeLimits,
  CodeRuntimeToolCallResolution,
  ToolPresentationMode
} from '../../code-mode'
import {
  DEFAULT_CODE_MODE_LIMITS,
  formatRunCodeFailure,
  resolveCodeModeToolBindings,
  truncateToByteBudget
} from '../../code-mode'

export interface RunCodeToolDeps {
  /** 工具可用性 Owner；绑定解析与嵌套执行闸门共用同一激活口径 */
  readonly getToolAvailability: () => ToolAvailability | null
  /** 当前呈现模式；direct 模式下 run_code 不进模型可见面，幻觉调用在此拒绝 */
  readonly getPresentationMode: () => ToolPresentationMode
  /** 沙箱执行环境；生命周期由工厂方持有（共享 worker 或进程内），调用方不负责释放 */
  readonly createCodeRuntime: () => CodeRuntime
}

export function createRunCodeTool(deps: RunCodeToolDeps): ToolExecutor {
  return {
    name: 'run_code',
    description: [
      '在受限沙箱中执行一段 JavaScript，连续编排只读探索工具（tools.ls / tools.read / tools.grep / tools.find）。',
      '适合需要多轮 检索→阅读→再检索 交替的代码探索：中间结果留在沙箱内，只有 console.log 输出与 return 值会返回给你。',
      '- 代码是顶层 async 函数体：可直接使用 await 与 return；沙箱内没有定时器（setTimeout 等不可用），只有 tools.* 调用可以等待。',
      "- 工具调用形如 `const r = await tools.read({ path: 'src/a.ts' })`；成功 resolve `{ output: string }`，失败 throw ToolCallError（含 toolName 与 message，可 try/catch 后调整参数重试）。",
      '- 支持 Promise.all 并发调用；单次执行有调用次数、时长与大小上限，超限会返回明确原因。',
      '- 请在代码中筛选、加工出与任务相关的最小结果再 return；原样返回大文件会占用上下文。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要执行的 JavaScript 代码（顶层 async 函数体，可 await 与 return）'
        },
        description: {
          type: 'string',
          description: '一句话说明这段代码要探索什么（用于展示与诊断）'
        }
      },
      required: ['code', 'description']
    },
    executionMode: 'sequential',
    maxResultSizeChars: 128 * 1024,
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const code = typeof args.code === 'string' ? args.code : ''
      if (code.trim().length === 0) {
        return failure('code 不能为空')
      }
      if (deps.getPresentationMode() !== 'code-readonly') {
        return failure('run_code 仅在 code-readonly 实验模式下可用，当前会话为 direct 模式')
      }
      const invocationRef = context.invocationRef
      if (!invocationRef) {
        return failure('run_code 工具缺少完整 durable 调用身份')
      }
      const dispatch = context.dispatchNestedToolCall
      if (!dispatch) {
        return failure('run_code 必须经由统一执行流水线调用（缺少嵌套派发入口）')
      }
      const availability = deps.getToolAvailability()
      if (!availability) {
        return failure('工具可用性 Owner 未装配，run_code 拒绝执行')
      }

      const limits: CodeRuntimeLimits = DEFAULT_CODE_MODE_LIMITS
      const bindings = resolveCodeModeToolBindings(
        context.mode ?? 'default',
        new Set(availability.getActiveToolNames())
      )
      const runtime = deps.createCodeRuntime()
      const result = await runtime.execute({
        source: code,
        toolNames: bindings,
        limits,
        signal: context.abortSignal,
        dispatchToolCall: request => bridgeToolCall(request, dispatch)
      })

      const curated = formatCuratedOutput(result.logs, result.valueJson ?? null, limits)
      if (result.status === 'failed') {
        return {
          success: false,
          output: curated,
          error: formatRunCodeFailure(result.kind ?? 'execution_error', result.message ?? '')
        }
      }
      return { success: true, output: curated }
    }
  }
}

/** 沙箱工具调用 → 统一流水线；结果 JSON 化送回沙箱 */
async function bridgeToolCall(
  request: { callId: number; toolName: string; argsJson: string },
  dispatch: (input: { toolName: string; args: Record<string, unknown> }) => Promise<NestedToolCallResult>
): Promise<CodeRuntimeToolCallResolution> {
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(request.argsJson)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, errorMessage: `工具入参必须是对象（收到 ${Array.isArray(parsed) ? '数组' : typeof parsed}）` }
    }
    args = parsed as Record<string, unknown>
  } catch {
    return { ok: false, errorMessage: '工具入参不是合法 JSON 对象' }
  }
  const nested = await dispatch({ toolName: request.toolName, args })
  if (nested.success) {
    return { ok: true, resultJson: JSON.stringify({ output: nested.output }) }
  }
  return { ok: false, errorMessage: nested.error ?? '工具调用失败' }
}

/** curated output：console + return，按 maxModelOutputBytes 合计封顶 */
function formatCuratedOutput(
  logs: readonly string[],
  valueJson: string | null,
  limits: CodeRuntimeLimits
): string {
  const sections: string[] = []
  if (logs.length > 0) {
    sections.push(['[console]', ...logs].join('\n'))
  }
  if (valueJson !== null) {
    sections.push(['[return]', prettyJson(valueJson)].join('\n'))
  }
  if (sections.length === 0) {
    return '（代码未产生输出：请 console.log 或 return 与任务相关的结果）'
  }
  return truncateToByteBudget(
    sections.join('\n\n'),
    limits.maxModelOutputBytes,
    `\n…[输出超过 ${limits.maxModelOutputBytes} 字节已截断，请缩小 return 内容]`
  )
}

function prettyJson(valueJson: string): string {
  try {
    return JSON.stringify(JSON.parse(valueJson), null, 2)
  } catch {
    return valueJson
  }
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}
