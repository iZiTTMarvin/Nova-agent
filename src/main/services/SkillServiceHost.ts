/**
 * SkillServiceHost — 主进程单例宿主
 * 组装技能目录快照并在变更时推送 skill:changed；首屏后预热，切工作区与渲染端重载时 reload
 */
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { SkillService, toCatalogDiagnostics } from '../../runtime/skills/SkillService'
import { MAX_CONTEXT_SKILLS } from '../../runtime/skills/SkillLoader'
import type { SkillRegistry } from '../../runtime/skills/SkillRegistry'
import type { SkillCatalogSnapshot } from '../../shared/skills/types'
import { SKILL_CHANGED } from '../../shared/ipc/channels'

let skillService: SkillService | null = null
let boundWindow: BrowserWindow | null = null
/** 上次推送的快照；刷新中与失败时保留旧列表，避免 UI 闪空 */
let lastSnapshot: SkillCatalogSnapshot = {
  skills: [],
  loading: true,
  error: null,
  refreshedAt: null,
  diagnostics: [],
  modelBudget: { cap: MAX_CONTEXT_SKILLS, eligible: 0 }
}
let catalogWarmed = false

/** 获取或初始化 SkillService 单例；目录在首次读取时才扫描 */
export function getSkillService(): SkillService {
  if (!skillService) {
    skillService = new SkillService({
      getAppPath: () => app.getAppPath()
    })
  }
  return skillService
}

/**
 * 工作区变化后让技能目录跟随。已对齐的工作区不重复扫描；
 * 尚未读取过目录时只记录工作区，扫描留给首次读取。
 */
export function alignSkillsToWorkspace(workspaceRoot: string | null): void {
  if (!skillService || lastSnapshot.refreshedAt === null) {
    getSkillService().selectWorkspace(workspaceRoot)
    return
  }
  if (skillService.getWorkspaceRoot() === workspaceRoot) return
  reloadSkillsForWorkspace(workspaceRoot)
}

/** 绑定主窗口，用于 skill:changed 推送与重载重扫 */
export function bindSkillServiceWindow(win: BrowserWindow | null): void {
  boundWindow = win
  win?.webContents.on('did-start-navigation', rescanOnRendererReload)
}

/** 整页重载后按磁盘重扫：手动增删的技能 reload 即可见；扫描与新页面加载脚本并行，首次拉取即为新目录 */
function rescanOnRendererReload(
  event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
): void {
  if (!catalogWarmed || !event.isMainFrame || event.isSameDocument) return
  try {
    reloadAndEmit(() => getSkillService().reload())
  } catch {
    // 失败已记入错误快照，新页面拉取时展示
  }
}

/** 确保单例 registry 对齐指定工作区并返回（发送 preflight 与 runtime 装配共用） */
export function ensureSkillRegistryForWorkspace(workspaceRoot: string): SkillRegistry {
  const service = getSkillService()
  if (service.getWorkspaceRoot() !== workspaceRoot) {
    service.load(workspaceRoot)
  }
  return service.getRegistry()
}

function buildSnapshot(service: SkillService): SkillCatalogSnapshot {
  return {
    skills: service.list(),
    loading: false,
    error: null,
    refreshedAt: Date.now(),
    diagnostics: toCatalogDiagnostics(service.getRegistry()),
    modelBudget: service.getModelBudget()
  }
}

/**
 * 拉取当前快照（skill:list）。pull 不改变刷新语义，只返回上次推送状态。
 * 预热前不扫描：同步目录 IO 会堵住首屏期间的其他 IPC，此时返回 loading 快照，预热后推送终态。
 */
export function getCatalogSnapshot(): SkillCatalogSnapshot {
  if (catalogWarmed && lastSnapshot.refreshedAt === null) {
    lastSnapshot = buildSnapshot(getSkillService())
  }
  return { ...lastSnapshot }
}

/** 首屏就绪后扫描启动工作区的技能目录并推送 */
export function warmSkillCatalog(): void {
  catalogWarmed = true
  if (lastSnapshot.refreshedAt !== null) return
  lastSnapshot = buildSnapshot(getSkillService())
  emitSkillChanged()
}

/** 向渲染进程广播上次快照 */
export function emitSkillChanged(): void {
  const win = boundWindow
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed()) return
  wc.send(SKILL_CHANGED, { snapshot: lastSnapshot })
}

/**
 * 刷新并推送：先发 loading 快照，成功发终态，失败保留旧列表并广播 error。
 * 失败仍向调用方抛出，保持 skill:reload 的拒绝语义。
 */
function reloadAndEmit(reload: () => void): void {
  lastSnapshot = { ...lastSnapshot, loading: true, error: null }
  emitSkillChanged()
  try {
    reload()
  } catch (err) {
    lastSnapshot = {
      ...lastSnapshot,
      loading: false,
      error: err instanceof Error ? err.message : String(err)
    }
    emitSkillChanged()
    throw err
  }
  lastSnapshot = buildSnapshot(getSkillService())
  emitSkillChanged()
}

/**
 * 切换工作区后重新加载技能并通知 UI
 */
export function reloadSkillsForWorkspace(workspaceRoot: string | null): void {
  reloadAndEmit(() => getSkillService().load(workspaceRoot))
}

/** 变更后统一 reload + 推送 */
export function refreshSkillsAfterMutation(): void {
  reloadAndEmit(() => getSkillService().reload())
}
