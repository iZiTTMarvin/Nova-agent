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
    // 摘要取自 UI 正在展示的缓存条目：主进程据此比对「用户看到的版本」与当前字节。
    // 缓存里没有该文件条目时不能凭空猜摘要，先重拉权威 diff 再提示用户重审。
    const entry = get().messageDiffs[messageId]?.diffs.find(d => d.filePath === filePath)
    if (!entry || entry.currentDigest === undefined) {
      await get().loadMessageDiffs(sessionId, messageId, true)
      throw new Error('改动已过期，请重新查看')
    }
    try {
      await window.api.invoke('reject-file', {
        sessionId,
        messageId,
        filePath,
        expectedDigest: entry.currentDigest
      })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!get().messageDiffs[messageId]) return
      set(state => updateDiffReviewPatch(state, messageId, [filePath], 'rejected'))
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
      // 失败说明摘要或清单已过期：原地强制重拉权威 diff 后再向上抛错，
      // 清空缓存会让组件卸载、刚产生的错误提示还没渲染就被销毁
      if (isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) {
        await get().loadMessageDiffs(sessionId, messageId, true)
      }
      throw err
    }
  },

  loadMessageDiffs: async (sessionId, messageId, force = false) => {
    const state = get()
    const sessionAtStart = state.currentSessionId
    if (sessionId !== sessionAtStart) return
    if (!force && state.messageDiffs[messageId]) return

    const generation = captureDiffGeneration()
    // force 重拉保留现有缓存继续展示，不进 loading；否则组件会被骨架屏换下场、丢掉刚产生的行内错误
    if (!force) {
      set(current => markDiffLoadingPatch(current, messageId))
    }

    try {
      const result = await window.api.invoke('get-message-diffs', { sessionId, messageId })
      if (!isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) return
      if (!result || !Array.isArray(result.diffs)) {
        set(current => clearDiffLoadingPatch(current, messageId))
        return
      }
      // 流式期间挂载的消息会在 checkpoint 落盘前拉取：空结果不能覆盖
      // live 占位或已有的真实数据，留给 message_end 的终态加载写入；
      // force 重拉发生在操作失败后，空结果即权威状态，正常提交
      if (result.diffs.length === 0 && !force) {
        const current = get()
        // 有 live 占位说明 checkpoint 稍后才落盘，保留 loading 交给终态加载
        if ((current.loadingDiffPlaceholders[messageId]?.length ?? 0) > 0) return
        // 已有真实数据（终态加载已完成）时同理只退 loading，不回退成空缓存
        if ((current.messageDiffs[messageId]?.diffs.length ?? 0) > 0) {
          set(cur => clearDiffLoadingPatch(cur, messageId))
          return
        }
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
    // 每个文件的摘要都取自当前展示的缓存；缺任一条目即视为过期，重拉后提示重审
    const cache = get().messageDiffs[messageId]
    const files: Array<{ filePath: string; expectedDigest: string | null }> = []
    let stale = !cache
    if (cache) {
      for (const fp of filePaths) {
        const entry = cache.diffs.find(d => d.filePath === fp)
        if (!entry || entry.currentDigest === undefined) {
          stale = true
          break
        }
        files.push({ filePath: fp, expectedDigest: entry.currentDigest })
      }
    }
    if (stale) {
      await get().loadMessageDiffs(sessionId, messageId, true)
      throw new Error('改动已过期，请重新查看')
    }
    try {
      const result = await window.api.invoke('reject-all-files', { sessionId, messageId, files })
      if (
        isRequestCurrent(generation, sessionAtStart, get().currentSessionId) &&
        get().messageDiffs[messageId]
      ) {
        set(state => updateDiffReviewPatch(state, messageId, result.restored, 'rejected'))
      }
      if (result.failed.length > 0) {
        console.warn('部分文件拒绝失败:', result.failed)
        if (isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) {
          await get().loadMessageDiffs(sessionId, messageId, true)
        }
      }
      return result
    } catch (err) {
      console.error('批量拒绝文件出错:', err)
      if (isRequestCurrent(generation, sessionAtStart, get().currentSessionId)) {
        await get().loadMessageDiffs(sessionId, messageId, true)
      }
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
      const cache = get().messageDiffs[messageId]
      if (cache && cache.diffs.length > 0) return
      // 已提交的空缓存是流式早期拉取的假结果（checkpoint 尚未落盘），
      // 清掉让位给 live 占位，由 message_end 的终态加载重写
      set(state => ({
        ...clearMessageDiffPatch(state, messageId),
        ...liveDiffPatch(state, messageId, diffs)
      }))
      return
    }

    const nextDiffs: DiffEntry[] = diffs.map(diff => ({
      filePath: diff.filePath,
      status: diff.status,
      hunks: diff.hunks ?? [],
      // 事件载荷不携带工作区字节摘要；拒绝前必须重拉权威 diff。
      currentDigest: undefined
    }))
    set(state => finalDiffPatch(state, messageId, nextDiffs, reviews))
  }
})
