/**
 * 只负责空闲延迟的轻量计时器。
 *
 * 压缩资格、取消信号、进行中状态和写回 fence 均由 CompactionService 持有，
 * timer 不接触 AgentContext，也不拥有任何模型调用生命周期。
 */
export class IdleCompressionTimer {
  /** 空闲延迟（毫秒），< 300s Anthropic prompt cache TTL */
  static readonly IDLE_DELAY_MS = 266_000

  private timerHandle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onElapsed: () => void) {}

  /** 重新开始计时；同一实例始终只保留一个 timeout。 */
  start(): void {
    this.cancel()
    this.timerHandle = setTimeout(() => {
      this.timerHandle = null
      this.onElapsed()
    }, IdleCompressionTimer.IDLE_DELAY_MS)
  }

  /** 取消尚未到期的 timeout。 */
  cancel(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle)
      this.timerHandle = null
    }
  }
}
