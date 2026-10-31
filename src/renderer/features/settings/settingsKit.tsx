/**
 * 设置页原语 —— 页面 = 命名分组列表；分组 = 行列表（rows）或裸块（bare）；
 * 行 = 可选图标块 + label/描述 + 右侧限宽控件。行组为圆角卡片、hairline 分隔。
 */
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { Heading } from '@astryxdesign/core/Heading'
import { Item } from '@astryxdesign/core/Item'
import { Selector } from '@astryxdesign/core/Selector'
import { Text } from '@astryxdesign/core/Text'
import './settingsKit.css'
import './settingsGlass.css'

/**
 * 设置页统一下拉：Selector 默认把选中项叠在触发器上展开，会盖住触发器和相邻行；
 * 固定为在触发器下方展开，所有设置面板必须经此入口使用下拉。
 */
export function SettingsSelect(props: ComponentProps<typeof Selector>) {
  return <Selector placement="below" {...props} />
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function SettingsPage(props: { className?: string; children: ReactNode }) {
  return <div className={cx('settings-page', props.className)}>{props.children}</div>
}

export function SettingsSection(props: {
  title?: ReactNode
  description?: ReactNode
  /** 组级操作簇，右对齐（刷新、新建等） */
  action?: ReactNode
  /** rows（默认）= hairline 行组；bare = 任意块（网格、编辑器、表格） */
  variant?: 'rows' | 'bare'
  className?: string
  children: ReactNode
}) {
  const hasHeader = props.title != null || props.description != null || props.action != null
  return (
    <section className={cx('settings-section', props.className)}>
      {hasHeader && (
        <div className="settings-section__header">
          <div className="settings-section__title-stack">
            {props.title != null && <Heading level={3}>{props.title}</Heading>}
            {props.description != null && (
              <Text type="supporting" size="sm" color="secondary">
                {props.description}
              </Text>
            )}
          </div>
          {props.action != null && <div className="settings-section__action">{props.action}</div>}
        </div>
      )}
      <div className={props.variant === 'bare' ? 'settings-section__body' : 'settings-rows'}>
        {props.children}
      </div>
    </section>
  )
}

export function SettingsRow(props: {
  label: ReactNode
  description?: ReactNode
  /** 行首图标，渲染在统一的图标块内 */
  icon?: ReactNode
  /** 行右侧控件簇，限宽并可换行，避免压扁 label 列 */
  end?: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <Item
      density="balanced"
      align={props.align}
      startContent={
        props.icon == null ? undefined : (
          <span className="settings-row-icon" aria-hidden="true">
            {props.icon}
          </span>
        )
      }
      label={props.label}
      description={props.description == null ? undefined : <>{props.description}</>}
      endContent={
        props.end == null ? undefined : <span className="settings-row-end">{props.end}</span>
      }
    />
  )
}

/** 行组内的全宽表单块（输入区、预览等），与行共享分隔节奏 */
export function SettingsField(props: { className?: string; children: ReactNode }) {
  return <div className={cx('settings-field', props.className)}>{props.children}</div>
}

/** 行组尾部的按钮簇 */
export function SettingsActions(props: { className?: string; children: ReactNode }) {
  return <div className={cx('settings-field settings-actions', props.className)}>{props.children}</div>
}

/** 玻璃面板根：自带玻璃变量与静态柔和底光，内容放在其上方 */
export function SettingsGlassPanel(props: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('settings-panel settings-glass settings-glass-panel', props.className)}>
      <div className="glass-aurora" aria-hidden="true" />
      {props.children}
    </div>
  )
}

export interface SettingsSegmentedOption<T extends string> {
  value: T
  label: ReactNode
  isDisabled?: boolean
  title?: string
}

/** 玻璃分段控件（单选）：方向键切换，滑块跟随选中项 */
export function SettingsSegmented<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<SettingsSegmentedOption<T>>
  onChange: (value: T) => void
  className?: string
}) {
  const { options, value, onChange } = props
  const index = Math.max(0, options.findIndex(option => option.value === value))
  const move = (event: KeyboardEvent<HTMLButtonElement>, step: 1 | -1) => {
    event.preventDefault()
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next = options[(((index + step * offset) % options.length) + options.length) % options.length]
      if (next && !next.isDisabled) {
        onChange(next.value)
        const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
        buttons?.[options.indexOf(next)]?.focus()
        return
      }
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={cx('glass-tabs', props.className)}
      style={{ '--n': options.length, '--i': index } as CSSProperties}
    >
      <span className="glass-tabs__thumb" aria-hidden="true" />
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          title={option.title}
          disabled={option.isDisabled}
          className="glass-tabs__item"
          onClick={() => onChange(option.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, 1)
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, -1)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 玻璃分组卡：标题 + 可选右侧辅助 + 内容；用于长表单按主题拆块，块与块之间留白清晰 */
export function SettingsCard(props: {
  title?: ReactNode
  description?: ReactNode
  /** 标题右侧的状态或操作 */
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cx('settings-card glass-card', props.className)}>
      {(props.title != null || props.aside != null) && (
        <header className="settings-card__head">
          <div className="settings-card__heading">
            {props.title != null && <h4 className="settings-card__title">{props.title}</h4>}
            {props.description != null && <p className="settings-card__desc">{props.description}</p>}
          </div>
          {props.aside != null && <div className="settings-card__aside">{props.aside}</div>}
        </header>
      )}
      <div className="settings-card__body">{props.children}</div>
    </section>
  )
}

/** 卡内一行：左文案右控件，行间发丝线 */
export function SettingsCardRow(props: { label: ReactNode; description?: ReactNode; control: ReactNode }) {
  return (
    <div className="settings-card__row">
      <div className="settings-card__row-text">
        <span className="settings-card__row-label">{props.label}</span>
        {props.description != null && <span className="settings-card__row-desc">{props.description}</span>}
      </div>
      <div className="settings-card__row-control">{props.control}</div>
    </div>
  )
}
