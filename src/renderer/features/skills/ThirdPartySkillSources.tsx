/**
 * ThirdPartySkillSources — 第三方技能来源开关：每个来源需用户确认后才读取，默认全部关闭
 */
import React from 'react'
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

  const toggle = async (source: ThirdPartySkillSourceStatus, enabled: boolean) => {
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
    await onChange({ ...current, [source.id]: enabled })
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
            onChange={enabled => void toggle(source, enabled)}
          />
        </li>
      ))}
    </ul>
  )
}
