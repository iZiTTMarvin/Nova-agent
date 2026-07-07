/**
 * 主进程落盘日志（electron-log）
 *
 * 日志目录：%APPDATA%/Nova Agent/logs/（按天滚动、限制总大小）
 */
import log from 'electron-log'
import { app } from 'electron'
import path from 'path'

const MAX_LOG_BYTES = 20 * 1024 * 1024

/** 初始化文件日志与全局异常钩子（主进程入口最早调用） */
export function initMainLogger(): typeof log {
  const logsDir = path.join(app.getPath('userData'), 'logs')

  log.transports.file.resolvePathFn = (_variables, message) => {
    const date = message?.date ?? new Date()
    const day = date.toISOString().slice(0, 10)
    return path.join(logsDir, `main-${day}.log`)
  }
  log.transports.file.maxSize = MAX_LOG_BYTES
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

  // 开发态仍输出到控制台，生产态以文件为主
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info'

  process.on('uncaughtException', (error) => {
    log.error('[uncaughtException]', error)
    // 不吞错：记录后交由 Node/Electron 默认行为处理
  })

  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason)
  })

  log.info('主进程日志已初始化', { logsDir })
  return log
}

export { log as mainLog }
