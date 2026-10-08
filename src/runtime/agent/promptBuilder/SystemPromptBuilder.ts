/**
 * SystemPromptBuilder — system prompt 分层流水线拼装
 * 每层独立包裹标题，顺序固定以保障缓存前缀稳定性
 */
import type { SystemPromptLayers } from '../types'

const LAYER_TITLES: Record<keyof SystemPromptLayers, string> = {
  agentRole: 'Agent Role',
  baseRules: 'Base Rules',
  projectRules: 'Project Rules',
  memoryContext: 'Memory Policy',
  skillContext: 'Skills',
  modeInstruction: 'Mode',
  taskPolicy: 'Task Policy',
  toolSummary: 'Available Tools',
  memorySnapshot: 'Memory'
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
      'taskPolicy',
      'toolSummary',
      'memorySnapshot'
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

  /**
   * 遗忘后改写已冻结 prompt 里的记忆层：按 buildLayer 产出的精确文本定位替换，
   * 找不到该层返回 null（调用方据此 fail closed）。newSnapshot 为 null 时连同分隔空行一起删层。
   */
  static replaceMemorySnapshotLayer(prompt: string, oldSnapshot: string, newSnapshot: string | null): string | null {
    const oldLayer = SystemPromptBuilder.buildLayer(LAYER_TITLES.memorySnapshot, oldSnapshot)
    const index = prompt.indexOf(oldLayer)
    if (index < 0) return null
    const before = prompt.slice(0, index)
    const after = prompt.slice(index + oldLayer.length)
    const insertion = newSnapshot === null ? '' : SystemPromptBuilder.buildLayer(LAYER_TITLES.memorySnapshot, newSnapshot)
    // 层间分隔是 \n\n：删层时连同其前或后的一个分隔符去掉，避免留下空档
    if (newSnapshot === null) {
      if (before.endsWith('\n\n')) return before.slice(0, -2) + after
      if (after.startsWith('\n\n')) return before + after.slice(2)
      return before + after
    }
    return before + insertion + after
  }
}
