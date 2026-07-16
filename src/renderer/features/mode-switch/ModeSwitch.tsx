import React, { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { HandIcon, PlanIcon, CodeIcon, CheckSmallIcon, ArrowUpIcon } from '../../components/Icons'
import type { Mode } from '../../../shared/session/types'
import { motion, AnimatePresence } from 'framer-motion'
import './ModeSwitch.css'

interface ModeOption {
  id: Mode
  name: string
  desc: string
  icon: React.ReactNode
}

export const ModeSwitch: React.FC = () => {
  const currentMode = useSettingsStore(state => state.currentMode)
  const setMode = useSettingsStore(state => state.setMode)

  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 行为模式三档；权限档位（ask/auto）已迁到设置
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
      desc: '只读分析，禁止写入与执行命令',
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
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#2d2d2d] hover:bg-[#3d3d3d] text-[#e0e0e0] border border-[#3d3d3d] transition-colors font-medium text-[13px]"
      >
        <span className="text-[#a0a0a0]">{activeOption.icon}</span>
        <span>{activeOption.name}</span>
      </button>

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
              <span className="text-[#a0a0a0] text-xs font-medium">模式选择</span>
              <div className="flex items-center gap-1 text-[#666] text-[10px]">
                <span className="flex items-center justify-center w-4 h-4 rounded border border-[#333] bg-[#222]">
                  <ArrowUpIcon size={10} />
                </span>
                <span>+</span>
                <span className="flex items-center justify-center px-1.5 h-4 rounded border border-[#333] bg-[#222]">
                  tab
                </span>
                <span className="ml-1">切换</span>
              </div>
            </div>

            <div className="flex flex-col p-1.5">
              {modeOptions.map(option => {
                const isActive = currentMode === option.id
                return (
                  <button
                    key={option.id}
                    onClick={() => {
                      setMode(option.id)
                      setIsOpen(false)
                    }}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-colors relative ${
                      isActive ? 'bg-[#005fb8]' : 'hover:bg-[#2d2d2d]'
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
