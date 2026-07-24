import React, { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
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
import type { Mode } from '../../../shared/session/types'
import { motion, AnimatePresence } from 'framer-motion'
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

export const ModeSwitch: React.FC<ModeSwitchProps> = ({
  supportsVision = false,
  onSelectImage,
  onSelectSkills
}) => {
  const currentMode = useSettingsStore(state => state.currentMode)
  const setMode = useSettingsStore(state => state.setMode)

  const [isOpen, setIsOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const activeOption = modeOptions.find(m => m.id === currentMode) || modeOptions[0]
  const activeChip = currentMode === 'plan'
    ? {
        label: 'Plan',
        className: 'border-[#c9973f] bg-[#3a2f1d] text-[#f0c665]',
        iconClassName: 'text-[#f0c665]'
      }
    : currentMode === 'compose'
      ? {
          label: 'XForge',
          className: 'border-[#7665b5] bg-[#2e2940] text-[#cec3ff]',
          iconClassName: 'text-[#cec3ff]'
        }
      : null

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="relative flex items-center gap-1.5" ref={containerRef}>
      <button
        onClick={() => {
          setSwitchError(null)
          setIsOpen(!isOpen)
        }}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-50 text-gray-500 transition-colors hover:bg-[rgba(201,100,66,0.1)] hover:text-[#c96442]"
        title="添加工作流、上下文与工具"
        aria-label="添加工作流、上下文与工具"
        type="button"
      >
        <PlusIcon size={16} />
      </button>

      {activeChip && (
        <div
          data-testid="active-mode-chip"
          className={`flex h-8 items-center rounded-lg border text-[13px] font-medium transition-colors ${activeChip.className}`}
        >
          <button
            onClick={() => {
              setSwitchError(null)
              setIsOpen(!isOpen)
            }}
            className="flex h-full items-center gap-1.5 rounded-l-lg pl-2.5 pr-1 hover:bg-white/5"
            title="切换工作模式"
            type="button"
          >
            <span className={activeChip.iconClassName}>{activeOption.icon}</span>
            <span>{activeChip.label}</span>
          </button>
          <button
            aria-label={`退出 ${activeChip.label}`}
            className="flex h-full items-center rounded-r-lg pl-1 pr-2 hover:bg-white/5"
            onClick={async event => {
              event.stopPropagation()
              setSwitchError(null)
              try {
                await setMode('default')
                setIsOpen(false)
              } catch (error) {
                setSwitchError(error instanceof Error ? error.message : '退出模式失败')
                setIsOpen(true)
              }
            }}
            title={`退出 ${activeChip.label}`}
            type="button"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      )}

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute bottom-[calc(100%+8px)] left-0 w-[320px] bg-[#1e1e1e] border border-[#333] rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#2d2d2d]">
              <span className="text-[#a0a0a0] text-xs font-medium">添加工作流、上下文与工具</span>
            </div>

            <div className="flex flex-col p-1.5">
              {switchError && (
                <div className="mx-1.5 mb-1.5 rounded-md border border-[#6b3030] bg-[#351f1f] px-2.5 py-2 text-[11px] leading-snug text-[#f0a5a5]">
                  {switchError}
                </div>
              )}
              {modeOptions.map(option => {
                const isActive = currentMode === option.id
                return (
                  <button
                    key={option.id}
                    onClick={async () => {
                      if (isActive) {
                        setIsOpen(false)
                        return
                      }
                      setSwitchError(null)
                      try {
                        await setMode(option.id)
                        setIsOpen(false)
                      } catch (error) {
                        setSwitchError(
                          error instanceof Error ? error.message : '切换模式失败'
                        )
                      }
                    }}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-colors relative ${
                      isActive
                        ? 'bg-[#005fb8]'
                        : 'hover:bg-[#2d2d2d]'
                    }`}
                  >
                    <div className={`mt-[3px] shrink-0 ${isActive ? 'text-[#e0e0e0]' : 'text-[#a0a0a0]'}`}>
                      {option.icon}
                    </div>
                    <div className="flex flex-col gap-0.5 flex-1 pr-6">
                      <span className={`text-[13px] font-medium leading-tight ${isActive ? 'text-white' : 'text-[#e0e0e0]'}`}>
                        {option.name}
                      </span>
                      <span className={`text-[11px] leading-snug ${isActive ? 'text-[#a0c5ff]' : 'text-[#888]'}`}>
                        {option.desc}
                      </span>
                    </div>
                    {isActive && (
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 text-white">
                        <CheckSmallIcon size={16} />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>

            {(supportsVision || onSelectSkills) && (
              <div className="flex flex-col border-t border-[#2d2d2d] p-1.5">
                {supportsVision && onSelectImage && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false)
                      onSelectImage()
                    }}
                    className="flex items-center gap-2.5 rounded-lg p-2.5 text-left text-[#e0e0e0] transition-colors hover:bg-[#2d2d2d]"
                  >
                    <span className="text-[#a0a0a0]"><ImageIcon size={14} /></span>
                    <span className="text-[13px] font-medium">添加图片</span>
                  </button>
                )}
                {onSelectSkills && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false)
                      onSelectSkills()
                    }}
                    className="flex items-center gap-2.5 rounded-lg p-2.5 text-left text-[#e0e0e0] transition-colors hover:bg-[#2d2d2d]"
                  >
                    <span className="text-[#a0a0a0]"><SparklesIcon size={14} /></span>
                    <span className="text-[13px] font-medium">技能与命令</span>
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
