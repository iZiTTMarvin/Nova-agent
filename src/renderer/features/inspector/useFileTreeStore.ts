/**
 * 项目文件树状态 Owner（Inspector FilesTab）。
 * 按相对目录懒加载并缓存 entries；过滤只作用于已加载节点。
 */
import { create } from 'zustand'
import type { FsEntry, FsListDirectoryResult } from '../../../shared/fs/types'

export interface FileTreeState {
  nodes: Record<string, FsEntry[] | undefined>
  expanded: Record<string, boolean>
  loading: Record<string, boolean>
  errors: Record<string, string | undefined>
  filter: string
  selectedFile: string | null

  loadDir: (relativeDir?: string) => Promise<void>
  toggleExpand: (relativePath: string) => void
  setExpanded: (relativePath: string, open: boolean) => void
  setFilter: (filter: string) => void
  selectFile: (relativePath: string | null) => void
  collapseAll: () => void
  refresh: () => Promise<void>
  reset: () => void
}

const ROOT_KEY = ''

const INITIAL: Pick<
  FileTreeState,
  'nodes' | 'expanded' | 'loading' | 'errors' | 'filter' | 'selectedFile'
> = {
  nodes: {},
  expanded: { [ROOT_KEY]: true },
  loading: {},
  errors: {},
  filter: '',
  selectedFile: null
}

async function invokeListDirectory(relativeDir: string): Promise<FsEntry[]> {
  const result = (await window.api.invoke('fs:list-directory', {
    relativeDir
  })) as FsListDirectoryResult
  return result.entries
}

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  ...INITIAL,

  loadDir: async (relativeDir = ROOT_KEY) => {
    const key = relativeDir
    const state = get()
    if (state.loading[key]) return

    set({
      loading: { ...state.loading, [key]: true },
      errors: { ...state.errors, [key]: undefined }
    })

    try {
      const entries = await invokeListDirectory(key)
      const latest = get()
      set({
        nodes: { ...latest.nodes, [key]: entries },
        loading: { ...latest.loading, [key]: false }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败'
      const latest = get()
      set({
        loading: { ...latest.loading, [key]: false },
        errors: { ...latest.errors, [key]: message }
      })
    }
  },

  toggleExpand: (relativePath) => {
    const { expanded, nodes, loadDir } = get()
    const next = !expanded[relativePath]
    set({ expanded: { ...expanded, [relativePath]: next } })
    if (next && nodes[relativePath] === undefined) {
      void loadDir(relativePath)
    }
  },

  setExpanded: (relativePath, open) => {
    const { expanded, nodes, loadDir } = get()
    set({ expanded: { ...expanded, [relativePath]: open } })
    if (open && nodes[relativePath] === undefined) {
      void loadDir(relativePath)
    }
  },

  setFilter: (filter) => set({ filter }),

  selectFile: (relativePath) => set({ selectedFile: relativePath }),

  collapseAll: () => {
    set({ expanded: { [ROOT_KEY]: true } })
  },

  refresh: async () => {
    const selectedFile = get().selectedFile
    set({
      nodes: {},
      loading: {},
      errors: {},
      expanded: { [ROOT_KEY]: true },
      selectedFile
    })
    await get().loadDir(ROOT_KEY)
  },

  reset: () => set({ ...INITIAL })
}))

/** 已加载树中：名称匹配，或目录含匹配后代 */
export function entryMatchesFilter(
  entry: FsEntry,
  filter: string,
  nodes: Record<string, FsEntry[] | undefined>
): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  if (entry.name.toLowerCase().includes(q)) return true
  if (entry.type !== 'directory') return false
  const children = nodes[entry.relativePath]
  if (!children) return false
  return children.some(child => entryMatchesFilter(child, q, nodes))
}

/** 过滤激活时，匹配目录应强制展开以便看到后代 */
export function shouldForceExpand(
  relativePath: string,
  filter: string,
  nodes: Record<string, FsEntry[] | undefined>
): boolean {
  const q = filter.trim()
  if (!q) return false
  const children = nodes[relativePath]
  if (!children) return false
  return children.some(child => entryMatchesFilter(child, q, nodes))
}

export function resetFileTreeStoreForTests(): void {
  useFileTreeStore.setState({ ...INITIAL })
}
