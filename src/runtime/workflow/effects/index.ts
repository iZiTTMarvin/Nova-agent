/**
 * 共享副作用凭证层：文件 / bash / worktree / integrate 的 prepared → committed 凭证，
 * 以及工作区路径边界校验。
 *
 * 依赖图最底层：不得 import workflow 下任何其他模块。
 */
export {
  SideEffectBlockedError,
  isSideEffectCtx,
  effectIdFromKey,
  setFaultInjector,
  injectFault
} from './sideEffectCtx'
export type { SideEffectCtx, SideEffectPolicy, FaultPoint } from './sideEffectCtx'

export {
  assertSafeRelativePath,
  isPathInside,
  canonicalizeRoot,
  resolveExistingPathUnderRoot
} from './pathSafety'
export type { SafeExistingPath } from './pathSafety'
