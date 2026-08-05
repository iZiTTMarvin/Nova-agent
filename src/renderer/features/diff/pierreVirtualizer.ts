import { Virtualizer } from '@pierre/diffs'

interface VirtualizerEntry {
  virtualizer: Virtualizer
  references: number
}

const virtualizers = new WeakMap<HTMLElement, VirtualizerEntry>()

export function acquirePierreVirtualizer(scrollElement: HTMLElement): {
  virtualizer: Virtualizer
  release: () => void
} {
  let entry = virtualizers.get(scrollElement)

  if (!entry) {
    const virtualizer = new Virtualizer()
    virtualizer.setup(scrollElement)
    entry = { virtualizer, references: 0 }
    virtualizers.set(scrollElement, entry)
  }

  entry.references++
  let released = false

  return {
    virtualizer: entry.virtualizer,
    release: () => {
      if (released) return
      released = true

      const current = virtualizers.get(scrollElement)
      if (!current) return

      current.references--
      if (current.references > 0) return

      current.virtualizer.cleanUp()
      virtualizers.delete(scrollElement)
    }
  }
}
