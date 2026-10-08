import type { ForgottenMemory } from '../types'
import { escapeMemorySnapshotText } from './selectCoreEntries'

export interface RedactedMemorySnapshot {
  text: string | null
  removedGlobal: number
  removedProject: number
}

/**
 * 从已渲染的记忆快照文本中删除被遗忘 scope 的条目行。
 * 只删与 `- ${escapeMemorySnapshotText(content)}` 完全相等的行：Global 节只删 global、
 * Project 节只删 project，同一正文在另一 scope 节出现不受影响。
 * 某节条目行删光时连同节头（project 连同 Workspace 行）删除；内容清空则 text 返回 null。
 * 无变化返回 null。
 */
export function redactMemorySnapshotText(text: string, forgotten: ForgottenMemory): RedactedMemorySnapshot | null {
  const targets = new Set(forgotten.contents.map(content => `- ${escapeMemorySnapshotText(content)}`))
  const lines = text.split('\n')
  const open = lines.findIndex(line => /^<memory\b/.test(line))
  const close = lines.lastIndexOf('</memory>')
  if (!targets.size || open < 0 || close <= open) return null
  const inner = lines.slice(open + 1, close)
  const out: string[] = []
  let removedGlobal = 0
  let removedProject = 0
  for (let i = 0; i < inner.length;) {
    const line = inner[i]
    const kind = line === '## Global' ? 'global' : line.startsWith('## Project: ') ? 'project' : null
    if (!kind) { out.push(line); i++; continue }
    const header = [line]
    i++
    if (kind === 'project' && inner[i]?.startsWith('Workspace: ')) { header.push(inner[i]); i++ }
    // 节内条目是连续的 `- ` 行；omitted 提示等非条目行属于外层结构，不算节内容
    const entries: string[] = []
    while (i < inner.length && inner[i].startsWith('- ')) { entries.push(inner[i]); i++ }
    const kept: string[] = []
    for (const entry of entries) {
      if (kind === forgotten.scope.scopeKind && targets.has(entry)) {
        if (kind === 'global') removedGlobal++
        else removedProject++
      } else kept.push(entry)
    }
    if (kept.length) out.push(...header, ...kept)
  }
  if (!removedGlobal && !removedProject) return null
  const content = out.join('\n')
  return {
    text: content.trim() ? `${lines.slice(0, open + 1).join('\n')}\n${content}\n${lines.slice(close).join('\n')}` : null,
    removedGlobal,
    removedProject
  }
}
