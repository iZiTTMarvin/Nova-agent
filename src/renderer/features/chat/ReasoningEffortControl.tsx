/**
 * ReasoningEffortControl — Composer 的思考强度选择器。
 *
 * 触发器显示当前生效档位；浮层以连续拖动、离散落档的方式选择推理强度，
 * 节点由当前模型的真实能力决定（如 MiniMax 只有 High / Max 两个节点）。
 * 档位少于两个时不渲染：没有可选的意义，也不暴露无效参数。
 *
 * 选择写回会话级覆盖（选回模型默认档时清除覆盖）；覆盖不再适用于当前模型时自动清除。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { BrainIcon, ChevronIcon, ThinkIcon } from '../../components/Icons'
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

  if (!currentSessionId || !entry || !currentRef || tiers.length < 2 || !effectiveTier) return null

  return (
    <ReasoningEffortSlider
      key={JSON.stringify([currentSessionId, currentRef.providerId, currentRef.modelEntryId, tiers, defaultEffort])}
      tiers={tiers}
      effectiveTier={effectiveTier}
      defaultEffort={defaultEffort}
      setReasoningEffortOverride={setReasoningEffortOverride}
    />
  )
}

interface ReasoningEffortSliderProps {
  tiers: readonly ConcreteEffort[]
  effectiveTier: ConcreteEffort
  defaultEffort: ReasoningEffort
  setReasoningEffortOverride: (effort: ReasoningEffort | null) => Promise<void>
}

/** A small, deterministic constellation: CSS only, no timers or particle loop. */
const SPARKS = [
  [7, 24], [12, 78], [19, 46], [27, 15], [32, 69], [39, 39],
  [44, 82], [51, 25], [57, 61], [63, 15], [68, 76], [73, 45],
  [79, 20], [83, 72], [89, 34], [94, 58]
] as const

const ReasoningEffortSlider: React.FC<ReasoningEffortSliderProps> = ({
  tiers, effectiveTier, defaultEffort, setReasoningEffortOverride
}) => {
  // Preview follows the pointer continuously. Only the nearest supported tier is persisted.
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const requestVersion = useRef(0)

  useEffect(() => () => { requestVersion.current += 1 }, [])

  const activeIndex = Math.max(0, tiers.indexOf(effectiveTier))
  const selectedIndex = pendingIndex ?? activeIndex
  const shownIndex = dragProgress === null
    ? selectedIndex
    : Math.round(dragProgress * (tiers.length - 1))
  const shownTier = tiers[shownIndex] ?? effectiveTier
  const shownLabel = EFFORT_LABELS[shownTier]
  const triggerLabel = EFFORT_LABELS[tiers[selectedIndex] ?? effectiveTier]
  const progress = (dragProgress ?? shownIndex / (tiers.length - 1)) * 100
  const isHighest = shownIndex === tiers.length - 1
  const defaultLabel = defaultEffort !== 'auto' && tiers.includes(defaultEffort)
    ? EFFORT_LABELS[defaultEffort]
    : null

  const commitTier = useCallback((tier: ConcreteEffort) => {
    const version = ++requestVersion.current
    setPendingIndex(tiers.indexOf(tier))
    setSaveError(null)
    // 保留预览直到写回完成，迟到的旧请求不可覆盖下一次选择。
    void setReasoningEffortOverride(tier === defaultEffort ? null : tier)
      .catch(() => {
        if (requestVersion.current === version) setSaveError('思考强度保存失败，请重试。')
      })
      .finally(() => {
        if (requestVersion.current === version) setPendingIndex(null)
      })
  }, [defaultEffort, setReasoningEffortOverride, tiers])

  const progressFromClientX = useCallback((clientX: number): number => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const indexFromClientX = useCallback((clientX: number): number => {
    return Math.round(progressFromClientX(clientX) * (tiers.length - 1))
  }, [progressFromClientX, tiers.length])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    draggingRef.current = true
    setDragProgress(progressFromClientX(event.clientX))
  }, [progressFromClientX])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    setDragProgress(progressFromClientX(event.clientX))
  }, [progressFromClientX])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const tier = tiers[indexFromClientX(event.clientX)]
    setDragProgress(null)
    if (tier && (tier !== effectiveTier || pendingIndex !== null)) commitTier(tier)
  }, [commitTier, effectiveTier, indexFromClientX, pendingIndex, tiers])

  const handlePointerCancel = useCallback(() => {
    draggingRef.current = false
    setDragProgress(null)
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const lastIndex = tiers.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(lastIndex, shownIndex + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, shownIndex - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = lastIndex
    if (next === null || next === shownIndex) return
    event.preventDefault()
    const tier = tiers[next]
    if (tier) commitTier(tier)
  }, [shownIndex, commitTier, tiers])

  const panel = (
    <div className="effort-panel">
      <div className="effort-panel__header">
        <div className="effort-panel__heading" aria-live="polite">
          <span className="effort-panel__eyebrow">Effort</span>
          <span className={'effort-panel__value' + (isHighest ? ' effort-panel__value--highest' : '')} key={shownTier}>
            {shownLabel}
          </span>
        </div>
        <span
          className="effort-panel__info"
          title="越高的思考强度可能获得更充分的推理，也可能增加等待时间。具体效果取决于模型。"
          aria-label="思考强度越高，模型可能推理更久"
        >i</span>
      </div>

      <div className="effort-panel__scale" aria-hidden="true">
        <span>Faster</span>
        <span>Smarter</span>
      </div>

      <div
        ref={railRef}
        className={'effort-slider' + (dragProgress !== null ? ' effort-slider--dragging' : '') + (isHighest ? ' effort-slider--stellar' : '')}
        style={{ '--effort-progress': progress + '%' } as React.CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={tiers.length - 1}
        aria-valuenow={shownIndex}
        aria-valuetext={shownLabel}
        aria-busy={pendingIndex !== null}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <div className="effort-slider__track" aria-hidden="true" />
        <div className="effort-slider__fill" aria-hidden="true" />
        <div className="effort-slider__cosmos" aria-hidden="true">
          {SPARKS.map(([x, y], index) => (
            <span
              key={index}
              className="effort-slider__spark"
              style={{
                left: x + '%',
                top: y + '%',
                animationDelay: (-0.19 * (index % 7)) + 's'
              }}
            />
          ))}
        </div>
        {tiers.map((tier, index) => (
          <span
            key={tier}
            className={'effort-slider__stop' + (index <= shownIndex ? ' effort-slider__stop--active' : '')}
            style={{ left: (100 * index / (tiers.length - 1)) + '%' }}
            aria-hidden="true"
          />
        ))}
        <div className="effort-slider__thumb" aria-hidden="true">
          <span className="effort-slider__thumb-halo" />
          <BrainIcon size={20} />
          <svg className="effort-slider__nova-star" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0.5c1.4 6.6 4.9 10.1 11.5 11.5-6.6 1.4-10.1 4.9-11.5 11.5C10.6 17.4 7.1 13.9.5 12 7.1 10.6 10.6 7.1 12 .5Z" />
          </svg>
        </div>
      </div>

      <div className="effort-panel__footer">
        <span>Model default</span>
        <span>{defaultLabel ?? 'Auto'}</span>
      </div>
      {saveError && <div className="effort-panel__error" role="alert">{saveError}</div>}
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
        label={'思考强度：' + triggerLabel}
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
