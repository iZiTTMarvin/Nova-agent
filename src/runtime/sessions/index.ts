export { SessionStore } from './SessionStore'
export type {
  SessionSummary,
  SessionData,
  SessionMessage,
  SessionToolCall
} from './types'
export { SESSION_DATA_FILE } from './types'
export {
  CURRENT_SESSION_SCHEMA_VERSION,
  migrateSessionData,
  migrateSessionFile,
  migrateV3ToV4
} from './migrations'
export {
  MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE,
  normalizeMessageToBlocksSource,
  serializeMessageForDisk,
  projectContentFromBlocks,
  projectToolCallsFromBlocks,
  projectAssistantFieldsFromBlocks,
  buildBlocksFromLegacyFields
} from './messageProjection'
export type { MessageIndexSnapshot, MessageIndexEntry } from './messageIndex'
export {
  SESSION_MESSAGE_INDEX_FILE,
  buildMessageIndex,
  loadMessageIndex
} from './messageIndex'
export type { MessagePatchEvent } from './messagePatches'
export { SESSION_MESSAGE_PATCHES_FILE } from './messagePatches'
export {
  computeActivePath,
  buildChildrenIndex,
  getBranchPosition,
  findCommonAncestor,
  resolveCurrentLeafId,
  ensureMessageParentChain,
  getSessionActiveMessages,
  attachBranchMeta,
  findSubtreeLeaf
} from './tree'
export type { BranchMeta } from './tree'
