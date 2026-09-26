import { useEffect, useRef, useState } from 'react'
import type { KnowledgeClaim } from '../../../shared/learning/knowledgeClaim'
import { parseKnowledgeClaims } from '../../../shared/learning/knowledgeClaim'
import type { LearningSourceResult } from '../../../shared/learning/surface'
import type { LearningMaterialState } from './useLearningStore'

interface LearningMaterialPanelProps {
  sessionId: string
  state: LearningMaterialState
  onClose: () => void
  onEditInDev: (nodeId: string, nodeTitle: string, filePath: string | null) => void
}

function parseBody(bodyJson: string): { summary: string; learningGoal: string; claims: readonly KnowledgeClaim[]; unreadNote: string } | null {
  try {
    const raw: unknown = JSON.parse(bodyJson)
    if (!raw || typeof raw !== 'object') return null
    return {
      summary: 'summary' in raw && typeof raw.summary === 'string' ? raw.summary : '',
      learningGoal: 'learningGoal' in raw && typeof raw.learningGoal === 'string' ? raw.learningGoal : '',
      claims: parseKnowledgeClaims('claims' in raw ? raw.claims : []),
      unreadNote: 'unreadNote' in raw && typeof raw.unreadNote === 'string' ? raw.unreadNote : ''
    }
  } catch { return null }
}

const labels = { source_fact: '源码事实', inference: '从实现推断', general_explanation: '通用解释', unverified: '未核实' }

export function LearningMaterialPanel({ sessionId, state, onClose, onEditInDev }: LearningMaterialPanelProps): React.ReactElement {
  const [source, setSource] = useState<LearningSourceResult | null>(null)
  const [loading, setLoading] = useState(false)
  const sourceRequest = useRef(0)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    return () => { sourceRequest.current++ }
  }, [])
  // 同节点教材重新发布后，旧版本的源码核对结果不再对应当前出处，一并作废
  const materialRevision = state.material?.nodeRevision
  useEffect(() => {
    sourceRequest.current++
    setSource(null)
    setLoading(false)
  }, [materialRevision])
  const body = state.material ? parseBody(state.material.bodyJson) : null
  const openSource = async (receiptId: string) => {
    const request = ++sourceRequest.current
    setLoading(true)
    setSource(null)
    try {
      const result = await window.api.invoke('learning:get-source', { sessionId, nodeId: state.nodeId, receiptId })
      if (request === sourceRequest.current) setSource(result)
    } catch (error) {
      if (request === sourceRequest.current) setSource({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === sourceRequest.current) setLoading(false)
    }
  }
  return <aside className="learning-material" aria-label="学习材料" onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <header className="learning-material__header"><span className="learning-material__title">{state.material?.title ?? '节点材料'}</span>
      <button ref={closeRef} type="button" aria-label="关闭材料面板" onClick={onClose}>关闭</button></header>
    {state.status === 'loading' && <p role="status">正在读取节点材料…</p>}
    {state.status === 'error' && <p role="alert">读取失败：{state.error}</p>}
    {state.status === 'ready' && !state.material && <p>这个节点尚无已发布教材。</p>}
    {state.material && !body && <p role="alert">材料格式无效，请重新整理教材。</p>}
    {state.material && body && <>
      <p className="learning-material__goal">{body.learningGoal}</p>
      <p className="learning-material__summary">{body.summary}</p>
      {body.unreadNote && <p className="learning-material__note">{body.unreadNote}</p>}
      <ul className="learning-material__claims">{body.claims.map((claim, index) => <li key={index} className="learning-claim">
        <span className="learning-claim__kind">{labels[claim.kind]}</span>
        <span className="learning-claim__text">{claim.kind === 'unverified' ? claim.question : claim.text}</span>
        {claim.kind === 'inference' && <span className="learning-claim__uncertainty">{claim.uncertainty}</span>}
        {claim.kind === 'unverified' && <span className="learning-claim__uncertainty">缺少证据：{claim.missingEvidence}</span>}
        {(claim.kind === 'source_fact' || claim.kind === 'inference') && claim.sourceIds.map(id => {
          const receipt = state.material?.sources.find(item => item.receiptId === id)
          return receipt && <button key={id} type="button" className="learning-material__source" onClick={() => void openSource(id)}>{receipt.filePath}:{receipt.startLine}</button>
        })}
      </li>)}</ul>
      <div className="learning-material__sources"><span className="learning-material__sources-title">源码出处</span>
        {state.material.sources.length === 0 && <span>暂无项目源码出处</span>}
        {state.material.sources.map(receipt => <button key={receipt.receiptId} type="button" className="learning-material__source"
          onClick={() => void openSource(receipt.receiptId)}>{receipt.filePath}:{receipt.startLine}–{receipt.endLine}</button>)}
      </div>
      {loading && <p role="status">正在核对当前源码…</p>}
      {source && (source.ok ? <div>
        <p className="learning-material__note" role="status">{source.changed ? '源码已变化，以下是当前片段；原教材需要复核。' : '已核对：当前片段与教材出处一致。'}</p>
        <pre className="learning-material__code">{source.text}</pre>
      </div> : <p role="alert">{source.message}</p>)}
      <button type="button" className="learning-material__edit-dev" onClick={() => onEditInDev(state.nodeId, state.material!.title,
        source?.ok ? `${source.filePath}:${source.startLine}` : state.material!.sources[0]?.filePath ?? null)}>在开发中改这里</button>
    </>}
  </aside>
}
