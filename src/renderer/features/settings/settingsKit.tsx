/**
 * 设置页原语 —— 页面 = 命名分组列表；分组 = 行列表（rows）或裸块（bare）；
 * 行 = 左侧 label/描述 + 右侧限宽控件。行组无边到边、hairline 分隔。
 */
import type { ComponentProps, ReactNode } from 'react'
import { Heading } from '@astryxdesign/core/Heading'
import { Item } from '@astryxdesign/core/Item'
import { Selector } from '@astryxdesign/core/Selector'
import { Text } from '@astryxdesign/core/Text'
import './settingsKit.css'

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
  /** 行右侧控件簇，限宽并可换行，避免压扁 label 列 */
  end?: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <Item
      density="balanced"
      align={props.align}
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
