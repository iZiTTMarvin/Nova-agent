import React from 'react'

export interface AutoModeToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export const AutoModeToggle: React.FC<AutoModeToggleProps> = ({ enabled, onChange }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="全自动完成"
      title="全自动完成"
      onClick={() => onChange(!enabled)}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
        enabled
          ? 'bg-text-primary text-white'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-300' : 'bg-gray-300'}`}
      />
      全自动
    </button>
  )
}

