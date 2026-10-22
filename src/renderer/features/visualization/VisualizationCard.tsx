/**
 * 会话内可视化卡片：生成中显示进度，展示后挂载沙箱帧，并承载慢放、展开、导出与报错修复。
 * props 只收原始值：流式 tick 重建工具块对象时，内容未变的卡片不重渲染。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import {
  parseVisualizationResult,
  VISUALIZATION_MAX_INLINE_HEIGHT,
  VISUALIZATION_SLOW_MOTION_SCALE,
  type VisualizationDocumentStatus
} from '../../../shared/visualization'
import { AlertIcon, ClockIcon, DownloadIcon, ExpandIcon, SparklesIcon, SpinnerIcon } from '../../components/Icons'
import { VisualizationDialog } from './VisualizationDialog'
import { VISUALIZATION_PLACEHOLDER_HEIGHT, VisualizationFrame } from './VisualizationFrame'
import { useVisualizationMessageSubmitter } from './VisualizationMessageContext'
import {
  formatVisualizationEventMessage,
  formatVisualizationRepairMessage
} from './visualizationMessages'
import { useVisualizationTheme } from './visualizationTheme'
import './VisualizationCard.css'

const MAX_COLLECTED_ERRORS = 20
const NOTICE_DURATION_MS = 2400

type FrameState = VisualizationDocumentStatus | 'loading' | 'timeout'

export interface VisualizationCardProps {
  status: 'running' | 'success' | 'error'
  title: string
  result?: string
  /** 流式参数已到达的字符数，生成中用作进度 */
  streamedChars?: number
}

export const VisualizationCard: React.FC<VisualizationCardProps> = React.memo(function VisualizationCard({
  status,
  title,
  result,
  streamedChars
}) {
  const presentation = status === 'success' ? parseVisualizationResult(result) : null
  if (presentation) {
    return <PresentedVisualization uri={presentation.uri} title={presentation.title} />
  }

  const generating = status === 'running'
  return (
    <section
      className="visualization-card"
      data-testid="visualization-card"
      data-state={generating ? 'generating' : 'invalid'}
      aria-busy={generating}
      aria-label={title ? `可视化：${title}` : '可视化'}
    >
      <header className="visualization-card__header">
        <span className="visualization-card__icon" aria-hidden="true">
          {generating ? <SpinnerIcon size={15} className="visualization-card__spinner" /> : <AlertIcon size={15} />}
        </span>
        <span className="visualization-card__title">{title || '可视化'}</span>
      </header>
      <div
        className={`visualization-card__placeholder${generating ? ' visualization-card__placeholder--live' : ''}`}
        style={{ height: VISUALIZATION_PLACEHOLDER_HEIGHT }}
      >
        <span className="visualization-card__meta">{generating ? formatProgress(streamedChars) : '可视化结果无法解析'}</span>
      </div>
    </section>
  )
})

function formatProgress(chars: number | undefined): string {
  if (!chars) return '正在生成…'
  return chars < 1000 ? `正在生成 · ${chars} 字符` : `正在生成 · ${(chars / 1000).toFixed(1)}k 字符`
}

function PresentedVisualization({ uri, title }: { uri: string; title: string }): React.ReactElement {
  const theme = useVisualizationTheme()
  const [attempt, setAttempt] = useState(0)
  const [frameState, setFrameState] = useState<FrameState>('loading')
  const [animated, setAnimated] = useState(false)
  const [slowMotion, setSlowMotion] = useState(false)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [repairRequested, setRepairRequested] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const motionScale = slowMotion ? VISUALIZATION_SLOW_MOTION_SCALE : 1

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const markTimeout = useCallback(() => setFrameState('timeout'), [])
  const markAnimated = useCallback(() => setAnimated(true), [])
  const collectError = useCallback((message: string) => {
    setErrors(current =>
      current.includes(message) || current.length >= MAX_COLLECTED_ERRORS ? current : [...current, message]
    )
  }, [])
  const submit = useVisualizationMessageSubmitter()
  const sendEvent = useCallback(
    (name: string, data: unknown) => {
      void submit(formatVisualizationEventMessage(title, name, data), 'event').then(outcome => {
        if (outcome.status === 'blocked') setNotice(outcome.notice)
      })
    },
    [submit, title]
  )
  const requestRepair = (): void => {
    setRepairRequested(true)
    void submit(formatVisualizationRepairMessage(title, errors), 'repair').then(outcome => {
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
    try {
      const outcome = await window.api.invoke('visualization:export', { uri, title, theme })
      if (outcome.status === 'saved') setNotice('已导出')
      else if (outcome.status === 'failed') setNotice(`导出失败：${outcome.error}`)
    } catch (err) {
      setNotice(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ready = frameState === 'ok'
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

  return (
    <section
      className="visualization-card"
      data-testid="visualization-card"
      data-state={frameState}
      aria-label={`可视化：${title}`}
    >
      <header className="visualization-card__header">
        <span className="visualization-card__icon" aria-hidden="true">
          <SparklesIcon size={15} />
        </span>
        <span className="visualization-card__title" title={title}>{title}</span>
        {notice && <span className="visualization-card__notice" role="status">{notice}</span>}
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
      </header>

      {frameState === 'timeout' ? (
        <div className="visualization-card__state" style={{ minHeight: VISUALIZATION_PLACEHOLDER_HEIGHT }}>
          <span>可视化加载超时</span>
          <Button label="重试" variant="secondary" size="sm" onClick={retry} />
        </div>
      ) : (
        <div className="visualization-card__viewport">
          <VisualizationFrame
            key={attempt}
            uri={uri}
            title={title}
            theme={theme}
            motionScale={motionScale}
            maxHeight={VISUALIZATION_MAX_INLINE_HEIGHT}
            cacheHeight
            onReady={setFrameState}
            onTimeout={markTimeout}
            onAnimated={markAnimated}
            onRuntimeError={collectError}
            onUserEvent={sendEvent}
            onOverflow={setOverflowing}
          />
          {frameState === 'loading' && (
            <div className="visualization-card__loading" aria-hidden="true">
              <SpinnerIcon size={15} className="visualization-card__spinner" />
            </div>
          )}
        </div>
      )}

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

      {expanded && (
        <VisualizationDialog
          uri={uri}
          title={title}
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
}
