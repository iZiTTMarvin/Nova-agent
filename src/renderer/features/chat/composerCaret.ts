/** 输入框插入点跟随：把当前插入点滚进输入框自身的可视范围。 */

function scrollableAncestor(node: Node): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
  while (el) {
    const overflowY = getComputedStyle(el).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return null
}

/** 折叠的 Range 在行首/行尾常没有矩形，退而取相邻一个字符或节点的矩形 */
function caretRect(range: Range): DOMRect | null {
  const direct = Array.from(range.getClientRects()).at(-1)
  if (direct && direct.height > 0) return direct

  const { startContainer: container, startOffset: offset } = range
  const probe = document.createRange()
  if (container.nodeType === Node.TEXT_NODE) {
    const length = container.textContent?.length ?? 0
    if (length === 0) return null
    if (offset > 0) probe.setStart(container, offset - 1)
    else probe.setStart(container, 0)
    probe.setEnd(container, Math.min(length, probe.startOffset + 1))
  } else {
    const before = container.childNodes[offset - 1]
    const node = before ?? container.childNodes[offset]
    if (!node) return null
    if (node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0) {
      const length = node.textContent?.length ?? 0
      probe.setStart(node, before ? length - 1 : 0)
      probe.setEnd(node, before ? length : 1)
    } else {
      probe.selectNode(node)
    }
  }
  const rect = Array.from(probe.getClientRects()).at(-1)
  return rect && rect.height > 0 ? rect : null
}

export function revealCaretInScroller(selection: Selection | null): void {
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  const scroller = scrollableAncestor(range.startContainer)
  const rect = caretRect(range)
  if (!scroller || !rect) return
  const view = scroller.getBoundingClientRect()
  if (rect.bottom > view.bottom) scroller.scrollTop += rect.bottom - view.bottom
  else if (rect.top < view.top) scroller.scrollTop -= view.top - rect.top
}
