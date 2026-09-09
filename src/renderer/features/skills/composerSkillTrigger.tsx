/**
 * Composer `/` trigger — 把 slash 候选接到 ChatComposerInput 的官方 SearchSource。
 *
 * 选中后插入纯文本 `/${name} `（不是 chip）：用户可继续敲参数；官方 trigger
 * 在空白边界处自动关闭菜单，因此不会再拦截参数阶段的 Enter。
 */
import type { ReactNode } from 'react'
import type {
  ChatComposerTrigger,
  ChatComposerTriggerItem
} from '@astryxdesign/core/Chat'
import type { SearchSource } from '@astryxdesign/core/Typeahead'
import type { SkillCatalogDiagnostic, SkillSummary } from '../../../shared/skills/types'
import {
  filterAndRankCandidates,
  skillsToCandidates,
  type SlashCandidate
} from './slashCandidates'
import './composerSkillTrigger.css'

export type ComposerSkillItem = ChatComposerTriggerItem & {
  auxiliaryData: SlashCandidate
}

function toSearchable(candidate: SlashCandidate): ComposerSkillItem {
  return {
    id: `${candidate.kind}:${candidate.name}`,
    label: candidate.name,
    auxiliaryData: candidate
  }
}

function rankQuery(query: string, skills: SkillSummary[]): ComposerSkillItem[] {
  return filterAndRankCandidates(query, skillsToCandidates(skills)).map(toSearchable)
}

export interface ComposerSkillTriggerOptions {
  /** 无结果时的空态文案；调用方按目录可用性传入，无可用与无匹配用不同文案 */
  emptySearchResultsText?: string
  /** 目录诊断；模式受限类在候选项上给出发送前提示 */
  getDiagnostics?: () => SkillCatalogDiagnostic[]
}

/**
 * 构建稳定的 `/` trigger。`getSkills` 每次 search 时读取最新列表，
 * 避免 skills 变更时重建 trigger（会打断已打开的菜单）。
 */
export function createComposerSkillTrigger(
  getSkills: () => SkillSummary[],
  opts?: ComposerSkillTriggerOptions
): ChatComposerTrigger {
  const getDiagnostics = opts?.getDiagnostics ?? (() => [])
  const searchSource: SearchSource<ComposerSkillItem> = {
    bootstrap: async () => rankQuery('', getSkills()),
    search: async query => rankQuery(query, getSkills())
  }

  return {
    character: '/',
    searchSource,
    menuLabel: '技能与命令',
    emptySearchResultsText: opts?.emptySearchResultsText ?? '没有匹配的技能',
    loadingText: '搜索中…',
    renderItem: (item): ReactNode => {
      const candidate = (item as ComposerSkillItem).auxiliaryData
      const kindLabel = candidate.kind === 'skill' ? 'skill' : 'command'
      const profileNote =
        candidate.kind === 'skill'
          ? getDiagnostics().find(
            d => d.skillName === candidate.name && d.code === 'profile_restricted'
          )?.message
          : undefined
      return (
        <span className="composer-skill-trigger__item">
          <span className="composer-skill-trigger__title">
            <span className="composer-skill-trigger__slash">/</span>
            {candidate.name}
            <span className="composer-skill-trigger__kind"> ({kindLabel})</span>
          </span>
          {candidate.description ? (
            <span className="composer-skill-trigger__desc">
              {candidate.description}
              {profileNote ? (
                <span className="composer-skill-trigger__note">{profileNote}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      )
    },
    onSelect: item => {
      const candidate = (item as ComposerSkillItem).auxiliaryData
      return `/${candidate.name} `
    }
  }
}
