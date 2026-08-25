import React from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import './PermissionModeButton.css'

export interface FullAccessConfirmDialogProps {
  isOpen: boolean
  isSubmitting?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export const FullAccessConfirmDialog: React.FC<FullAccessConfirmDialogProps> = ({
  isOpen,
  isSubmitting = false,
  onCancel,
  onConfirm
}) => {
  if (!isOpen) return null

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isSubmitting) onCancel()
      }}
      purpose="info"
      padding={0}
      width="min(480px, calc(100vw - 32px))"
      className="full-access-confirm"
      aria-labelledby="full-access-confirm-title"
    >
      <div className="full-access-confirm__body">
        <h3 id="full-access-confirm-title">切换到完全访问？</h3>
        <p>
          Nova 将可以直接执行命令，并访问当前用户本身有权限访问的文件和网络资源。
          高风险操作也不会再请求批准。
        </p>
        <p>仅在你信任当前任务和工作区时启用。</p>
      </div>
      <div className="full-access-confirm__actions">
        <Button
          label="取消"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          isDisabled={isSubmitting}
        >
          取消
        </Button>
        <Button
          label="启用完全访问"
          variant="primary"
          size="sm"
          className="full-access-confirm__enable"
          onClick={onConfirm}
          isDisabled={isSubmitting}
        >
          {isSubmitting ? '启用中…' : '启用完全访问'}
        </Button>
      </div>
    </Dialog>
  )
}
