/**
 * 第三方技能来源：用户同意后原地读取 `.agents` / `.claude` 下的技能，不复制、不改动。
 * 每个来源覆盖用户级（~/.x/skills）与当前项目级（<workspace>/.x/skills）两处。
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { countSkillDirs } from './skillDirectories'
import type {
  ThirdPartySkillLocation,
  ThirdPartySkillSourceId,
  ThirdPartySkillSources,
  ThirdPartySkillSourceStatus
} from '../../shared/skills/types'

const SOURCES: ReadonlyArray<{ id: ThirdPartySkillSourceId; label: string; dirName: string }> = [
  { id: 'agents', label: '.agents', dirName: '.agents' },
  { id: 'claude', label: '.claude', dirName: '.claude' }
]

export const DEFAULT_THIRD_PARTY_SKILL_SOURCES: ThirdPartySkillSources = { agents: false, claude: false }

function locationsFor(
  dirName: string,
  workspaceRoot: string | null,
  home: string
): Array<{ scope: ThirdPartySkillLocation['scope']; path: string }> {
  const locations: Array<{ scope: ThirdPartySkillLocation['scope']; path: string }> = [
    { scope: 'user', path: join(home, dirName, 'skills') }
  ]
  if (workspaceRoot) locations.push({ scope: 'project', path: join(workspaceRoot, dirName, 'skills') })
  return locations
}

/** 已同意来源对应的扫描目录；用户级在前，项目级在后 */
export function resolveThirdPartySkillDirs(
  sources: ThirdPartySkillSources,
  workspaceRoot: string | null,
  home: string = homedir()
): string[] {
  return SOURCES.filter(source => sources[source.id]).flatMap(source =>
    locationsFor(source.dirName, workspaceRoot, home).map(location => location.path)
  )
}

/** 设置页展示：每个来源的路径、是否存在、检测到的技能数 */
export function describeThirdPartySources(
  sources: ThirdPartySkillSources,
  workspaceRoot: string | null,
  home: string = homedir()
): ThirdPartySkillSourceStatus[] {
  return SOURCES.map(source => ({
    id: source.id,
    label: source.label,
    enabled: sources[source.id],
    locations: locationsFor(source.dirName, workspaceRoot, home).map(location => ({
      ...location,
      exists: existsSync(location.path),
      count: countSkillDirs(location.path)
    }))
  }))
}
