import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import {
  HandIcon,
  PlanIcon,
  CodeIcon,
  CheckSmallIcon,
  CloseIcon,
  ImageIcon,
  PlusIcon,
  SparklesIcon
} from '../../components/Icons'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { Mode } from '../../../shared/session/types'
import './ModeSwitch.css'

interface ModeOption {
  id: Mode
  name: string
  desc: string
  icon: React.ReactNode
}

interface ModeSwitchProps {
  supportsVision?: boolean
  onSelectImage?: () => void
  onSelectSkills?: () => void
}

interface ModeMenuItemProps {
  label: string
  description?: string
  icon: React.ReactNode
  isActive?: boolean
  onClick: () => void
}

/** Button-backed menu row keeps the menu item in the same Astryx focus path. */
const ModeMenuItem: React.FC<ModeMenuItemProps> = ({
  label,
  description,
  icon,
  isActive = false,
  onClick
}) => (
  <Button
    label={label}
    variant={isActive ? 'primary' : 'ghost'}
    size="sm"
    width="100%"
    role="menuitem"
    tabIndex={-1}
    icon={icon}
    endContent={isActive ? <CheckSmallIcon size={16} /> : undefined}
    className={`mode-switch__menu-item${isActive ? ' mode-switch__menu-item--active' : ''}`}
    onClick={onClick}
  >
    <span className="mode-switch__menu-item-content">
      <span className="mode-switch__menu-item-label">{label}</span>
      {description ? <span className="mode-switch__menu-item-desc">{description}</span> : null}
    </span>
  </Button>
)

export const ModeSwitch: React.FC<ModeSwitchProps> = ({
  supportsVision = false,
  onSelectImage,
  onSelectSkills
}) => {
  const currentMode = useSettingsStore(state => state.currentMode)
  const setMode = useSettingsStore(state => state.setMode)
  const [isOpen, setIsOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const modeOptions: ModeOption[] = [
    {
      id: 'default',
      name: '默认模式',
      desc: '模型自主循环协作；工具批准策略见设置',
      icon: <HandIcon size={14} />
    },
    {
      id: 'plan',
      name: '计划模式',
      desc: '分析仓库并保存到项目 .nova/plans，确认后衔接默认模式',
      icon: <PlanIcon size={14} />
    },
    {
      id: 'compose',
      name: 'XForge',
      desc: '自然语言驱动 BuildRail 开发流程（自动选阶段并推进）',
      icon: <CodeIcon size={14} />
    }
  ]

  const activeOption = modeOptions.find(option => option.id === currentMode) ?? modeOptions[0]
  const activeChip = currentMode === 'plan'
    ? { label: 'Plan', className: 'mode-switch__chip--plan' }
    : currentMode === 'compose'
      ? { label: 'XForge', className: 'mode-switch__chip--compose' }
      : null

  const openMenu = () => {
    setSwitchError(null)
    setIsOpen(true)
  }

  const handleModeSelect = async (option: ModeOption): Promise<void> => {
    if (currentMode === option.id) {
      setIsOpen(false)
      return
    }
    setSwitchError(null)
    try {
      await setMode(option.id)
      setIsOpen(false)
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : '切换模式失败')
      setIsOpen(true)
    }
  }

  const handleExitMode = async (): Promise<void> => {
    setSwitchError(null)
    try {
      await setMode('default')
      setIsOpen(false)
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : '退出模式失败')
      setIsOpen(true)
    }
  }

  return (
    <div className="mode-switch">
      <DropdownMenu
        className="mode-switch__menu"
        placement="above"
        menuWidth={320}
        isMenuOpen={isOpen}
        onOpenChange={setIsOpen}
        button={{
          label: '添加工作流、上下文与工具',
          variant: 'ghost',
          size: 'sm',
          isIconOnly: true,
          icon: <PlusIcon size={16} />,
          tooltip: '添加工作流、上下文与工具'
        }}
      >
        <div className="mode-switch__menu-title">添加工作流、上下文与工具</div>
        {switchError && (
          <div className="mode-switch__error" role="status">
            {switchError}
          </div>
        )}
        {modeOptions.map(option => {
          const isActive = currentMode === option.id
          return (
            <ModeMenuItem
              key={option.id}
              icon={option.icon}
              label={option.name}
              description={option.desc}
              isActive={isActive}
              onClick={() => void handleModeSelect(option)}
            />
          )
        })}
        {(supportsVision || onSelectSkills) && (
          <div className="mode-switch__menu-section">
            {supportsVision && onSelectImage && (
              <ModeMenuItem
                icon={<ImageIcon size={14} />}
                label="添加图片"
                onClick={() => {
                  setIsOpen(false)
                  onSelectImage()
                }}
              />
            )}
            {onSelectSkills && (
              <ModeMenuItem
                icon={<SparklesIcon size={14} />}
                label="技能与命令"
                onClick={() => {
                  setIsOpen(false)
                  onSelectSkills()
                }}
              />
            )}
          </div>
        )}
      </DropdownMenu>

      {activeChip && (
        <div data-testid="active-mode-chip" className={`mode-switch__chip ${activeChip.className}`}>
          <Button
            label="切换工作模式"
            variant="ghost"
            size="sm"
            icon={activeOption.icon}
            tooltip="切换工作模式"
            className="mode-switch__chip-main"
            onClick={openMenu}
          >
            {activeChip.label}
          </Button>
          <IconButton
            label={`退出 ${activeChip.label}`}
            variant="ghost"
            size="sm"
            icon={<CloseIcon size={12} />}
            className="mode-switch__chip-close"
            tooltip={`退出 ${activeChip.label}`}
            onClick={() => void handleExitMode()}
          />
        </div>
      )}
    </div>
  )
}
