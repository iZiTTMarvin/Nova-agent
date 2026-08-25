/**
 * 持久进程会话契约：registry、进程调用方（bash 工具）与读取方共用的唯一类型来源。
 */

export type ProcessSessionState = 'running' | 'exited'

export type ProcessSessionSource = 'main-run' | 'subagent-run'

export interface ProcessOwner {
  sessionId: string
  runId: string
}

export interface RegisterProcessInput {
  owner: ProcessOwner
  source: ProcessSessionSource
  command: string
  workdir: string
  /** 创建该会话的命令是否被判为破坏性（决定后续 write 是否要抢写者租约） */
  destructive: boolean
  /** 会话首个 read 之前已产出的文本（调用方已净化） */
  seedOutput: string
  /** 终止进程树；必须可安全重复调用；实现方保证最终 resolve */
  killTree: () => Promise<void>
  /** 向进程 stdin 写入（持久会话 stdin 保持打开）；进程退出后不可用 */
  writeStdin: (data: string) => Promise<void>
  /** POSIX 下尽力发送 SIGINT；Windows 平台调用方传 undefined */
  interrupt?: () => boolean
  /**
   * 会话终结前排空调用方缓冲中的未交付文本（如输出净化器滞留的无尾换行行）。
   * settle 幂等保证只调用一次；返回文本会作为最后一批输出入账。
   */
  flushPendingOutput?: () => string
  /**
   * 已 spawn 的子进程。registry 只用它做三件事：读取 exitCode/signalCode 判存活、
   * 监听 'close' 与 'error' 事件自主感知退出（settle 幂等，与调用方通知互为双保险）。
   * registry 不得对它做任何其他操作。
   */
  child: {
    exitCode: number | null
    signalCode: string | null
    once(event: 'close' | 'error', listener: () => void): void
  }
  /** checkpoint 滚动基线（类型唯一来源为 checkpoints 领域；无 checkpoint 环境传 null） */
  checkpointBaseline: import('../checkpoints/snapshot').WorkspaceSnapshot | null
}

export interface ReadPage {
  text: string
  /** 未读内容是否还有剩余（有则提示模型继续 read） */
  hasMore: boolean
  /** 是否发生过早期输出被滚动窗口丢弃（丢弃的早期字节只能经溢出文件找回） */
  droppedEarly: boolean
  /** 溢出文件信息（总量超阈值时存在；路径形如 nova-bash-*.log，交给调用方走 artifact 认领） */
  spill: { path: string; totalBytes: number; totalLines: number } | null
}

export type ProcessErrorCode =
  | 'unknown-ref'
  | 'not-authorized'
  | 'process-exited'
  | 'active-limit'
  | 'retained-bytes-limit'
  | 'unsupported-on-windows'

export class ProcessSessionError extends Error {
  readonly code: ProcessErrorCode

  constructor(code: ProcessErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
