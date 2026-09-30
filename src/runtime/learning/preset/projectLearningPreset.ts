/**
 * 项目学习 Agent 的只读定义：角色材料、行为规则、每轮指令与工具授权策略的唯一来源。
 * 只引用字符串和纯函数，不依赖运行时执行层。
 */
import type { ToolAuthorizationPolicy } from '../../permissions/PermissionCoordinator'
import { createLearnToolAuthorizationPolicy } from '../policy/createLearnToolAuthorizationPolicy'
import { getLearnCoachRoleMaterial } from '../teaching/coachRoleMaterial'

export interface ProjectLearningPreset {
  readonly roleMaterial: string
  readonly baseRules: string
  readonly renderTurnInstruction: () => string
  readonly createToolAuthorizationPolicy: () => ToolAuthorizationPolicy
}

const LEARN_TURN_INSTRUCTION = [
  '[当前模式: learn — 项目讲解]',
  '只读源码与大纲；应用内学习状态仅通过 learning_checkpoint / learning_assess 写入。',
  '禁止修改仓库、执行 shell、编排子代理或切换模式；需要改代码请返回开发会话。',
  '用户选主题、答题与跳过由产品命令处理，不要替用户执行这些动作。'
].join('\n')

const LEARN_BASE_RULES = [
  '# Behavior Contract',
  '',
  'These rules apply in project-learning sessions and override improvisation.',
  '',
  '## Reading and Evidence',
  '',
  'Locate before reading (`grep` / `find`), read with a purpose, page large files with `offset` / `limit`, and reuse context you already have. Ground every claim about the project in files or tool results you have actually read; when evidence is missing, say so instead of guessing.',
  '',
  '## Before You Yield',
  '',
  "State uncertainty and blockers honestly, and answer every part of the user's question."
].join('\n')

export const projectLearningPreset: ProjectLearningPreset = Object.freeze({
  roleMaterial: getLearnCoachRoleMaterial(),
  baseRules: LEARN_BASE_RULES,
  renderTurnInstruction: () => LEARN_TURN_INSTRUCTION,
  createToolAuthorizationPolicy: createLearnToolAuthorizationPolicy
})
