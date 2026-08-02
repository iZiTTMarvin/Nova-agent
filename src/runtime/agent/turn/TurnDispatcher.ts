/**
 * TurnDispatcher — 按已解析 route 调用产品执行器（Skill Fork），
 * 或把 agent 路径输入规范化为声明式结果。
 *
 * 边界：只返回数据，不拥有轮次生命周期——不修改 AgentLoop 状态、不写入对话上下文、
 * 不发事件、不操作 checkpoint、不提交 durable run、不解析第二次 route。
 * session prefix / mode instruction / context 写入 / skill root 登记 / 终态收尾
 * 全部由 AgentLoop 根据返回值统一执行。
 */
import { extractTextFromContent, type ContentBlock } from '../../model/types'
import type { SkillManifest } from '../../skills/types'
import type { AgentTurnRoute } from './resolveAgentTurnRoute'

/** skill fork 执行请求：ctx 由 AgentLoop 在分派时提供 durable message 身份。 */
export interface SkillForkExecutionRequest {
  skill: SkillManifest
  args: string
  ctx: {
    workingDir: string
    messageId: string
    abortSignal?: AbortSignal
  }
  templateContext: { workspacePath?: string }
}

/** 产品执行器集合：由宿主（AgentRuntimeFactory / 测试）装配，缺失时对应 route fail closed */
export interface TurnExecutors {
  skillForkRunner?: (
    request: SkillForkExecutionRequest
  ) => Promise<{ success: boolean; summary: string }>
}

/** 分派时由 AgentLoop 提供的本轮执行环境（dispatcher 不持有这些状态） */
export interface TurnDispatchContext {
  messageId: string
  abortSignal?: AbortSignal
  fork: {
    workingDir: string
    workspacePath?: string
  }
}

/**
 * 分派结果（纯数据）：
 * - handled：执行器已完成本轮产品路径，AgentLoop 负责把摘要写入上下文并发事件；
 * - continue：进入 Agent kernel，AgentLoop 负责拼接 session prefix / mode instruction
 *   并写入 AgentContext.messages。
 */
export type TurnDispatchOutcome =
  | { kind: 'handled'; assistantSummary: string }
  | {
      kind: 'continue'
      userContent: string | ContentBlock[]
      userText: string
      assistantPrelude?: string
      grantedSkillRoot?: string
    }

export class TurnDispatcher {
  constructor(private readonly executors: TurnExecutors) {}

  /**
   * 校验已解析 route 是否具备执行能力。
   * 非 agent route 必须已装配对应执行器，否则 fail closed。
   * 仅做能力断言，不产生副作用，可在轮次副作用前安全调用。
   */
  assertRouteExecutable(route: AgentTurnRoute): void {
    switch (route.kind) {
      case 'skill_fork':
        if (!this.executors.skillForkRunner) {
          throw new Error('route 为 skill_fork 但未注入 skillForkRunner')
        }
        break
      case 'agent':
        break
    }
  }

  /**
   * 按 route 穷举分派。执行器抛出的错误原样向上传播，
   * 由 AgentLoop 的统一 finalizer 决定终态。
   */
  async dispatch(
    content: string | ContentBlock[],
    route: AgentTurnRoute,
    ctx: TurnDispatchContext
  ): Promise<TurnDispatchOutcome> {
    switch (route.kind) {
      case 'skill_fork': {
        this.assertRouteExecutable(route)
        const result = await this.executors.skillForkRunner!({
          skill: route.skill,
          args: route.args,
          ctx: {
            workingDir: ctx.fork.workingDir,
            messageId: ctx.messageId,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {})
          },
          templateContext: { workspacePath: ctx.fork.workspacePath }
        })
        return { kind: 'handled', assistantSummary: result.summary }
      }

      case 'agent': {
        const dispatch = route.dispatch
        if (dispatch.kind === 'inject') {
          return {
            kind: 'continue',
            userContent: dispatch.userContent,
            userText: dispatch.userContent,
            assistantPrelude: dispatch.assistantContent,
            ...(dispatch.skillDirectory ? { grantedSkillRoot: dispatch.skillDirectory } : {})
          }
        }
        if (dispatch.kind === 'system_notice') {
          return { kind: 'continue', userContent: dispatch.text, userText: dispatch.text }
        }
        // passthrough：原始输入直接进入 Agent kernel
        return {
          kind: 'continue',
          userContent: content,
          userText: typeof content === 'string' ? content : extractTextFromContent(content)
        }
      }
    }
  }
}
