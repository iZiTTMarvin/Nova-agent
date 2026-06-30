/**
 * workspaceHandler — 工作区单一事实源 IPC（PRD §5.1）
 *
 * 注册所有 workspace:* 命令并负责把 workspace:changed 事件推给 renderer。
 * 所有命令都委托给 WorkspaceService，handler 本身无业务逻辑。
 */
import { ipcMain, BrowserWindow } from 'electron'
import {
  WORKSPACE_GET,
  WORKSPACE_SELECT_PROJECT,
  WORKSPACE_CREATE_SESSION,
  WORKSPACE_DELETE_SESSION,
  WORKSPACE_SELECT_SESSION,
  WORKSPACE_SET_MODE,
  WORKSPACE_REGENERATE,
  WORKSPACE_SWITCH_BRANCH,
  WORKSPACE_BUMP_MESSAGES_REVISION,
  WORKSPACE_EDIT_RESEND,
  WORKSPACE_CHANGED
} from '../../shared/ipc/channels'
import type { WorkspaceState } from '../../shared/workspace/types'
import { getWorkspaceService } from '../services/WorkspaceService'

export function registerWorkspaceHandler(getMainWindow: () => BrowserWindow | null): void {
  const service = getWorkspaceService()

  // 注入广播：workspace 状态变更时推给所有窗口
  service.setBroadcaster((state: WorkspaceState) => {
    const win = getMainWindow()
    // win 可能为 null（启动早期），此时跳过；renderer 启动后会主动 workspace:get 拉取
    if (win && !win.isDestroyed()) {
      win.webContents.send(WORKSPACE_CHANGED, { state })
    }
  })

  ipcMain.handle(WORKSPACE_GET, async () => {
    return service.getState()
  })

  ipcMain.handle(WORKSPACE_SELECT_PROJECT, async (_event, params?: { path?: string }) => {
    return await service.selectProject(params ?? {})
  })

  ipcMain.handle(WORKSPACE_CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: import('../../shared/session').Mode }) => {
    return service.createSession(params)
  })

  ipcMain.handle(WORKSPACE_DELETE_SESSION, async (_event, params: { sessionId: string }) => {
    return service.deleteSession(params.sessionId)
  })

  ipcMain.handle(WORKSPACE_SELECT_SESSION, async (_event, params: { sessionId: string }) => {
    return service.selectSession(params.sessionId)
  })

  ipcMain.handle(WORKSPACE_SET_MODE, async (_event, params: { mode: import('../../shared/session').Mode; sessionId?: string }) => {
    return service.setMode(params)
  })

  ipcMain.handle(WORKSPACE_REGENERATE, async (_event, params: { sessionId: string; messageId: string }) => {
    return service.prepareRegenerate(params)
  })

  ipcMain.handle(WORKSPACE_SWITCH_BRANCH, async (_event, params: { sessionId: string; targetMessageId: string }) => {
    return service.switchBranch(params)
  })

  ipcMain.handle(WORKSPACE_BUMP_MESSAGES_REVISION, async () => {
    return service.bumpMessagesRevision()
  })

  ipcMain.handle(WORKSPACE_EDIT_RESEND, async (_event, params: { sessionId: string; messageId: string }) => {
    return service.prepareEditResend(params)
  })
}
