/**
 * 主题详情：标题、学习目标、要点与出处。出处 chip 点击后就地展开片段；
 * 推断类要点用 ≈ 与弱色标注；「在开发会话中修改」收进右上 ⋯ 菜单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { ArrowLeftIcon, MoreIcon, SpinnerIcon } from '../../../components/Icons'
import type { KnowledgeClaim } from '../../../../shared/learning/knowledgeClaim'
import { parseKnowledgeClaims } from '../../../../shared/learning/knowledgeClaim'
import type {
  KnowledgeNodeSourceView,
  KnowledgeNodeSummaryView
} from '../../../../shared/learning/knowledgeProjection'
import type { LearningNodeMaterialResult, LearningSourceResult } from '../../../../shared/learning/surface'
import { selectSessionIsRunning, useRunStore } from '../../../stores/useRunStore'
import { useSettingsStore } from '../../../stores/useSettingsStore'
import { useLearningStore } from '../useLearningStore'
import { switchToDevSurface } from '../learningSurfaceSwitch'
import {
  LEARNING_DETAIL_BACK,
  LEARNING_DETAIL_BODY_INVALID,
  LEARNING_DETAIL_EDIT_IN_DEV,
  LEARNING_DETAIL_MENU_LABEL,
  LEARNING_DETAIL_NO_MATERIAL,
  LEARNING_DETAIL_START,
  LEARNING_INFERENCE_TOOLTIP,
  LEARNING_OUTLINE_LOADING,
  LEARNING_SOURCE_CHANGED,
  LEARNING_SOURCE_SNIPPET_LABEL,
  learningEditInDevPrefill,
  learningEditInDevPrefillWithoutSource,
  learningSourceFailureCopy
} from '../learningCopy'

interface OutlineTopicDetailProps {
  sessionId: string
  node: KnowledgeNodeSummaryView
  onBack: () => void
}

interface ParsedNodeBody {
  readonly learningGoal: string
  readonly summary: string
  readonly claims: readonly KnowledgeClaim[]
}

function parseBody(bodyJson: string): ParsedNodeBody | null {
  try {
    const raw: unknown = JSON.parse(bodyJson)
    if (!raw || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    return {
      learningGoal: typeof row.learningGoal === 'string' ? row.learningGoal : '',
      summary: typeof row.summary === 'string' ? row.summary : '',
      claims: parseKnowledgeClaims(row.claims ?? [])
    }
  } catch {
    return null
  }
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : filePath
}

interface SourceState {
  readonly status: 'loading' | 'ready'
  readonly result: LearningSourceResult | null
}

export function OutlineTopicDetail({ sessionId, node, onBack }: OutlineTopicDetailProps): React.ReactElement {
  const [materialState, setMaterialState] = useState<LearningNodeMaterialResult | 'loading' | null>('loading')
  const [expandedReceiptId, setExpandedReceiptId] = useState<string | null>(null)
  const [sourceState, setSourceState] = useState<SourceState | null>(null)
  // 材料与出处共用一个递增编号：晚到的旧响应一律丢弃
  const requestRef = useRef(0)

  const selectedNodeId = useLearningStore(state =>
    state.sessionId === sessionId ? state.projection?.selectedNodeId ?? null : null
  )
  const commandPending = useLearningStore(state => state.sessionId === sessionId && state.commandPending)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const isRunning = useRunStore(state => selectSessionIsRunning(state, sessionId))
  const busy = commandPending || isRunning

  useEffect(() => {
    const request = ++requestRef.current
    setMaterialState('loading')
    setExpandedReceiptId(null)
    setSourceState(null)
    window.api
      .invoke('learning:get-node-material', { sessionId, nodeId: node.nodeId })
      .then(result => {
        if (request === requestRef.current) setMaterialState(result)
      })
      .catch(error => {
        if (request === requestRef.current) {
          setMaterialState({ ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      })
  }, [sessionId, node.nodeId])

  const material = materialState !== 'loading' && materialState?.ok ? materialState.material : null
  const body = useMemo(() => (material ? parseBody(material.bodyJson) : null), [material])

  // 展开的片段只挂在第一个引用该出处的要点下，避免同一出处被多处引用时重复渲染
  const snippetClaimIndex = useMemo(() => {
    if (!expandedReceiptId || !body) return -1
    return body.claims.findIndex(
      claim =>
        (claim.kind === 'source_fact' || claim.kind === 'inference') &&
        claim.sourceIds.includes(expandedReceiptId)
    )
  }, [body, expandedReceiptId])

  const toggleSource = useCallback(
    async (receiptId: string) => {
      if (expandedReceiptId === receiptId) {
        requestRef.current++
        setExpandedReceiptId(null)
        setSourceState(null)
        return
      }
      const request = ++requestRef.current
      setExpandedReceiptId(receiptId)
      setSourceState({ status: 'loading', result: null })
      try {
        const result = await window.api.invoke('learning:get-source', { sessionId, nodeId: node.nodeId, receiptId })
        if (request === requestRef.current) setSourceState({ status: 'ready', result })
      } catch (error) {
        if (request === requestRef.current) {
          setSourceState({
            status: 'ready',
            result: { ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }
          })
        }
      }
    },
    [expandedReceiptId, node.nodeId, sessionId]
  )

  const handleEditInDev = useCallback(() => {
    // 优先当前展开的片段位置，其次材料的第一条出处
    const opened = sourceState?.status === 'ready' && sourceState.result?.ok ? sourceState.result : null
    const receipt: Pick<KnowledgeNodeSourceView, 'filePath' | 'startLine'> | null = opened
      ? { filePath: opened.filePath, startLine: opened.startLine }
      : material?.sources[0]
        ? { filePath: material.sources[0].filePath, startLine: material.sources[0].startLine }
        : null
    const text = receipt
      ? learningEditInDevPrefill(node.title, receipt.filePath, receipt.startLine)
      : learningEditInDevPrefillWithoutSource(node.title)
    useSettingsStore.getState().requestComposerPrefill(text)
    void switchToDevSurface()
  }, [material, node.title, sourceState])

  const handleStart = useCallback(() => {
    void sendCommand({ sessionId, action: { type: 'select_node', nodeId: node.nodeId } })
  }, [node.nodeId, sendCommand, sessionId])

  const renderSnippet = (): React.ReactNode => {
    if (sourceState?.status === 'loading' || (expandedReceiptId && !sourceState)) {
      return (
        <div className="learning-detail__snippet" role="status">
          <SpinnerIcon size={12} className="learning-outline__stage-spin" />
        </div>
      )
    }
    const result = sourceState?.result
    if (!result) return null
    if (!result.ok) {
      return <p className="learning-detail__snippet-error">{learningSourceFailureCopy(result)}</p>
    }
    return (
      <div className="learning-detail__snippet">
        {result.changed && <p className="learning-detail__snippet-changed">{LEARNING_SOURCE_CHANGED}</p>}
        <pre className="learning-detail__code" role="region" aria-label={LEARNING_SOURCE_SNIPPET_LABEL}>{result.text}</pre>
      </div>
    )
  }

  return (
    <div className="learning-detail">
      <div className="learning-detail__header">
        <IconButton
          label={LEARNING_DETAIL_BACK}
          icon={<ArrowLeftIcon size={14} />}
          variant="ghost"
          size="sm"
          onClick={onBack}
          tooltip={LEARNING_DETAIL_BACK}
        />
        <h3 className="learning-detail__title" title={node.title}>{node.title}</h3>
        <DropdownMenu
          button={{ label: LEARNING_DETAIL_MENU_LABEL, tooltip: LEARNING_DETAIL_MENU_LABEL, isIconOnly: true, variant: 'ghost', size: 'sm', icon: <MoreIcon size={14} /> }}
          menuWidth={200}
          items={[{ label: LEARNING_DETAIL_EDIT_IN_DEV, onClick: handleEditInDev }]}
        />
      </div>

      {materialState === 'loading' && (
        <p className="learning-detail__state" role="status">{LEARNING_OUTLINE_LOADING}</p>
      )}
      {materialState !== 'loading' && materialState !== null && !materialState.ok && (
        <p className="learning-detail__state" role="alert">{materialState.message}</p>
      )}
      {materialState !== 'loading' && materialState?.ok && !materialState.material && (
        <p className="learning-detail__state">{LEARNING_DETAIL_NO_MATERIAL}</p>
      )}
      {material && !body && (
        <p className="learning-detail__state" role="alert">{LEARNING_DETAIL_BODY_INVALID}</p>
      )}

      {material && body && (
        <div className="learning-detail__body">
          {body.learningGoal && <p className="learning-detail__goal">{body.learningGoal}</p>}
          {body.summary && <p className="learning-detail__summary">{body.summary}</p>}
          <ul className="learning-detail__claims">
            {body.claims.map((claim, index) => {
              // 没有出处的存疑要点不进界面：详情只展示有依据的内容
              if (claim.kind === 'unverified') return null
              const inferred = claim.kind === 'inference'
              const sourceIds = claim.kind === 'source_fact' || claim.kind === 'inference' ? claim.sourceIds : []
              return (
                <li key={index} className={`learning-detail__claim${inferred ? ' learning-detail__claim--inferred' : ''}`}>
                  <p className="learning-detail__claim-text">
                    {inferred && (
                      <span className="learning-detail__claim-mark" title={LEARNING_INFERENCE_TOOLTIP} aria-label={LEARNING_INFERENCE_TOOLTIP}>
                        ≈
                      </span>
                    )}
                    {claim.text}
                  </p>
                  {sourceIds.length > 0 && (
                    <span className="learning-detail__sources">
                      {sourceIds.map(receiptId => {
                        const receipt = material.sources.find(item => item.receiptId === receiptId)
                        if (!receipt) return null
                        const isExpanded = expandedReceiptId === receiptId
                        const chipLabel = `${fileNameOf(receipt.filePath)}:${receipt.startLine}`
                        return (
                          <Button
                            key={receiptId}
                            label={chipLabel}
                            variant="ghost"
                            size="sm"
                            className="learning-detail__source-chip"
                            tooltip={receipt.filePath}
                            aria-expanded={isExpanded}
                            onClick={() => void toggleSource(receiptId)}
                          />
                        )
                      })}
                    </span>
                  )}
                  {index === snippetClaimIndex && renderSnippet()}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {selectedNodeId !== node.nodeId && (
        <div className="learning-detail__footer">
          <Button
            label={LEARNING_DETAIL_START}
            variant="primary"
            size="md"
            className="learning-detail__start"
            isDisabled={busy || materialState === 'loading'}
            onClick={handleStart}
          />
        </div>
      )}
    </div>
  )
}
