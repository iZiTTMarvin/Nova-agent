import {
  CODE_CONTEXT_LIMITS,
  CodeContextInputError,
  RankingPolicy,
  createEmptyCodeContextPack,
  serializeCodeContextPack,
  type CodeContextPack,
  type CodeContextQueryPort,
  type CodeContextRequestedIntent
} from '../../code-graph/context'
import { OutputSink } from '../OutputSink'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

export const CODE_CONTEXT_TOOL_DESCRIPTION = [
  '查询当前工作区的本地代码索引，返回定义、关系证据与建议阅读范围。',
  '用 locate 定位符号，understand 建立局部上下文，impact 查找修改前应检查的影响候选。',
  '关系是可追溯候选，不代表已证明完整调用链或影响范围；按 recommendedReads 继续用 read 确认源码。'
].join('\n')

export interface CodeContextToolDeps {
  readonly getQueryPort: () => CodeContextQueryPort | null
}

const inputPolicy = new RankingPolicy()

export function createCodeContextTool(deps: CodeContextToolDeps): ToolExecutor {
  return {
    name: 'code_context',
    description: CODE_CONTEXT_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要定位的符号、模块、路径或代码概念。'
        },
        intent: {
          type: 'string',
          enum: ['locate', 'understand', 'impact'],
          description: '查询意图；默认 locate。'
        },
        scope: {
          type: 'string',
          description: '可选的工作区相对目录或文件范围。'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseArgs(args)
      if (!parsed.ok) return failure(parsed.error)
      if (context.abortSignal?.aborted) return failure('代码上下文查询已取消')

      const port = deps.getQueryPort()
      if (port === null) {
        return finalizePack(
          unavailablePack(parsed.intent, '代码索引查询端尚未就绪；请继续使用 grep/read'),
          context
        )
      }

      try {
        const pack = await port.query({
          query: parsed.query,
          intent: parsed.intent,
          ...(parsed.scope === null ? {} : { scope: parsed.scope }),
          ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
        })
        if (context.abortSignal?.aborted) return failure('代码上下文查询已取消')
        return finalizePack(pack, context)
      } catch (error) {
        if (error instanceof CodeContextInputError) return failure(error.message)
        if (isAbortError(error) || context.abortSignal?.aborted) {
          return failure('代码上下文查询已取消')
        }
        return finalizePack(
          unavailablePack(parsed.intent, '代码索引当前不可用；请改用 grep/read'),
          context
        )
      }
    }
  }
}

type ParsedArgs =
  | {
      readonly ok: true
      readonly query: string
      readonly intent: CodeContextRequestedIntent
      readonly scope: string | null
    }
  | { readonly ok: false; readonly error: string }

function parseArgs(args: Record<string, unknown>): ParsedArgs {
  if (typeof args.query !== 'string') return { ok: false, error: '缺少 query 参数' }
  const intent = parseIntent(args.intent)
  if (intent === null) {
    return { ok: false, error: 'intent 必须是 locate / understand / impact' }
  }
  if (args.scope !== undefined && typeof args.scope !== 'string') {
    return { ok: false, error: 'scope 必须是工作区相对路径' }
  }
  try {
    const query = inputPolicy.normalizeQuery(args.query).original
    const scope = inputPolicy.normalizeScope(args.scope)
    return { ok: true, query, intent, scope }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '代码上下文查询参数无效'
    }
  }
}

function parseIntent(value: unknown): CodeContextRequestedIntent | null {
  if (value === undefined) return 'locate'
  // flow 不进入公开 schema；显式拒绝幻觉调用，避免被静默降级成其他意图。
  if (value === 'locate' || value === 'understand' || value === 'impact' || value === 'flow') {
    return value
  }
  return null
}

function unavailablePack(intent: CodeContextRequestedIntent, reason: string) {
  const summary = intent === 'flow'
    ? 'unavailable · flow · 当前版本不提供多跳代码流；建议改用 impact 或 grep'
    : `unavailable · ${intent} · ${reason}`
  return createEmptyCodeContextPack({
    status: 'unavailable',
    intent,
    summary,
    warnings: [
      intent === 'flow'
        ? 'flow 当前不可用；请改用 impact，跨层通道可继续用 grep 定位'
        : reason
    ]
  })
}

async function finalizePack(
  pack: CodeContextPack,
  context: ToolContext
): Promise<ToolResult> {
  if (!context.artifactStore || !context.sessionId) {
    return failure('代码上下文工具缺少 OutputSink 会话边界')
  }
  const sink = new OutputSink({
    artifactStore: context.artifactStore,
    sessionId: context.sessionId,
    toolName: 'code_context',
    maxContextBytes: CODE_CONTEXT_LIMITS.hardBytes
  })
  const finalized = await sink.finalize(serializeCodeContextPack(pack))
  return {
    success: true,
    output: finalized.contextText,
    ...(finalized.artifactId ? { artifactId: finalized.artifactId } : {}),
    ...(finalized.truncationMeta?.truncated
      ? { truncationMeta: finalized.truncationMeta }
      : {})
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}
