/**
 * useGitBranchSwitcher — 分支菜单的状态机（照 ZCode 同名 hook 精简）。
 *
 * 拥有：菜单开合、分支列表快照、创建弹窗字段、mutation pending 与结构化 issue 展示。
 * 不拥有 Git 真源：变更成功后由调用方刷新摘要，列表在每次展开时重新拉取。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranchIssue, GitBranchListResult, GitBranchMutationResult } from '../../../shared/git/types'

export interface UseGitBranchSwitcherParams {
  workspaceRoot: string | null
  /** 当前摘要的分支名：变化且菜单关闭时丢弃本地快照，避免「切了不变」 */
  currentBranchName: string | null
  /** 分支真正变化且创建/切换成功后回调（刷新摘要） */
  onChanged: () => void
}

export interface UseGitBranchSwitcherResult {
  open: boolean
  setOpen: (open: boolean) => void
  createDialogOpen: boolean
  openCreateDialog: () => void
  closeCreateDialog: () => void
  createBranchName: string
  setCreateBranchName: (name: string) => void
  branchesResult: GitBranchListResult | null
  loadingBranches: boolean
  mutationPending: boolean
  /** 切换失败的 issue（菜单内展示）；成功后清空 */
  switchIssue: GitBranchIssue | null
  /** 创建失败的 issue（弹窗内展示）；编辑名称或关闭弹窗时清空 */
  createIssue: GitBranchIssue | null
  switchBranch: (branchName: string) => Promise<void>
  createBranchAndSwitch: () => Promise<void>
}

function toUnexpectedIssue(error: unknown): GitBranchIssue {
  return {
    code: 'mutation-failed',
    detail: error instanceof Error ? error.message : undefined
  }
}

export function useGitBranchSwitcher({
  workspaceRoot,
  currentBranchName,
  onChanged
}: UseGitBranchSwitcherParams): UseGitBranchSwitcherResult {
  const [open, setOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createBranchName, setCreateBranchNameRaw] = useState('')
  const [branchesResult, setBranchesResult] = useState<GitBranchListResult | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [mutationPending, setMutationPending] = useState(false)
  const [switchIssue, setSwitchIssue] = useState<GitBranchIssue | null>(null)
  const [createIssue, setCreateIssue] = useState<GitBranchIssue | null>(null)

  const requestVersion = useRef(0)
  const rootRef = useRef<string | null>(workspaceRoot)
  rootRef.current = workspaceRoot
  const mutationPendingRef = useRef(mutationPending)
  mutationPendingRef.current = mutationPending

  const loadBranches = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    if (!root) return
    const version = ++requestVersion.current
    setLoadingBranches(true)
    try {
      const result = await window.api.invoke('git:list-branches', { workspaceRoot: root })
      if (version !== requestVersion.current || rootRef.current !== root) return
      setBranchesResult(result)
    } catch {
      if (version !== requestVersion.current) return
      setBranchesResult(null)
    } finally {
      if (version === requestVersion.current) setLoadingBranches(false)
    }
  }, [])

  // 展开时拉取列表；关闭时丢弃快照并清掉上一轮错误
  useEffect(() => {
    if (open) {
      setSwitchIssue(null)
      void loadBranches()
      return
    }
    requestVersion.current += 1
    setLoadingBranches(false)
    setBranchesResult(null)
    setSwitchIssue(null)
  }, [open, loadBranches])

  // 外部分支名变化（切换成功回流 / 初次加载）且菜单关闭时，让下次展开重新拉取
  useEffect(() => {
    if (open) return
    requestVersion.current += 1
    setBranchesResult(null)
  }, [currentBranchName, open])

  const setCreateBranchName = useCallback((name: string) => {
    setCreateBranchNameRaw(name)
    setCreateIssue(null)
  }, [])

  const openCreateDialog = useCallback(() => {
    setCreateBranchNameRaw('')
    setCreateIssue(null)
    setCreateDialogOpen(true)
  }, [])

  const closeCreateDialog = useCallback(() => {
    setCreateDialogOpen(false)
    setCreateBranchNameRaw('')
    setCreateIssue(null)
  }, [])

  const applyMutationResult = useCallback(
    (result: GitBranchMutationResult, target: 'switch' | 'create'): boolean => {
      if (!result.ok) {
        if (target === 'switch') setSwitchIssue(result.issue)
        else setCreateIssue(result.issue)
        return false
      }
      if (target === 'switch') setSwitchIssue(null)
      else setCreateIssue(null)
      if (result.didChange || result.created) onChanged()
      return true
    },
    [onChanged]
  )

  const switchBranch = useCallback(
    async (branchName: string): Promise<void> => {
      const root = rootRef.current
      if (!root || mutationPendingRef.current) return
      setMutationPending(true)
      setSwitchIssue(null)
      try {
        const result = await window.api.invoke('git:switch-branch', {
          workspaceRoot: root,
          branchName
        })
        const ok = applyMutationResult(result, 'switch')
        if (ok && rootRef.current === root) await loadBranches()
      } catch (error) {
        setSwitchIssue(toUnexpectedIssue(error))
      } finally {
        setMutationPending(false)
      }
    },
    [applyMutationResult, loadBranches]
  )

  const createBranchAndSwitch = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    const name = createBranchName.trim()
    if (!root || mutationPendingRef.current) return
    setMutationPending(true)
    setCreateIssue(null)
    try {
      const result = await window.api.invoke('git:create-branch', {
        workspaceRoot: root,
        branchName: name
      })
      if (!applyMutationResult(result, 'create')) return
      setCreateDialogOpen(false)
      setCreateBranchNameRaw('')
      if (rootRef.current === root) await loadBranches()
    } catch (error) {
      setCreateIssue(toUnexpectedIssue(error))
    } finally {
      setMutationPending(false)
    }
  }, [applyMutationResult, createBranchName, loadBranches])

  return {
    open,
    setOpen,
    createDialogOpen,
    openCreateDialog,
    closeCreateDialog,
    createBranchName,
    setCreateBranchName,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchIssue,
    createIssue,
    switchBranch,
    createBranchAndSwitch
  }
}
