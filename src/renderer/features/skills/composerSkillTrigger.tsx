/**
 * Composer `/` trigger — 把 slash 候选接到 ChatComposerInput 的官方 SearchSource。
 *
 * 选中后插入行内 token 芯片，序列化值仍是 `/${name}`：草稿、发送与拒绝路径
 * 继续走纯文本协议。官方 trigger 在空白边界关闭菜单，不拦截参数阶段 Enter。
 */
import type { ReactNode } from 'react'
import type {
  ChatComposerToken,
  ChatComposerTrigger,
  ChatComposerTriggerItem
} from '@astryxdesign/core/Chat'
import type { SearchSource } from '@astryxdesign/core/Typeahead'
import type { SkillCatalogDiagnostic, SkillSummary } from '../../../shared/skills/types'
import type { Mode } from '../../../shared/session/types'
import {
  filterAndRankCandidates,
  nativeCommandsToCandidates,
  skillsToCandidates,
  pilotSkillsToCandidates,
  type SlashCandidate
} from './slashCandidates'
import './composerSkillTrigger.css'

export type ComposerSkillItem = ChatComposerTriggerItem & {
  // 官方 useTriggerMenu 按 auxiliaryData.group 分组并渲染组标题
  auxiliaryData: SlashCandidate & { group: string }
}

/** Slash 芯片：羊皮纸 yellow badge，序列化为 `/${name}` */
export function skillComposerToken(name: string): ChatComposerToken {
  return {
    value: `/${name}`,
    label: `/${name}`,
    variant: 'yellow'
  }
}

const GROUP_LABEL: Record<SlashCandidate['kind'], string> = {
  command: '命令',
  skill: '技能'
}

function toSearchable(candidate: SlashCandidate): ComposerSkillItem {
  return {
    id: `${candidate.kind}:${candidate.name}`,
    label: candidate.name,
    auxiliaryData: { ...candidate, group: GROUP_LABEL[candidate.kind] }
  }
}

function rankQuery(
  query: string,
  skills: SkillSummary[],
  opts?: ComposerSkillTriggerOptions
): ComposerSkillItem[] {
  const mode = opts?.getMode?.()
  const skillCandidates =
    mode === 'pilot'
      ? pilotSkillsToCandidates(skills, opts?.onOpenPilotSettings)
      : skillsToCandidates(skills)
  const candidates = [...nativeCommandsToCandidates(), ...skillCandidates]
  const ranked = filterAndRankCandidates(query, candidates)
  // 组标题按首个 item 的出现顺序渲染，命令必须整体排在技能前，不能被高分技能穿插
  const commands = ranked.filter(c => c.kind === 'command')
  return [...commands, ...ranked.filter(c => c.kind !== 'command')].map(toSearchable)
}

export interface ComposerSkillTriggerOptions {
  /** 无结果时的空态文案 */
  emptySearchResultsText?: string
  /** 目录诊断；模式受限类在候选项上给出发送前提示 */
  getDiagnostics?: () => SkillCatalogDiagnostic[]
  /** 当前运行模式 */
  getMode?: () => Mode
  /** 点击引导/管理项时唤起设置 */
  onOpenPilotSettings?: () => void
}

/**
 * 构建稳定的 `/` trigger。`getSkills` 每次 search 时读取最新列表，
 * 避免 skills 变更时重建 trigger（会打断已打开的菜单）。
 */
export function createComposerSkillTrigger(
  getSkills: () => SkillSummary[] | Promise<SkillSummary[]>,
  opts?: ComposerSkillTriggerOptions
): ChatComposerTrigger {
  const getDiagnostics = opts?.getDiagnostics ?? (() => [])
  const searchSource: SearchSource<ComposerSkillItem> = {
    bootstrap: async () => {
      const skills = await getSkills()
      return rankQuery('', skills, opts)
    },
    search: async query => {
      const skills = await getSkills()
      return rankQuery(query, skills, opts)
    }
  }

  return {
    character: '/',
    searchSource,
    menuLabel: '技能与命令',
    emptySearchResultsText: opts?.emptySearchResultsText ?? '没有匹配的技能或命令',
    loadingText: '搜索中…',
    renderItem: (item): ReactNode => {
      const candidate = (item as ComposerSkillItem).auxiliaryData
      if (candidate.isAction) {
        return (
          <span className="composer-skill-trigger__item composer-skill-trigger__item--action">
            <span className="composer-skill-trigger__title">
              <span className="composer-skill-trigger__slash" style={{ opacity: 0.6 }}>✦</span>
              {candidate.name}
            </span>
            {candidate.description ? (
              <span className="composer-skill-trigger__desc">
                {candidate.description}
              </span>
            ) : null}
          </span>
        )
      }
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
      if (candidate.isAction) {
        candidate.action?.()
        return ''
      }
      return skillComposerToken(candidate.name)
    }
  }
}
