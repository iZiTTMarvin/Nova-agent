import React from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { CompassIcon, UserCheckIcon, SparklesIcon } from '../../components/Icons'
import type { Mode } from '../../../shared/session/types'
import './ModeSwitch.css'

interface ModeOption {
  id: Mode
  name: string
  icon: React.ReactNode
}

export const ModeSwitch: React.FC = () => {
  const currentMode = useAppStore(state => state.currentMode)
  const setMode = useAppStore(state => state.setMode)

  const modeOptions: ModeOption[] = [
    {
      id: 'plan',
      name: 'Plan',
      icon: <CompassIcon size={12} />
    },
    {
      id: 'default',
      name: 'Collaborative',
      icon: <UserCheckIcon size={12} />
    },
    {
      id: 'auto',
      name: 'Auto',
      icon: <SparklesIcon size={12} />
    }
  ]

  return (
    <div className="mode-pill-selector">
      {modeOptions.map(option => (
        <button
          key={option.id}
          className={`mode-pill-btn ${currentMode === option.id ? 'mode-pill-btn--active' : ''}`}
          onClick={() => setMode(option.id)}
        >
          {option.icon}
          <span>{option.name}</span>
        </button>
      ))}
    </div>
  )
}
