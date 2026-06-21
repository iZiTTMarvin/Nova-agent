/**
 * promptRenderer — 运行时读取 prompt 模板文件
 *
 * ⚠️ 本文件【必须】留在 agent/ 根目录，与 prompts/ 资源目录同级，禁止搬进
 * promptBuilder/ 等子目录。原因：BASE_RULES_FILE 通过 __dirname 相对解析
 * base-rules.md，而 __dirname 的语义随运行环境而变：
 *   - 生产/开发态（electron-vite bundle）：__dirname 被拍平为 out/main/，
 *     资源由 copyAgentPrompts 插件复制到 out/main/prompts/，与源码位置无关；
 *   - 测试态（vitest，不 bundle）：__dirname 忠实指向源码目录，本文件与
 *     prompts/ 同级时 join(__dirname,'prompts',...) 才能命中资源。
 * 一旦把本文件移进子目录，vitest 态的 __dirname 变为该子目录，资源路径断裂，
 * renderBaseRules() 静默返回 ''，系统提示词丢失行为契约层——且所有测试因走
 * 覆盖路径而全绿，问题只在生产暴露。详见目录重组方案 §3。
 *
 * base-rules.md 在源码时位于本文件旁的 prompts/ 目录；
 * 打包后由 electron-vite 的 copyAgentPrompts 插件复制到 out/main/prompts/。
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
