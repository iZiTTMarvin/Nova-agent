/**
 * 学习表面 IPC Handler
 * 纯 IPC 适配层：Renderer 只提交未知载荷，会话身份与项目归属一律由主进程从
 * SessionStore 解析；学习命令经 LearningSurfaceHost 校验后交接给受信任教练 turn。
 */
import { BrowserWindow } from 'electron'
import { handle } from './secureIpc'
import {
  LEARNING_COMMAND,
  LEARNING_BUILD,
  LEARNING_CANCEL_BUILD,
  LEARNING_GET_SOURCE,
  LEARNING_GET_NODE_MATERIAL,
  LEARNING_GET_SURFACE,
  LEARNING_SURFACE_CHANGED
} from '../../shared/ipc/channels'
import type { ModelClient } from '../../runtime/model/ModelClient'
import { ImageStore } from '../../runtime/storage/ImageStore'
import { getSessionStore } from '../services/SessionStoreHost'
import { resolveSessionModelConfig } from '../services/sessionModelConfig'
import { createModelClient } from '../services/createModelClient'
import {
  loadLearningNodeMaterial,
  loadLearningSource,
  startLearningBuild,
  stopLearningBuild,
  loadLearningSurface,
  setLearningSurfaceBroadcaster,
  submitLearningSurfaceCommand
} from '../learning/LearningSurfaceHost'

export function registerLearningHandler(
  getMainWindow: () => BrowserWindow | null,
  getModelClient: () => ModelClient | null,
  getImageStore: () => ImageStore
): void {
  setLearningSurfaceBroadcaster((sessionId: string | null, workspaceRoot: string) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(LEARNING_SURFACE_CHANGED, { sessionId, workspaceRoot })
  })

  handle(LEARNING_BUILD, async (_event, params: { sessionId: string }) => {
    const session = getSessionStore().loadMetadata(params.sessionId)
    const sessionConfig = session ? resolveSessionModelConfig(session) : null
    const model = sessionConfig ? createModelClient(sessionConfig) : getModelClient()
    return startLearningBuild(params.sessionId, model)
  })
  handle(LEARNING_CANCEL_BUILD, async (_event, params: { sessionId: string }) => stopLearningBuild(params.sessionId))
  handle(LEARNING_GET_SOURCE, async (_event, params: { sessionId: string; nodeId: string; receiptId: string }) =>
    loadLearningSource(params.sessionId, params.nodeId, params.receiptId))

  handle(LEARNING_GET_SURFACE, async (_event, params: { sessionId: string }) => {
    return loadLearningSurface(params.sessionId)
  })

  handle(LEARNING_GET_NODE_MATERIAL, async (_event, params: { sessionId: string; nodeId: string }) => {
    return loadLearningNodeMaterial(params.sessionId, params.nodeId)
  })

  handle(LEARNING_COMMAND, async (_event, params: { sessionId: string; command: unknown }) => {
    return submitLearningSurfaceCommand(
      { sessionId: params.sessionId, command: params.command },
      { getMainWindow, getModelClient, getImageStore }
    )
  })
}
