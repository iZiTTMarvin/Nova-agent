/**
 * 写完最后输出后强制进程退出。
 *
 * headless CLI 是批处理入口：正常返回后事件循环里可能仍残留句柄
 * （典型场景：任务里用 nohup 启动的后台进程继承了工具子进程的管道，
 * 导致 ChildProcess 的 stdio 一直不释放）。不主动 exit 会让进程永远挂着，
 * 外部调用方（评测 harness、CI）只能干等到超时。
 *
 * 退出前先等最后一笔输出真正刷进管道，避免摘要被截断；管道对端异常时
 * 由兜底定时器强制退出。
 */
export function writeAndExit(
  stream: NodeJS.WritableStream,
  chunk: string,
  exitCode: number,
  exit: (code: number) => void = code => process.exit(code)
): void {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    exit(exitCode)
  }
  const fallback = setTimeout(finish, 5_000)
  // unref：兜底定时器本身不能再反过来拖住进程
  if (typeof fallback === 'object' && typeof fallback.unref === 'function') {
    fallback.unref()
  }
  // write 回调在数据冲刷完成后触发（含背压场景），届时即可安全退出
  stream.write(chunk, () => {
    clearTimeout(fallback)
    finish()
  })
}
