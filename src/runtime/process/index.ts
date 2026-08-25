/**
 * 持久进程会话领域入口：进程登记表与输出日志的公共契约。
 */
export {
  processRegistry,
  ProcessRegistry,
  MAX_ACTIVE_PROCESSES_PER_SESSION,
  TERMINATE_TIMEOUT_MS,
  RETAINED_UNREAD_CAP_BYTES,
  type SessionHandle,
  type SessionDescribe
} from './registry'
export {
  SessionOutputJournal,
  RETENTION_MAX_LINES,
  RETENTION_MAX_BYTES,
  SPILL_THRESHOLD_BYTES,
  READ_PAGE_MAX_LINES,
  READ_PAGE_MAX_BYTES
} from './journal'
export { ProcessSessionError } from './types'
export type {
  ProcessSessionState,
  ProcessSessionSource,
  ProcessOwner,
  RegisterProcessInput,
  ReadPage,
  ProcessErrorCode
} from './types'
