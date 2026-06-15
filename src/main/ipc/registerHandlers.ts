import { ipcMain } from 'electron'
import { PING } from '../../shared/ipc/channels'
import { registerProjectHandler } from './projectHandler'
import { registerConfigHandler } from './configHandler'
import { registerModeHandler } from './modeHandler'
import { registerSessionHandler } from './sessionHandler'
import { registerSkillHandler } from './skillHandler'
import { registerSettingsHandler } from './settingsHandler'
import { registerRulesHandler } from './rulesHandler'
import { registerSubagentsHandler } from './subagentsHandler'
import { registerWorkspaceHandler } from './workspaceHandler'
import { registerPermissionHandler } from './permissionHandler'
import { initWorkspaceService } from '../services/WorkspaceService'
import { getSessionStore } from './sessionHandler'
import { getMainWindow } from '../index'

/**
 * 注册所有主进程与渲染进程的 IPC 命令通信处理器
 * 统一分发并代理各类具体功能处理器
 */
export function registerIpcHandlers(): void {
  // ping/pong 基础连通测试
  ipcMain.handle(PING, async () => {
    return 'pong'
  })

  // 注册项目目录选择 IPC
  registerProjectHandler(getMainWindow)

  // 注册模型配置存取 IPC
  registerConfigHandler()

  // 注册运行模式切换 IPC
  registerModeHandler()

  // 注册会话管理与回退操作 IPC（必须在 workspaceHandler 之前，初始化 SessionStore）
  registerSessionHandler()

  // 注册技能管理 IPC
  registerSkillHandler(getMainWindow)

  // 设置 / 规则 / 子代理 IPC
  registerSettingsHandler()
  registerRulesHandler()
  registerSubagentsHandler()

  // ── 工作区单一事实源（PRD §5.1） ──
  // SessionStore 已由 registerSessionHandler 初始化，这里构建 WorkspaceService 并注册其 IPC。
  // 启动时从磁盘加载会话列表，让 renderer 首屏即可拿到 availableSessions。
  const workspaceService = initWorkspaceService({
    getSessionStore,
    getMainWindow
  })
  workspaceService.initOnStartup()
  registerWorkspaceHandler(getMainWindow)

  // 权限持久化规则（PRD §5.2）
  registerPermissionHandler()
}
