/**
 * 跨 store selectors
 *
 * 一些 selector 跨越多个 store（例如 selectSupportsVision 依赖 modelConfig，
 * 而 modelConfig 在 useSettingsStore），用独立函数封装，调用方传入所需的 store 切片。
 *
 * 这里的 selector 不绑定具体 store，而是接收各 store 的 state 切片参数，
 * 让调用方按需从各自 store 读取后再传入，避免隐式跨 store 订阅导致的重渲染失控。
 */
import { resolveSupportsVision } from '../../shared/config/types'
import type { ModelConfig } from '../../shared/config'

/**
 * 当前模型是否支持图片输入（vision）。
 * 调用方应从 useSettingsStore 读取 modelConfig 后传入。
 *
 * @param modelConfig settings store 中的 modelConfig（可能为 null，未加载完成时）
 */
export function selectSupportsVisionFromConfig(modelConfig: ModelConfig | null): boolean {
  const modelId = modelConfig?.modelId ?? ''
  return resolveSupportsVision(modelId, modelConfig?.supportsVision)
}
