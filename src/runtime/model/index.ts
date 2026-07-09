export { type ModelClient } from './ModelClient'
export { OpenAICompatibleModelClient } from './OpenAICompatibleModelClient'
export { validateModelConfig, saveModelConfig, loadModelConfig, getModelConfigPath, loadLlmRegistry, saveLlmRegistry, setActiveModelInRegistry } from './config'
export { fetchProviderModels } from './fetchProviderModels'
export { buildReasoningParams } from './reasoningDialect'
export {
  projectMessagesForVision,
  providerRejectsToolMultimodal
} from './visionProjection'
export type { VisionProjectionOptions } from './visionProjection'
export type { ConfigValidationError, ConfigValidationResult } from './config'
export type {
  ChatMessage, ChatToolCall, ToolDefinition,
  ModelClientConfig, ChatEvent
} from './types'
