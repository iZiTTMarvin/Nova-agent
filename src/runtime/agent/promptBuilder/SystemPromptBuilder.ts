/**
 * SystemPromptBuilder — 7 层 system prompt 流水线拼装
 * 每层独立包裹标题，顺序固定以保障缓存前缀稳定性
 */
import type { SystemPromptLayers } from '../types'

const LAYER_TITLES: Record<keyof SystemPromptLayers, string> = {
  agentRole: 'Agent Role',
  baseRules: 'Base Rules',
  projectRules: 'Project Rules',
  memoryContext: 'Project Memory',
  skillContext: 'Skills',
  modeInstruction: 'Mode',
  toolSummary: 'Available Tools'
}

export class SystemPromptBuilder {
  /**
   * 拼装完整 system prompt
   * @param layers 各层内容（空层自动跳过）
   */
  static build(layers: SystemPromptLayers): string {
    const parts: string[] = []
    const ordered: (keyof SystemPromptLayers)[] = [
      'agentRole',
      'baseRules',
      'projectRules',
      'memoryContext',
      'skillContext',
      'modeInstruction',
      'toolSummary'
    ]
    for (const key of ordered) {
      const content = layers[key]
      if (!content?.trim()) continue
      const title = key === 'projectRules' && layers.projectRules
        ? `${LAYER_TITLES[key]} (from project)`
        : LAYER_TITLES[key]
      parts.push(SystemPromptBuilder.buildLayer(title, content))
    }
    return parts.join('\n\n')
  }

  /**
   * 单层格式化：`=== TITLE ===` 包裹
   * @param name 层标题
   * @param content 层正文
   */
  static buildLayer(name: string, content: string): string {
    return `=== ${name} ===\n${content.trim()}`
  }
}
