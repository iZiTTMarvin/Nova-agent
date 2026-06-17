/**
 * promptRenderer — 运行时读取 prompt 模板文件
 *
 * base-rules.md 在开发时位于本文件旁的 prompts/ 目录；
 * 打包后由 electron-vite 插件复制到 out/main/prompts/，与 __dirname 相对解析。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** base-rules.md 相对本模块目录的路径（开发 / 打包后均有效） */
const BASE_RULES_FILE = join(__dirname, 'prompts', 'base-rules.md')

/**
 * 读取并返回 base-rules 行为契约正文。
 * @param rulesFilePath 可选覆盖路径（仅测试用）；默认读取模块旁 prompts/base-rules.md
 * 文件缺失或读取失败时返回空字符串，不抛错。
 */
export function renderBaseRules(rulesFilePath: string = BASE_RULES_FILE): string {
  try {
    if (!existsSync(rulesFilePath)) {
      return ''
    }
    return readFileSync(rulesFilePath, 'utf-8').trim()
  } catch {
    return ''
  }
}
