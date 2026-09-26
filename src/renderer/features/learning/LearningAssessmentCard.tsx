import { useState } from 'react'
import type { LearningAssessmentView } from '../../../shared/learning/surface'
import { useLearningStore } from './useLearningStore'
import { assessmentVerdictLabel } from './learningStatus'

export function LearningAssessmentCard({ sessionId, assessment, disabled }: {
  sessionId: string; assessment: LearningAssessmentView; disabled: boolean
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const reason = useLearningStore(state => state.drafts[sessionId]?.answers[`dispute:${assessment.assessmentId}`] ?? '')
  const setDraft = useLearningStore(state => state.setDraft)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const submit = async () => {
    const receipt = await sendCommand({ sessionId, action: { type: 'dispute', assessmentId: assessment.assessmentId, reason: reason.trim() || '请重新核对我的回答与原判据' } })
    if (receipt?.ok) { setEditing(false); setDraft(sessionId, `dispute:${assessment.assessmentId}`, '') }
  }
  return <section className="learning-assessment" aria-label="评估反馈">
    <header className="learning-assessment__header"><span className="learning-assessment__badge">反馈</span>
      <span className="learning-assessment__verdict">{assessmentVerdictLabel(assessment.verdict)}</span>
      {assessment.disputed && <span className="learning-assessment__disputed">已质疑，待复核</span>}
    </header>
    <p className="learning-assessment__summary">{assessment.summary}</p>
    <blockquote className="learning-assessment__quote">{assessment.userQuote}</blockquote>
    {!assessment.disputed && !editing && <button type="button" disabled={disabled} onClick={() => setEditing(true)}>质疑这次评估</button>}
    {editing && <div>
      <textarea className="learning-assessment__reason" aria-label="评估质疑原因" placeholder="你认为哪里判断得不准确？可以补充，也可以直接请求复核。"
        value={reason} onChange={event => setDraft(sessionId, `dispute:${assessment.assessmentId}`, event.target.value)} disabled={disabled} />
      <button type="button" disabled={disabled} onClick={() => void submit()}>请求复核</button>
      <button type="button" disabled={disabled} onClick={() => setEditing(false)}>取消</button>
    </div>}
  </section>
}
