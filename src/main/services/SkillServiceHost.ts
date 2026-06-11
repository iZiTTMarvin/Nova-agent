/**
 * SkillServiceHost — 主进程单例宿主
 * 绑定 BrowserWindow，在变更时推送 skill:changed；启动与切工作区时 reload
 */
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { SkillService } from '../../runtime/skills/SkillService'
import type { SkillSummary } from '../../shared/skills/types'
import { SKILL_CHANGED } from '../../shared/ipc/channels'

let skillService: SkillService | null = null
let boundWindow: BrowserWindow | null = null

/** 获取或初始化 SkillService 单例 */
export function getSkillService(): SkillService {
  if (!skillService) {
    skillService = new SkillService({
      getAppPath: () => app.getAppPath()
    })
    skillService.load(null)
  }
  return skillService
}

/** 绑定主窗口，用于 skill:changed 推送 */
export function bindSkillServiceWindow(win: BrowserWindow | null): void {
  boundWindow = win
}

/** 向渲染进程广播技能列表变更 */
export function emitSkillChanged(skills?: SkillSummary[]): void {
  const payload = skills ?? getSkillService().list()
  const win = boundWindow
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed()) return
  wc.send(SKILL_CHANGED, { skills: payload })
}

/**
 * 切换工作区后重新加载技能并通知 UI
 */
export function reloadSkillsForWorkspace(workspaceRoot: string | null): void {
  getSkillService().load(workspaceRoot)
  emitSkillChanged()
}

/** 变更后统一 reload + 推送 */
export function refreshSkillsAfterMutation(): void {
  getSkillService().reload()
  emitSkillChanged()
}
