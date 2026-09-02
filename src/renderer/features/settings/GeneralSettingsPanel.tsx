/**
 * GeneralSettingsPanel — 通用偏好设置面板
 *
 * 包含：默认运行模式、bash shell、持久终端会话、编辑器字体/主题、diff 自动展开、应用更新。
 * 所有改动通过 settings:set 持久化，主进程做 schema 校验。
 */
import React, { useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  APP_UPDATE_STATE_CHANGED,
  CHECK_APP_UPDATE,
  DOWNLOAD_APP_UPDATE,
  GET_APP_UPDATE_STATE,
  INSTALL_APP_UPDATE,
} from '../../../shared/ipc/channels'
import { SettingsField, SettingsPage, SettingsRow, SettingsSection } from './settingsKit'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { Mode } from '../../../shared/session/types'
import type { AppUpdateSnapshot } from '../../../shared/update'
import { FullAccessConfirmDialog } from '../permissions/FullAccessConfirmDialog'

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'default', label: '默认模式（模型自主循环）' },
  { value: 'plan', label: '计划模式（只读分析）' }
]

const PERMISSION_OPTIONS: Array<{
  value: NovaSettingsDto['defaultPermissionMode']
  label: string
  disabled?: boolean
}> = [
  { value: 'request_approval', label: '请求批准' },
  { value: 'auto', label: '自动' },
  { value: 'full_access', label: '完全访问' }
]

function displayVersion(version: string): string {
  return version.toLowerCase().startsWith('v') ? version : `v${version}`
}

function formatCheckedAt(checkedAt: string): string {
  const date = new Date(checkedAt)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function describeUpdateState(snapshot: AppUpdateSnapshot | null): string {
  if (!snapshot) return '正在读取版本信息…'
  switch (snapshot.status) {
    case 'idle':
      return `当前版本 ${displayVersion(snapshot.currentVersion)}`
    case 'checking':
      return `当前版本 ${displayVersion(snapshot.currentVersion)}，正在检查更新…`
    case 'up-to-date': {
      const checkedAt = formatCheckedAt(snapshot.checkedAt)
      return `已是最新版本 ${displayVersion(snapshot.currentVersion)}${checkedAt ? `（${checkedAt} 检查）` : ''}`
    }
    case 'available':
      return `发现新版本 ${displayVersion(snapshot.update.version)}`
    case 'downloading':
      return `正在下载 ${displayVersion(snapshot.update.version)}（${Math.round(Math.min(100, Math.max(0, snapshot.progress.percent)))}%）`
    case 'ready':
      return `${displayVersion(snapshot.update.version)} 已就绪，重启后自动安装`
    case 'error':
      return snapshot.operation === 'check'
        ? `检查更新失败：${snapshot.message}`
        : `下载更新失败：${snapshot.message}`
  }
}

/** 依据当前快照给出可执行动作；无可执行动作（检查中/下载中/已是最新）返回 null */
function getUpdateAction(
  snapshot: AppUpdateSnapshot | null,
): { label: string; channel: typeof DOWNLOAD_APP_UPDATE | typeof INSTALL_APP_UPDATE } | null {
  if (!snapshot) return null
  if (snapshot.status === 'available') return { label: '下载更新', channel: DOWNLOAD_APP_UPDATE }
  if (snapshot.status === 'ready') return { label: '重启并安装', channel: INSTALL_APP_UPDATE }
  if (snapshot.status === 'error' && snapshot.operation === 'download') {
    return { label: '重试下载', channel: DOWNLOAD_APP_UPDATE }
  }
  return null
}

export const GeneralSettingsPanel: React.FC = () => {
  const theme = useSettingsStore(state => state.theme)
  const setTheme = useSettingsStore(state => state.setTheme)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [updateSnapshot, setUpdateSnapshot] = useState<AppUpdateSnapshot | null>(null)
  const [updateActionError, setUpdateActionError] = useState<string | null>(null)

  useEffect(() => {
    void loadSettings()
  }, [])

  // 更新状态由主进程 AppUpdateController 唯一持有，这里只订阅镜像用于就地展示
  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.api.on(APP_UPDATE_STATE_CHANGED, (snapshot) => {
      if (!cancelled) setUpdateSnapshot(snapshot)
    })
    void window.api.invoke(GET_APP_UPDATE_STATE)
      .then((snapshot) => {
        if (!cancelled) setUpdateSnapshot(snapshot)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const loadSettings = async () => {
    try {
      const s = await window.api.invoke('settings:get')
      setSettings(s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设置失败')
    }
  }

  /** 局部更新单个字段并持久化 */
  const update = async <K extends keyof NovaSettingsDto>(key: K, value: NovaSettingsDto[K]): Promise<void> => {
    if (!settings) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await window.api.invoke('settings:set', { [key]: value } as Partial<NovaSettingsDto>)
      setSettings(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  const updateTheme = async (nextTheme: NovaSettingsDto['theme']): Promise<void> => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await setTheme(nextTheme)
      setSettings(current => (current ? { ...current, theme: nextTheme } : current))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  const selectDefaultPermissionMode = (value: NovaSettingsDto['defaultPermissionMode']): void => {
    if (!settings) return
    if (value === 'full_access' && settings.defaultPermissionMode !== 'full_access') {
      setConfirmFullAccess(true)
      return
    }
    void update('defaultPermissionMode', value)
  }

  /** 手动检查 / 下载 / 安装共用入口；状态变化经 APP_UPDATE_STATE_CHANGED 回流 */
  const runUpdateAction = async (channel: typeof CHECK_APP_UPDATE | typeof DOWNLOAD_APP_UPDATE | typeof INSTALL_APP_UPDATE): Promise<void> => {
    setUpdateActionError(null)
    try {
      await window.api.invoke(channel)
    } catch (err) {
      setUpdateActionError(err instanceof Error && err.message.trim() ? err.message : '操作未完成，请重试。')
    }
  }

  if (!settings) {
    return (
      <div className="settings-panel">
        <div className="settings-panel__scroll">
          <p className="settings-panel__muted">加载中…</p>
        </div>
      </div>
    )
  }

  const defaultMode = settings.defaultMode === 'compose' ? 'default' : settings.defaultMode
  const updateAction = getUpdateAction(updateSnapshot)

  return (
    <div className="settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsSection title="行为">
            <SettingsRow
              label="默认运行模式"
              description="新建会话时使用的默认行为模式。"
              end={
                <Selector
                  label="默认运行模式"
                  isLabelHidden
                  options={MODE_OPTIONS}
                  value={defaultMode}
                  onChange={value => void update('defaultMode', value as Mode)}
                  isDisabled={saving}
                  width={240}
                />
              }
            />
            <SettingsRow
              label="默认权限模式"
              description="新建会话使用；已有会话保留自己的权限模式。"
              end={
                <Selector
                  label="默认权限模式"
                  isLabelHidden
                  options={PERMISSION_OPTIONS}
                  value={settings.defaultPermissionMode}
                  onChange={value => selectDefaultPermissionMode(value as NovaSettingsDto['defaultPermissionMode'])}
                  isDisabled={saving}
                  width={240}
                />
              }
            />
            <SettingsRow
              label="最大工具调用轮数"
              description="单条消息内 Agent 连续调用工具的上限，达到后会停下并提示。默认 100，范围 1~1000，长任务可调大。"
              end={
                <NumberInput
                  label="最大工具调用轮数"
                  isLabelHidden
                  value={settings.maxToolRounds}
                  onChange={value => void update('maxToolRounds', value)}
                  min={1}
                  max={1000}
                  step={10}
                  isDisabled={saving}
                  width={130}
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="外观">
            <SettingsRow
              label="主题"
              description="界面主题外观。"
              end={
                <SegmentedControl
                  label="主题"
                  value={theme}
                  onChange={value => void updateTheme(value as NovaSettingsDto['theme'])}
                  isDisabled={saving}
                >
                  <SegmentedControlItem value="system" label="跟随系统" />
                  <SegmentedControlItem value="light" label="浅色" />
                  <SegmentedControlItem value="dark" label="深色" />
                </SegmentedControl>
              }
            />
          </SettingsSection>

          <SettingsSection title="Shell">
            <SettingsField>
              <TextInput
                label="默认 Shell（bash 工具）"
                description="为空时使用系统默认 shell。"
                value={settings.defaultShell}
                onChange={value => void update('defaultShell', value)}
                placeholder="留空使用系统默认（如 cmd / bash / zsh）"
                isDisabled={saving}
                width="100%"
              />
            </SettingsField>
            <SettingsRow
              label="持久终端会话"
              description="开启后，长时间运行的命令超时不再被强制终止，而是转为可继续交互的终端会话；关闭后退回超时即终止的行为。"
              end={
                <Switch
                  label="持久终端会话"
                  isLabelHidden
                  value={settings.persistentShellSessions}
                  onChange={checked => void update('persistentShellSessions', checked)}
                  isDisabled={saving}
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="编辑器">
            <SettingsRow
              label="编辑器字号（px）"
              description="范围 8~32。"
              end={
                <NumberInput
                  label="编辑器字号（px）"
                  isLabelHidden
                  value={settings.editorFontSize}
                  onChange={value => void update('editorFontSize', value)}
                  min={8}
                  max={32}
                  isDisabled={saving}
                  width={110}
                />
              }
            />
            <SettingsField>
              <TextInput
                label="编辑器字体家族"
                description="CSS font-family 值，多个用逗号分隔。"
                value={settings.editorFontFamily}
                onChange={value => void update('editorFontFamily', value)}
                isDisabled={saving}
                width="100%"
              />
            </SettingsField>
            <SettingsRow
              label="Diff 自动展开"
              description="默认展开文件变更审查区域。"
              end={
                <Switch
                  label="Diff 自动展开"
                  isLabelHidden
                  value={settings.diffAutoExpand}
                  onChange={checked => void update('diffAutoExpand', checked)}
                  isDisabled={saving}
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="应用更新">
            <SettingsRow
              label="应用版本"
              description={describeUpdateState(updateSnapshot)}
              end={
                <>
                  {updateAction && (
                    <Button
                      label={updateAction.label}
                      size="sm"
                      onClick={() => void runUpdateAction(updateAction.channel)}
                    >
                      {updateAction.label}
                    </Button>
                  )}
                  <Button
                    label="检查更新"
                    variant="secondary"
                    size="sm"
                    onClick={() => void runUpdateAction(CHECK_APP_UPDATE)}
                    isDisabled={
                      updateSnapshot?.status === 'checking' || updateSnapshot?.status === 'downloading'
                    }
                  >
                    {updateSnapshot?.status === 'checking' ? '正在检查…' : '检查更新'}
                  </Button>
                </>
              }
            />
            {updateActionError && (
              <SettingsField>
                <span className="settings-status settings-status--error">{updateActionError}</span>
              </SettingsField>
            )}
          </SettingsSection>

          {error && <div className="settings-status settings-status--gap settings-status--error">{error}</div>}
          {saved && <div className="settings-status settings-status--gap settings-status--ok">已保存</div>}
        </SettingsPage>
      </div>
      <FullAccessConfirmDialog
        isOpen={confirmFullAccess}
        isSubmitting={saving}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => {
          setConfirmFullAccess(false)
          void update('defaultPermissionMode', 'full_access')
        }}
      />
    </div>
  )
}
