/**
 * 打开当前会话 active plan 文件（阶段条「计划」节点详情入口）
 */
import { join } from 'path'
import { shell } from 'electron'
import { handle } from './secureIpc'
import { WORKSPACE_OPEN_ACTIVE_PLAN } from '../../shared/ipc/channels'
import { getSessionStore } from '../services/SessionStoreHost'
import { getWorkspaceService } from '../services/WorkspaceService'

export function registerPlanFileHandler(): void {
  handle(WORKSPACE_OPEN_ACTIVE_PLAN, async (_event, params: { sessionId?: unknown }) => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw new Error('缺少会话 ID')
    const session = getSessionStore().load(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    // readActivePlan 内部校验 `.nova/plans/*.md` 真实普通文件边界，避免被诱导打开任意路径
    const doc = getWorkspaceService().readActivePlan({ sessionId })
    if (!doc) throw new Error('当前会话没有可打开的计划文件')
    const err = await shell.openPath(join(session.workspaceRoot, doc.path))
    if (err) throw new Error(`无法打开计划文件：${err}`)
  })
}
