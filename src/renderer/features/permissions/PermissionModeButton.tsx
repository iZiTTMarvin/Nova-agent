import React, { useEffect, useState } from 'react'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { CheckSmallIcon, ShieldIcon } from '../../components/Icons'
import type { PermissionMode } from '../../../shared/session/types'
import { FullAccessConfirmDialog } from './FullAccessConfirmDialog'
import './PermissionModeButton.css'

interface PermissionModeOption {
  id: PermissionMode
  label: string
  description: string
  disabled?: boolean
}

const OPTIONS: PermissionModeOption[] = [
  {
    id: 'request_approval',
    label: '请求批准',
    description: 'Shell、工作区外文件和网络操作执行前询问'
  },
  {
    id: 'auto',
    label: '自动',
    description: '常规开发操作自动执行，风险操作需要确认'
  },
  {
    id: 'full_access',
    label: '完全访问',
    description: '允许 Nova 直接访问文件、网络并执行命令'
  }
]

export interface PermissionModeButtonProps {
  permissionMode: PermissionMode
  isDisabled?: boolean
  onChange: (permissionMode: PermissionMode) => Promise<void> | void
}

export const PermissionModeButton: React.FC<PermissionModeButtonProps> = ({
  permissionMode,
  isDisabled = false,
  onChange
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingFullAccess, setPendingFullAccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = OPTIONS.find(option => option.id === permissionMode) ?? OPTIONS[0]
  const interactionDisabled = isDisabled || isSaving

  useEffect(() => {
    if (interactionDisabled) {
      setIsOpen(false)
      setPendingFullAccess(false)
    }
  }, [interactionDisabled])

  useEffect(() => {
    setPendingFullAccess(false)
  }, [permissionMode])

  const selectMode = async (option: PermissionModeOption): Promise<void> => {
    if (option.disabled || option.id === permissionMode || interactionDisabled) {
      setIsOpen(false)
      return
    }

    if (option.id === 'full_access') {
      setIsOpen(false)
      setPendingFullAccess(true)
      return
    }

    await applyMode(option.id)
  }

  const applyMode = async (nextMode: PermissionMode): Promise<void> => {
    setError(null)
    setIsSaving(true)
    try {
      await onChange(nextMode)
      setIsOpen(false)
      setPendingFullAccess(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换权限模式失败')
      setIsOpen(nextMode !== 'full_access')
    } finally {
      setIsSaving(false)
    }
  }

  const tooltip = interactionDisabled
    ? '等待当前操作完成后再切换权限模式'
    : `${active.label}：${active.description}`

  return (
    <>
      <DropdownMenu
      className="permission-mode__menu"
      placement="above"
      menuWidth={320}
      isMenuOpen={isOpen}
      onOpenChange={setIsOpen}
      button={{
        label: active.label,
        variant: 'ghost',
        size: 'sm',
        icon: <ShieldIcon size={16} />,
        tooltip,
        isDisabled: interactionDisabled,
        className: `permission-mode__trigger permission-mode__trigger--${permissionMode}`
      }}
    >
      <div className="permission-mode__menu-title">权限模式</div>
      {error ? <div className="permission-mode__error" role="status">{error}</div> : null}
      {OPTIONS.map(option => (
        <DropdownMenuItem
          key={option.id}
          label={option.label}
          description={option.description}
          icon={<ShieldIcon size={14} />}
          endContent={permissionMode === option.id ? <CheckSmallIcon size={16} /> : undefined}
          isDisabled={option.disabled}
          className={permissionMode === option.id ? 'permission-mode__item--active' : undefined}
          onClick={() => void selectMode(option)}
        />
      ))}
      </DropdownMenu>
      <FullAccessConfirmDialog
        isOpen={pendingFullAccess}
        isSubmitting={isSaving}
        onCancel={() => setPendingFullAccess(false)}
        onConfirm={() => void applyMode('full_access')}
      />
    </>
  )
}
