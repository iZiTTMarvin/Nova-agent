/**
 * 交接包渲染：只读账本字段，拼进 system 尾部。提交瞬间冻结，渲染期不算。
 */
import type { MessageOrigin } from '../../model/types'
import type { CompactionLedger, LedgerEntry, StateDoc } from '../../sessions'

export function formatPointerStub(
  id: string,
  from: MessageOrigin,
  to: MessageOrigin
): string {
  return `[${id}: 折叠 #${from.messageId}:${from.step}–#${to.messageId}:${to.step}；原文可用 history_read("${id}")]`
}

const TOUCHED_FILES_BOUNDARY =
  '（仅本会话 checkpoint 记录的创建/修改/删除，含 bash 快照 diff；不含编辑器手改与因过大跳过备份的文件）'

function renderTouchedFiles(entry: LedgerEntry): string | null {
  const { paths, omittedCount } = entry.touchedFiles
  if (paths.length === 0 && omittedCount === 0) return null
  const overflow = omittedCount > 0 ? `…另 ${omittedCount} 个文件` : null
  const files = [...paths, ...(overflow ? [overflow] : [])].join('、')
  return `改过的文件: ${files}${TOUCHED_FILES_BOUNDARY}`
}

/** 单条账本条目的只读渲染。折成指针后只留一行；touchedFiles 仍留在账本供 history_read。 */
export function renderLedgerEntry(entry: LedgerEntry): string {
  const pointer = formatPointerStub(entry.id, entry.shadows.from, entry.shadows.to)
  if (entry.stub === pointer) return pointer
  const files = renderTouchedFiles(entry)
  return files ? `${entry.stub}\n${files}` : entry.stub
}

function renderTaskVerbatim(state: StateDoc): string | null {
  const verbatim = state.taskVerbatim
  if (!verbatim) return null
  return `当前任务原文（#${verbatim.origin.messageId}:${verbatim.origin.step}）：\n${verbatim.text}`
}

/** 已提交账本字段的只读渲染，不含冻结 system prompt。 */
export function renderHandoffPacket(ledger: CompactionLedger): string {
  const parts: string[] = []
  for (const entry of ledger.entries) {
    const rendered = renderLedgerEntry(entry)
    if (rendered) parts.push(rendered)
  }
  if (ledger.state?.text) parts.push(ledger.state.text)
  const verbatim = ledger.state ? renderTaskVerbatim(ledger.state) : null
  if (verbatim) parts.push(verbatim)
  if (ledger.state?.realityLine) parts.push(ledger.state.realityLine)
  return parts.join('\n\n')
}

export function renderCompactedSystem(
  frozenSystemPrompt: string,
  ledger: CompactionLedger
): string {
  const packet = renderHandoffPacket(ledger)
  return packet.length > 0 ? `${frozenSystemPrompt}\n\n${packet}` : frozenSystemPrompt
}
