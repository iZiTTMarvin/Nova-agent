export { AgentLoop } from './AgentLoop'
export { EventBus } from './EventBus'
export type { AgentEvent, AgentEventCallback, AgentState, AgentLoopConfig } from './types'

// 主进程公共契约：以下符号被 main/ipc 消费，收敛走 barrel 以与 agent 内部布局解耦。
// 渲染进程不消费本 barrel（含运行时值会破坏 renderer bundle tree-shaking）。
export { renderToolInventory } from './promptBuilder/toolPromptRenderer'
export { buildStableSystemPrompt, normalizeFrozenSystemPrompt, getStableSystemPrompt } from './promptBuilder/modePrompt'
export type { RecoveryState } from './recovery/RecoveryStateMachine'
export { buildSkillContext } from './promptBuilder/buildSkillContext'
export { estimateTokens, estimateContextTokens, estimateChatMessageTokens } from './tokenEstimator'
export { discoverProjectRules, discoverProjectRulesFile } from './context/projectRulesDiscovery'
export { renderBaseRules } from './promptRenderer'
export { calculateContextBreakdown } from './context/contextBreakdownCalculator'
export {
  listRuleFiles,
  readRuleFile,
  writeRuleFile,
  isPathInsideRoot,
  buildNewGlobalRulePath,
  buildNewWorkspaceRulePath,
  type RuleFileEntry,
  type RuleScope
} from './context/rulesDiscovery'
export { BUILTIN_SUBAGENTS, getSubAgentSpec, listSubAgents } from './core/SubAgentConfig'
export type { SubAgentSpec } from './core/SubAgentConfig'
