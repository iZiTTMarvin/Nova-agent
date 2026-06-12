/**
 * Skill IPC 处理器 — 暴露 skill:* 命令
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  SKILL_LIST,
  SKILL_GET,
  SKILL_GET_BODY,
  SKILL_CREATE,
  SKILL_DELETE,
  SKILL_TOGGLE,
  SKILL_IMPORT,
  SKILL_EXPORT,
  SKILL_RELOAD,
  SKILL_PICK_IMPORT
} from '../../shared/ipc/channels'
import {
  getSkillService,
  refreshSkillsAfterMutation,
  reloadSkillsForWorkspace
} from '../services/SkillServiceHost'
import type { SkillCreateInput, SkillImportInput } from '../../shared/skills/types'

export function registerSkillHandler(getMainWindow?: () => BrowserWindow | null): void {
  const service = () => getSkillService()

  ipcMain.handle(SKILL_LIST, async () => service().list())

  ipcMain.handle(SKILL_GET, async (_event, name: string) => service().get(name))

  ipcMain.handle(SKILL_GET_BODY, async (_event, name: string) => service().getBody(name))

  ipcMain.handle(SKILL_CREATE, async (_event, input: SkillCreateInput) => {
    const created = service().create(input)
    refreshSkillsAfterMutation()
    return created
  })

  ipcMain.handle(SKILL_DELETE, async (_event, name: string) => {
    service().delete(name)
    refreshSkillsAfterMutation()
  })

  ipcMain.handle(SKILL_TOGGLE, async (_event, params: { name: string; enabled: boolean }) => {
    const updated = service().toggle(params.name, params.enabled)
    refreshSkillsAfterMutation()
    return updated
  })

  ipcMain.handle(SKILL_IMPORT, async (_event, input: SkillImportInput) => {
    const imported = await service().import(input)
    refreshSkillsAfterMutation()
    return imported
  })

  ipcMain.handle(SKILL_PICK_IMPORT, async () => {
    const window = getMainWindow?.() ?? null
    const dialogOptions = {
      title: '选择技能 zip 包',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(SKILL_EXPORT, async (_event, name: string) => {
    return service().export(name)
  })

  ipcMain.handle(SKILL_RELOAD, async (_event, workspaceRoot?: string | null) => {
    if (workspaceRoot !== undefined) {
      reloadSkillsForWorkspace(workspaceRoot)
    } else {
      refreshSkillsAfterMutation()
    }
    return service().getReloadResult()
  })
}
