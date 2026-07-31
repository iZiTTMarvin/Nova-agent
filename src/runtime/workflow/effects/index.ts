/** Workflow 副作用层公共出口；本目录不得依赖其他 workflow 层。 */
export { effectIdFromKey } from './sideEffectCtx'
export type { SideEffectCtx } from './sideEffectCtx'

export {
  assertSafeRelativePath,
  canonicalizeRoot,
  isPathInside,
  resolveExistingPathUnderRoot
} from './pathSafety'
export type { SafeExistingPath } from './pathSafety'
