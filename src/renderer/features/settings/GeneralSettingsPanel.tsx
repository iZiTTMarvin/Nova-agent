/**
 * GeneralSettingsPanel — 通用偏好设置面板
 *
 * 包含：默认运行模式、bash shell、持久终端会话、编辑器字体/主题、diff 自动展开、应用更新。
 * 所有改动通过 settings:set 持久化，主进程做 schema 校验。
 */
import React, { useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import {
  BellIcon,
  ClockIcon,
  CompassIcon,
  ContrastIcon,
  DownloadIcon,
  EyeOffIcon,
  FolderIcon,
  ShieldIcon,
  SlidersIcon,
  TerminalIcon
} from '../../components/Icons'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  APP_UPDATE_STATE_CHANGED,
  CHECK_APP_UPDATE,
  DOWNLOAD_APP_UPDATE,
  GET_APP_UPDATE_STATE,
  INSTALL_APP_UPDATE,
} from '../../../shared/ipc/channels'
import { SettingsCard, SettingsCardRow, SettingsGlassPanel, SettingsPage, SettingsSegmented, SettingsSelect } from './settingsKit'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { Mode } from '../../../shared/session/types'
import type { AppUpdateSnapshot } from '../../../shared/update'
import { FullAccessConfirmDialog } from '../permissions/FullAccessConfirmDialog'
import { formatSettingsTime } from './formatDateTime'

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
  return formatSettingsTime(date.getTime())
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
  const streamSmoothness = useSettingsStore(state => state.streamSmoothness)
  const setStreamSmoothness = useSettingsStore(state => state.setStreamSmoothness)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [shellDraft, setShellDraft] = useState('')
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
      setShellDraft(s.defaultShell)
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

  const updateStreamSmoothness = async (next: NovaSettingsDto['streamSmoothness']): Promise<void> => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await setStreamSmoothness(next)
      setSettings(current => (current ? { ...current, streamSmoothness: next } : current))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  // Shell 是自由文本：本地草稿，失焦或回车才落盘，避免每敲一个字符就写一次 settings.json
  const commitShell = (): void => {
    if (!settings) return
    const next = shellDraft.trim()
    if (next === settings.defaultShell) return
    void update('defaultShell', next)
  }

  const selectDefaultPermissionMode = (value: NovaSettingsDto['defaultPermissionMode']): void => {
    if (!settings) return
    if (value === 'full_access' && settings.defaultPermissionMode !== 'full_access') {
      setConfirmFullAccess(true)
      return
    }
    void update('defaultPermissionMode', value)
  }

  /** 默认工作区目录选择：纯取路径，选择后立即持久化 */
  const pickDefaultWorkspace = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await window.api.invoke('settings:pick-directory')
      if (picked) await update('defaultWorkspacePath', picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择文件夹失败')
    }
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

  const defaultMode = settings.defaultMode
  const updateAction = getUpdateAction(updateSnapshot)

  return (
    <SettingsGlassPanel className="general-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsCard title="运行与权限">
            <SettingsCardRow
              label="默认运行模式"
              control={
                <SettingsSelect
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
            <SettingsCardRow
              label="默认权限模式"
              control={
                <SettingsSelect
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
            <SettingsCardRow
              label="默认工作区"
              description="未指定项目时使用，留空为系统默认路径。"
              control={
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="glass-chip" title={settings.defaultWorkspacePath ?? '~/.nova/workspace'}>
                    {settings.defaultWorkspacePath ?? '默认 (~/.nova/workspace)'}
                  </span>
                  <Button
                    label="选择文件夹"
                    variant="secondary"
                    size="sm"
                    onClick={() => void pickDefaultWorkspace()}
                    isDisabled={saving}
                  >
                    选择文件夹…
                  </Button>
                  {settings.defaultWorkspacePath ? (
                    <Button
                      label="恢复默认工作区"
                      variant="ghost"
                      size="sm"
                      onClick={() => void update('defaultWorkspacePath', null)}
                      isDisabled={saving}
                    >
                      恢复默认
                    </Button>
                  ) : null}
                </div>
              }
            />
            <SettingsCardRow
              label="单次任务工具轮数上限"
              description="留空表示不设限制。"
              control={
                <NumberInput
                  label="单次任务工具轮数上限"
                  isLabelHidden
                  hasClear
                  value={settings.maxToolRounds}
                  onChange={value => void update('maxToolRounds', value ?? null)}
                  min={1}
                  max={1000}
                  step={10}
                  isDisabled={saving}
                  width={130}
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="界面与交互">
            <SettingsCardRow
              label="主题外观"
              control={
                <SettingsSegmented
                  label="主题外观"
                  value={theme}
                  onChange={value => void updateTheme(value as NovaSettingsDto['theme'])}
                  options={[
                    { value: 'system', label: '跟随系统' },
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' }
                  ]}
                />
              }
            />
            <SettingsCardRow
              label="流式输出节奏"
              description="平滑按打字机节奏均匀输出，即时随网络分块直接显示。"
              control={
                <SettingsSegmented
                  label="流式输出节奏"
                  value={streamSmoothness}
                  onChange={value => void updateStreamSmoothness(value as NovaSettingsDto['streamSmoothness'])}
                  options={[
                    { value: 'smooth', label: '平滑' },
                    { value: 'instant', label: '即时' }
                  ]}
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="终端环境">
            <SettingsCardRow
              label="默认 Shell"
              control={
                <TextInput
                  label="默认 Shell"
                  isLabelHidden
                  value={shellDraft}
                  onChange={value => setShellDraft(value)}
                  onBlur={() => commitShell()}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitShell()
                  }}
                  placeholder="系统默认（cmd / bash / zsh）"
                  isDisabled={saving}
                  width={260}
                />
              }
            />
            <SettingsCardRow
              label="持久终端会话"
              description="长命令执行时保持会话存活，支持后续交互。"
              control={
                <Switch
                  label="持久终端会话"
                  isLabelHidden
                  value={settings.persistentShellSessions}
                  onChange={checked => void update('persistentShellSessions', checked)}
                  isDisabled={saving}
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="桌面通知">
            <SettingsCardRow
              label="任务完成时通知我"
              description="任务完成或等待你批准时推送系统通知。"
              control={
                <Switch
                  label="任务完成时通知我"
                  isLabelHidden
                  value={settings.notificationsEnabled}
                  onChange={checked => void update('notificationsEnabled', checked)}
                  isDisabled={saving}
                />
              }
            />
            <SettingsCardRow
              label="仅在窗口失焦时通知"
              control={
                <Switch
                  label="仅在窗口失焦时通知"
                  isLabelHidden
                  value={settings.notifyOnlyWhenUnfocused}
                  onChange={checked => void update('notifyOnlyWhenUnfocused', checked)}
                  isDisabled={saving}
                />
              }
            />
          </SettingsCard>

          <SettingsCard
            title="应用与更新"
            description={describeUpdateState(updateSnapshot)}
            aside={
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {updateAction && (
                  <Button
                    label={updateAction.label}
                    size="sm"
                    variant="primary"
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
              </div>
            }
          >
            {updateActionError && (
              <span className="settings-status settings-status--error">{updateActionError}</span>
            )}
          </SettingsCard>
        </SettingsPage>
      </div>
      {(error || saved) && (
        <div
          className={`settings-toast ${error ? 'settings-toast--error' : 'settings-toast--ok'}`}
          role={error ? 'alert' : 'status'}
        >
          {error ?? '已保存'}
        </div>
      )}
      <FullAccessConfirmDialog
        isOpen={confirmFullAccess}
        isSubmitting={saving}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => {
          setConfirmFullAccess(false)
          void update('defaultPermissionMode', 'full_access')
        }}
      />
    </SettingsGlassPanel>
  )
}
