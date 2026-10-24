/**
 * 交互组件改动摘要：把一次提交后的变量值整理成「组件标题 + 控件标签 = 当前值」，
 * 交给界面状态待发箱，随下一条用户消息告诉模型用户调过什么。
 */
import {
  MAX_INTERFACE_STATE_VALUES,
  type InterfaceStateValue,
  type InterfaceStateWidget
} from '../../../shared/visualization/interfaceState'
import {
  inlineUiChildren,
  inlineUiText,
  type InlineUiNode,
  type InlineUiProgram,
  type InlineUiVars
} from './inlineUiLanguage'

const FALLBACK_TITLE = '交互组件'

function findTitle(node: InlineUiNode): string | null {
  if (node.type === 'card' && node.title) return node.title
  if (node.type === 'collapsible') return node.title
  if (node.type === 'text' && node.style === 'title') return node.text
  for (const child of inlineUiChildren(node)) {
    const title = findTitle(child)
    if (title) return title
  }
  return null
}

interface ControlLabel {
  readonly label: string
  readonly format: (value: unknown) => string
}

function collectControls(node: InlineUiNode, out: Map<string, ControlLabel>): void {
  const put = (variable: string, label: string | null, format: (value: unknown) => string): void => {
    if (variable && !out.has(variable)) out.set(variable, { label: label?.trim() || variable, format })
  }
  switch (node.type) {
    case 'slider':
      put(node.variable, node.label, value => `${inlineUiText(value)}${node.unit ?? ''}`)
      break
    case 'choice': case 'select':
      put(node.variable, node.label, inlineUiText)
      break
    case 'switch':
      put(node.variable, node.label, value => (value === true ? '开' : value === false ? '关' : '—'))
      break
    case 'input':
      put(node.variable, node.label, inlineUiText)
      break
    case 'tabs':
      if (node.binding) {
        const tabs = node.tabs
        put(node.binding.variable, '标签页', value =>
          typeof value === 'number' ? (tabs[value]?.label ?? inlineUiText(value)) : inlineUiText(value))
      }
      break
    case 'steps': case 'flow': {
      const items = node.type === 'steps' ? node.steps : node.items
      if (node.current) {
        put(node.current.variable, '当前步骤', value =>
          typeof value === 'number' && items[value] ? `${value + 1}. ${items[value].title}` : inlineUiText(value))
      }
      break
    }
    case 'walkthrough':
      if (node.current) {
        const steps = node.phases.flatMap(phase => phase.steps)
        put(node.current.variable, '当前步骤', value =>
          typeof value === 'number' && steps[value] ? `第 ${value + 1} 步 · ${steps[value].title}` : inlineUiText(value))
      }
      break
    default:
      break
  }
  for (const child of inlineUiChildren(node)) collectControls(child, out)
}

/**
 * 与初始值比较得出改过的变量；控件的标签作为名字，没有控件的变量（只被按钮改过）用变量名。
 * 全部回到初始值时 values 为空，模型据此知道用户把组件复原了。
 */
export function summarizeInlineUiChanges(
  program: InlineUiProgram,
  tree: InlineUiNode | null,
  vars: InlineUiVars
): InterfaceStateWidget {
  const controls = new Map<string, ControlLabel>()
  if (tree) collectControls(tree, controls)
  const values: InterfaceStateValue[] = []
  for (const [name, initial] of program.declarations) {
    const value = vars[name]
    if (value === undefined || value === initial) continue
    const control = controls.get(name)
    values.push({ label: control?.label ?? name, value: control ? control.format(value) : inlineUiText(value) })
    if (values.length >= MAX_INTERFACE_STATE_VALUES) break
  }
  return { title: (tree && findTitle(tree)) || FALLBACK_TITLE, values }
}
