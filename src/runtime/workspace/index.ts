/**
 * 工作区并发控制子系统：writer lease（单写者多读者）+ 冲突检测辅助。
 */
export {
  writerLeaseRegistry,
  DEFAULT_LEASE_TIMEOUT_MS,
  type WriterLease,
  type AcquireResult
} from './WriterLease'
export {
  WORKSPACE_CONFLICT_PREFIX,
  isWorkspaceConflictResult,
  workspaceConflictResult,
  acquireWriterLeaseOrConflict
} from './conflict'
