/**
 * ReasoningEffortControl — Composer 的思考强度选择器。
 *
 * 触发器显示当前生效档位（Low / Medium / High / Max）；点开的浮层是离散档位滑杆，
 * 节点由当前模型的真实能力决定（如 MiniMax 只有 High / Max 两个节点）。
 * 档位少于两个时不渲染：没有可选的意义，也不暴露无效参数。
 *
 * 选择写回会话级覆盖（选回模型默认档时清除覆盖）；覆盖不再适用于当前模型时自动清除。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Popover } from '@astryxdesign/core/Popover'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  findModelEntry,
  findProvider,
  getSupportedReasoningEfforts,
  resolveModelReasoningEffort,
  type ReasoningEffort
} from '../../../shared/config/llmRegistry'
import { ChevronIcon, ThinkIcon } from '../../components/Icons'
import './ReasoningEffortControl.css'

/** 档位标签：统一首字母大写英文，跨模型可辨且不随界面语言漂移。 */
const EFFORT_LABELS: Record<Exclude<ReasoningEffort, 'auto'>, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

type ConcreteEffort = Exclude<ReasoningEffort, 'auto'>

export const ReasoningEffortControl: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const override = useWorkspaceStore(state => state.reasoningEffortOverride)
  const activeModelRef = useWorkspaceStore(state => state.activeModelRef)
  const currentSessionId = useWorkspaceStore(state => state.currentSessionId)
  const setReasoningEffortOverride = useWorkspaceStore(
    state => state.setReasoningEffortOverride
  )
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const currentRef = activeModelRef ?? llmRegistry?.activeModel ?? null
  const entry = useMemo(() => {
    if (!llmRegistry || !currentRef) return null
    const provider = findProvider(llmRegistry, currentRef.providerId)
    return provider ? findModelEntry(provider, currentRef.modelEntryId) ?? null : null
  }, [currentRef?.modelEntryId, currentRef?.providerId, llmRegistry])

  const tiers = useMemo<readonly ConcreteEffort[]>(() => {
    if (!entry) return []
    return (getSupportedReasoningEfforts(entry) ?? [])
      .filter((value): value is ConcreteEffort => value !== 'auto')
  }, [entry])

  const defaultEffort = entry ? resolveModelReasoningEffort(entry) : 'auto'

  /** 当前生效档位：会话覆盖可用时按覆盖，否则模型默认档，最后兜底到最低档。 */
  const effectiveTier = useMemo<ConcreteEffort | null>(() => {
    if (tiers.length === 0) return null
    if (override && override !== 'auto' && tiers.includes(override)) return override
    if (defaultEffort !== 'auto' && tiers.includes(defaultEffort)) return defaultEffort
    return tiers[0] ?? null
  }, [defaultEffort, override, tiers])

  const activeIndex = effectiveTier ? Math.max(0, tiers.indexOf(effectiveTier)) : 0
  const shownIndex = dragIndex ?? activeIndex
  const shownTier = tiers[shownIndex] ?? effectiveTier

  const commitTier = useCallback((tier: ConcreteEffort) => {
    void setReasoningEffortOverride(tier === defaultEffort ? null : tier).catch(error => {
      console.error('[ReasoningEffortControl] 切换思考强度失败:', error)
    })
  }, [defaultEffort, setReasoningEffortOverride])

  const indexFromClientX = useCallback((clientX: number): number => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = (clientX - rect.left) / rect.width
    const clamped = Math.min(1, Math.max(0, ratio))
    return Math.round(clamped * (tiers.length - 1))
  }, [tiers.length])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    draggingRef.current = true
    setDragIndex(indexFromClientX(event.clientX))
  }, [indexFromClientX])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    setDragIndex(indexFromClientX(event.clientX))
  }, [indexFromClientX])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const tier = tiers[indexFromClientX(event.clientX)]
    setDragIndex(null)
    if (tier && tier !== effectiveTier) commitTier(tier)
  }, [commitTier, effectiveTier, indexFromClientX, tiers])

  const handlePointerCancel = useCallback(() => {
    draggingRef.current = false
    setDragIndex(null)
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const lastIndex = tiers.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(lastIndex, activeIndex + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, activeIndex - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = lastIndex
    if (next === null || next === activeIndex) return
    event.preventDefault()
    const tier = tiers[next]
    if (tier) commitTier(tier)
  }, [activeIndex, commitTier, tiers])

  if (!currentSessionId || !entry || tiers.length < 2 || !shownTier) return null

  const pct = (shownIndex / (tiers.length - 1)) * 100
  const shownLabel = EFFORT_LABELS[shownTier]
  const triggerLabel = EFFORT_LABELS[effectiveTier ?? shownTier]

  const panel = (
    <div className="effort-panel">
      <div className="effort-panel__value" aria-live="polite">{shownLabel}</div>
      <div
        ref={railRef}
        className="effort-slider"
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={tiers.length - 1}
        aria-valuenow={shownIndex}
        aria-valuetext={shownLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <div className="effort-slider__track" />
        <div className="effort-slider__fill" style={{ width: `${pct}%` }} />
        {tiers.map((tier, index) => (
          <span
            key={tier}
            className={`effort-slider__stop${index <= shownIndex ? ' effort-slider__stop--active' : ''}`}
            style={{ left: `${(index / (tiers.length - 1)) * 100}%` }}
          />
        ))}
        <div className="effort-slider__thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  )

  return (
    <Popover
      label="思考强度"
      placement="above"
      alignment="end"
      hasAutoFocus={false}
      className="effort-control"
      content={panel}
    >
      <Button
        label={`思考强度：${triggerLabel}`}
        variant="ghost"
        size="sm"
        tooltip="思考强度"
        className="effort-control__trigger"
      >
        <span className="effort-control__content">
          <ThinkIcon size={14} />
          <span className="effort-control__label">{triggerLabel}</span>
          <ChevronIcon size={12} direction="down" />
        </span>
      </Button>
    </Popover>
  )
}
