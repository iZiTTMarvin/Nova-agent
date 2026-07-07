import { existsSync } from 'fs'

let rgAvailable = false

export function setRgAvailable(v: boolean): void {
  rgAvailable = v
}

export function isRgAvailable(): boolean {
  return rgAvailable
}

export function findRipgrep(): string {
  try {
    // 开发与打包均通过包入口解析 rgPath；asarUnpack 后 require 可正常加载
    const rgPath = require('@vscode/ripgrep').rgPath as string
    if (existsSync(rgPath)) {
      return rgPath
    }
  } catch {
    // @vscode/ripgrep 未安装或加载失败
  }

  return 'rg'
}
