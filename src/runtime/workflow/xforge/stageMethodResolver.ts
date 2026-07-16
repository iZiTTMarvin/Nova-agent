import type { SkillManifest } from '../../skills/types'
import type { XForgeExplorationMethod } from './stageExecutor'
import { getXForgeStageBinding } from './stageBinding'
import type { XForgeStage } from './types'

export interface XForgeStageMethodRegistry {
  get(name: string): SkillManifest | undefined
}

export type XForgeStageMethodResolution =
  | {
      ok: true
      method: string
      skill?: SkillManifest
    }
  | {
      ok: false
      method: string
      reason: string
    }

const RUNTIME_METHODS = new Set([
  'main-agent',
  'runtime-test-gate',
  'review-subagent',
  'runtime-report'
])

/**
 * 解析当前阶段唯一方法。SkillRegistry 已负责 project > global > builtin 的遮蔽顺序；
 * 这里负责拒绝缺失、损坏或工具声明自相矛盾的方法，禁止静默换用其它 skill。
 */
export function resolveXForgeStageMethod(
  registry: XForgeStageMethodRegistry,
  stage: XForgeStage,
  opts: { explorationMethod?: XForgeExplorationMethod } = {}
): XForgeStageMethodResolution {
  const binding = getXForgeStageBinding(stage)
  const method = stage === 'brainstorm'
    ? (opts.explorationMethod ?? binding.method)
    : binding.method

  if (RUNTIME_METHODS.has(method)) return { ok: true, method }

  const skill = registry.get(method)
  if (!skill) {
    return {
      ok: false,
      method,
      reason: `阶段 ${stage} 所需方法 ${method} 缺失，已检查 project > global > builtin`
    }
  }
  if (skill.invalid || !skill.enabled || !skill.body.trim()) {
    return {
      ok: false,
      method,
      reason: `阶段方法 ${method} 无效: ${skill.invalidReason ?? '未启用或正文为空'}`
    }
  }

  const forbidden = new Set(skill.forbiddenTools ?? [])
  for (const toolName of skill.allowedTools ?? []) {
    if (forbidden.has(toolName)) {
      return {
        ok: false,
        method,
        reason: `阶段方法 ${method} 同时允许并禁止工具 ${toolName}`
      }
    }
  }

  return { ok: true, method, skill }
}
