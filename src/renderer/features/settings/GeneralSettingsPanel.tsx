/**
 * GeneralSettingsPanel — 通用偏好设置面板（PRD §5.6）
 *
 * 包含：默认运行模式、bash shell/超时、编辑器字体/主题、diff 自动展开。
 * 所有改动通过 settings:set 持久化，主进程做 schema 校验。
 */
import React, { useEffect, useState } from 'react'
import { TextInput } from '@astryxdesign/core/TextInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { Mode } from '../../../shared/session/types'

const THEME_OPTIONS: { value: NovaSettingsDto['theme']; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'default', label: '默认模式（模型自主循环）' },
  { value: 'plan', label: '计划模式（只读分析）' }
]

const PERMISSION_OPTIONS: { value: NovaSettingsDto['permissionPolicy']; label: string }[] = [
  { value: 'ask', label: '执行前确认（bash 需批准）' },
  { value: 'auto', label: '自动执行（危险命令仍拦截）' }
]

export const GeneralSettingsPanel: React.FC = () => {
  const theme = useSettingsStore(state => state.theme)
  const setTheme = useSettingsStore(state => state.setTheme)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadSettings()
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
      // 1.5s 后隐藏"已保存"提示
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

  if (!settings) {
    return (
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h3 className="settings-panel__title">通用</h3>
        </header>
        <div className="settings-panel__scroll">加载中…</div>
      </div>
    )
  }

  const defaultMode = settings.defaultMode === 'compose' ? 'default' : settings.defaultMode

  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h3 className="settings-panel__title">通用</h3>
        <p className="settings-panel__desc">应用级偏好设置，重启后仍然生效。</p>
      </header>

      <div className="settings-modal__form settings-panel__scroll">
        <Selector
          label="默认运行模式"
          description="新建会话时使用的默认行为模式。"
          options={MODE_OPTIONS}
          value={defaultMode}
          onChange={value => void update('defaultMode', value as Mode)}
          isDisabled={saving}
          width="100%"
        />

        <Selector
          label="工具批准"
          description="仅约束默认模式；计划模式始终只读，XForge 模式 run 内固定自动执行语义。"
          options={PERMISSION_OPTIONS}
          value={settings.permissionPolicy}
          onChange={value => void update('permissionPolicy', value as NovaSettingsDto['permissionPolicy'])}
          isDisabled={saving}
          width="100%"
        />

        <TextInput
          label="默认 Shell（bash 工具）"
          description="为空时使用系统默认 shell。"
          value={settings.defaultShell}
          onChange={value => void update('defaultShell', value)}
          placeholder="留空使用系统默认（如 cmd / bash / zsh）"
          isDisabled={saving}
          width="100%"
        />

        <NumberInput
          label="Shell 命令超时（毫秒）"
          description="0 表示不超时。默认 120000ms（2 分钟）。"
          value={settings.defaultShellTimeout}
          onChange={value => void update('defaultShellTimeout', value)}
          min={0}
          step={1000}
          isDisabled={saving}
          width="100%"
        />

        <NumberInput
          label="最大工具调用轮数"
          description="单条消息内 Agent 连续调用工具的上限，达到后会停下并提示。默认 100，范围 1~1000。长任务（脚手架 / 大规模重构）可调大。"
          value={settings.maxToolRounds}
          onChange={value => void update('maxToolRounds', value)}
          min={1}
          max={1000}
          step={10}
          isDisabled={saving}
          width="100%"
        />

        <Switch
          label="Diff 自动展开"
          description="默认展开文件变更审查区域。"
          value={settings.diffAutoExpand}
          onChange={checked => void update('diffAutoExpand', checked)}
          isDisabled={saving}
          width="100%"
        />

        <NumberInput
          label="编辑器字号（px）"
          description="范围 8~32。"
          value={settings.editorFontSize}
          onChange={value => void update('editorFontSize', value)}
          min={8}
          max={32}
          isDisabled={saving}
          width="100%"
        />

        <TextInput
          label="编辑器字体族"
          description="CSS font-family 值，多个用逗号分隔。"
          value={settings.editorFontFamily}
          onChange={value => void update('editorFontFamily', value)}
          isDisabled={saving}
          width="100%"
        />

        <Selector
          label="主题"
          description="界面主题外观。"
          options={THEME_OPTIONS}
          value={theme}
          onChange={value => void updateTheme(value as NovaSettingsDto['theme'])}
          isDisabled={saving}
          width="100%"
        />

        {error && <div className="settings-modal__error">{error}</div>}
        {saved && <div className="settings-modal__help" style={{ color: '#2e7d32' }}>已保存</div>}
      </div>
    </div>
  )
}
