/**
 * XForge 兼容路由（现有运行路径）— 轻量 LLM 意图分类
 *
 * 将 compose 模式下的自然语言输入分为 quick / plan / full 三档，never-throw。
 * 这是当前仍在使用的旧入口实现；产品目标是 BuildRail 阶段自适应顺序工作流
 * （见 docs/todo/XForge实施方案.md），不得把三档路由当作最终产品定义。
 */
import type { ModelClient } from '../model/ModelClient'
import type { ChatMessage } from '../model/types'
import { extractJson } from '../workflow/jsonExtract'

/** 路由档位 */
export type ComposeRoute = 'quick' | 'plan' | 'full'

export interface ComposeRouteResult {
  route: ComposeRoute
  reason: string
}

/** router 超时上限（毫秒），超时降级为 quick */
const ROUTER_TIMEOUT_MS = 8000

const ROUTER_SYSTEM_PROMPT = `你是 XForge 编排模式的意图分类器。根据用户输入判断应走哪条路径，只返回严格 JSON，格式：
{"route":"quick|plan|full","reason":"一句话理由"}

三档判定标准：

quick：单点改动、答疑、解释、查代码、对话澄清。
  示例：改个文案、这段代码什么意思、把按钮颜色改成蓝色、这个报错怎么修、不对换个思路。
  特征：一次响应即可解决，无需流程化协作。

plan：设计、调研、规划、构思、可行性分析。用户想先想清楚，不马上写代码。
  示例：我想做一个商城帮我分析下、调研 XX 技术方案、帮我设计登录模块的架构、有个想法帮我理一理。
  特征：需要产出结构化方案文档，当下不执行代码改动。

full：明确的开发需求，动词驱动 + 清晰对象，值得走完整开发流程。
  示例：实现登录功能、开发支付模块、重构认证系统并加测试、从零搭建用户管理。
  特征：需求够明确，要走 实现→验证→审查→发布 完整 TDD 流程。

只输出 JSON，不要其他文字。`

function isValidRoute(value: unknown): value is ComposeRoute {
  return value === 'quick' || value === 'plan' || value === 'full'
}

function buildRouterMessages(input: string): ChatMessage[] {
  return [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    { role: 'user', content: `用户输入：\n${input}` }
  ]
}

/** 收集模型流式输出并解析路由结果 */
async function runRouterCore(
  input: string,
  modelClient: ModelClient,
  abortSignal?: AbortSignal
): Promise<ComposeRouteResult> {
  let accumulated = ''

  for await (const ev of modelClient.chat(buildRouterMessages(input), undefined, { abortSignal })) {
    if (ev.type === 'text_delta') {
      accumulated += ev.delta
    } else if (ev.type === 'error' || ev.type === 'cancelled') {
      return { route: 'quick', reason: 'router 调用失败降级' }
    }
  }

  const parsed = extractJson(accumulated)
  if (!parsed || typeof parsed !== 'object') {
    return { route: 'quick', reason: 'router JSON 解析失败降级' }
  }

  const record = parsed as Record<string, unknown>
  if (!isValidRoute(record.route)) {
    return { route: 'quick', reason: 'router 路由值非法降级' }
  }

  const reason = typeof record.reason === 'string' && record.reason.trim()
    ? record.reason.trim()
    : '分类完成'

  return { route: record.route, reason }
}

/**
 * 对用户输入做 compose 模式意图分类。
 * 任何失败（异常、超时、模型 error）均降级为 quick，不抛错。
 */
export async function routeComposeInput(
  input: string,
  modelClient: ModelClient,
  opts?: { abortSignal?: AbortSignal }
): Promise<ComposeRouteResult> {
  try {
    const timeoutResult: ComposeRouteResult = { route: 'quick', reason: 'router 超时降级' }
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<ComposeRouteResult>((resolve) => {
      timeoutId = setTimeout(() => resolve(timeoutResult), ROUTER_TIMEOUT_MS)
    })

    const corePromise = runRouterCore(input, modelClient, opts?.abortSignal).finally(() => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    })

    return await Promise.race([corePromise, timeoutPromise])
  } catch {
    return { route: 'quick', reason: 'router 异常降级' }
  }
}
