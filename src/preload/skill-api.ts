/**
 * window.nova.skill — 技能管理 preload API
 * 对齐 docs/skill-system-design.md §5.8
 */
import { ipcRenderer } from 'electron'
import type { NovaSkillApi } from '../shared/skills/types'
import {
  SKILL_LIST,
  SKILL_GET,
  SKILL_GET_BODY,
  SKILL_CREATE,
  SKILL_DELETE,
  SKILL_IMPORT,
  SKILL_EXPORT,
  SKILL_RELOAD,
  SKILL_PICK_IMPORT,
  SKILL_CHANGED
} from '../shared/ipc/channels'
import { invokeMain } from './remoteInvoke'

export const skillApi: NovaSkillApi = {
  list: () => invokeMain(SKILL_LIST),

  get: (name) => invokeMain(SKILL_GET, name),

  getBody: (name) => invokeMain(SKILL_GET_BODY, name),

  create: (input) => invokeMain(SKILL_CREATE, input),

  delete: (name) => invokeMain(SKILL_DELETE, name),

  import: (input) => invokeMain(SKILL_IMPORT, input),

  export: (name, destPath) => invokeMain(SKILL_EXPORT, { name, destPath }),

  reload: (workspaceRoot) => invokeMain(SKILL_RELOAD, workspaceRoot),

  pickImportFile: () => invokeMain(SKILL_PICK_IMPORT),

  onChange: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { snapshot: import('../shared/skills/types').SkillCatalogSnapshot }) => {
      cb(data.snapshot)
    }
    ipcRenderer.on(SKILL_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(SKILL_CHANGED, handler)
    }
  }
}
