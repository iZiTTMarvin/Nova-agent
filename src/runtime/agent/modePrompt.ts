import type { Mode } from '../../shared/session/types'

const BASE_PROMPT = [
  '你是 Nova 的编程助手。',
  '你要基于当前工作区和工具结果回答，保持诚实、具体、可执行。'
].join('\n')

const PLAN_PROMPT = [
  BASE_PROMPT,
  '当前处于 plan 模式。这是只读规划模式。',
  '你只能读取和分析项目，只能使用只读工具（ls、read、grep、find）。',
  '你不能编辑文件、不能写入内容、不能执行 bash，也不能声称自己已经创建、修改或保存了任何文件。',
  '你的输出应该是分析、计划、风险说明和需要确认的问题。',
  '不要把完整可直接落盘的实现文件内容当作写入工具的替代品输出到正文里。',
  '如果用户明确要求直接实现，请明确说明需要切换到 default 或 auto 模式。'
].join('\n')

const DEFAULT_PROMPT = [
  BASE_PROMPT,
  '当前处于 default 模式。你可以结合工具读取、修改和验证工作区；遇到需要确认的高风险操作，系统会接管审批。'
].join('\n')

const AUTO_PROMPT = [
  BASE_PROMPT,
  '当前处于 auto 模式。你可以更主动地推进实现和验证，但仍然要遵守工具权限与安全边界。'
].join('\n')

/** 根据模式生成系统提示词，让模型和工具可见性使用同一份模式心智 */
export function getSystemPromptForMode(mode: Mode): string {
  switch (mode) {
    case 'plan':
      return PLAN_PROMPT
    case 'auto':
      return AUTO_PROMPT
    case 'default':
    default:
      return DEFAULT_PROMPT
  }
}
