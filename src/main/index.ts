import { app, BrowserWindow, Menu, shell, dialog } from 'electron'
// registerSchemesAsPrivileged 必须在 app.whenReady 之前调用，放模块顶层最早执行
import { registerNovaImageScheme, registerNovaImageHandler } from './protocol/novaImageProtocol'
import { registerWindowHandler, watchWindowMaximizeState } from './ipc/windowHandler'
import { resolveAppIconPath } from './appIcon'
import { join } from 'path'
import { spawn } from 'child_process'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { registerAgentHandler } from './ipc/agentHandler'
import { syncTavilyApiKeyFromSettings } from '../runtime/settings/syncTavilyApiKey'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig, loadLlmRegistry } from '../runtime/model/config'
import { resolveActiveModelConfig } from '../shared/config/llmRegistry'
import { resolveCacheProfile } from '../runtime/model/cacheProfile'
import { findRipgrep, setRgAvailable } from '../runtime/tools/find-rg'
import type { ModelClient } from '../runtime/model/ModelClient'
import type { Mode } from '../shared/session'
import { bindSkillServiceWindow, getSkillService } from './services/SkillServiceHost'
import { closeMemoryService } from './services/MemoryServiceHost'
import { flushCurrentSessionOnQuit } from './services/MemoryConsolidationHost'
import { getWorkspaceService } from './services/WorkspaceService'
import { closeAllSessionIndexes } from '../runtime/sessions/SessionIndexHost'
import { installMainLoopLagMonitor } from './diagnostics/mainLoopLagMonitor'
import { getMainWindow, setMainWindow } from './mainWindowRef'
import { initMainLogger, mainLog } from './logger'
import { initAutoUpdater } from './updater'
import { bindRegistryApiKeyCrypto } from '../runtime/model/registryCrypto'
import { decryptApiKeyFromDisk, encryptApiKeyForDisk } from './services/apiKeyStorage'
import { runXForgeTestGateSmoke } from './diagnostics/xforgeTestGateSmoke'

/** 退出流程是否已进入同步落盘阶段（可重入守卫） */
let quitInProgress = false
let requestedExitCode = 0

/** 渲染进程崩溃自动恢复次数上限（防循环崩溃） */
const MAX_RENDER_RELOAD_ATTEMPTS = 3
let renderReloadAttempts = 0

/** 模型客户端实例，运行时通过配置初始化 */
let modelClient: ModelClient | null = null

/** 当前选择的本地项目目录绝对路径 */
let currentProjectPath: string | null = null

/** 当前运行模式，默认协作模式 */
let currentMode: Mode = 'default'

/** 获取主窗口实例 */
export { getMainWindow } from './mainWindowRef'

// 注册 nova-image:// scheme 属性。必须在 app.whenReady 之前执行，
// 否则 registerSchemesAsPrivileged 静默失败，<img src="nova-image://..."> 无法加载。
registerNovaImageScheme()

/** 获取模型客户端 */
export function getModelClient(): ModelClient | null {
  return modelClient
}

/** 设置模型客户端 */
export function setModelClient(client: ModelClient | null): void {
  modelClient = client
}

/** 获取当前工作区路径 */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

/** 设置当前工作区路径 */
export function setCurrentProjectPath(path: string | null): void {
  currentProjectPath = path
}

/** 获取当前模式 */
export function getCurrentMode(): Mode {
  return currentMode
}

/** 设置当前模式 */
export function setCurrentMode(mode: Mode): void {
  currentMode = mode
}

/**
 * 启动时自动载入持久化的模型配置以提供免配直接运行体验
 * 使用 runtime/model/config 模块统一管理配置文件的读取逻辑
 */
function loadModelConfigOnStartup(): void {
  try {
    const config = loadModelConfig(app.getPath('userData'))
    if (config) {
      const client = new OpenAICompatibleModelClient(config)
      const profile = resolveCacheProfile(config.baseUrl, config.modelId, {
        cacheProfile: config.cacheProfile,
        cacheStrategy: config.cacheStrategy
      })
      client.setCacheStrategy(profile.marker === 'cache_control' ? 'anthropic' : 'auto')
      modelClient = client
      return
    }
    // 无活跃模型时尝试加载注册表（可能全部未配置 key）
    const registry = loadLlmRegistry(app.getPath('userData'))
    if (registry) {
      const active = resolveActiveModelConfig(registry)
      if (active) {
        const client = new OpenAICompatibleModelClient(active)
        const profile = resolveCacheProfile(active.baseUrl, active.modelId, {
          cacheProfile: active.cacheProfile,
          cacheStrategy: active.cacheStrategy
        })
        client.setCacheStrategy(profile.marker === 'cache_control' ? 'anthropic' : 'auto')
        modelClient = client
      }
    }
  } catch (err) {
    console.error('启动时加载持久化配置失败:', err)
  }
}

/**
 * 探测 ripgrep 是否可用
 * 尝试执行 rg --version，成功则标记 rgAvailable = true
 */
async function probeRipgrep(): Promise<void> {
  try {
    const rgPath = findRipgrep()
    await new Promise<void>((resolve, reject) => {
      const p = spawn(rgPath, ['--version'], { timeout: 5000 })
      p.on('close', (code) => code === 0 ? resolve() : reject())
      p.on('error', reject)
    })
    setRgAvailable(true)
  } catch {
    setRgAvailable(false)
    console.warn('[nova-agent] ripgrep 未就绪，grep 将降级为 Node.js 基础搜索')
  }
}

/**
 * 创建应用主窗口
 * 加载 renderer 页面，开发环境使用 dev server，生产环境加载构建产物
 */
function createMainWindow(): void {
  const iconPath = resolveAppIconPath()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    frame: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    },
    title: 'Nova Agent',
    show: false
  })
  setMainWindow(win)

  win.on('ready-to-show', () => {
    if (getMainWindow()) {
      watchWindowMaximizeState(win)
      bindSkillServiceWindow(win)
    }
    win.show()
  })

  win.on('closed', () => {
    setMainWindow(null)
  })

  const contents = win.webContents

  // 导航安全：永不在应用内开新窗口；http(s) 外链走系统浏览器
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl.startsWith('http://') || navigationUrl.startsWith('https://')) {
      event.preventDefault()
      void shell.openExternal(navigationUrl)
    }
  })

  // 渲染进程崩溃自愈：记日志 + reload（带上限防循环）
  contents.on('render-process-gone', (_event, details) => {
    mainLog.error('[render-process-gone]', details)
    if (renderReloadAttempts >= MAX_RENDER_RELOAD_ATTEMPTS) {
      void dialog.showMessageBox(win, {
        type: 'error',
        title: 'Nova Agent',
        message: '界面多次崩溃，请重启应用。',
        buttons: ['确定']
      })
      return
    }
    renderReloadAttempts++
    if (!contents.isDestroyed()) {
      contents.reload()
    }
  })

  contents.on('did-finish-load', () => {
    renderReloadAttempts = 0
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 开发模式下自动打开开发者工具（修复 F12 打不开的问题）
  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools({ mode: 'right' })
  }
}

app.whenReady().then(async () => {
  if (process.env.NOVA_XFORGE_TEST_GATE_SMOKE === '1') {
    try {
      const result = await runXForgeTestGateSmoke()
      console.log(`[xforge-test-gate-smoke] ${JSON.stringify(result)}`)
      requestedExitCode = result.exitCode === 0 && !result.timedOut && !result.blockedReason ? 0 : 1
      app.exit(requestedExitCode)
    } catch (error) {
      console.error('[xforge-test-gate-smoke] failed:', error)
      requestedExitCode = 1
      app.exit(requestedExitCode)
    }
    return
  }

  initMainLogger()
  bindRegistryApiKeyCrypto(encryptApiKeyForDisk, decryptApiKeyFromDisk)

  // Windows 任务栏分组与固定快捷方式需要稳定的 AppUserModelId
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.nova-agent.app')
  }

  // 0. 主进程 event-loop lag 采样（只读观测，dev 下暴露 window.__novaMainLoopLag）
  installMainLoopLagMonitor({ devOnly: true })

  // 1. 移除默认菜单栏，使用自定义标题栏
  Menu.setApplicationMenu(null)

  // 2. 尝试从本地加载模型配置以初始化 modelClient
  //    同步毫秒级；保留在 show 前避免「用户极快点击发送时模型未就绪」窗口。
  loadModelConfigOnStartup()

  // 3. 注册所有 renderer → main 的 IPC 处理器（含 WorkspaceService.initOnStartup → store.list）
  //    必须在 createMainWindow 之前完成：renderer mount 即发 workspace:get / window-is-maximized 等
  //    invoke，handler 未注册会 reject；且 initOnStartup 不 broadcast，延后会让侧边栏永久空。
  //    返回 ImageStore 实例：nova-image:// 协议 handler 需复用它读盘。
  const imageStore = registerIpcHandlers()

  // 4. 注册 Agent 运行时专属事件与通道（复用 imageStore，用于历史图片 URL→base64 转换）
  registerAgentHandler(getMainWindow, getModelClient, () => imageStore)

  // 4.5. 注册窗口控制的 IPC 处理器
  registerWindowHandler(getMainWindow)

  // 4.6. 注册 nova-image:// 协议 handler（必须在 createMainWindow 之前；
  //      scheme 属性已在模块顶层通过 registerSchemesAsPrivileged 注册）
  registerNovaImageHandler(imageStore)

  // 5. 创建渲染视窗（窗口尽早诞生，loadURL → ready-to-show → show 异步进行）
  createMainWindow()

  initAutoUpdater(getMainWindow)

  // ── 6. 窗口已开始加载，把不阻塞首屏的重活推迟到下一个事件循环 tick ──
  //    这些步骤均有降级或非首屏路径依赖：
  //    - probeRipgrep：rgAvailable 默认 false，grep 工具自动降级 Node 搜索（不崩）；
  //      原 await spawn(timeout:5000) 是首屏 LCP 5.57s 的主因，改后台执行后不再阻塞窗口诞生。
  //    - getSkillService().load(null)：builtin 技能预热，send-message/selectSession 有 load(projectPath) 兜底。
  //    - syncTavilyApiKeyFromSettings：仅设置环境变量供 web_search，非首屏路径。
  //    注意：runStartupStorageGc 仍在 registerIpcHandlers 内同步执行（次要耗时，且为减小改动面保留）。
  setImmediate(() => {
    void probeRipgrep()
    getSkillService().load(null)
    syncTavilyApiKeyFromSettings()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', (event) => {
  if (quitInProgress) return

  event.preventDefault()
  quitInProgress = true

  try {
    const ws = getWorkspaceService().getState()
    if (ws.currentSessionId && ws.currentProjectPath) {
      // 退出路径永不跑 LLM 提炼，仅同步 drain + 写盘
      flushCurrentSessionOnQuit(ws.currentSessionId, ws.currentProjectPath)
    }
  } catch {
    // WorkspaceService 未初始化时跳过
  }
  closeMemoryService()
  // 与 Memory 一致：退出前释放全部会话索引 SQLite 句柄，避免残留锁
  closeAllSessionIndexes()
  app.exit(requestedExitCode)
})
