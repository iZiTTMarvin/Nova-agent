import React from 'react'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'

export interface AutoModeToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export const AutoModeToggle: React.FC<AutoModeToggleProps> = ({ enabled, onChange }) => {
  return (
    <ToggleButton
      label="全自动完成"
      tooltip="全自动完成"
      isPressed={enabled}
      onPressedChange={next => onChange(next)}
      size="sm"
      className="auto-mode-toggle"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-300' : 'bg-gray-300'}`}
      />
      全自动
    </ToggleButton>
  )
}
