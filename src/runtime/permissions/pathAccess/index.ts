export {
  CanonicalPathCache,
  canonicalizeExistingPath,
  canonicalizeExistingPathAsync,
  canonicalizeTargetPath,
  createCanonicalPathCache,
  isPathWithinRoot,
  lexicalNormalize,
  normalizeDrive,
  toWorkspaceRelativePath,
  type CanonicalResult
} from './canonicalPath'
export { resolvePathAccess, isPathAccessible, type PathAccessResolution } from './pathAccessPolicy'
export {
  addSessionPathGrant,
  clearExecutionPathGrants,
  clearSessionPathGrants,
  getExecutionPathGrants,
  getSessionPathGrants,
  listPathGrantsForAccess,
  matchPathGrant,
  replaceSkillPathGrants,
  setExecutionPathGrants
} from './sessionPathGrants'
