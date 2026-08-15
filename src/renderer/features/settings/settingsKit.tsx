/**
 * 设置页原语 —— 页面 = 命名分组列表；分组 = 行列表（rows）或裸块（bare）；
 * 行 = 左侧 label/描述 + 右侧限宽控件。行组无边到边、hairline 分隔。
 */
import type { ReactNode } from 'react'
import { Divider } from '@astryxdesign/core/Divider'
import { Heading } from '@astryxdesign/core/Heading'
import { Item } from '@astryxdesign/core/Item'
import { Text } from '@astryxdesign/core/Text'
import './settingsKit.css'

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
      {hasHeader && <Divider />}
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
