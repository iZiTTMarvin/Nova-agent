import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

let rgAvailable = false

export function setRgAvailable(v: boolean): void {
  rgAvailable = v
}

export function isRgAvailable(): boolean {
  return rgAvailable
}

export function findRipgrep(): string {
  if (!app.isPackaged) {
    try {
      // 使用 require 而非 import：@vscode/ripgrep 的默认导出是二进制路径字符串，
      // 其 ESM 兼容在不同打包环境下不稳定，require 可确保拿到 CJS 导出的 rgPath
      const rgPath = require('@vscode/ripgrep').rgPath as string
      if (existsSync(rgPath)) {
        return rgPath
      }
    } catch {
      // @vscode/ripgrep 未安装或加载失败
    }
  } else {
    const isWindows = process.platform === 'win32'
    const rgPath = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@vscode/ripgrep',
      'bin',
      isWindows ? 'rg.exe' : 'rg'
    )
    if (existsSync(rgPath)) {
      return rgPath
    }
  }

  return 'rg'
}
