import { app, BrowserWindow, Menu } from 'electron'
import { registerWindowHandler, watchWindowMaximizeState } from './ipc/windowHandler'
import { join } from 'path'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { registerAgentHandler } from './ipc/agentHandler'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig as loadPersistedModelConfig } from '../runtime/model/config'
import type { ModelClient } from '../runtime/model/ModelClient'
import type { Mode } from '../shared/session'

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
    const config = loadPersistedModelConfig(app.getPath('userData'))
    if (config) {
      modelClient = new OpenAICompatibleModelClient(config)
    }
  } catch (err) {
    console.error('启动时加载持久化配置失败:', err)
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
}

app.whenReady().then(() => {
  // 0. 移除默认菜单栏，使用自定义标题栏
  Menu.setApplicationMenu(null)

  // 1. 尝试从本地加载模型配置以初始化 modelClient
  loadModelConfigOnStartup()
  
  // 2. 注册所有 renderer → main 的 IPC 处理器
  registerIpcHandlers()
  
  // 3. 注册 Agent 运行时专属事件与通道
  registerAgentHandler(getMainWindow, getModelClient)

  // 3.5. 注册窗口控制的 IPC 处理器
  registerWindowHandler(getMainWindow)
  
  // 4. 创建渲染视窗
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
