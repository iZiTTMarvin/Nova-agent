/**
 * Skill 相关 UI 文案（中文为主）
 */
import type { SkillSource } from '../../../shared/skills/types'

/** 技能来源 badge 文案 */
export function skillSourceLabel(source: SkillSource): string {
  switch (source) {
    case 'builtin':
      return '内置'
    case 'global':
      return '本地'
    case 'project':
      return '项目'
    case 'third_party':
      return '第三方'
    case 'virtual':
      return '虚拟'
    case 'mcp':
      return 'MCP'
    default:
      return source
  }
}

export const skillsI18n = {
  panelTitle: '技能',
  panelDesc: '技能是可被 / 唤起或由模型调用的指令模板。内置技能随应用分发，也可在本地或项目中自定义。',
  thirdPartyTitle: '共享其他工具的技能',
  thirdPartyHint: '默认只使用 Nova 自己的技能（~/.nova/skills）。开启后，Nova 会直接读取对应目录中的技能，不复制、不修改；关闭立即停止读取。',
  thirdPartyUserLabel: (id: string) => `~/${id}/skills`,
  thirdPartyProjectLabel: (id: string) => `项目 ${id}/skills`,
  thirdPartyCount: (n: number) => `${n} 个技能`,
  thirdPartyMissing: '目录不存在',
  thirdPartyConfirmTitle: (id: string) => `读取 ${id} 中的技能？`,
  thirdPartyConfirmMessage: (id: string, total: number) =>
    `Nova 将直接读取 ${id}/skills 下的 ${total} 个技能（用户目录与当前项目）。这些技能可能带有可执行脚本，请确认你信任它们的来源。`,
  thirdPartyConfirmDetail: '只读取，不会复制到 Nova，也不会修改原目录。随时可以关闭。',
  thirdPartyConfirmAction: '开启读取',
  menuLabel: (name: string) => `${name} 的更多操作`,
  menuUse: '在输入框使用',
  detailPath: '位置',
  detailBody: '指令内容',
  detailBodyLoading: '加载中…',
  detailClose: '关闭',
  create: '+ 新建',
  import: '导入',
  use: '使用',
  export: '导出',
  exportSuccess: (path: string) => `已导出到 ${path}`,
  searchLabel: '搜索技能',
  searchPlaceholder: '按名称或描述搜索',
  sourceFilterLabel: '筛选来源',
  allSources: '全部',
  filterMine: '我的',
  filterThirdParty: '第三方',
  filterBuiltin: '内置',
  empty: '暂无技能',
  noSearchResults: '没有匹配的技能',
  reload: '刷新列表',
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
  selectHint: '选择规则文件进行编辑',
  scopeWorkspace: '项目',
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
