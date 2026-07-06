import { app, BrowserWindow, Menu } from 'electron'
import { registerWindowHandler, watchWindowMaximizeState } from './ipc/windowHandler'
import { join } from 'path'
import { spawn } from 'child_process'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { registerAgentHandler } from './ipc/agentHandler'
import { syncTavilyApiKeyFromSettings } from '../runtime/settings/syncTavilyApiKey'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig, loadLlmRegistry } from '../runtime/model/config'
import { resolveActiveModelConfig } from '../shared/config/llmRegistry'
import { inferCacheStrategy } from '../shared/config/types'
import { findRipgrep, setRgAvailable } from '../runtime/tools/find-rg'
import type { ModelClient } from '../runtime/model/ModelClient'
import type { Mode } from '../shared/session'
import { bindSkillServiceWindow, getSkillService } from './services/SkillServiceHost'
import { closeMemoryService } from './services/MemoryServiceHost'
import { flushCurrentSessionOnQuit } from './services/MemoryConsolidationHost'
import { extractOnSessionLeave, isMemoryExtractEnabled } from './services/MemoryExtractHost'
import { getSessionStore } from './ipc/sessionHandler'
import { getWorkspaceService } from './services/WorkspaceService'
import { installMainLoopLagMonitor } from './diagnostics/mainLoopLagMonitor'

/** 主窗口实例 */
let mainWindow: BrowserWindow | null = null

/** 模型客户端实例，运行时通过配置初始化 */
let modelClient: ModelClient | null = null

/** 当前选择的本地项目目录绝对路径 */
let currentProjectPath: string | null = null

/** 当前运行模式，默认协作模式 */
let currentMode: Mode = 'default'

/** 获取主窗口实例 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

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
      if (!config.cacheStrategy) {
        client.setCacheStrategy(inferCacheStrategy(config.baseUrl))
      }
      modelClient = client
      return
    }
    // 无活跃模型时尝试加载注册表（可能全部未配置 key）
    const registry = loadLlmRegistry(app.getPath('userData'))
    if (registry) {
      const active = resolveActiveModelConfig(registry)
      if (active) {
        const client = new OpenAICompatibleModelClient(active)
        if (!active.cacheStrategy) {
          client.setCacheStrategy(inferCacheStrategy(active.baseUrl))
        }
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    },
    title: 'Nova Agent',
    show: false
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) {
      watchWindowMaximizeState(mainWindow)
      bindSkillServiceWindow(mainWindow)
    }
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 开发模式下自动打开开发者工具（修复 F12 打不开的问题）
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'right' })
  }
}

app.whenReady().then(async () => {
  // 0. 主进程 event-loop lag 采样（只读观测，dev 下暴露 window.__novaMainLoopLag）
  installMainLoopLagMonitor({ devOnly: true })

  // 0.1 探测 ripgrep 是否可用
  await probeRipgrep()

  // 1. 移除默认菜单栏，使用自定义标题栏
  Menu.setApplicationMenu(null)

  // 2. 尝试从本地加载模型配置以初始化 modelClient
  loadModelConfigOnStartup()
  
  // 3. 注册所有 renderer → main 的 IPC 处理器
  registerIpcHandlers()

  // 3.1 启动时同步 Tavily API Key 到环境变量（供 web_search 工具使用）
  syncTavilyApiKeyFromSettings()

  // 3.5 应用启动时加载内置 + 全局技能（无需先发消息）
  getSkillService().load(null)
  
  // 4. 注册 Agent 运行时专属事件与通道
  registerAgentHandler(getMainWindow, getModelClient)

  // 4.5. 注册窗口控制的 IPC 处理器
  registerWindowHandler(getMainWindow)
  
  // 5. 创建渲染视窗
  createMainWindow()

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

app.on('will-quit', () => {
  try {
    const ws = getWorkspaceService().getState()
    if (ws.currentSessionId && ws.currentProjectPath) {
      if (isMemoryExtractEnabled()) {
        extractOnSessionLeave(ws.currentSessionId, ws.currentProjectPath, getSessionStore())
      } else {
        flushCurrentSessionOnQuit(ws.currentSessionId, ws.currentProjectPath)
      }
    }
  } catch {
    // WorkspaceService 未初始化时跳过
  }
  closeMemoryService()
})
