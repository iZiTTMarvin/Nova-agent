import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { ChatMessage } from '../../model/types'
import { parseJsonObject } from './mainAgentSession'
import type { XForgeMainAgentSession } from './mainAgentSession'
import { validateXForgePlan, type XForgeValidatedPlan } from './plan'
import type { StageResolverInput, XForgeStartStage } from './types'

export interface XForgeRequestResolutionOptions {
  request: string
  explicitFullDev?: boolean
  workspaceRoot: string
  modelClient: ModelClient | ModelClientPool
  abortSignal?: AbortSignal
}

export interface XForgeImportedPlan {
  plan: XForgeValidatedPlan
}

interface ResolverSemanticPayload {
  reviewOnly: boolean
  codeReadyForTest: boolean
  isBugfix: boolean
  isVagueNewRequirement: boolean
  isNonDevRequest: boolean
  modelSemanticHint: 'brainstorm' | 'plan'
}

/** 合并确定性规则与语义分类，得到 stage resolver 输入。 */
export async function resolveXForgeRequestSignals(
  options: Pick<XForgeRequestResolutionOptions, 'request' | 'explicitFullDev' | 'modelClient' | 'abortSignal'>
): Promise<StageResolverInput> {
  const deterministic = classifyXForgeRequest(options.request, options.explicitFullDev === true)
  if (options.explicitFullDev) return deterministic

  try {
    const semantic = await classifyXForgeRequestSemantically(
      stripFullDevCommand(options.request),
      options.modelClient,
      options.abortSignal
    )
    return mergeResolverSignals(deterministic, semantic)
  } catch {
    return {
      ...deterministic,
      modelSemanticHint: 'failed'
    }
  }
}

function mergeResolverSignals(
  deterministic: StageResolverInput,
  semantic: ResolverSemanticPayload
): StageResolverInput {
  const reviewOnly = deterministic.reviewOnly === true || semantic.reviewOnly
  const codeReadyForTest = deterministic.codeReadyForTest === true || semantic.codeReadyForTest
  const isBugfix = (deterministic.isBugfix === true || semantic.isBugfix) && !codeReadyForTest
  const devSignal =
    reviewOnly ||
    codeReadyForTest ||
    isBugfix ||
    deterministic.hasDesignOnlyDoc === true ||
    deterministic.requestedStartStage !== undefined

  return {
    ...deterministic,
    reviewOnly,
    codeReadyForTest,
    isBugfix,
    isVagueNewRequirement:
      deterministic.isVagueNewRequirement === true || semantic.isVagueNewRequirement,
    isNonDevRequest: semantic.isNonDevRequest && !devSignal,
    modelSemanticHint: semantic.modelSemanticHint
  }
}

async function classifyXForgeRequestSemantically(
  input: string,
  modelClient: ModelClient | ModelClientPool,
  abortSignal?: AbortSignal
): Promise<ResolverSemanticPayload> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 XForge 的入口语义分类器。你没有工具，不要请求工具，不要解释。',
        'XForge 只面向代码开发、修复、测试、审查和可执行工程计划。',
        '只返回一个 JSON 对象：{"reviewOnly":boolean,"codeReadyForTest":boolean,"isBugfix":boolean,"isVagueNewRequirement":boolean,"isNonDevRequest":boolean,"modelSemanticHint":"brainstorm|plan"}。',
        'reviewOnly 表示用户要求只看、只审查、解释问题或明确不要动/不要改代码。',
        'isNonDevRequest 只用于普通问答、概念解释或闲聊；代码审查、调试、架构审查和测试请求都不是 non-dev。',
        'modelSemanticHint：需求模糊、目标未定、需要先探索时为 brainstorm；可直接形成工程计划时为 plan。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `用户输入：\n${input}`
    }
  ]
  let output = ''
  for await (const event of modelClient.chat(messages, undefined, { abortSignal })) {
    if (event.type === 'text_delta') output += event.delta
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'context_overflow') throw new Error(event.rawError)
    if (event.type === 'cancelled') throw new Error('resolver semantic classification cancelled')
  }
  const parsed = parseJsonObject(output)
  if (!isResolverSemanticPayload(parsed)) {
    throw new Error('resolver semantic classification returned invalid JSON')
  }
  return parsed
}

/**
 * 读取并规范化用户引用的 plan 文件；只返回解析结果，不写入 run state。
 * 路径必须落在 workspace 内，拒绝越界与不可导入内容。
 */
export async function importReferencedValidatedPlan(
  options: XForgeRequestResolutionOptions,
  session: XForgeMainAgentSession
): Promise<XForgeImportedPlan | null> {
  if (options.explicitFullDev) return null
  const referencedPath = extractReferencedMarkdownPath(options.request)
  if (!referencedPath) return null

  const root = realpathSync(options.workspaceRoot)
  const candidate = resolve(root, referencedPath)
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  if (!existsSync(candidate)) return null
  const target = realpathSync(candidate)
  if (target !== root && !target.startsWith(root + sep)) return null
  const stats = statSync(target)
  if (!stats.isFile() || stats.size > 512 * 1024) return null
  const markdown = readFileSync(target, 'utf8')
  if (!looksLikeImportablePlan(markdown)) return null

  const payload = await session.runJson<XForgeImportedPlan>([
    '把用户引用的实施计划规范化为 XForge Validated Plan。只能抽取文档已经明确写出的事实，不得补写或猜测缺失内容。',
    '只返回紧凑 JSON：{"plan":{"version":1,"goal":"...","constraints":["..."],"nonGoals":["..."],"repositoryFacts":["..."],"changeScope":["..."],"tasks":[{"id":"T1","title":"...","acceptance":["..."]}],"acceptanceMap":{"T1":["..."]},"verificationChecklist":["`npm ...`"],"risks":["..."]}}。不要返回 Markdown；verificationChecklist 只能保留文档明确给出的安全命令，没有命令时返回空数组。',
    `引用路径：${referencedPath}`,
    markdown
  ].join('\n\n'), isImportedPlanPayload)
  const validation = validateXForgePlan(payload.plan)
  return validation.valid ? payload : null
}

/** 从用户输入提取 workspace-relative markdown 路径；不存在则返回 null。 */
export function extractReferencedMarkdownPath(input: string): string | null {
  const match = input.match(/`([^`]+\.md)`|"([^"]+\.md)"|'([^']+\.md)'|([A-Za-z0-9_./\\-]+\.md)\b/i)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null)?.trim() ?? null
}

export function looksLikeImportablePlan(markdown: string): boolean {
  const hasTasks = /(?:^|\n)\s*(?:-\s*\[[ xX]\]|\d+[.)])\s+\S/m.test(markdown)
  const hasAcceptance = /(验收|acceptance|完成条件|definition of done)/i.test(markdown)
  const hasScope = /(变更范围|change scope|涉及文件|修改文件|模块)/i.test(markdown)
  const hasRisk = /(风险|risk|回退|rollback)/i.test(markdown)
  return hasTasks && hasAcceptance && hasScope && hasRisk
}

export function classifyXForgeRequest(
  input: string,
  explicitFullDev = false
): StageResolverInput {
  const text = stripFullDevCommand(input)
  if (explicitFullDev) return { isVagueNewRequirement: true, requestedStartStage: 'brainstorm' }
  const reviewOnly =
    /(只|仅).{0,8}(审查|review|检查|看看)|不要(改|动|修改)(代码|文件)?|禁止修改|别(改|动)(代码|文件)?/i.test(text)
  const codeReadyForTest = /(已经|已).{0,10}(改好|完成|实现).{0,12}(测试|检查|验证)|从测试开始/i.test(text)
  const isBugfix = /(修复|bug|报错|故障|崩溃|异常|卡顿|很卡|加载慢|加载.*卡|性能问题)/i.test(text) && !codeReadyForTest
  const hasDesignOnlyDoc = /(?:\.md\b|设计文档|方案文档|需求文档)/i.test(text)
  const requestedStartStage = parseRequestedStage(text)
  const vague = /(还没想清楚|不确定|想做|我想|我打算|帮我想|探索一下|需求模糊|你觉得|有什么建议|怎么看)/i.test(text)
  return {
    reviewOnly,
    codeReadyForTest,
    isBugfix,
    hasDesignOnlyDoc,
    isVagueNewRequirement: vague,
    ...(requestedStartStage ? { requestedStartStage } : {})
  }
}

function parseRequestedStage(text: string): XForgeStartStage | undefined {
  if (/从(需求探索|brainstorm)开始/i.test(text)) return 'brainstorm'
  if (/从(计划|plan)开始/i.test(text)) return 'plan'
  if (/从(scope|范围审查)开始/i.test(text)) return 'scope_check'
  if (/从(实现|开发|implement)开始/i.test(text)) return 'implement'
  if (/从(测试|test)开始/i.test(text)) return 'test'
  if (/从(审查|review)开始/i.test(text)) return 'review'
  return undefined
}

export function stripFullDevCommand(input: string): string {
  return input.replace(/^\s*\/br-full-dev\b\s*/i, '').trim()
}

function isResolverSemanticPayload(value: unknown): value is ResolverSemanticPayload {
  return isRecord(value) &&
    typeof value.reviewOnly === 'boolean' &&
    typeof value.codeReadyForTest === 'boolean' &&
    typeof value.isBugfix === 'boolean' &&
    typeof value.isVagueNewRequirement === 'boolean' &&
    typeof value.isNonDevRequest === 'boolean' &&
    (value.modelSemanticHint === 'brainstorm' || value.modelSemanticHint === 'plan')
}

function isImportedPlanPayload(value: unknown): value is XForgeImportedPlan {
  return isRecord(value) && isRecord(value.plan)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
