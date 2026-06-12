/**
 * Skill 相关 UI 文案（中文为主）
 */
import type { SkillSource } from '../../../runtime/skills/types'

/** 技能来源 badge 文案 */
export function skillSourceLabel(source: SkillSource): string {
  switch (source) {
    case 'builtin':
      return '内置'
    case 'global':
      return '本地'
    case 'project':
      return '项目'
    case 'third_party_claude':
      return '第三方'
    default:
      return source
  }
}

export const skillsI18n = {
  panelTitle: '技能',
  panelDesc: '技能是可被 / 命令或模型调用的指令模板。内置技能随应用分发，也可在本地或项目中自定义。',
  loadThirdParty: '加载第三方 skill',
  loadThirdPartyHint: '开启后读取 Claude Code 技能目录，与 Nova 内置/本地技能合并展示。',
  create: '+ 新建',
  import: '导入',
  use: '使用',
  toggle: '启用模型调用',
  showAll: '显示全部',
  showLess: '收起',
  empty: '暂无技能',
  delete: '删除',
  builtinNoDelete: '内置技能不可删除',
  createTitle: '新建技能',
  createNameLabel: '名称（slug）',
  createNameHint: '小写字母、数字与连字符，如 my-skill',
  createNameInvalid: '名称格式无效',
  createDescLabel: '描述',
  createDescRequired: '请填写描述',
  createBodyLabel: '正文（Markdown）',
  createTemplateLabel: '模板',
  createTemplates: {
    blank: '空白',
    new: 'new 脚手架',
    onboard: 'onboard 向导'
  } as const,
  createLocationLabel: '保存位置',
  createLocationGlobal: '全局 (~/.nova/skills)',
  createLocationProject: '当前项目',
  createNeedProject: '请先打开项目工作区',
  createCancel: '取消',
  createSubmit: '创建',
  createSubmitting: '创建中…',
  createSuccess: (name: string) => `技能「${name}」已创建`,
  createTemplateLoadFailed: '加载模板失败',
  importLocationLabel: '导入到',
  importDropHint: '将 .zip 拖到此处，或点击下方按钮选择文件',
  importPickZip: '选择 zip 文件',
  importUrlPlaceholder: 'https://example.com/skill.zip',
  importFromUrl: '从 URL 导入',
  importZipOnly: '仅支持 .zip 文件',
  importing: '正在导入…',
  importSuccess: (name: string) => `已导入技能「${name}」`,
  showImportBar: '显示导入区',
  hideImportBar: '收起导入区'
} as const

export const rulesI18n = {
  panelTitle: '规则',
  panelDesc: '规则用于约束 Agent 行为，可始终生效或按文件路径生效（路径匹配将在后续版本支持）。',
  create: '+ 新建',
  empty: '暂无规则文件',
  selectHint: '从左侧选择规则文件进行编辑',
  scopeWorkspace: '工作区',
  scopeGlobal: '全局',
  save: '保存',
  saved: '已保存',
  newRulePrompt: '输入新规则文件名（不含扩展名）',
  newRuleScope: '创建位置',
  needProject: '请先打开项目工作区'
} as const

export const subagentsI18n = {
  panelTitle: '子代理',
  panelDesc: '子代理是专用于探索、编码等任务的独立 Agent 配置，可由主 Agent 通过 task 工具调用。',
  create: '+ 新建子代理',
  empty: '暂无子代理',
  builtin: '内置',
  custom: '自定义',
  allowedTools: '允许的工具',
  editJson: '编辑 JSON',
  save: '保存',
  delete: '删除',
  newNamePrompt: '子代理名称（英文 slug）'
} as const
