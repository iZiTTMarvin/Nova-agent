import { ipcMain, app } from 'electron'
import { SAVE_MODEL_CONFIG, LOAD_MODEL_CONFIG } from '../../shared/ipc/channels'
import type { ModelConfig } from '../../shared/config'
import { saveModelConfig, loadModelConfig } from '../../runtime/model/config'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { getModelClient, setModelClient } from '../index'

/**
 * 注册模型配置相关的 IPC 处理器
 * 
 * 职责：
 * 1. save-model-config：持久化 → 实时更新全局 ModelClient
 *    校验由 saveModelConfig 内部统一执行，失败时抛出异常，前端 catch 展示
 * 2. load-model-config：从磁盘读取配置回传给渲染进程
 */
export function registerConfigHandler(): void {
  // 保存模型配置（校验由 saveModelConfig 统一执行）
  ipcMain.handle(SAVE_MODEL_CONFIG, async (_event, rawConfig: ModelConfig): Promise<void> => {
    // saveModelConfig 内部校验并持久化；校验失败会抛异常，IPC 会自动将错误传回 renderer
    const config = saveModelConfig(rawConfig, app.getPath('userData'))

    // 实时更新主进程持有的 ModelClient 实例以保证后续 Agent 消息发送使用最新配置
    const activeClient = getModelClient()
    if (activeClient) {
      activeClient.updateConfig(config)
    } else {
      setModelClient(new OpenAICompatibleModelClient(config))
    }
  })

  // 读取模型配置（校验由 loadModelConfig 统一执行）
  ipcMain.handle(LOAD_MODEL_CONFIG, async (): Promise<ModelConfig | null> => {
    return loadModelConfig(app.getPath('userData'))
  })
}
