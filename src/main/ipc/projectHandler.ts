import { dialog, BrowserWindow } from 'electron'
import { handle } from './secureIpc'
import { SELECT_PROJECT } from '../../shared/ipc/channels'
import { setCurrentProjectPath } from '../index'
import { reloadSkillsForWorkspace } from '../services/SkillServiceHost'

/**
 * 注册项目选择相关的 IPC 处理器
 * 允许渲染进程通过 Electron 原生对话框选择本地工作区目录
 * 
 * @param getMainWindow 获取当前活跃的主窗口实例，用作对话框的父窗口
 */
export function registerProjectHandler(getMainWindow: () => BrowserWindow | null): void {
  handle(SELECT_PROJECT, async (): Promise<string | null> => {
    const window = getMainWindow()
    if (!window) {
      return null
    }

    // 弹出文件夹选择对话框，限制只能选择目录
    const result = await dialog.showOpenDialog(window, {
      title: '选择本地项目工作区',
      properties: ['openDirectory', 'createDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    
    // 同步更新主进程维护的全局项目路径，以供 AgentLoop 启动时作为 workingDir 边界
    setCurrentProjectPath(selectedPath)
    reloadSkillsForWorkspace(selectedPath)

    return selectedPath
  })
}
