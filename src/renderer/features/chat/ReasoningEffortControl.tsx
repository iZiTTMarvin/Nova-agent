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
import { ChevronIcon, InfoIcon, ThinkIcon } from '../../components/Icons'
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

const ReasoningEffortSlider: React.FC<ReasoningEffortSliderProps> = ({
  tiers, effectiveTier, defaultEffort, setReasoningEffortOverride
}) => {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const dragRatioRef = useRef(0)
  const requestVersion = useRef(0)

  useEffect(() => () => { requestVersion.current += 1 }, [])

  const activeIndex = Math.max(0, tiers.indexOf(effectiveTier))
  const defaultIndex = tiers.indexOf(defaultEffort as ConcreteEffort)
  const shownIndex = previewIndex ?? pendingIndex ?? activeIndex
  const shownTier = tiers[shownIndex] ?? effectiveTier
  const shownLabel = EFFORT_LABELS[shownTier]
  const triggerLabel = EFFORT_LABELS[tiers[pendingIndex ?? activeIndex] ?? effectiveTier]
  const isHighest = shownIndex === tiers.length - 1
  const defaultLabel = defaultIndex >= 0 ? EFFORT_LABELS[tiers[defaultIndex] as ConcreteEffort] : null

  const commitTier = useCallback((tier: ConcreteEffort) => {
    const version = ++requestVersion.current
    setPendingIndex(tiers.indexOf(tier))
    setSaveError(null)
    // 保存确认前保留选择，旧请求不能清掉较新的预览。
    void setReasoningEffortOverride(tier === defaultEffort ? null : tier)
      .catch(() => {
        if (requestVersion.current === version) setSaveError('思考强度保存失败，请重试。')
      })
      .finally(() => {
        if (requestVersion.current === version) setPendingIndex(null)
      })
  }, [defaultEffort, setReasoningEffortOverride, tiers])

  const ratioFromClientX = useCallback((clientX: number): number => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  // 连续跟随直接写 CSS 变量，不经过 React；只有跨档才更新预览索引触发重渲染。
  // 拖动中渲染期的 ratio 取自同一 ref，避免 React 重渲染覆盖指针位置。
  const paintDrag = useCallback((clientX: number) => {
    const ratio = ratioFromClientX(clientX)
    dragRatioRef.current = ratio
    railRef.current?.style.setProperty('--effort-ratio', ratio.toFixed(4))
    setPreviewIndex(Math.round(ratio * (tiers.length - 1)))
  }, [ratioFromClientX, tiers.length])

  const releaseDrag = useCallback(() => {
    draggingRef.current = false
    railRef.current?.style.removeProperty('--effort-ratio')
    setDragging(false)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    draggingRef.current = true
    setDragging(true)
    paintDrag(event.clientX)
  }, [paintDrag])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    paintDrag(event.clientX)
  }, [paintDrag])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const tier = tiers[Math.round(ratioFromClientX(event.clientX) * (tiers.length - 1))]
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    releaseDrag()
    setPreviewIndex(null)
    if (tier && (tier !== effectiveTier || pendingIndex !== null)) commitTier(tier)
  }, [commitTier, effectiveTier, pendingIndex, ratioFromClientX, releaseDrag, tiers])

  const handlePointerCancel = useCallback(() => {
    if (!draggingRef.current) return
    releaseDrag()
    setPreviewIndex(null)
  }, [releaseDrag])

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

  const sliderStyle: React.CSSProperties & { '--effort-ratio': number } = {
    '--effort-ratio': previewIndex === null ? shownIndex / (tiers.length - 1) : dragRatioRef.current
  }

  const panel = (
    <div className="effort-panel">
      <div className="effort-panel__header">
        <div className="effort-panel__heading" aria-live="polite">
          <span className="effort-panel__eyebrow">思考强度</span>
          <span className={`effort-panel__value${isHighest ? ' effort-panel__value--highest' : ''}`} key={shownTier}>
            {shownLabel}
          </span>
        </div>
        <span
          className="effort-panel__info"
          tabIndex={0}
          title="思考强度越高，模型可能推理越充分，等待也越久；具体效果取决于模型。"
          aria-label="思考强度越高，模型可能推理越充分，等待也越久"
        >
          <InfoIcon size={13} />
        </span>
      </div>
      <div
        ref={railRef}
        className={`effort-slider${dragging ? ' effort-slider--dragging' : ''}${isHighest ? ' effort-slider--stellar' : ''}`}
        style={sliderStyle}
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
        <div className="effort-slider__flow" aria-hidden="true" />
        {tiers.map((tier, index) => (
          <span
            key={tier}
            className={`effort-slider__stop${index <= shownIndex ? ' effort-slider__stop--active' : ''}${index === defaultIndex ? ' effort-slider__stop--default' : ''}`}
            style={{ left: `${(index / (tiers.length - 1)) * 100}%` }}
            aria-hidden="true"
          />
        ))}
        <div className="effort-slider__knob" aria-hidden="true">
          <svg className="effort-slider__brain" viewBox="0 0 24 24">
            <path d="M12 6.2C11.2 3.6 8.6 3 7.4 4.6 4.8 4.2 3 6.2 3.8 8.6 2.4 10 2.4 14 3.8 15.4 3 17.8 4.8 19.8 7.4 19.4 8.6 21 11.2 20.4 12 18.2 12.8 20.4 15.4 21 16.6 19.4 19.2 19.8 21 17.8 20.2 15.4 21.6 14 21.6 10 20.2 8.6 21 6.2 19.2 4.2 16.6 4.6 15.4 3 12.8 3.6 12 6.2Z" />
            <path d="M12 6.2c0 2.6-.7 4.2-2.1 5.2M12 6.2c0 2.6.7 4.2 2.1 5.2M12 18.2c0-2.6-.7-4.2-2.1-5.2M12 18.2c0-2.6.7-4.2 2.1-5.2" />
          </svg>
          <svg className="effort-slider__star" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1.5c1.2 5.6 4.2 8.6 9.8 9.8-5.6 1.2-8.6 4.2-9.8 9.8-1.2-5.6-4.2-8.6-9.8-9.8 5.6-1.2 8.6-4.2 9.8-9.8Z" />
          </svg>
        </div>
      </div>
      <div className="effort-panel__footer">
        <span>模型默认</span>
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
