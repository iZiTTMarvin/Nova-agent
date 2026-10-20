import React, { useEffect, useRef } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { useConfirmStore, type PendingConfirm } from './confirmDialog'
import './ConfirmDialogHost.css'

const DEFAULT_BUTTONS = ['取消', '确定']

const ConfirmDialogView: React.FC<{
  request: PendingConfirm
  onSettle: (response: number) => void
}> = ({ request, onSettle }) => {
  const { options } = request
  const buttons = options.buttons?.length ? options.buttons : DEFAULT_BUTTONS
  const cancelId = options.cancelId ?? 0
  const defaultId = Math.min(options.defaultId ?? buttons.length - 1, buttons.length - 1)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const titleId = `confirm-dialog-title-${request.id}`

  // 原生 showModal 默认聚焦第一个可聚焦元素（取消），需要显式落到 defaultId。
  useEffect(() => {
    const frame = requestAnimationFrame(() => buttonRefs.current[defaultId]?.focus())
    return () => cancelAnimationFrame(frame)
  }, [defaultId])

  return (
    <Dialog
      isOpen
      onOpenChange={open => {
        if (!open) onSettle(cancelId)
      }}
      purpose="info"
      padding={0}
      width="min(420px, calc(100vw - 32px))"
      className="confirm-dialog"
      aria-labelledby={titleId}
    >
      <div className="confirm-dialog__body">
        <h3 id={titleId} className="confirm-dialog__title">{options.title ?? options.message}</h3>
        {options.title && <p className="confirm-dialog__message">{options.message}</p>}
        {options.detail && <p className="confirm-dialog__detail">{options.detail}</p>}
      </div>
      <div className="confirm-dialog__actions">
        {buttons.map((label, index) => {
          const isCancel = index === cancelId
          const variant = isCancel && buttons.length > 1
            ? 'secondary'
            : options.type === 'warning' ? 'destructive' : 'primary'
          return (
            <Button
              key={`${index}:${label}`}
              ref={node => { buttonRefs.current[index] = node }}
              label={label}
              variant={variant}
              size="sm"
              onClick={() => onSettle(index)}
            >
              {label}
            </Button>
          )
        })}
      </div>
    </Dialog>
  )
}

/** 挂在应用根部：展示队首确认请求，结果回写给 `confirmDialog()` 的调用方。 */
export const ConfirmDialogHost: React.FC = () => {
  const current = useConfirmStore(state => state.queue[0])
  const settle = useConfirmStore(state => state.settle)
  if (!current) return null
  return (
    <ConfirmDialogView
      key={current.id}
      request={current}
      onSettle={response => settle(current.id, response)}
    />
  )
}
