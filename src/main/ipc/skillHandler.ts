/**
 * Skill IPC 处理器 — 暴露 skill:* 命令
 */
import { ipcMain } from 'electron'
import {
  SKILL_LIST,
  SKILL_GET,
  SKILL_CREATE,
  SKILL_DELETE,
  SKILL_TOGGLE,
  SKILL_IMPORT,
  SKILL_EXPORT,
  SKILL_RELOAD
} from '../../shared/ipc/channels'
import {
  getSkillService,
  refreshSkillsAfterMutation,
  reloadSkillsForWorkspace
} from '../services/SkillServiceHost'
import type { SkillCreateInput, SkillImportInput } from '../../shared/skills/types'

export function registerSkillHandler(): void {
  const service = () => getSkillService()

  ipcMain.handle(SKILL_LIST, async () => service().list())

  ipcMain.handle(SKILL_GET, async (_event, name: string) => service().get(name))

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
    const imported = service().import(input)
    refreshSkillsAfterMutation()
    return imported
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
