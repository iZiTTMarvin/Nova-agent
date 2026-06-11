/**
 * SkillManifest — 向后兼容 re-export
 * @deprecated 请从 ./types 或 ./frontmatter 直接导入
 */
export type { SkillManifest, SkillSource, LoadError, SlashParseResult, TemplateContext } from './types'
export { parseSkillMarkdown } from './frontmatter'
