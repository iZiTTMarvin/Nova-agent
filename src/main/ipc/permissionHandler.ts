/**
 * permissionHandler — 权限规则持久化 IPC（PRD §5.2）
 *
 * 注册 permission:list / upsert / delete 命令，委托给 PermissionService。
 *
 * 安全约束（PRD §5.2.5）：
 * - 项目级规则的 projectPath 必须是当前打开的项目路径，否则拒绝（防恶意项目静默写规则）。
 * - 当前项目路径从 main 进程全局状态读取，不接受 renderer 传入的任意路径。
 */
import { ipcMain } from 'electron'
import { grantSessionPermission } from '../../runtime/permissions/PermissionManager'
import { PERMISSION_LIST, PERMISSION_UPSERT, PERMISSION_DELETE, PERMISSION_GRANT_SESSION_SCOPE } from '../../shared/ipc/channels'
import {
  listPermissionRules,
  upsertPermissionRule,
  deletePermissionRule
} from '../../runtime/permissions/PermissionService'
import type { PermissionRule } from '../../runtime/permissions/PermissionRule'
import type {
  PermissionRuleDto,
  PermissionListParams,
  PermissionUpsertParams,
  PermissionDeleteParams
} from '../../shared/permissions/types'
import { getCurrentProjectPath } from '../index'

/** runtime PermissionRule → IPC dto */
function toDto(rule: PermissionRule): PermissionRuleDto {
  return { ...rule }
}

export function registerPermissionHandler(): void {
  ipcMain.handle(PERMISSION_LIST, async (_event, params: PermissionListParams) => {
    // projectPath 优先用 renderer 传入值，兜底用主进程当前项目路径
    const projectPath = params?.projectPath ?? getCurrentProjectPath()
    const rules = listPermissionRules(projectPath)
    return rules.map(toDto)
  })

  ipcMain.handle(PERMISSION_UPSERT, async (_event, params: PermissionUpsertParams) => {
    // 安全校验：项目级规则的 projectPath 必须等于当前打开项目
    if (params.scope === 'project') {
      const current = getCurrentProjectPath()
      if (!current) {
        throw new Error('当前没有打开的项目，无法创建项目级权限规则')
      }
      if (params.projectPath && params.projectPath !== current) {
        throw new Error('项目级权限规则只能为当前打开的项目创建（安全约束）')
      }
      // 以主进程权威路径为准，忽略 renderer 传入
      params = { ...params, projectPath: current }
    }

    const rule = upsertPermissionRule({
      toolName: params.toolName,
      behavior: params.behavior,
      scope: params.scope,
      ...(params.scope === 'project' ? { projectPath: params.projectPath } : {}),
      ...(params.commandPrefix !== undefined ? { commandPrefix: params.commandPrefix } : {}),
      ...(params.commandRegex !== undefined ? { commandRegex: params.commandRegex } : {}),
      ...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
      ...(params.description !== undefined ? { description: params.description } : {})
    })
    return toDto(rule)
  })

  ipcMain.handle(PERMISSION_DELETE, async (_event, params: PermissionDeleteParams) => {
    const projectPath = params.projectPath ?? getCurrentProjectPath()
    const deleted = deletePermissionRule(params.ruleId, projectPath)
    return { deleted }
  })

  ipcMain.handle(PERMISSION_GRANT_SESSION_SCOPE, async (_event, params: { sessionId: string; commandPrefix: string }) => {
    grantSessionPermission(params.sessionId, params.commandPrefix)
  })
}
