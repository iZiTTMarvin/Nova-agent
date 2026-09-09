/**
 * Skill IPC 处理器 — 暴露 skill:* 命令
 */
import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { handle } from './secureIpc'
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
  getCatalogSnapshot,
  getSkillService,
  refreshSkillsAfterMutation,
  reloadSkillsForWorkspace
} from '../services/SkillServiceHost'
import type { SkillCreateInput, SkillExportInput, SkillImportInput } from '../../shared/skills/types'

export function registerSkillHandler(getMainWindow?: () => BrowserWindow | null): void {
  const service = () => getSkillService()

  handle(SKILL_LIST, async () => getCatalogSnapshot())

  handle(SKILL_GET, async (_event, name: string) => service().get(name))

  handle(SKILL_GET_BODY, async (_event, name: string) => service().getBody(name))

  handle(SKILL_CREATE, async (_event, input: SkillCreateInput) => {
    const created = service().create(input)
    refreshSkillsAfterMutation()
    return created
  })

  handle(SKILL_DELETE, async (_event, name: string) => {
    service().delete(name)
    refreshSkillsAfterMutation()
  })

  handle(SKILL_TOGGLE, async (_event, params: { name: string; enabled: boolean }) => {
    const updated = service().toggle(params.name, params.enabled)
    refreshSkillsAfterMutation()
    return updated
  })

  handle(SKILL_IMPORT, async (_event, input: SkillImportInput) => {
    const imported = await service().import(input)
    refreshSkillsAfterMutation()
    return imported
  })

  handle(SKILL_PICK_IMPORT, async () => {
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

  handle(SKILL_EXPORT, async (_event, input: SkillExportInput) => {
    if (input.destPath) {
      const zipPath = await service().export(input.name, input.destPath)
      return { canceled: false, zipPath }
    }
    const window = getMainWindow?.() ?? null
    const dialogOptions = {
      title: '导出技能',
      defaultPath: join(app.getPath('downloads'), `${input.name}.zip`),
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
    }
    const result = window
      ? await dialog.showSaveDialog(window, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    const zipPath = await service().export(input.name, result.filePath)
    return { canceled: false, zipPath }
  })

  handle(SKILL_RELOAD, async (_event, workspaceRoot?: string | null) => {
    if (workspaceRoot !== undefined) {
      reloadSkillsForWorkspace(workspaceRoot)
    } else {
      refreshSkillsAfterMutation()
    }
    return service().getReloadResult()
  })
}
