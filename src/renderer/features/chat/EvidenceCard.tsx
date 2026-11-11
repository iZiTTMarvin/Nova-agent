/**
 * present_evidence 展示卡：只呈现模型选出的真实工具产物，外观中性，不表示验证通过。
 * 图片走 nova-image 协议；日志与实时页面均按点击经主进程核对会话归属后再返回。
 */
import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { EvidenceReference } from '../../../shared/evidence'
import { useBrowserStore } from '../browser/useBrowserStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import './EvidenceCard.css'

interface EvidenceCardProps {
  sessionId: string
  evidence: readonly EvidenceReference[]
}

function evidenceId(item: EvidenceReference): string {
  return item.kind === 'image' ? item.url : item.artifactId
}

const EvidenceItem: React.FC<{ sessionId: string; item: EvidenceReference }> = ({ sessionId, item }) => {
  const [imageBroken, setImageBroken] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const toggleText = async (): Promise<void> => {
    if (text !== null) { setText(null); return }
    setLoading(true)
    setMessage(null)
    try {
      const result = await window.api.invoke('evidence:read-artifact', { sessionId, id: evidenceId(item) })
      if (result.status === 'available') setText(result.text)
      else setMessage(`日志不可用：${result.reason}`)
    } catch {
      setMessage('日志不可用')
    } finally {
      setLoading(false)
    }
  }

  const openLive = async (): Promise<void> => {
    setMessage(null)
    try {
      const result = await window.api.invoke('evidence:open-browser', { sessionId, id: evidenceId(item) })
      if (result.status === 'applied') {
        useBrowserStore.getState().focusPage(result.page.browserId)
        useLayoutStore.getState().openBrowserPane(false)
        setMessage('已打开实时页面')
      } else {
        setMessage(`实时页面不可用：${result.detail}，请重新验证`)
      }
    } catch {
      setMessage('实时页面不可用，请重新验证')
    }
  }

  return (
    <li className="evidence-card__item">
      <div className="evidence-card__desc">
        {item.description}
        <span className="evidence-card__source">来自 {item.sourceTool}</span>
      </div>
      {item.kind === 'image' ? (
        imageBroken ? (
          <div className="evidence-card__note">截图不可用（文件缺失或已损坏）</div>
        ) : (
          <button
            type="button"
            className={`evidence-card__image-btn${zoomed ? ' evidence-card__image-btn--zoomed' : ''}`}
            aria-label={zoomed ? '收起截图' : '放大截图'}
            onClick={() => setZoomed(value => !value)}
          >
            <img src={item.url} alt={item.description} onError={() => setImageBroken(true)} />
          </button>
        )
      ) : text !== null ? (
        <pre className="evidence-card__text">{text || '（空输出）'}</pre>
      ) : null}
      <div className="evidence-card__actions">
        {item.kind === 'artifact' && (
          <Button
            label={text !== null ? '收起日志' : loading ? '读取中…' : '查看日志'}
            variant="secondary"
            size="sm"
            isDisabled={loading}
            onClick={() => void toggleText()}
          />
        )}
        {item.kind === 'image' && item.browser && (
          <Button label="打开实时结果" variant="secondary" size="sm" onClick={() => void openLive()} />
        )}
        {message && <span className="evidence-card__note" role="status">{message}</span>}
      </div>
    </li>
  )
}

export const EvidenceCard: React.FC<EvidenceCardProps> = React.memo(function EvidenceCard({ sessionId, evidence }) {
  return (
    <section className="evidence-card" data-testid="evidence-card" aria-label="工具产物">
      <header className="evidence-card__header">
        工具产物<span className="evidence-card__hint">仅表示产物存在，不代表目标已验证</span>
      </header>
      <ul className="evidence-card__list">
        {evidence.map(item => <EvidenceItem key={`${sessionId}:${evidenceId(item)}`} sessionId={sessionId} item={item} />)}
      </ul>
    </section>
  )
})
