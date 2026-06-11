/**
 * window.nova.skill — 技能管理 preload API
 * 对齐 docs/skill-system-design.md §5.8
 */
import { ipcRenderer } from 'electron'
import type { NovaSkillApi } from '../shared/skills/types'
import {
  SKILL_LIST,
  SKILL_GET,
  SKILL_CREATE,
  SKILL_DELETE,
  SKILL_TOGGLE,
  SKILL_IMPORT,
  SKILL_EXPORT,
  SKILL_RELOAD,
  SKILL_CHANGED
} from '../shared/ipc/channels'

export const skillApi: NovaSkillApi = {
  list: () => ipcRenderer.invoke(SKILL_LIST),

  get: (name) => ipcRenderer.invoke(SKILL_GET, name),

  create: (input) => ipcRenderer.invoke(SKILL_CREATE, input),

  delete: (name) => ipcRenderer.invoke(SKILL_DELETE, name),

  toggle: (name, enabled) => ipcRenderer.invoke(SKILL_TOGGLE, { name, enabled }),

  import: (input) => ipcRenderer.invoke(SKILL_IMPORT, input),

  export: (name) => ipcRenderer.invoke(SKILL_EXPORT, name),

  reload: (workspaceRoot) => ipcRenderer.invoke(SKILL_RELOAD, workspaceRoot),

  onChange: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { skills: import('../shared/skills/types').SkillSummary[] }) => {
      cb(data.skills)
    }
    ipcRenderer.on(SKILL_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(SKILL_CHANGED, handler)
    }
  }
}
