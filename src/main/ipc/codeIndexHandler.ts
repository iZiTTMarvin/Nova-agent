import { shell, type BrowserWindow } from 'electron'
import type { CodeIndexStatusDto } from '../../shared/code-index'
import {
  CODEINDEX_GET_STATUS,
  CODEINDEX_OPEN_DIR,
  CODEINDEX_REBUILD,
  CODEINDEX_STATUS
} from '../../shared/ipc/channels'
import {
  ensureCodeGraphForWorkspace,
  getCodeGraphDirectoryForWorkspace,
  getCodeGraphStatusForWorkspace,
  getDisabledCodeGraphStatus,
  rebuildCodeGraphForWorkspace,
  setCodeGraphStatusBroadcaster
} from '../services/CodeGraphHost'
import type { WorkspaceService } from '../services/WorkspaceService'
import { handle } from './secureIpc'

interface CodeIndexSessionContext {
  readonly workspaceRoot: string | null
  readonly enabled: boolean
}

interface CodeIndexSessionReader {
  load(sessionId: string): {
    readonly workspaceRoot: string
    readonly codeIndexEnabled: boolean
  } | null
}

export function registerCodeIndexHandler(
  workspaceService: Pick<WorkspaceService, 'getState'>,
  getSessionStore: () => CodeIndexSessionReader,
  getMainWindow: () => BrowserWindow | null
): void {
  setCodeGraphStatusBroadcaster((snapshot) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(CODEINDEX_STATUS, snapshot)
  })

  handle(CODEINDEX_GET_STATUS, async (): Promise<CodeIndexStatusDto> => {
    const context = resolveCurrentContext(workspaceService, getSessionStore())
    if (!context.enabled || context.workspaceRoot === null) {
      // 状态查询不能把关闭能力变成隐式的 Runtime 启动入口。
      return getDisabledCodeGraphStatus(context.workspaceRoot)
    }
    ensureCodeGraphForWorkspace(context.workspaceRoot)
    return getCodeGraphStatusForWorkspace(context.workspaceRoot)
  })

  handle(CODEINDEX_REBUILD, async (): Promise<{ accepted: boolean }> => {
    const context = requireEnabledContext(workspaceService, getSessionStore())
    ensureCodeGraphForWorkspace(context.workspaceRoot)
    return { accepted: await rebuildCodeGraphForWorkspace(context.workspaceRoot) }
  })

  handle(CODEINDEX_OPEN_DIR, async (): Promise<void> => {
    const workspaceRoot = requireWorkspaceRoot(workspaceService)
    const directory = await getCodeGraphDirectoryForWorkspace(workspaceRoot)
    const error = await shell.openPath(directory)
    if (error) throw new Error(`打开代码索引目录失败：${error}`)
  })
}

function resolveCurrentContext(
  workspaceService: Pick<WorkspaceService, 'getState'>,
  sessionStore: CodeIndexSessionReader
): CodeIndexSessionContext {
  const state = workspaceService.getState()
  if (state.currentProjectPath === null || state.currentSessionId === null) {
    return { workspaceRoot: state.currentProjectPath, enabled: false }
  }
  const session = sessionStore.load(state.currentSessionId)
  return {
    workspaceRoot: state.currentProjectPath,
    enabled: session?.workspaceRoot === state.currentProjectPath && session.codeIndexEnabled === true
  }
}

function requireEnabledContext(
  workspaceService: Pick<WorkspaceService, 'getState'>,
  sessionStore: CodeIndexSessionReader
): { readonly workspaceRoot: string } {
  const context = resolveCurrentContext(workspaceService, sessionStore)
  if (!context.enabled || context.workspaceRoot === null) {
    throw new Error('当前会话未启用代码索引')
  }
  return { workspaceRoot: context.workspaceRoot }
}

function requireWorkspaceRoot(
  workspaceService: Pick<WorkspaceService, 'getState'>
): string {
  const workspaceRoot = workspaceService.getState().currentProjectPath
  if (workspaceRoot === null) {
    throw new Error('当前没有打开的工作区')
  }
  return workspaceRoot
}
