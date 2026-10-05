/**
 * 项目文件树状态 Owner（Inspector FilesTab）。
 * 按相对目录懒加载并缓存 entries；过滤结果是工作区搜索的派生投影。
 */
import { create } from 'zustand'
import type { FsEntry, FsListDirectoryResult } from '../../../shared/fs/types'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'

export interface FileTreeState {
  nodes: Record<string, FsEntry[] | undefined>
  expanded: Record<string, boolean>
  loading: Record<string, boolean>
  errors: Record<string, string | undefined>
  filter: string
  filterMatches: string[]
  filterLoading: boolean
  filterError: string | undefined
  filterGeneration: number
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
  'nodes'
  | 'expanded'
  | 'loading'
  | 'errors'
  | 'filter'
  | 'filterMatches'
  | 'filterLoading'
  | 'filterError'
  | 'filterGeneration'
  | 'selectedFile'
> = {
  nodes: {},
  expanded: { [ROOT_KEY]: true },
  loading: {},
  errors: {},
  filter: '',
  filterMatches: [],
  filterLoading: false,
  filterError: undefined,
  filterGeneration: 0,
  selectedFile: null
}

async function invokeListDirectory(relativeDir: string): Promise<FsEntry[]> {
  const result = (await window.api.invoke('fs:list-directory', {
    relativeDir
  })) as FsListDirectoryResult
  return result.entries
}

async function invokeSearchFiles(workspaceRoot: string, query: string): Promise<string[]> {
  const result = await window.api.invoke('workspace:search-files', {
    workspaceRoot,
    query
  })
  return result.files
}

export const useFileTreeStore = create<FileTreeState>((set, get) => {
  const searchFilter = async (query: string, generation: number): Promise<void> => {
    const workspaceRoot = useWorkspaceStore.getState().currentProjectPath
    if (!workspaceRoot) {
      if (get().filterGeneration === generation) {
        set({ filterLoading: false })
      }
      return
    }

    try {
      const files = await invokeSearchFiles(workspaceRoot, query)
      const current = get()
      if (
        current.filterGeneration !== generation ||
        current.filter.trim() !== query ||
        useWorkspaceStore.getState().currentProjectPath !== workspaceRoot
      ) {
        return
      }
      set({
        filterMatches: files,
        filterLoading: false,
        filterError: undefined
      })
    } catch (err) {
      const current = get()
      if (
        current.filterGeneration !== generation ||
        current.filter.trim() !== query ||
        useWorkspaceStore.getState().currentProjectPath !== workspaceRoot
      ) {
        return
      }
      set({
        filterMatches: [],
        filterLoading: false,
        filterError: err instanceof Error ? err.message : '搜索文件失败'
      })
    }
  }

  return {
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

    setFilter: (filter) => {
      const query = filter.trim()
      const generation = get().filterGeneration + 1
      set({
        filter,
        filterMatches: [],
        filterLoading: query.length > 0,
        filterError: undefined,
        filterGeneration: generation
      })
      if (query.length > 0) {
        void searchFilter(query, generation)
      }
    },

    selectFile: (relativePath) => set({ selectedFile: relativePath }),

    collapseAll: () => {
      set({ expanded: { [ROOT_KEY]: true } })
    },

    refresh: async () => {
      const state = get()
      const query = state.filter.trim()
      const generation = state.filterGeneration + 1
      const selectedFile = state.selectedFile
      set({
        nodes: {},
        loading: {},
        errors: {},
        expanded: { [ROOT_KEY]: true },
        filterMatches: [],
        filterLoading: query.length > 0,
        filterError: undefined,
        filterGeneration: generation,
        selectedFile
      })
      await get().loadDir(ROOT_KEY)
      if (query.length > 0) {
        void searchFilter(query, generation)
      }
    },

    reset: () => {
      set({
        ...INITIAL,
        filterGeneration: get().filterGeneration + 1
      })
    }
  }
})

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
  useFileTreeStore.setState({
    ...INITIAL,
    filterGeneration: useFileTreeStore.getState().filterGeneration + 1
  })
}
