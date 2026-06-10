/**
 * 空闲时自动压缩计时器
 *
 * 当用户停止输入一段时间后（默认 266 秒），在后台自动压缩对话历史，预热 prompt cache。
 * 用户下一个消息到达时直接命中缓存，冷启动首次 token 延迟降低 50%+。
 *
 * 参考 OpenClacky idle_compression_timer.rb，适配 nova-agent 的 AgentLoop 架构：
 * - 使用 Node.js 内置 setTimeout / clearTimeout，不引入额外依赖
 * - 独立 AbortController，不与主循环 cancel 混用
 * - 静默失败：空闲压缩是优化手段，失败不应打扰用户
 *
 * 回滚职责：timer 不做上下文回滚。
 * runCompaction() 只在成功路径（rebuildWithCompression）替换 this.context，
 * 中断/失败时 this.context 不变。AgentLoop.runIdleCompaction() 在 finally 中用
 * prevContext 快照恢复 abort 导致的部分修改，timer 层无需关心。
 */

/** AgentLoop 上需要暴露的接口，避免 IdleCompressionTimer 直接依赖 AgentLoop 类 */
export interface IdleCompactionTarget {
  /** 执行压缩（内部调用 runCompaction），abort 时回滚上下文 */
  runIdleCompaction(abortSignal: AbortSignal): Promise<void>
}

/**
 * 空闲压缩计时器
 *
 * 调用方在循环结束时 start()，新消息到达时 cancel()。
 * 计时器到期后异步执行压缩，不阻塞任何调用方。
 */
export class IdleCompressionTimer {
  /** 空闲延迟（毫秒），< 300s Anthropic prompt cache TTL */
  static readonly IDLE_DELAY_MS = 266_000

  private target: IdleCompactionTarget
  private timerHandle: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private _compressing = false

  constructor(target: IdleCompactionTarget) {
    this.target = target
  }

  /**
   * 启动空闲计时器（fire-and-forget）。
   * 如果已有计时器在运行，先取消再重新开始。
   */
  start(): boolean {
    this.clearTimer()

    this.abortController = new AbortController()

    this.timerHandle = setTimeout(() => {
      this.timerHandle = null
      this.runIdleCompaction()
    }, IdleCompressionTimer.IDLE_DELAY_MS)

    return true
  }

  /**
   * 取消计时器和正在运行的压缩。
   * 同步调用，不 await 压缩退出。
   * 压缩的 LLM 调用被 AbortSignal 中断后由 AgentLoop.runIdleCompaction 自行回滚。
   */
  cancel(): void {
    this.clearTimer()

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  /** 是否正在执行压缩 */
  isCompressing(): boolean {
    return this._compressing
  }

  /**
   * 内部方法：触发空闲压缩。
   * 回滚由 AgentLoop.runIdleCompaction 负责，timer 只管静默吞异常。
   */
  private async runIdleCompaction(): Promise<void> {
    const ac = this.abortController
    if (!ac || ac.signal.aborted) return

    this._compressing = true

    try {
      await this.target.runIdleCompaction(ac.signal)
    } catch {
      // 静默处理。AbortError 的回滚由 target.runIdleCompaction 的 finally 负责
    } finally {
      this._compressing = false
      this.abortController = null
    }
  }

  /** 清除 setTimeout 句柄 */
  private clearTimer(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle)
      this.timerHandle = null
    }
  }
}
