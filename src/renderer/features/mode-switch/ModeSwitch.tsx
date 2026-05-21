import React from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { CompassIcon, UserCheckIcon, SparklesIcon } from '../../components/Icons'
import type { Mode } from '../../../shared/session/types'
import './ModeSwitch.css'

interface ModeOption {
  id: Mode
  name: string
  description: string
  icon: React.ReactNode
}

export const ModeSwitch: React.FC = () => {
  const currentMode = useAppStore(state => state.currentMode)
  const setMode = useAppStore(state => state.setMode)

  const modeOptions: ModeOption[] = [
    {
      id: 'plan',
      name: '分析模式 (Plan)',
      description: '仅生成执行计划与建议，不会对本地文件执行写入与修改。安全可信。',
      icon: <CompassIcon size={18} />
    },
    {
      id: 'default',
      name: '协同模式 (Default)',
      description: '推荐模式。支持智能修改代码，遇到风险操作（如 bash 脚本）会弹窗征求您的授权。',
      icon: <UserCheckIcon size={18} />
    },
    {
      id: 'auto',
      name: '自主模式 (Auto)',
      description: '全自动模式。Nova 会自动决策权限与命令执行，仅在任务彻底完成后向您汇报。',
      icon: <SparklesIcon size={18} />
    }
  ]

  return (
    <div className="mode-switch">
      <h3 className="mode-switch__title">运行模式</h3>
      <div className="mode-switch__options">
        {modeOptions.map(option => (
          <button
            key={option.id}
            className={`mode-switch__card ${currentMode === option.id ? 'mode-switch__card--active' : ''}`}
            onClick={() => setMode(option.id)}
          >
            <div className="mode-switch__icon-wrapper">
              {option.icon}
            </div>
            <div className="mode-switch__info">
              <span className="mode-switch__name">{option.name}</span>
              <span className="mode-switch__desc">{option.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
