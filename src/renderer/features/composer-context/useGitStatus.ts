/**
 * useGitStatus — 当前工作区的 Git 摘要拉取与刷新触发。
 *
 * 触发点：工作区切换、Agent 消息结束（工具写完文件的时刻，800ms 尾防抖合并）、
 * 分支变更成功后由调用方 refresh。带请求版本号防陈旧回填。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_MESSAGE_END } from '../../../shared/ipc/channels'
import type { GitStatusSummary } from '../../../shared/git/types'

const MESSAGE_END_REFRESH_DEBOUNCE_MS = 800

export interface UseGitStatusResult {
  /** null 表示尚未拉到结果或当前工作区不可用 */
  summary: GitStatusSummary | null
  refresh: () => Promise<void>
}

export function useGitStatus(workspaceRoot: string | null): UseGitStatusResult {
  const [summary, setSummary] = useState<GitStatusSummary | null>(null)
  const requestVersion = useRef(0)
  const rootRef = useRef<string | null>(workspaceRoot)
  rootRef.current = workspaceRoot

  const refresh = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    if (!root) {
      requestVersion.current += 1
      setSummary(null)
      return
    }

    const version = ++requestVersion.current
    try {
      const next = await window.api.invoke('git:get-status', { workspaceRoot: root })
      if (version !== requestVersion.current || rootRef.current !== root) return
      setSummary(next)
    } catch {
      if (version !== requestVersion.current || rootRef.current !== root) return
      setSummary(null)
    }
  }, [])

  // 工作区变化：清空旧摘要并立即拉取
  useEffect(() => {
    setSummary(null)
    void refresh()
  }, [workspaceRoot, refresh])

  // 任意消息结束都重取；子代理并发时由尾防抖合并为一次
  useEffect(() => {
    let timer: number | null = null
    const unsubscribe = window.api.on(AGENT_MESSAGE_END, () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void refresh()
      }, MESSAGE_END_REFRESH_DEBOUNCE_MS)
    })
    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [refresh])

  return { summary, refresh }
}
