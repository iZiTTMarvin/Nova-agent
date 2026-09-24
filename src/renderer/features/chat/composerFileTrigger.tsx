/**
 * Composer `@` trigger — 文件引用候选接到官方 SearchSource。
 *
 * 选中后插入行内芯片，序列化值仍是 `@相对路径` 纯文本：草稿、发送与
 * 拒绝路径继续走纯文本协议。候选来自主进程 git ls-files（5 秒 TTL 缓存）。
 */
import type { ReactNode } from 'react'
import type {
  ChatComposerToken,
  ChatComposerTrigger,
  ChatComposerTriggerItem
} from '@astryxdesign/core/Chat'
import type { SearchSource } from '@astryxdesign/core/Typeahead'
import './composerFileTrigger.css'

export type ComposerFileItem = ChatComposerTriggerItem & {
  auxiliaryData: { path: string }
}

/** 文件芯片：序列化为 `@相对路径`，发送侧不预读内容 */
export function fileComposerToken(path: string): ChatComposerToken {
  return {
    value: `@${path}`,
    label: `@${path}`,
    variant: 'blue'
  }
}

/**
 * 构建 `@` trigger。候选每次 search 时读当前工作区；IPC 往返用
 * 120ms trailing 去抖合并击键，过期请求按序号丢弃。
 */
export function createComposerFileTrigger(
  getCurrentProject: () => string | null
): ChatComposerTrigger {
  let pending: ReturnType<typeof setTimeout> | null = null
  /** 请求序号：只有最新一次 search 的结果才允许 resolve，防止慢 IPC 旧结果覆盖新请求 */
  let epoch = 0

  const runSearch = async (query: string): Promise<ComposerFileItem[]> => {
    const project = getCurrentProject()
    if (!project) return []
    try {
      const result = await window.api.invoke('workspace:search-files', {
        workspaceRoot: project,
        query
      })
      return result.files.map(path => ({
        id: `file:${path}`,
        label: path,
        auxiliaryData: { path }
      }))
    } catch {
      return []
    }
  }

  const searchSource: SearchSource<ComposerFileItem> = {
    bootstrap: async () => runSearch(''),
    search: (query: string) =>
      new Promise<ComposerFileItem[]>(resolve => {
        const myEpoch = ++epoch
        if (pending) clearTimeout(pending)
        // trailing 去抖：击键停止 120ms 后发起 IPC；过期请求直接空结果丢弃
        pending = setTimeout(() => {
          void runSearch(query).then(items => {
            if (myEpoch === epoch) resolve(items)
          })
        }, 120)
      })
  }

  return {
    character: '@',
    searchSource,
    menuLabel: '文件',
    emptySearchResultsText: '没有匹配的文件',
    loadingText: '搜索文件…',
    renderItem: (item): ReactNode => {
      const path = (item as ComposerFileItem).auxiliaryData.path
      const separator = path.lastIndexOf('/')
      const dir = separator > 0 ? path.slice(0, separator + 1) : ''
      const name = separator > 0 ? path.slice(separator + 1) : path
      return (
        <span className="composer-file-trigger__item">
          {dir ? <span className="composer-file-trigger__dir">{dir}</span> : null}
          <span className="composer-file-trigger__name">{name}</span>
        </span>
      )
    },
    onSelect: item => fileComposerToken((item as ComposerFileItem).auxiliaryData.path)
  }
}
