/**
 * openui 节点树 → React 组件。
 *
 * 安全不变量：模型产出的值只以文本节点出现；不用 dangerouslySetInnerHTML；
 * 不接收 URL、原始样式或颜色字符串。内联样式只有应用算出的数字（宽度百分比、
 * 列数、入场错峰序号）和应用主题的系列色。
 */
import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Slider } from '@astryxdesign/core/Slider'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { walkAskLabel, type InlineUiAsk, type InlineUiNode, type InlineUiPrimitive, type InlineUiWalkStep } from './inlineUiLanguage'
import { useVisualizationTheme } from '../visualization/visualizationTheme'

type NodeOf<T extends InlineUiNode['type']> = Extract<InlineUiNode, { type: T }>

export interface InlineUiHandlers {
  readonly interactive: boolean
  readonly onSetVar: (variable: string, value: InlineUiPrimitive) => void
  readonly onButton: (node: NodeOf<'button'>) => void
  /** 组件自带的追问入口（如 Walkthrough 的「深入讲讲这一步」） */
  readonly onAsk: (ask: InlineUiAsk) => void
}

const HandlersContext = createContext<InlineUiHandlers>({
  interactive: false,
  onSetVar: () => {},
  onButton: () => {},
  onAsk: () => {}
})

const useHandlers = (): InlineUiHandlers => useContext(HandlersContext)

export function InlineUiTree({ node, handlers }: { node: InlineUiNode; handlers: InlineUiHandlers }): React.ReactElement {
  return (
    <HandlersContext.Provider value={handlers}>
      <NodeView node={node} index={0} />
    </HandlersContext.Provider>
  )
}

/** 入场错峰序号：同一容器内前 8 个子项依次延迟，之后的同时出现 */
const stagger = (index: number): CSSProperties => ({ '--iu-i': Math.min(index, 8) } as CSSProperties)

function ChildList({ nodes }: { nodes: InlineUiNode[] }): React.ReactElement {
  return <>{nodes.map((child, i) => <NodeView key={i} node={child} index={i} />)}</>
}

function NodeView({ node, index }: { node: InlineUiNode; index: number }): React.ReactNode {
  const { interactive, onSetVar, onButton } = useHandlers()
  const style = stagger(index)
  switch (node.type) {
    case 'col':
    case 'row':
      return <div className={`inline-ui__${node.type} inline-ui__item`} style={style}><ChildList nodes={node.children} /></div>
    case 'grid':
      return (
        <div className="inline-ui__grid inline-ui__item" style={{ ...style, '--iu-cols': node.columns } as CSSProperties}>
          <ChildList nodes={node.children} />
        </div>
      )
    case 'card':
      return (
        <section className="inline-ui__card inline-ui__item" style={style}>
          {node.title !== null && <div className="inline-ui__card-title">{node.title}</div>}
          <ChildList nodes={node.children} />
        </section>
      )
    case 'collapsible':
      return <CollapsibleView node={node} style={style} />
    case 'tabs':
      return <TabsView node={node} style={style} />
    case 'text':
      return <div className={`inline-ui__text inline-ui__text--${node.style} inline-ui__item`} style={style}>{node.text}</div>
    case 'callout':
      return (
        <div className={`inline-ui__callout inline-ui__tone--${node.tone} inline-ui__item`} role="note" style={style}>
          {node.title !== null && <div className="inline-ui__callout-title">{node.title}</div>}
          <div className="inline-ui__callout-body">{node.text}</div>
        </div>
      )
    case 'code':
      return (
        <div className="inline-ui__code inline-ui__item" style={style}>
          {node.language !== null && <div className="inline-ui__code-lang">{node.language}</div>}
          <pre><code>{node.code}</code></pre>
        </div>
      )
    case 'list': {
      const items = node.items.map((item, i) => <li key={i}>{item}</li>)
      return node.ordered
        ? <ol className="inline-ui__list inline-ui__item" style={style}>{items}</ol>
        : <ul className="inline-ui__list inline-ui__item" style={style}>{items}</ul>
    }
    case 'kv':
      return (
        <dl className="inline-ui__kv inline-ui__item" style={style}>
          {node.items.map((item, i) => (
            <div key={i} className="inline-ui__kv-row">
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'badge':
      return <span className={`inline-ui__badge inline-ui__tone--${node.tone} inline-ui__item`} style={style}>{node.text}</span>
    case 'divider':
      return <hr className="inline-ui__divider inline-ui__item" style={style} />
    case 'stat':
      return (
        <div className={`inline-ui__stat inline-ui__stat--${node.tone} inline-ui__item`} style={style}>
          <div className="inline-ui__stat-label">{node.label}</div>
          <div className="inline-ui__stat-value">{node.value}</div>
          {node.hint !== null && <div className="inline-ui__stat-hint">{node.hint}</div>}
        </div>
      )
    case 'progress': {
      const ratio = node.value === null ? 0 : Math.min(1, Math.max(0, node.value / node.max))
      return (
        <div className={`inline-ui__progress inline-ui__tone--${node.tone} inline-ui__item`} style={style}>
          <div className="inline-ui__progress-head">
            {node.label !== null && <span>{node.label}</span>}
            <span className="inline-ui__progress-value">{node.display}</span>
          </div>
          <div
            className="inline-ui__progress-track"
            role="progressbar"
            aria-label={node.label ?? undefined}
            aria-valuemin={0}
            aria-valuemax={node.max}
            aria-valuenow={node.value ?? undefined}
          >
            <span className="inline-ui__progress-fill" style={{ width: `${ratio * 100}%` }} />
          </div>
        </div>
      )
    }
    case 'table':
      return (
        <div className="inline-ui__table-wrap inline-ui__item" style={style}>
          <table className="inline-ui__table">
            <thead>
              <tr>{node.headers.map((header, i) => <th key={i}>{header}</th>)}</tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r} className={node.highlight === r ? 'inline-ui__table-row--highlight' : undefined}>
                  {row.map((cell, c) => <td key={c}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'bars':
      return <BarsView node={node} style={style} />
    case 'chart':
      return <ChartView node={node} style={style} />
    case 'pie':
      return <PieView node={node} style={style} />
    case 'architecture':
      return <ArchitectureView node={node} style={style} />
    case 'flow':
      return <FlowView node={node} style={style} />
    case 'steps':
      return <StepsView node={node} style={style} />
    case 'walkthrough':
      return <WalkthroughView node={node} style={style} />
    case 'flashcard':
      return <FlashcardView node={node} style={style} />
    case 'slider': {
      const disabled = !interactive || !node.valid
      return (
        <div className="inline-ui__control inline-ui__item" style={style}>
          <Slider
            label={node.label ?? ' '}
            value={node.value ?? node.min ?? 0}
            min={node.min ?? 0}
            max={node.max ?? 100}
            step={node.step}
            isDisabled={disabled}
            onChange={(value: number) => onSetVar(node.variable, value)}
            formatValue={value => `${value}${node.unit ?? ''}`}
            valueDisplay="text"
          />
        </div>
      )
    }
    case 'choice': {
      const disabled = !interactive || node.value === null
      return (
        <div className="inline-ui__control inline-ui__item" style={style}>
          <SegmentedControl
            label={node.label ?? ' '}
            value={node.value ?? ''}
            isDisabled={disabled}
            onChange={(value: string) => onSetVar(node.variable, value)}
          >
            {node.options.map(option => (
              <SegmentedControlItem key={option} value={option} label={option} />
            ))}
          </SegmentedControl>
        </div>
      )
    }
    case 'select': {
      const disabled = !interactive || node.value === null
      return (
        <div className="inline-ui__control inline-ui__control--field inline-ui__item" style={style}>
          <Selector
            label={node.label ?? '选择'}
            isLabelHidden={node.label === null}
            options={node.options}
            value={node.value ?? undefined}
            isDisabled={disabled}
            placement="below"
            size="sm"
            onChange={(value: string) => onSetVar(node.variable, value)}
          />
        </div>
      )
    }
    case 'switch':
      return (
        <div className="inline-ui__control inline-ui__item" style={style}>
          <Switch
            label={node.label}
            value={node.value ?? false}
            isDisabled={!interactive || node.value === null}
            onChange={(checked: boolean) => onSetVar(node.variable, checked)}
          />
        </div>
      )
    case 'input':
      return (
        <div className="inline-ui__control inline-ui__control--field inline-ui__item" style={style}>
          <TextInput
            label={node.label}
            value={node.value ?? ''}
            placeholder={node.placeholder ?? undefined}
            isDisabled={!interactive || node.value === null}
            size="sm"
            onChange={(value: string) => onSetVar(node.variable, value)}
          />
        </div>
      )
    case 'button': {
      const disabled = !interactive || node.actions.length === 0
      const tooltip = !interactive
        ? '生成中'
        : node.preview !== null
          ? `将发送：${node.preview}`
          : undefined
      return (
        <span className="inline-ui__control inline-ui__item" style={style}>
          <Button
            label={node.label}
            variant={node.variant}
            size="sm"
            isDisabled={disabled}
            tooltip={tooltip}
            onClick={() => onButton(node)}
          />
        </span>
      )
    }
  }
}

/* ---------- 讲解类组件 ---------- */

function CollapsibleView({ node, style }: { node: NodeOf<'collapsible'>; style: CSSProperties }): React.ReactElement {
  const [open, setOpen] = useState(node.defaultOpen)
  const panelId = useId()
  return (
    <div className={`inline-ui__collapsible inline-ui__item${open ? ' is-open' : ''}`} style={style}>
      <button
        type="button"
        className="inline-ui__collapsible-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
      >
        <span className="inline-ui__chevron" aria-hidden="true" />
        <span>{node.title}</span>
      </button>
      {open && (
        <div id={panelId} className="inline-ui__collapsible-body">
          <ChildList nodes={node.children} />
        </div>
      )}
    </div>
  )
}

function TabsView({ node, style }: { node: NodeOf<'tabs'>; style: CSSProperties }): React.ReactElement {
  const { interactive, onSetVar } = useHandlers()
  const [localActive, setLocalActive] = useState(0)
  const baseId = useId()
  const bound = node.binding !== null
  const active = Math.min(node.tabs.length - 1, bound ? (node.active ?? 0) : localActive)
  // 绑定变量的标签页要等回答完成才可切换；未绑定的只是本地视图，随时可切
  const switchable = !bound || interactive
  const select = (index: number): void => {
    if (!switchable || index === active) return
    const binding = node.binding
    if (binding === null) setLocalActive(index)
    else onSetVar(binding.variable, binding.kind === 'number' ? index : node.tabs[index].label)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const next = (active + delta + node.tabs.length) % node.tabs.length
    select(next)
    const tab = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
    tab?.focus()
  }
  return (
    <div className="inline-ui__tabs inline-ui__item" style={style}>
      <div className="inline-ui__tablist" role="tablist" onKeyDown={onKeyDown}>
        {node.tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`${baseId}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${baseId}-panel`}
            tabIndex={i === active ? 0 : -1}
            disabled={!switchable && i !== active}
            className={`inline-ui__tab${i === active ? ' is-active' : ''}`}
            onClick={() => select(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        key={active}
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        className="inline-ui__tabpanel"
      >
        <ChildList nodes={node.tabs[active]?.children ?? []} />
      </div>
    </div>
  )
}

function FlashcardView({ node, style }: { node: NodeOf<'flashcard'>; style: CSSProperties }): React.ReactElement {
  const [flipped, setFlipped] = useState(false)
  return (
    <button
      type="button"
      className={`inline-ui__flashcard inline-ui__item${flipped ? ' is-flipped' : ''}`}
      style={style}
      aria-pressed={flipped}
      aria-label={flipped ? `答案：${node.back}` : `${node.front}（点击翻面）`}
      onClick={() => setFlipped(value => !value)}
    >
      <span className="inline-ui__flashcard-inner">
        <span className="inline-ui__flashcard-face inline-ui__flashcard-front" aria-hidden={flipped}>
          <span>{node.front}</span>
          <span className="inline-ui__flashcard-hint">点击翻面</span>
        </span>
        <span className="inline-ui__flashcard-face inline-ui__flashcard-back" aria-hidden={!flipped}>
          <span>{node.back}</span>
        </span>
      </span>
    </button>
  )
}

function ArchitectureView({ node, style }: { node: NodeOf<'architecture'>; style: CSSProperties }): React.ReactElement {
  const { interactive, onSetVar, onAsk } = useHandlers()
  const [localModule, setLocalModule] = useState(0)
  const flat = node.layers.flatMap(layer => layer.nodes)
  const total = flat.length
  const requested = !interactive ? total - 1 : node.current !== null ? (node.current.value ?? 0) : localModule
  const active = Math.min(total - 1, Math.max(0, Math.trunc(requested)))
  const go = (index: number): void => {
    if (!interactive || index === active) return
    if (node.current !== null) onSetVar(node.current.variable, index)
    else setLocalModule(index)
  }
  return (
    <div className="inline-ui__architecture inline-ui__item" style={style}>
      <div className="inline-ui__architecture-canvas">
        {node.layers.map((layer, layerIndex) => {
          const layerStart = node.layers.slice(0, layerIndex).reduce((sum, item) => sum + item.nodes.length, 0)
          return (
            <React.Fragment key={`${layer.title}-${layerIndex}`}>
              <div className="inline-ui__architecture-layer">
                <div className="inline-ui__architecture-label">{layer.title}</div>
                <div className="inline-ui__architecture-nodes">
                  {layer.nodes.map((item, nodeIndex) => {
                    const global = layerStart + nodeIndex
                    return (
                      <button
                        key={global}
                        type="button"
                        className={`inline-ui__architecture-node${global === active ? ' is-current' : ''}`}
                        disabled={!interactive}
                        aria-pressed={global === active}
                        onClick={() => go(global)}
                      >
                        {item.title}
                      </button>
                    )
                  })}
                </div>
              </div>
              {layerIndex < node.layers.length - 1 && (
                <div className="inline-ui__architecture-connector">
                  <div className="inline-ui__architecture-connector-axis">
                    {layer.relation !== null && <span className="inline-ui__architecture-relation">{layer.relation}</span>}
                    <span className="inline-ui__architecture-arrow" aria-hidden="true" />
                  </div>
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
      <WalkDetail key={active} step={flat[active]} interactive={interactive} onAsk={onAsk} askLabel="深入讲讲这个模块" />
    </div>
  )
}

const FLOW_NODE_MIN_WIDTH = 144
const FLOW_ARROW_GAP = 30

function FlowView({ node, style }: { node: NodeOf<'flow'>; style: CSSProperties }): React.ReactElement {
  const { interactive, onSetVar } = useHandlers()
  const rootRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState<number | null>(null)
  const current = node.current
  const clickable = interactive && current !== null
  const active = current?.value ?? null
  const activeItem = active !== null ? node.items[active] : undefined

  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    setAvailableWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined) setAvailableWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowBudget = node.items.length * FLOW_NODE_MIN_WIDTH + Math.max(0, node.items.length - 1) * FLOW_ARROW_GAP
  const direction = node.direction === 'row' && node.items.length > 1 && availableWidth !== null && availableWidth >= rowBudget ? 'row' : 'col'
  const go = (index: number): void => {
    if (clickable && current !== null && index >= 0 && index < node.items.length) onSetVar(current.variable, index)
  }
  return (
    <div ref={rootRef} className={`inline-ui__flow inline-ui__flow--${direction} inline-ui__item`} style={style}>
      <ol className="inline-ui__flow-track">
        {node.items.map((item, i) => {
          const state = active === null ? '' : i === active ? ' is-current' : i < active ? ' is-done' : ''
          const content = (
            <>
              <span className="inline-ui__flow-index">{i + 1}</span>
              <span className="inline-ui__flow-title">{item.title}</span>
              {current === null && item.detail !== null && <span className="inline-ui__flow-detail">{item.detail}</span>}
            </>
          )
          return (
            <li key={i} className={`inline-ui__flow-step${state}`} style={stagger(i)} aria-current={i === active ? 'step' : undefined}>
              {current !== null ? (
                <button type="button" className="inline-ui__flow-node" disabled={!clickable} onClick={() => go(i)}>
                  {content}
                </button>
              ) : (
                <div className="inline-ui__flow-node">{content}</div>
              )}
              {i < node.items.length - 1 && <span className="inline-ui__flow-arrow" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>
      {current !== null && activeItem && (
        <div className="inline-ui__flow-inspector">
          <div key={active} className="inline-ui__flow-inspector-body">
            <div className="inline-ui__flow-inspector-title">{`${(active ?? 0) + 1}. ${activeItem.title}`}</div>
            {activeItem.detail !== null && <div className="inline-ui__flow-inspector-detail">{activeItem.detail}</div>}
          </div>
          <div className="inline-ui__flow-transport">
            <Button label="上一步" variant="secondary" size="sm" isDisabled={!clickable || (active ?? 0) <= 0} onClick={() => go((active ?? 0) - 1)} />
            <Button label="下一步" variant="primary" size="sm" isDisabled={!clickable || (active ?? 0) >= node.items.length - 1} onClick={() => go((active ?? 0) + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}

function StepsView({ node, style }: { node: NodeOf<'steps'>; style: CSSProperties }): React.ReactElement {
  const { interactive, onSetVar } = useHandlers()
  const current = node.current
  const clickable = interactive && current !== null
  return (
    <ol className="inline-ui__steps inline-ui__item" style={style}>
      {node.steps.map((step, i) => {
        const active = current?.value === i
        const body = (
          <>
            <div className="inline-ui__step-title">{step.title}</div>
            {step.detail !== null && <div className="inline-ui__step-detail">{step.detail}</div>}
          </>
        )
        return (
          <li key={i} className={`inline-ui__step${active ? ' inline-ui__step--active' : ''}`} aria-current={active ? 'step' : undefined}>
            {current !== null ? (
              <button type="button" className="inline-ui__step-button" disabled={!clickable} onClick={() => onSetVar(current.variable, i)}>
                {body}
              </button>
            ) : body}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 分阶段讲解：阶段进度条 → 阶段说明 → 本阶段步骤与详情 → 跨阶段翻页。
 * 生成中跟随最新写完的一步，用户看着讲解一步步长出来；可交互后回到
 * $step（未绑定时为本地状态）指向的那一步。
 */
function WalkthroughView({ node, style }: { node: NodeOf<'walkthrough'>; style: CSSProperties }): React.ReactElement {
  const { interactive, onSetVar, onAsk } = useHandlers()
  const [localStep, setLocalStep] = useState(0)
  const flat = node.phases.flatMap((phase, p) => phase.steps.map(step => ({ step, phase: p })))
  const total = flat.length
  const requested = !interactive ? total - 1 : node.current !== null ? (node.current.value ?? 0) : localStep
  const active = Math.min(total - 1, Math.max(0, Math.trunc(requested)))
  const phaseIndex = flat[active].phase
  const phase = node.phases[phaseIndex]
  const firstOf = (p: number): number => flat.findIndex(item => item.phase === p)
  const phaseStart = firstOf(phaseIndex)
  const go = (index: number): void => {
    if (!interactive || index < 0 || index >= total || index === active) return
    if (node.current !== null) onSetVar(node.current.variable, index)
    else setLocalStep(index)
  }
  const nextCrossesPhase = active < total - 1 && flat[active + 1].phase !== phaseIndex
  return (
    <div className="inline-ui__walk inline-ui__item" style={style}>
      <ol className="inline-ui__walk-phases" style={{ '--iu-phases': node.phases.length } as CSSProperties}>
        {node.phases.map((item, i) => (
          <li
            key={i}
            className="inline-ui__walk-phase"
            data-state={i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'todo'}
            style={stagger(i)}
          >
            <button
              type="button"
              disabled={!interactive}
              aria-current={i === phaseIndex ? 'step' : undefined}
              aria-label={`阶段 ${i + 1}：${item.title}`}
              onClick={() => go(firstOf(i))}
            >
              <span className="inline-ui__walk-phase-bar" aria-hidden="true" />
              <span className="inline-ui__walk-phase-label">
                <span className="inline-ui__walk-phase-index">{i + 1}</span>
                <span className="inline-ui__walk-phase-title">{item.title}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div key={phaseIndex} className="inline-ui__walk-head">
        <div className="inline-ui__walk-kicker">{`阶段 ${phaseIndex + 1} / ${node.phases.length}`}</div>
        <div className="inline-ui__walk-phase-name">{phase.title}</div>
        {phase.summary !== null && <div className="inline-ui__walk-summary">{phase.summary}</div>}
        {phase.io !== null && (
          <div className="inline-ui__walk-io">
            <span className="inline-ui__walk-io-label">数据流</span>
            <code>{phase.io}</code>
          </div>
        )}
      </div>
      <div className="inline-ui__walk-body">
        <ol className="inline-ui__walk-steps">
          {phase.steps.map((item, i) => {
            const global = phaseStart + i
            const state = global < active ? ' is-done' : global === active ? ' is-current' : ''
            return (
              <li key={`${phaseIndex}-${i}`} style={stagger(i)}>
                <button
                  type="button"
                  className={`inline-ui__walk-step${state}`}
                  disabled={!interactive}
                  aria-current={global === active ? 'step' : undefined}
                  onClick={() => go(global)}
                >
                  <span className="inline-ui__walk-step-index">{global + 1}</span>
                  <span className="inline-ui__walk-step-text">
                    <span className="inline-ui__walk-step-title">{item.title}</span>
                    {item.meta !== null && <span className="inline-ui__walk-step-meta">{item.meta}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        <WalkDetail key={active} step={flat[active].step} interactive={interactive} onAsk={onAsk} />
      </div>
      <div className="inline-ui__walk-footer">
        <span className="inline-ui__walk-position">{`第 ${active + 1} / ${total} 步`}</span>
        <span className="inline-ui__walk-transport">
          <Button label="上一步" variant="secondary" size="sm" isDisabled={!interactive || active <= 0} onClick={() => go(active - 1)} />
          <Button
            label={nextCrossesPhase ? '下一阶段' : '下一步'}
            variant="primary"
            size="sm"
            isDisabled={!interactive || active >= total - 1}
            onClick={() => go(active + 1)}
          />
        </span>
      </div>
    </div>
  )
}

function WalkDetail({ step, interactive, onAsk, askLabel = '深入讲讲这一步' }: {
  step: InlineUiWalkStep
  interactive: boolean
  onAsk: (ask: InlineUiAsk) => void
  askLabel?: string
}): React.ReactElement {
  const [sourceOpen, setSourceOpen] = useState(false)
  const sourceId = useId()
  const ask = step.ask
  return (
    // 只在可交互时播报：生成中每写完一步都会换内容，播报会刷屏
    <div className="inline-ui__walk-detail" aria-live={interactive ? 'polite' : undefined}>
      <div className="inline-ui__walk-detail-title">{step.title}</div>
      {step.meta !== null && <div className="inline-ui__walk-detail-meta">{step.meta}</div>}
      {step.detail !== null && <p className="inline-ui__walk-detail-text">{step.detail}</p>}
      {step.data !== null && (
        <dl className="inline-ui__kv inline-ui__walk-data">
          {step.data.map((row, i) => (
            <div key={i} className="inline-ui__kv-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {step.code !== null && (
        <div className={`inline-ui__walk-source${sourceOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="inline-ui__walk-source-head"
            aria-expanded={sourceOpen}
            aria-controls={sourceId}
            onClick={() => setSourceOpen(value => !value)}
          >
            <span className="inline-ui__chevron" aria-hidden="true" />
            <span>{step.file ?? '查看源码'}</span>
          </button>
          {sourceOpen && <pre id={sourceId}><code>{step.code}</code></pre>}
        </div>
      )}
      {ask !== null && (
        <span className="inline-ui__walk-ask">
          <Button
            label={askLabel}
            variant="secondary"
            size="sm"
            isDisabled={!interactive}
            tooltip={interactive ? `将发送：${ask}` : '生成中'}
            onClick={() => onAsk({ label: walkAskLabel(step), prompt: ask })}
          />
        </span>
      )}
    </div>
  )
}

/* ---------- 图表 ---------- */

function usePalette(): string[] {
  const theme = useVisualizationTheme()
  return [
    theme.tokens['series-1'], theme.tokens['series-2'], theme.tokens['series-3'],
    theme.tokens['series-4'], theme.tokens['series-5'], theme.tokens['series-6']
  ]
}

function BarsView({ node, style }: { node: NodeOf<'bars'>; style: CSSProperties }): React.ReactElement {
  const palette = usePalette()
  const max = node.items.reduce((acc, item) => Math.max(acc, item.value ?? 0), 0)
  return (
    <div className="inline-ui__bars inline-ui__item" style={style}>
      {node.items.map((item, i) => {
        const ratio = max > 0 && item.value !== null ? item.value / max : 0
        const width = Math.min(100, Math.max(0, ratio * 100))
        return (
          <div key={i} className="inline-ui__bars-row" style={stagger(i)}>
            <span className="inline-ui__bars-label">{item.label}</span>
            <span className="inline-ui__bars-track">
              <span
                className="inline-ui__bars-fill"
                style={{ width: `${width}%`, background: palette[i % palette.length] }}
              />
            </span>
            <span className="inline-ui__bars-value">{item.display}</span>
          </div>
        )
      })}
    </div>
  )
}

const CHART_W = 600
const CHART_H = 220
const PAD = { top: 14, right: 12, bottom: 30, left: 48 }

/** 取 1/2/5×10^n 的整齐刻度，最多 5 条 */
function niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  if (min === max) { max = min + 1 }
  const span = max - min
  const raw = span / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(m => m * magnitude).find(s => span / s <= 4) ?? 10 * magnitude
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)))
  return { lo, hi, ticks }
}

const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const fullNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

function ChartView({ node, style }: { node: NodeOf<'chart'>; style: CSSProperties }): React.ReactElement {
  const palette = usePalette()
  const values = node.series.flatMap(s => s.values.filter((v): v is number => v !== null))
  const { lo, hi, ticks } = niceScale(Math.min(0, ...values), Math.max(0, ...values))
  const plotW = CHART_W - PAD.left - PAD.right
  const plotH = CHART_H - PAD.top - PAD.bottom
  const band = plotW / Math.max(1, node.labels.length)
  const y = (v: number): number => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH
  const x = (i: number): number => PAD.left + band * (i + 0.5)
  const baseline = y(Math.max(lo, 0))
  const labelEvery = Math.max(1, Math.ceil(node.labels.length / 10))
  const unit = node.unit ?? ''
  const showLegend = node.series.length > 1 || node.series.some(s => s.name !== '' && s.name !== '—')
  const singleBarLabels = node.kind === 'bar' && node.series.length === 1 && node.labels.length <= 10
  return (
    <figure className={`inline-ui__chart inline-ui__chart--${node.kind} inline-ui__item`} style={style}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={node.series.map(s => s.name).join('、') || '图表'}>
        {ticks.map(tick => (
          <g key={tick} className="inline-ui__chart-grid">
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">{compactNumber.format(tick)}</text>
          </g>
        ))}
        {node.labels.map((label, i) => (
          i % labelEvery === 0 && (
            <text key={i} className="inline-ui__chart-xlabel" x={x(i)} y={CHART_H - PAD.bottom + 16} textAnchor="middle">
              {label.length > 8 ? `${label.slice(0, 7)}…` : label}
            </text>
          )
        ))}
        {node.kind === 'bar' && node.series.map((series, s) => {
          const inner = (band * 0.68) / node.series.length
          return series.values.map((v, i) => {
            if (v === null) return null
            const top = Math.min(y(v), baseline)
            const height = Math.max(1, Math.abs(y(v) - baseline))
            const bx = PAD.left + band * i + band * 0.16 + inner * s
            return (
              <g key={`${s}-${i}`}>
                <rect
                  className="inline-ui__chart-bar"
                  x={bx} y={top} width={Math.max(2, inner - 2)} height={height} rx={3}
                  fill={palette[s % palette.length]}
                  style={stagger(i)}
                >
                  <title>{`${node.labels[i]}${series.name && series.name !== '—' ? `（${series.name}）` : ''}：${fullNumber.format(v)}${unit}`}</title>
                </rect>
                {singleBarLabels && (
                  <text className="inline-ui__chart-value" x={bx + inner / 2 - 1} y={top - 5} textAnchor="middle">
                    {`${compactNumber.format(v)}${unit}`}
                  </text>
                )}
              </g>
            )
          })
        })}
        {node.kind !== 'bar' && node.series.map((series, s) => {
          const points = series.values.map((v, i) => (v === null ? null : [x(i), y(v)] as const))
          const segments: string[] = []
          let open = false
          for (const point of points) {
            if (point === null) { open = false; continue }
            segments.push(`${open ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`)
            open = true
          }
          const valid = points.filter((p): p is readonly [number, number] => p !== null)
          const color = palette[s % palette.length]
          const area = node.kind === 'area' && valid.length > 1
            ? `M${valid[0][0].toFixed(1)},${baseline.toFixed(1)} ${valid.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} L${valid[valid.length - 1][0].toFixed(1)},${baseline.toFixed(1)} Z`
            : null
          return (
            <g key={s}>
              {area !== null && <path className="inline-ui__chart-area" d={area} fill={color} />}
              <path className="inline-ui__chart-line" d={segments.join(' ')} stroke={color} pathLength={1} />
              {series.values.map((v, i) => v === null ? null : (
                <circle key={i} className="inline-ui__chart-point" cx={x(i)} cy={y(v)} r={3.5} fill={color} style={stagger(i)}>
                  <title>{`${node.labels[i]}${series.name && series.name !== '—' ? `（${series.name}）` : ''}：${fullNumber.format(v)}${unit}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      {showLegend && (
        <figcaption className="inline-ui__legend">
          {node.series.map((series, s) => (
            <span key={s} className="inline-ui__legend-item">
              <span className="inline-ui__legend-dot" style={{ background: palette[s % palette.length] }} />
              {series.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  )
}

function arcPath(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const point = (radius: number, angle: number): string =>
    `${(cx + radius * Math.sin(angle)).toFixed(2)},${(cy - radius * Math.cos(angle)).toFixed(2)}`
  const large = end - start > Math.PI ? 1 : 0
  if (inner <= 0) return `M${cx},${cy} L${point(r, start)} A${r},${r} 0 ${large} 1 ${point(r, end)} Z`
  return `M${point(r, start)} A${r},${r} 0 ${large} 1 ${point(r, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`
}

function PieView({ node, style }: { node: NodeOf<'pie'>; style: CSSProperties }): React.ReactElement {
  const palette = usePalette()
  const total = node.items.reduce((acc, item) => acc + item.value, 0)
  const r = 80
  const inner = node.donut ? 50 : 0
  let angle = 0
  const percent = (v: number): string => (total > 0 ? `${fullNumber.format((v / total) * 100)}%` : '—')
  return (
    <figure className="inline-ui__pie inline-ui__item" style={style}>
      <svg viewBox="0 0 200 200" role="img" aria-label="占比图">
        {total > 0 && node.items.map((item, i) => {
          const sweep = (item.value / total) * Math.PI * 2
          const start = angle
          angle += sweep
          const color = palette[i % palette.length]
          const label = `${item.label}：${item.display}（${percent(item.value)}）`
          // 单项占满一圈时弧线起止点重合，改画整圆
          if (sweep >= Math.PI * 2 - 1e-6) {
            return (
              <g key={i} className="inline-ui__pie-slice" style={stagger(i)}>
                <circle cx={100} cy={100} r={r} fill={color}><title>{label}</title></circle>
                {inner > 0 && <circle cx={100} cy={100} r={inner} className="inline-ui__pie-hole" />}
              </g>
            )
          }
          if (sweep <= 0) return null
          return (
            <path key={i} className="inline-ui__pie-slice" d={arcPath(100, 100, r, inner, start, start + sweep)} fill={color} style={stagger(i)}>
              <title>{label}</title>
            </path>
          )
        })}
        {node.donut && (
          <text className="inline-ui__pie-total" x={100} y={100} dy="0.35em" textAnchor="middle">
            {`${compactNumber.format(total)}${node.unit ?? ''}`}
          </text>
        )}
      </svg>
      <figcaption className="inline-ui__legend inline-ui__legend--stacked">
        {node.items.map((item, i) => (
          <span key={i} className="inline-ui__legend-item">
            <span className="inline-ui__legend-dot" style={{ background: palette[i % palette.length] }} />
            <span className="inline-ui__legend-label">{item.label}</span>
            <span className="inline-ui__legend-value">{`${item.display}（${percent(item.value)}）`}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
