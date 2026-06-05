/**
 * bash 工具的内部类型定义
 *
 * 这些类型描述了 bash 工具内部子模块之间的契约，与上层 ToolExecutor 接口
 * （`./types`）解耦，便于独立测试和后续替换执行后端。
 */

/** 可插拔执行后端接口，默认实现为本地 shell 执行。 */
export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      /** 子进程输出回调（stdout 与 stderr 合并），用于实时喂给 OutputAccumulator */
      onData: (data: Buffer) => void
      /** 取消信号；abort 触发后后端应负责终止进程树 */
      signal?: AbortSignal
      /** 进程环境变量 */
      env?: NodeJS.ProcessEnv
      /**
       * 子进程句柄回调：后端创建 child 后立即调用一次。
       * 上层用它做"后端未响应 abort 时的兜底杀进程"。
       * 不传则无副作用。
       */
      onChild?: (child: import('child_process').ChildProcess | null) => void
    }
  ): Promise<{ exitCode: number | null }>
}

/** Shell 可执行文件 + 启动参数 + 显示名。 */
export interface ShellConfig {
  /** 可执行文件绝对路径 */
  shell: string
  /** spawn 时紧随其后的参数（如 pwsh 的 -NoLogo / -NoProfile） */
  args: string[]
  /** 显示名（bash / pwsh / cmd），用于动态描述生成 */
  name: string
}

/** bash 工具 JSON Schema 入参（毫秒级超时、相对 workdir、可选描述）。 */
export interface BashToolParams {
  command: string
  /** 超时（毫秒），默认 120000，最大 300000 */
  timeout?: number
  /** 相对 workingDir 的工作目录（可选），不填则在 workingDir 执行 */
  workdir?: string
  /** 5-10 词的简短描述（可选） */
  description?: string
}

/** 截断结果详情。 */
export interface TruncationResult {
  /** 截断后的内容 */
  content: string
  /** 是否发生过截断（按行或按字节） */
  truncated: boolean
  /** 触发截断的限制维度 */
  truncatedBy: 'lines' | 'bytes' | null
  /** 原始总行数 */
  totalLines: number
  /** 原始总字节数 */
  totalBytes: number
  /** 截断后实际返回的行数 */
  outputLines: number
  /** 截断后实际返回的字节数 */
  outputBytes: number
  /** 最后一行本身是否被按字节截断（截掉了一部分） */
  lastLinePartial: boolean
  /** 完整输出落盘的临时文件路径（仅在被截断时设置） */
  fullOutputPath?: string
}

/** 截断选项。 */
export interface TruncationOptions {
  maxLines?: number
  maxBytes?: number
  /** 仅 truncateHead 使用：是否仅返回头部（不关心尾部内容） */
  mode?: 'head' | 'tail'
}

/** OutputAccumulator 的快照。 */
export interface OutputSnapshot {
  /** 截断后的内容 */
  content: string
  /** 完整文本（即使超过限制也尽量保留在内存中） */
  fullText: string
  /** 是否被截断 */
  truncated: boolean
  /** 截断维度 */
  truncatedBy: 'lines' | 'bytes' | null
  /** 原始总行数 */
  totalLines: number
  /** 原始总字节数 */
  totalBytes: number
  /** 输出行数 */
  outputLines: number
  /** 输出字节数 */
  outputBytes: number
  /** 最后一行是否被按字节截断 */
  lastLinePartial: boolean
  /** 完整输出落盘的临时文件路径（仅在被截断时设置） */
  fullOutputPath?: string
}
