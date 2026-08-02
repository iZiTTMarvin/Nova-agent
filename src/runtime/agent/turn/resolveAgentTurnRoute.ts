/**
 * resolveAgentTurnRoute — Turn 路由唯一真源。
 * 在创建 durable run 前确定实际执行类型，消除 session mode 代替执行类型的错位。
 * 纯函数：不执行 runner、不产生副作用、不修改状态，只根据输入分类意图。
 */
import type { ContentBlock } from '../../model/types'
import type { Mode } from '../../../shared/session/types'
import type { RunKind } from '../../../shared/run/types'
import type { SkillRegistry } from '../../skills/SkillRegistry'
import type { SkillDispatchResult, SkillManifest } from '../../skills/types'
import { invokeSkill } from '../../skills/invokeSkill'

/**
 * agent 路径允许的 dispatch 子类型。
 * 从 SkillDispatchResult 派生，避免手工复制形成平行类型。
 */
export type AgentDispatch = Extract<
  SkillDispatchResult,
  { kind: 'passthrough' | 'inject' | 'system_notice' }
>

/** 已解析的 Turn 路由（不可变事实，只负责分类） */
export type AgentTurnRoute =
  | { kind: 'agent'; dispatch: AgentDispatch }
  | { kind: 'skill_fork'; skill: SkillManifest; args: string }

export interface ResolveTurnRouteInput {
  content: string | ContentBlock[]
  mode: Mode
  skillRegistry: SkillRegistry | null
  workspacePath?: string
}

/**
 * 解析本轮的实际执行路由。
 * 复用 invokeSkill 做 slash 解析；编排意图由模型通过 start_workflow 工具表达。
 * 执行能力（runner 是否装配）由 AgentLoop 在副作用前校验，不在此处镜像。
 */
export function resolveAgentTurnRoute(input: ResolveTurnRouteInput): AgentTurnRoute {
  const {
    content,
    mode,
    skillRegistry,
    workspacePath
  } = input

  // ContentBlock[]（含图片）始终走 agent
  if (typeof content !== 'string') {
    return { kind: 'agent', dispatch: { kind: 'passthrough' } }
  }

  if (!skillRegistry) {
    return { kind: 'agent', dispatch: { kind: 'passthrough' } }
  }

  const dispatch = invokeSkill({
    input: content,
    registry: skillRegistry,
    profile: mode,
    templateContext: { workspacePath }
  })

  // fork
  if (dispatch.kind === 'fork') {
    return { kind: 'skill_fork', skill: dispatch.skill, args: dispatch.args }
  }

  // inject / system_notice / passthrough → agent
  return { kind: 'agent', dispatch }
}

/** route → durable run kind 的唯一映射 */
export function routeRunKind(_route: AgentTurnRoute): Extract<RunKind, 'agent'> {
  return 'agent'
}

/** 内部 Agent（task/fork 等）的默认路由 */
export function agentRoute(
  dispatch: AgentDispatch = { kind: 'passthrough' }
): AgentTurnRoute {
  return { kind: 'agent', dispatch }
}
