/**
 * Composer 模型选择器 — 级联下拉，支持按服务商分组
 */
import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  groupSelectableModels,
  getActiveModelDisplayName
} from '../../../shared/config/llmRegistry'
import { CheckSmallIcon } from '../../components/Icons'

export const ModelSelector: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const setActiveModel = useSettingsStore(state => state.setActiveModel)
  const openLlmSettings = useSettingsStore(state => state.openLlmSettings)

  const [isOpen, setIsOpen] = useState(false)
  const [hoveredProviderId, setHoveredProviderId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const groups = llmRegistry ? groupSelectableModels(llmRegistry) : []
  const displayName = llmRegistry ? getActiveModelDisplayName(llmRegistry) : null
  const hasModels = groups.length > 0

  const activeRef = llmRegistry?.activeModel

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setHoveredProviderId(null)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleSelect = async (providerId: string, modelEntryId: string) => {
    try {
      await setActiveModel(providerId, modelEntryId)
    } catch {
      // store 已打日志
    }
    setIsOpen(false)
    setHoveredProviderId(null)
  }

  const isActiveModel = (providerId: string, modelEntryId: string) =>
    activeRef?.providerId === providerId && activeRef?.modelEntryId === modelEntryId

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          if (!hasModels) {
            openLlmSettings()
            return
          }
          setIsOpen(!isOpen)
        }}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#2d2d2d] hover:bg-[#3d3d3d] text-[#e0e0e0] border border-[#3d3d3d] transition-colors font-medium text-[13px] max-w-[160px]"
        title={hasModels ? '切换模型' : '配置模型'}
      >
        <span className="truncate">{hasModels ? (displayName ?? '选择模型') : '未配置'}</span>
        <span className="text-[#888] text-[10px] shrink-0">▼</span>
      </button>

      <AnimatePresence>
        {isOpen && hasModels && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute bottom-[calc(100%+8px)] left-0 min-w-[200px] bg-[#2b2b2b] border border-[#3d3d3d] rounded-xl shadow-2xl z-50 overflow-visible py-1"
          >
            {groups.map(group => {
              // 单模型服务商：主菜单直接展示模型名
              if (group.models.length === 1) {
                const model = group.models[0]
                const active = isActiveModel(model.providerId, model.modelEntryId)
                return (
                  <button
                    key={`${group.providerId}-${model.modelEntryId}`}
                    type="button"
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                      active ? 'bg-[#3d3d3d] text-white' : 'text-[#e0e0e0] hover:bg-[#353535]'
                    }`}
                    onClick={() => void handleSelect(model.providerId, model.modelEntryId)}
                  >
                    <span className="truncate">{model.displayName}</span>
                    {active && <CheckSmallIcon size={14} />}
                  </button>
                )
              }

              // 多模型：服务商行 + 左侧子菜单
              return (
                <div
                  key={group.providerId}
                  className="relative"
                  onMouseEnter={() => setHoveredProviderId(group.providerId)}
                  onMouseLeave={() => setHoveredProviderId(null)}
                >
                  <div
                    className={`flex items-center justify-between gap-2 px-3 py-2 text-[13px] cursor-default ${
                      hoveredProviderId === group.providerId
                        ? 'bg-[#353535] text-white'
                        : 'text-[#e0e0e0]'
                    }`}
                  >
                    <span>{group.providerName}</span>
                    <span className="text-[#888]">›</span>
                  </div>

                  <AnimatePresence>
                    {hoveredProviderId === group.providerId && (
                      <motion.div
                        initial={{ opacity: 0, x: 4 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 4 }}
                        transition={{ duration: 0.12 }}
                        className="absolute right-full top-0 mr-1 min-w-[200px] max-w-[280px] bg-[#2b2b2b] border border-[#3d3d3d] rounded-xl shadow-2xl py-1 z-[60]"
                      >
                        {group.models.map(model => {
                          const active = isActiveModel(model.providerId, model.modelEntryId)
                          return (
                            <button
                              key={model.modelEntryId}
                              type="button"
                              className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                                active
                                  ? 'bg-[#3d3d3d] text-white'
                                  : 'text-[#e0e0e0] hover:bg-[#353535]'
                              }`}
                              onClick={() =>
                                void handleSelect(model.providerId, model.modelEntryId)
                              }
                            >
                              <span className="truncate font-mono text-[12px]">
                                {model.displayName}
                              </span>
                              {active && <CheckSmallIcon size={14} />}
                            </button>
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}

            <div className="border-t border-[#3d3d3d] mt-1 pt-1">
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-[13px] text-[#a0a0a0] hover:bg-[#353535] hover:text-[#e0e0e0] transition-colors"
                onClick={() => {
                  setIsOpen(false)
                  openLlmSettings()
                }}
              >
                管理模型
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
