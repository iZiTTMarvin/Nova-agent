/**
 * GitBranchCreateDialog — 创建并检出新分支弹窗（照 ZCode GitBranchCreateDialog 结构）。
 * 只负责表单展示与提交回调；校验与执行结果由 useGitBranchSwitcher 提供。
 */
import React from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { TextInput } from '@astryxdesign/core/TextInput'
import './composerContext.css'

export interface GitBranchCreateDialogProps {
  isOpen: boolean
  branchName: string
  isPending: boolean
  errorText: string | null
  onBranchNameChange: (name: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export const GitBranchCreateDialog: React.FC<GitBranchCreateDialogProps> = ({
  isOpen,
  branchName,
  isPending,
  errorText,
  onBranchNameChange,
  onCancel,
  onSubmit
}) => {
  if (!isOpen) return null

  const canSubmit = branchName.trim().length > 0 && !isPending

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isPending) onCancel()
      }}
      purpose="form"
      padding={0}
      width="min(460px, calc(100vw - 32px))"
      className="git-branch-create"
      aria-labelledby="git-branch-create-title"
    >
      <form
        className="git-branch-create__form"
        onSubmit={event => {
          event.preventDefault()
          if (canSubmit) onSubmit()
        }}
      >
        <h3 id="git-branch-create-title" className="git-branch-create__title">
          创建并检出新分支
        </h3>
        <p className="git-branch-create__desc">基于当前 HEAD 创建新分支，并立即切换过去。</p>

        <div className="git-branch-create__field">
          <TextInput
            label="分支名称"
            hasAutoFocus
            value={branchName}
            placeholder="例如 feature/login"
            isDisabled={isPending}
            onChange={value => onBranchNameChange(value)}
            onEnter={() => {
              if (canSubmit) onSubmit()
            }}
          />
        </div>

        {errorText ? (
          <div className="git-branch-create__error" role="alert">
            {errorText}
          </div>
        ) : null}

        <div className="git-branch-create__actions">
          <Button
            label="取消"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            isDisabled={isPending}
          >
            取消
          </Button>
          <Button
            label="创建并检出新分支"
            variant="primary"
            size="sm"
            type="submit"
            isDisabled={!canSubmit}
            isLoading={isPending}
          >
            {isPending ? '创建中…' : '创建并检出'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
