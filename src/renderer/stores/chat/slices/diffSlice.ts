import type { DiffEntry } from '../../../../shared/diff/types'
import {
  captureDiffGeneration,
  clearDiffLoadingPatch,
  clearMessageDiffPatch,
  commitLoadedDiffPatch,
  finalDiffPatch,
  initialDiffState,
  isDiffGenerationCurrent,
  liveDiffPatch,
  markDiffLoadingPatch,
  updateDiffReviewPatch
} from '../internal'
import type { ChatSliceCreator, DiffSliceState } from '../types'

function isRequestCurrent(
  generation: number,
  sessionAtStart: string | null,
  currentSessionId: string | null
): boolean {
  return isDiffGenerationCurrent(generation) && currentSessionId === sessionAtStart
}

export { initialDiffState }

export const createDiffSlice: ChatSliceCreator<DiffSliceState> = (set, get) => ({
  ...initialDiffState(),

  rejectFile: async (sessionId, messageId, filePath) => {
    const sessionAtStart = get().currentSessionId
    if (sessionId !== sessionAtStart) return
    const generation = captureDiffGeneration()
    try {
      await window.api.invoke('reject-file', { sessionId, messageId, filePath })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!get().messageDiffs[messageId]) return
      set(state => updateDiffReviewPatch(state, messageId, [filePath], 'rejected'))
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
      throw err
    }
  },

  loadMessageDiffs: async (sessionId, messageId) => {
    const state = get()
    const sessionAtStart = state.currentSessionId
    if (sessionId !== sessionAtStart) return
    if (state.messageDiffs[messageId]) return

    const generation = captureDiffGeneration()
    set(current => markDiffLoadingPatch(current, messageId))

    try {
      const result = await window.api.invoke('get-message-diffs', { sessionId, messageId })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!result || !Array.isArray(result.diffs)) {
        set(current => clearDiffLoadingPatch(current, messageId))
        return
      }
      set(current => commitLoadedDiffPatch(current, messageId, {
        diffs: result.diffs,
        reviews: result.reviews ?? {},
        skippedFiles: result.skippedFiles
      }))
    } catch (err) {
      console.error('加载 diff 出错:', err)
      if (isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) {
        set(current => clearDiffLoadingPatch(current, messageId))
      }
    }
  },

  acceptFile: async (sessionId, messageId, filePath) => {
    const sessionAtStart = get().currentSessionId
    if (sessionId !== sessionAtStart) return
    const generation = captureDiffGeneration()
    try {
      await window.api.invoke('accept-file', { sessionId, messageId, filePath })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!get().messageDiffs[messageId]) return
      set(state => updateDiffReviewPatch(state, messageId, [filePath], 'accepted'))
    } catch (err) {
      console.error('接受文件出错:', err)
      throw err
    }
  },

  acceptAllFiles: async (sessionId, messageId, filePaths) => {
    if (filePaths.length === 0) return
    const sessionAtStart = get().currentSessionId
    if (sessionId !== sessionAtStart) return
    const generation = captureDiffGeneration()
    try {
      await window.api.invoke('accept-all-files', { sessionId, messageId, filePaths })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!get().messageDiffs[messageId]) return
      set(state => updateDiffReviewPatch(state, messageId, filePaths, 'accepted'))
    } catch (err) {
      console.error('批量接受文件出错:', err)
      throw err
    }
  },

  rejectAllFiles: async (sessionId, messageId, filePaths) => {
    if (filePaths.length === 0) return { restored: [], failed: [] }
    const sessionAtStart = get().currentSessionId
    if (sessionId !== sessionAtStart) return { restored: [], failed: [] }
    const generation = captureDiffGeneration()
    try {
      const result = await window.api.invoke('reject-all-files', { sessionId, messageId, filePaths })
      if (
        isRequestCurrent(generation, sessionAtStart, get().currentSessionId) &&
        get().messageDiffs[messageId]
      ) {
        set(state => updateDiffReviewPatch(state, messageId, result.restored, 'rejected'))
      }
      if (result.failed.length > 0) {
        console.warn('部分文件拒绝失败:', result.failed)
      }
      return result
    } catch (err) {
      console.error('批量拒绝文件出错:', err)
      throw err
    }
  },

  clearMessageDiffs: (messageId) => {
    set(state => clearMessageDiffPatch(state, messageId))
  },

  /**
   * live 只提供文件占位；final 才携带 hunks 并成为可审查缓存。
   * final 已写入后到达的 late-live 必须被忽略，不能把完整数据降级为 loading。
   */
  handleDiffUpdate: (messageId, phase, diffs, reviews) => {
    if (phase === 'live') {
      if (get().messageDiffs[messageId]) return
      set(state => liveDiffPatch(state, messageId, diffs))
      return
    }

    const nextDiffs: DiffEntry[] = diffs.map(diff => ({
      filePath: diff.filePath,
      status: diff.status,
      hunks: diff.hunks ?? []
    }))
    set(state => finalDiffPatch(state, messageId, nextDiffs, reviews))
  }
})
