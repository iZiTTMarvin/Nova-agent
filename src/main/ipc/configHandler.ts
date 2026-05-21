import { ipcMain, app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { SAVE_MODEL_CONFIG, LOAD_MODEL_CONFIG } from '../../shared/ipc/channels'
import type { ModelConfig } from '../../shared/config'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { getModelClient, setModelClient } from '../index'

/** 获取模型配置文件的持久化存储绝对路径 */
export function getModelConfigPath(): string {
  return join(app.getPath('userData'), 'settings', 'model.json')
}

/**
 * 注册模型配置相关的 IPC 处理器
 * 负责在本地持久化配置文件 settings/model.json，并实时实例化或更新全局的 ModelClient
 */
export function registerConfigHandler(): void {
  // 保存模型配置
  ipcMain.handle(SAVE_MODEL_CONFIG, async (_event, config: ModelConfig): Promise<void> => {
    const configPath = getModelConfigPath()
    const configDir = join(app.getPath('userData'), 'settings')

    // 确保父目录存在
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // 写入本地 JSON
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    // 实时更新主进程持有的 ModelClient 实例以保证后续 Agent 消息发送使用最新 API 信息
    const activeClient = getModelClient()
    if (activeClient) {
      activeClient.updateConfig(config)
    } else {
      setModelClient(new OpenAICompatibleModelClient(config))
    }
  })

  // 读取模型配置
  ipcMain.handle(LOAD_MODEL_CONFIG, async (): Promise<ModelConfig | null> => {
    const configPath = getModelConfigPath()
    if (!fs.existsSync(configPath)) {
      return null
    }

    try {
      const content = fs.readFileSync(configPath, 'utf8')
      return JSON.parse(content) as ModelConfig
    } catch (err) {
      console.error('加载模型配置文件出错:', err)
      return null
    }
  })
}
