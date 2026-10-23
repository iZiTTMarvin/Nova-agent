/**
 * 会话内可视化卡片：生成中显示进度与流式预览，展示后挂载沙箱帧，并承载慢放、展开、导出与报错修复。
 * props 只收原始值：流式 tick 重建工具块对象时，内容未变的卡片不重渲染。
 *
 * 生成中与展示后共用同一棵结构：预览帧在交接期间不重挂载，垫在正式帧上方，
 * 正式帧握手后再淡出移除，避免「预览消失 → 空白转圈 → 正式内容」的闪烁。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import {
  parseVisualizationResult,
  VISUALIZATION_MAX_INLINE_HEIGHT,
  VISUALIZATION_PREVIEW_URI,
  VISUALIZATION_SLOW_MOTION_SCALE,
  type VisualizationDocumentStatus
} from '../../../shared/visualization'
import { AlertIcon, ClockIcon, DownloadIcon, ExpandIcon, SparklesIcon, SpinnerIcon } from '../../components/Icons'
import { VisualizationDialog } from './VisualizationDialog'
import { VISUALIZATION_PLACEHOLDER_HEIGHT, VisualizationFrame } from './VisualizationFrame'
import { useStreamingVisualizationHtml } from './useStreamingVisualizationHtml'
import { useVisualizationMessageSubmitter } from './VisualizationMessageContext'
import {
  formatVisualizationEventMessage,
  formatVisualizationRepairMessage
} from './visualizationMessages'
import { useVisualizationTheme } from './visualizationTheme'
import './VisualizationCard.css'

const MAX_COLLECTED_ERRORS = 20
const NOTICE_DURATION_MS = 2400
/** 与 .visualization-card__preview--fading 的过渡时长一致 */
const HANDOFF_FADE_MS = 240

type FrameState = VisualizationDocumentStatus | 'loading' | 'timeout'

export interface VisualizationCardProps {
  status: 'running' | 'success' | 'error'
  title: string
  result?: string
  /** 流式参数原文：预览的 HTML 与进度字符数都从这里派生 */
  argumentsRaw?: string
}

/** 预览帧不收集错误、不回传、不处理超时：正式帧挂载后会重新收集 */
const noopHandler = (): void => {}

export const VisualizationCard: React.FC<VisualizationCardProps> = React.memo(function VisualizationCard({
  status,
  title,
  result,
  argumentsRaw
}) {
  const theme = useVisualizationTheme()
  const preview = useStreamingVisualizationHtml(argumentsRaw)
  const lastPreviewHeightRef = useRef<number | undefined>(undefined)
  const sawArgumentsRawRef = useRef(false)
  const recordPreviewHeight = useCallback((height: number) => {
    lastPreviewHeightRef.current = height
  }, [])
  useEffect(() => {
    if (argumentsRaw !== undefined) sawArgumentsRawRef.current = true
  }, [argumentsRaw])

  const [attempt, setAttempt] = useState(0)
  const [frameState, setFrameState] = useState<FrameState>('loading')
  const [animated, setAnimated] = useState(false)
  const [slowMotion, setSlowMotion] = useState(false)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [repairRequested, setRepairRequested] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [handoffDone, setHandoffDone] = useState(false)
  const motionScale = slowMotion ? VISUALIZATION_SLOW_MOTION_SCALE : 1

  const presentation = status === 'success' ? parseVisualizationResult(result) : null
  const generating = status === 'running'
  const finalSettled = presentation !== null && frameState !== 'loading'

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 正式帧给出结论（就绪、缺失或超时）后预览开始淡出，过渡结束再卸载
  useEffect(() => {
    if (!finalSettled || handoffDone) return
    const timer = window.setTimeout(() => setHandoffDone(true), HANDOFF_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [finalSettled, handoffDone])

  const markTimeout = useCallback(() => setFrameState('timeout'), [])
  const markAnimated = useCallback(() => setAnimated(true), [])
  const collectError = useCallback((message: string) => {
    setErrors(current =>
      current.includes(message) || current.length >= MAX_COLLECTED_ERRORS ? current : [...current, message]
    )
  }, [])
  const displayTitle = presentation?.title ?? title
  const submit = useVisualizationMessageSubmitter()
  const sendEvent = useCallback(
    (name: string, data: unknown) => {
      void submit(formatVisualizationEventMessage(displayTitle, name, data), 'event').then(outcome => {
        if (outcome.status === 'blocked') setNotice(outcome.notice)
      })
    },
    [submit, displayTitle]
  )
  const requestRepair = (): void => {
    setRepairRequested(true)
    void submit(formatVisualizationRepairMessage(displayTitle, errors), 'repair').then(outcome => {
      if (outcome.status !== 'blocked') return
      // 没发出去就恢复按钮，用户之后还能再请求修复
      setRepairRequested(false)
      setNotice(outcome.notice)
    })
  }
  const retry = (): void => {
    setFrameState('loading')
    setAttempt(value => value + 1)
  }
  const exportHtml = async (): Promise<void> => {
    if (!presentation) return
    try {
      const outcome = await window.api.invoke('visualization:export', { uri: presentation.uri, title: displayTitle, theme })
      if (outcome.status === 'saved') setNotice('已导出')
      else if (outcome.status === 'failed') setNotice(`导出失败：${outcome.error}`)
    } catch (err) {
      setNotice(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ready = presentation !== null && frameState === 'ok'
  const showPreview =
    preview.html !== null && !handoffDone && frameState !== 'timeout' && (generating || presentation !== null)
  const progress =
    preview.complete || (argumentsRaw === undefined && sawArgumentsRawRef.current)
      ? '正在发布…'
      : argumentsRaw !== undefined
        ? formatProgress(argumentsRaw.length)
        : '正在生成…'

  const sharedActions = ready ? (
    <>
      {animated && (
        <IconButton
          label={slowMotion ? '恢复正常速度' : '慢放'}
          tooltip={slowMotion ? '恢复正常速度' : `慢放 ${VISUALIZATION_SLOW_MOTION_SCALE}×`}
          icon={<ClockIcon size={15} />}
          variant="ghost"
          size="sm"
          aria-pressed={slowMotion}
          className={slowMotion ? 'visualization-card__toggle--on' : undefined}
          onClick={() => setSlowMotion(value => !value)}
        />
      )}
      <IconButton
        label="导出 HTML"
        tooltip="导出为 HTML 文件"
        icon={<DownloadIcon size={15} />}
        variant="ghost"
        size="sm"
        clickAction={exportHtml}
      />
    </>
  ) : null

  const cardState = generating ? 'generating' : presentation ? frameState : 'invalid'
  const previewClassName = [
    'visualization-card__preview',
    presentation ? 'visualization-card__preview--overlay' : '',
    finalSettled ? 'visualization-card__preview--fading' : ''
  ].filter(Boolean).join(' ')

  // 视口子节点按固定槽位排列：预览帧所在槽位在生成 → 展示之间不变，iframe 不会被重建
  return (
    <section
      className="visualization-card"
      data-testid="visualization-card"
      data-state={cardState}
      aria-busy={generating}
      aria-label={displayTitle ? `可视化：${displayTitle}` : '可视化'}
    >
      <header className="visualization-card__header">
        <span className="visualization-card__icon" aria-hidden="true">
          {generating
            ? <SpinnerIcon size={15} className="visualization-card__spinner" />
            : presentation ? <SparklesIcon size={15} /> : <AlertIcon size={15} />}
        </span>
        <span className="visualization-card__title" title={displayTitle}>{displayTitle || '可视化'}</span>
        {generating && preview.html !== null && <span className="visualization-card__progress">{progress}</span>}
        {notice && <span className="visualization-card__notice" role="status">{notice}</span>}
        {presentation && (
          <div className="visualization-card__actions">
            {sharedActions}
            {ready && (
              <IconButton
                label="展开"
                tooltip="展开查看"
                icon={<ExpandIcon size={15} />}
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(true)}
              />
            )}
          </div>
        )}
      </header>

      <div className="visualization-card__viewport">
        {presentation && frameState !== 'timeout' ? (
          <VisualizationFrame
            key={attempt}
            uri={presentation.uri}
            title={displayTitle}
            theme={theme}
            motionScale={motionScale}
            maxHeight={VISUALIZATION_MAX_INLINE_HEIGHT}
            cacheHeight
            initialHeight={lastPreviewHeightRef.current}
            onReady={setFrameState}
            onTimeout={markTimeout}
            onAnimated={markAnimated}
            onRuntimeError={collectError}
            onUserEvent={sendEvent}
            onOverflow={setOverflowing}
          />
        ) : null}
        {presentation && frameState === 'timeout' ? (
          <div className="visualization-card__state" style={{ minHeight: VISUALIZATION_PLACEHOLDER_HEIGHT }}>
            <span>可视化加载超时</span>
            <Button label="重试" variant="secondary" size="sm" onClick={retry} />
          </div>
        ) : null}
        {presentation && frameState === 'loading' && !showPreview ? (
          <div className="visualization-card__loading" aria-hidden="true">
            <SpinnerIcon size={15} className="visualization-card__spinner" />
          </div>
        ) : null}
        {showPreview && preview.html !== null ? (
          <div className={previewClassName} data-testid="visualization-preview" aria-hidden={presentation ? true : undefined}>
            <VisualizationFrame
              uri={VISUALIZATION_PREVIEW_URI}
              title={displayTitle}
              theme={theme}
              motionScale={1}
              maxHeight={VISUALIZATION_MAX_INLINE_HEIGHT}
              previewHtml={preview.html}
              onReady={noopHandler}
              onTimeout={noopHandler}
              onAnimated={noopHandler}
              onRuntimeError={noopHandler}
              onUserEvent={noopHandler}
              onHeight={recordPreviewHeight}
            />
          </div>
        ) : null}
        {!presentation && !showPreview ? (
          <div
            className={`visualization-card__placeholder${generating ? ' visualization-card__placeholder--live' : ''}`}
            style={{ height: VISUALIZATION_PLACEHOLDER_HEIGHT }}
          >
            {generating && <PlaceholderSkeleton />}
            <span className="visualization-card__meta">{generating ? progress : '可视化结果无法解析'}</span>
          </div>
        ) : null}
      </div>

      {overflowing && (
        <footer className="visualization-card__overflow" data-testid="visualization-overflow">
          <span>内容超出卡片高度，可在卡片内滚动查看</span>
          <Button label="展开查看" variant="secondary" size="sm" onClick={() => setExpanded(true)} />
        </footer>
      )}

      {errors.length > 0 && (
        <footer className="visualization-card__footer" data-testid="visualization-errors">
          <AlertIcon size={14} aria-hidden="true" />
          <span className="visualization-card__error" title={errors.join('\n')}>
            {errors[0]}
            {errors.length > 1 ? `（另有 ${errors.length - 1} 条）` : ''}
          </span>
          <Button
            label={repairRequested ? '已请求修复' : '让 Nova 修复'}
            variant="secondary"
            size="sm"
            isDisabled={repairRequested}
            onClick={requestRepair}
          />
        </footer>
      )}

      {expanded && presentation && (
        <VisualizationDialog
          uri={presentation.uri}
          title={displayTitle}
          theme={theme}
          motionScale={motionScale}
          actions={sharedActions}
          onClose={() => setExpanded(false)}
          onAnimated={markAnimated}
          onRuntimeError={collectError}
          onUserEvent={sendEvent}
        />
      )}
    </section>
  )
})

function formatProgress(chars: number | undefined): string {
  if (!chars) return '正在生成…'
  return chars < 1000 ? `正在生成 · ${chars} 字符` : `正在生成 · ${(chars / 1000).toFixed(1)}k 字符`
}

/** 页面骨架：标题条 + 两列块 + 一行说明，暗示正在搭版面而不是空等 */
function PlaceholderSkeleton(): React.ReactElement {
  return (
    <div className="visualization-card__skeleton" aria-hidden="true">
      <span className="visualization-card__skeleton-bar visualization-card__skeleton-bar--title" />
      <span className="visualization-card__skeleton-row">
        <span className="visualization-card__skeleton-block" />
        <span className="visualization-card__skeleton-block" />
      </span>
      <span className="visualization-card__skeleton-bar" />
    </div>
  )
}
