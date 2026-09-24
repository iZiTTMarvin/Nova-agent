/**
 * Chromium 152 起，popover 正在显示/隐藏时再次 showPopover 会抛 InvalidStateError。
 * Astryx Layer 在子菜单与快捷键路径会重入调用；把这次打开延后到当前切换结束。
 */
export function installPopoverReentrancyGuard(): void {
  const proto = HTMLElement.prototype
  const original = proto.showPopover
  if (typeof original !== 'function') return

  proto.showPopover = function guardedShowPopover(
    this: HTMLElement,
    ...args: Parameters<typeof original>
  ): void {
    try {
      original.apply(this, args)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
      queueMicrotask(() => {
        try {
          original.apply(this, args)
        } catch {
          // 目标已关闭或仍在切换时放弃，避免死循环
        }
      })
    }
  }
}
