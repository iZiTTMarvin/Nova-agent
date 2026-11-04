/**
 * ThirdPartySkillSources — 第三方技能来源开关：每个来源需用户确认后才读取，默认全部关闭
 */
import React, { useRef, useState } from 'react'
import { Switch } from '@astryxdesign/core/Switch'
import { confirmDialog } from '../confirm/confirmDialog'
import type { ThirdPartySkillSourceStatus, ThirdPartySkillSources } from '../../../shared/skills/types'
import { skillsI18n } from './i18n'
import './ThirdPartySkillSources.css'

interface ThirdPartySkillSourcesProps {
  sources: ThirdPartySkillSourceStatus[]
  /** 持久化新的开关组合并让主进程重新扫描 */
  onChange: (next: ThirdPartySkillSources) => Promise<void>
}

export const ThirdPartySkillSourceList: React.FC<ThirdPartySkillSourcesProps> = ({ sources, onChange }) => {
  const current = Object.fromEntries(sources.map(s => [s.id, s.enabled])) as ThirdPartySkillSources
  // 进行中的切换目标值；并发切换另一来源时一并带上，避免用旧快照覆盖尚未回流的修改
  const [pending, setPending] = useState<Partial<ThirdPartySkillSources>>({})
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const toggle = async (source: ThirdPartySkillSourceStatus, enabled: boolean) => {
    if (source.id in pendingRef.current) return
    if (enabled) {
      const total = source.locations.reduce((sum, location) => sum + location.count, 0)
      const choice = await confirmDialog({
        type: 'warning',
        title: skillsI18n.thirdPartyConfirmTitle(source.label),
        message: skillsI18n.thirdPartyConfirmMessage(source.label, total),
        detail: skillsI18n.thirdPartyConfirmDetail,
        buttons: ['取消', skillsI18n.thirdPartyConfirmAction],
        defaultId: 0
      })
      if (choice !== 1) return
    }
    const next = { ...current, ...pendingRef.current, [source.id]: enabled }
    setPending(prev => ({ ...prev, [source.id]: enabled }))
    try {
      await onChange(next)
    } finally {
      // 结束后开关回到权威来源数据，由主进程快照决定最终状态
      setPending(prev => {
        const rest = { ...prev }
        delete rest[source.id]
        return rest
      })
    }
  }

  return (
    <ul className="third-party glass-card" aria-label={skillsI18n.thirdPartyTitle}>
      {sources.map(source => (
        <li key={source.id} className="third-party__row">
          <div className="third-party__text">
            <span className="third-party__name">{source.label}</span>
            {source.locations.map(location => (
              <span key={location.scope} className="third-party__path" title={location.path}>
                {location.scope === 'user'
                  ? skillsI18n.thirdPartyUserLabel(source.label)
                  : skillsI18n.thirdPartyProjectLabel(source.label)}
                <span className="third-party__count">
                  {location.exists ? skillsI18n.thirdPartyCount(location.count) : skillsI18n.thirdPartyMissing}
                </span>
              </span>
            ))}
          </div>
          <Switch
            label={`${skillsI18n.thirdPartyTitle} ${source.label}`}
            isLabelHidden
            value={source.enabled}
            isDisabled={source.id in pending}
            onChange={enabled => void toggle(source, enabled)}
          />
        </li>
      ))}
    </ul>
  )
}
