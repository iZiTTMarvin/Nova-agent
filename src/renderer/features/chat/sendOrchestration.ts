/**
 * 发送编排：把 handleSend 里"先 dismiss askQuestion，再 enqueue/send"的决策抽成纯函数，
 * 便于单测（渲染整个 ChatPanel 太重，且耦合一堆 icon / framer-motion / 子组件）。
 *
 * 背景：askQuestion 面板开着时，Agent 轮次被一个未 resolve 的工具 Promise 阻塞，
 * message_end 永不到达。若此时用户在输入框发新消息，旧实现只把它 enqueue 进
 * steering queue，而 queue 只在 message_end 时 drain → 互等死锁。
 *
 * 解法：发新消息前若有 pending askQuestion，先 dismiss（resolve 空 answers），
 * 让旧轮次能正常走到 message_end；新消息照常 enqueue，等 turn boundary drain。
 */

export interface SendDeps {
  /** 是否有 askQuestion 提问正等待用户回答 */
  hasPendingAskQuestion: boolean
  /** dismiss 当前 askQuestion（resolve 空 answers）。无 pending 时为 no-op。 */
  dismissAskQuestion: () => Promise<void>
}

export interface SendOutcome {
  /** 是否已对当前轮次的 askQuestion 执行 dismiss */
  dismissedAskQuestion: boolean
}

/**
 * 在 enqueue/send 之前执行的"前置动作"。
 * 当前职责：若存在 pending askQuestion，先 dismiss 解除阻塞。
 *
 * @returns 执行结果，供调用方 / 测试断言
 */
export async function preSendGate(deps: SendDeps): Promise<SendOutcome> {
  if (!deps.hasPendingAskQuestion) {
    return { dismissedAskQuestion: false }
  }
  await deps.dismissAskQuestion()
  return { dismissedAskQuestion: true }
}
