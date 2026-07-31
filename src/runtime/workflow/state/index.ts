/**
 * 编排持久化：run 元数据落盘、agent 结果 journal、磁盘路径约定。
 *
 * 本层不得 import host/ 或 definitions/ —— 持久化不感知宿主能力与具体 workflow。
 */
export {
  journalKeyBase,
  journalKey,
  appendJournalSync,
  loadJournal,
  clearJournal,
  scriptSha,
  ScriptShaMismatchError
} from './journal'
export type { ScriptShaMismatchPolicy } from './journal'

export {
  readComposeState,
  writeComposeState,
  createInitialState,
  applyStatePatch,
  writeTaskFailure,
  recomputeStats
} from './runState'
