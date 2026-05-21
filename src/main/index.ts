import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { registerAgentHandler } from './ipc/agentHandler'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import type { ModelClient } from '../runtime/model/ModelClient'

/** 主窗口实例 */
let mainWindow: BrowserWindow | null = null

/** 模型客户端实例，运行时通过配置初始化 */
let modelClient: ModelClient | null = null

/**
 * 创建应用主窗口
 * 加载 renderer 页面，开发环境使用 dev server，生产环境加载构建产物
 */
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    },
    title: 'Nova Agent',
    show: false
  })

  mainWindow.on('ready-to-show', () => {
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

/** 获取主窗口实例 */
function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 获取模型客户端（S3 暂用占位逻辑，S8 会对接 Settings 持久化） */
function getModelClient(): ModelClient | null {
  return modelClient
}

app.whenReady().then(() => {
  registerIpcHandlers()
  registerAgentHandler(getMainWindow, getModelClient)
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
