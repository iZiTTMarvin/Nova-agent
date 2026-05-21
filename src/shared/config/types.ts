/**
 * 模型配置类型
 * 全局唯一的 OpenAI-compatible 模型配置
 */
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
}
