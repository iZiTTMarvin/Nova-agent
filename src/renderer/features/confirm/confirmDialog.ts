/**
 * 应用内确认框的唯一状态 Owner：调用方 await `confirmDialog()` 拿到被点按钮的下标，
 * 宿主组件 `ConfirmDialogHost` 只负责展示队首请求并回报结果。
 */
import { create } from 'zustand'

export interface ConfirmDialogOptions {
  /** warning 会把确认按钮显示为危险色；error 常配单个“确定”按钮。 */
  type?: 'info' | 'question' | 'warning' | 'error'
  title?: string
  message: string
  detail?: string
  /** 按钮文案，从左到右；默认 ['取消', '确定']。 */
  buttons?: string[]
  /** 打开时获得焦点的按钮；默认最后一个。不可逆操作应指向取消。 */
  defaultId?: number
  /** Esc / 点击遮罩时返回的下标；默认 0。 */
  cancelId?: number
}

export interface PendingConfirm {
  id: number
  options: ConfirmDialogOptions
  resolve: (response: number) => void
}

interface ConfirmState {
  queue: PendingConfirm[]
  enqueue: (options: ConfirmDialogOptions) => Promise<number>
  settle: (id: number, response: number) => void
}

let nextId = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  queue: [],
  enqueue: options =>
    new Promise<number>(resolve => {
      set(state => ({ queue: [...state.queue, { id: nextId++, options, resolve }] }))
    }),
  settle: (id, response) => {
    const target = get().queue.find(item => item.id === id)
    if (!target) return
    set(state => ({ queue: state.queue.filter(item => item.id !== id) }))
    target.resolve(response)
  }
}))

/** 弹出确认框并返回被点按钮的下标；多个请求按先后顺序依次展示。 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<number> {
  return useConfirmStore.getState().enqueue(options)
}
