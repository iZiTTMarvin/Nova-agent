/**
 * bashTool — 兼容层。
 *
 * 历史：原本是 306 行的单文件实现。Bash 工具重构后，逻辑被拆分到
 * `src/runtime/tools/bash/` 下的多个子模块（shell / truncate /
 * output-accumulator / prompt / index）。
 *
 * 保留这个文件作为 re-export，避免上层调用方（ToolRegistry / AgentLoop /
 * agentHandler）改动导入路径。这是 Bash 工具重构的兼容性兜底。
 */
export { bashTool, getBashDescription, setBashOperations } from './bash'
export type { BashToolParams } from './bash'
