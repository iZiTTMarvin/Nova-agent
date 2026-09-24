/**
 * memory_manage — 由主 Agent 自主维护跨会话长期记忆。
 *
 * 设计原则：
 * - 写入应当稀少；大多数 turn 不需要调用。
 * - 模型负责判断「值不值得记」，本工具只负责证据校验、隐私过滤与确定性落库。
 * - 不直接写 repository，统一走 MemoryCandidateProcessor，复用去重 / 合并 / 替换 / 撤回策略。
 * - 只允许当前 primary session 的 user / 非 memory 工具结果作为证据，阻断自我引用。
 */
import { computeWorkspaceHash } from '../../memory/MemoryPaths'
import { MEMORY_TOOL_NAMES } from '../../memory/memoryTools'
import {
  MEMORY_CANDIDATE_CONTENT_MAX_CHARS,
  MEMORY_EVIDENCE_EXCERPT_MAX_CHARS,
  MEMORY_EVIDENCE_EXCERPT_MIN_CHARS,
  MEMORY_KEY_MAX_CHARS
} from '../../memory/memoryConfig'
import { filterPrivacyText } from '../../memory/PrivacyFilter'
import type { MemoryCandidateProcessor } from '../../memory/policy/MemoryCandidateProcessor'
import {
  MEMORY_KINDS,
  type MemoryCandidate,
  type MemoryCandidateEvidence,
  type MemoryKind,
  type ScopeHint
} from '../../memory/types'
import type { NovaSettings } from '../../settings/novaSettings'
import { extractTextFromSerializableContent } from '../../sessions/types'
import type { SessionMessage } from '../../sessions/types'
import { getSessionActiveMessages } from '../../sessions/tree'
import {
  assertSideEffectAllowed,
  type ToolContext,
  type ToolExecutor,
  type ToolResult
} from '../types'

const TOOL_NAME = 'memory_manage'
/**
 * 结果由环境产生、可作为 workspace_verified 强证据的工具。
 * 只收读取/搜索与真实执行的命令类：write/edit 的结果回显模型自己写的内容，
 * 属于自供证据，只能算 observed；bash/shell_session 保留是因为测试、构建等
 * 命令输出是「经验证结论」的主要来源。
 */
const WORKSPACE_EVIDENCE_TOOLS = new Set([
  'ls',
  'read',
  'grep',
  'find',
  'bash',
  'shell_session',
  'code_context',
  'archive_read',
  'history_read'
])

const TOOL_DESCRIPTION = `Maintain cross-session long-term memory. Call only when the current task has confirmed information that still matters to future sessions and cannot be cheaply re-derived from code; most turns should not write memory.

Worth saving:
- Preferences or constraints the user explicitly asked to keep long-term
- Confirmed important architecture decisions and their reasons
- Non-obvious bug root causes or pitfall lessons verified by code / tests / tool results
- Project conventions future tasks are likely to get wrong repeatedly but that cannot be cheaply re-derived

Do not save:
- One-off state such as current progress, which files changed, tests just passed
- Ordinary code facts that read/grep can trivially re-derive
- Unverified guesses, plans, temporary errors
- Secrets, credentials, or other sensitive information

remember: add or update. New facts under the same key are merged/replaced by the memory policy; when the identity is uncertain, run memory_search first.
forget: retract old memory. Prefer the same key and content as the old memory; when uncertain, run memory_search first.
The evidence excerpt must be verbatim from user messages or tool results in the current active session. memory_search / memory_manage results cannot serve as evidence for new memories.`

export interface MemoryManageToolDeps {
  getMemoryCandidateProcessor: () => Promise<Pick<MemoryCandidateProcessor, 'process'> | null>
  loadSettings: () => NovaSettings
}

type MemoryManageAction = 'remember' | 'forget'
type EvidenceType = 'user_message' | 'tool_result'

interface ParsedArgs {
  action: MemoryManageAction
  kind: MemoryKind
  scope: ScopeHint
  memoryKey: string | null
  content: string
  evidenceType: EvidenceType
  evidenceExcerpt: string
}

interface EvidenceMatch {
  type: EvidenceType
  messageId: string
  excerpt: string
  toolName?: string
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeMemoryKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().slice(0, MEMORY_KEY_MAX_CHARS)
  return normalized || null
}

function parseArgs(args: Record<string, unknown>): ParsedArgs | string {
  const action = args.action
  if (action !== 'remember' && action !== 'forget') {
    return 'action 必须是 remember 或 forget'
  }

  const kind = args.kind
  if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
    return `kind 必须是 ${MEMORY_KINDS.join(' / ')} 之一`
  }

  const scope = args.scope === undefined ? 'project' : args.scope
  if (scope !== 'project' && scope !== 'global') {
    return 'scope 必须是 project 或 global'
  }

  const rawContent = typeof args.content === 'string' ? args.content.trim() : ''
  if (!rawContent) return 'content 参数不能为空'
  const contentFiltered = filterPrivacyText(rawContent, {
    maxOutputChars: MEMORY_CANDIDATE_CONTENT_MAX_CHARS
  })
  if (contentFiltered.shouldDiscard || contentFiltered.hadSensitive || !contentFiltered.text.trim()) {
    return 'content 含敏感信息或无法安全保存，已拒绝写入记忆'
  }

  const evidence = args.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return 'evidence 参数不能为空'
  }
  const evidenceRecord = evidence as Record<string, unknown>
  const evidenceType = evidenceRecord.type
  if (evidenceType !== 'user_message' && evidenceType !== 'tool_result') {
    return 'evidence.type 必须是 user_message 或 tool_result'
  }
  const rawExcerpt = typeof evidenceRecord.excerpt === 'string' ? evidenceRecord.excerpt.trim() : ''
  if (!rawExcerpt) return 'evidence.excerpt 参数不能为空'
  const evidenceFiltered = filterPrivacyText(rawExcerpt)
  if (evidenceFiltered.shouldDiscard || evidenceFiltered.hadSensitive || !evidenceFiltered.text.trim()) {
    return 'evidence.excerpt 含敏感信息或无法安全保存，已拒绝写入记忆'
  }
  // 过短摘录几乎能挂靠任意消息，不构成有效证据
  if (normalizeForMatch(evidenceFiltered.text).length < MEMORY_EVIDENCE_EXCERPT_MIN_CHARS) {
    return `证据摘录过短，请复制一段有实际信息量的原文（至少 ${MEMORY_EVIDENCE_EXCERPT_MIN_CHARS} 个字符）`
  }

  return {
    action,
    kind: kind as MemoryKind,
    scope: scope as ScopeHint,
    memoryKey: normalizeMemoryKey(args.key),
    content: contentFiltered.text.trim(),
    evidenceType,
    evidenceExcerpt: evidenceFiltered.text.trim()
  }
}

/**
 * 只在当前 active branch 中找证据；模型不能拿旧分支、assistant 自述或 memory 工具结果给自己背书。
 */
export function findMemoryEvidence(
  messages: readonly SessionMessage[],
  type: EvidenceType,
  excerpt: string
): EvidenceMatch | null {
  const needle = normalizeForMatch(excerpt)
  if (!needle) return null

  if (type === 'user_message') {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.role !== 'user') continue
      const text = normalizeForMatch(extractTextFromSerializableContent(message.content))
      if (text.includes(needle)) {
        return { type, messageId: message.id, excerpt }
      }
    }
    return null
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (let j = message.toolCalls.length - 1; j >= 0; j--) {
      const call = message.toolCalls[j]!
      if (MEMORY_TOOL_NAMES.has(call.name) || typeof call.result !== 'string') continue
      const result = normalizeForMatch(call.result)
      if (result.includes(needle)) {
        return { type, messageId: message.id, excerpt, toolName: call.name }
      }
    }
  }
  return null
}

function buildCandidate(parsed: ParsedArgs, match: EvidenceMatch): MemoryCandidate {
  const strongWorkspaceEvidence =
    match.type === 'tool_result' &&
    Boolean(match.toolName && WORKSPACE_EVIDENCE_TOOLS.has(match.toolName))

  const evidence: MemoryCandidateEvidence = {
    type: match.type,
    excerpt: match.excerpt.slice(0, MEMORY_EVIDENCE_EXCERPT_MAX_CHARS),
    messageId: match.messageId
  }

  return {
    kind: parsed.kind,
    scopeHint: parsed.scope,
    memoryKey: parsed.memoryKey,
    content: parsed.content,
    explicitness:
      match.type === 'user_message'
        ? 'user_explicit'
        : strongWorkspaceEvidence
          ? 'workspace_verified'
          : 'observed',
    confidence:
      match.type === 'user_message'
        ? 1
        : strongWorkspaceEvidence
          ? 0.95
          : 0.75,
    intent: parsed.action === 'forget' ? 'negate' : 'assert',
    evidence: [evidence]
  }
}

function formatResult(action: MemoryManageAction, counts: ReturnType<MemoryCandidateProcessor['process']>): string {
  if (counts.failed > 0) {
    return '记忆处理失败，未可靠写入。不要反复重试；继续当前任务即可。'
  }
  if (action === 'forget') {
    return counts.retracted > 0 || counts.superseded > 0
      ? '长期记忆已撤回或更新。'
      : '没有找到需要撤回的长期记忆；不要重复调用。'
  }
  if (counts.added > 0 || counts.merged > 0 || counts.superseded > 0 || counts.promoted > 0) {
    return '长期记忆已记录或更新。'
  }
  return '没有产生新的长期记忆变更；现有记忆已足够或该候选未达到持久化条件。不要重复写入。'
}

export function createMemoryManageTool(deps: MemoryManageToolDeps): ToolExecutor {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'forget'],
          description: 'remember=add/update long-term memory; forget=retract old memory.'
        },
        kind: {
          type: 'string',
          enum: [...MEMORY_KINDS],
          description: 'Memory kind. Pick the kind closest to the fact\'s semantics.'
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Defaults to project. Use global only for user preferences / ways of working that hold across projects.'
        },
        key: {
          type: 'string',
          description: 'Optional stable key. Recommended for decisions/constraints that can change, e.g. context.compaction.placeholder.'
        },
        content: {
          type: 'string',
          description: 'The distilled fact to keep or retract. Do not stuff execution logs, whole tool outputs, or guesses.'
        },
        evidence: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['user_message', 'tool_result'],
              description: 'Whether the fact comes from an explicit user message or from this session\'s tool results.'
            },
            excerpt: {
              type: 'string',
              description: 'A short piece of evidence that can be found verbatim in the current active session. Do not paraphrase.'
            }
          },
          required: ['type', 'excerpt'],
          additionalProperties: false
        }
      },
      required: ['action', 'kind', 'content', 'evidence'],
      additionalProperties: false
    },
    executionMode: 'sequential',

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const settings = deps.loadSettings()
      if (!settings.memoryEnabled) {
        return { success: false, output: '', error: '记忆系统未启用' }
      }

      const parsed = parseArgs(args)
      if (typeof parsed === 'string') {
        return { success: false, output: '', error: parsed }
      }

      const sessionId = context.sessionId?.trim()
      const workspaceRoot = context.workingDir?.trim()
      const sessionStore = context.sessionStore
      if (!sessionId || !workspaceRoot || !sessionStore) {
        return { success: false, output: '', error: '当前缺少可验证的主会话上下文，拒绝写入长期记忆' }
      }

      const session = sessionStore.load(sessionId)
      if (!session) {
        return { success: false, output: '', error: '当前会话不存在，拒绝写入长期记忆' }
      }
      if (session.kind !== 'primary') {
        return { success: false, output: '', error: '子代理不能直接写长期记忆；请把结论交回主 Agent 判断' }
      }

      const activeMessages = getSessionActiveMessages(session)
      const match = findMemoryEvidence(activeMessages, parsed.evidenceType, parsed.evidenceExcerpt)
      if (!match) {
        return {
          success: false,
          output: '',
          error: '找不到对应原始证据。请复制当前用户消息或工具结果中的短原文，不要用总结/猜测作为证据。'
        }
      }

      const processor = await deps.getMemoryCandidateProcessor()
      if (!processor) {
        return { success: false, output: '', error: '记忆服务暂不可用，请继续当前任务，不要反复重试' }
      }

      try {
        assertSideEffectAllowed(context, 'memory_manage')
        const counts = processor.process({
          sessionId,
          projectScopeId: computeWorkspaceHash(workspaceRoot),
          workspaceRoot,
          candidates: [buildCandidate(parsed, match)]
        })
        return { success: true, output: formatResult(parsed.action, counts) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, output: '', error: `记忆写入失败：${message}` }
      }
    }
  }
}
