/**
 * GeneralSettingsPanel — 通用偏好设置面板（PRD §5.6）
 *
 * 包含：默认运行模式、bash shell/超时、verification 开关、编辑器字体/主题、diff 自动展开。
 * 所有改动通过 settings:set 持久化，主进程做 schema 校验。
 */
import React, { useEffect, useState } from 'react'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { Mode } from '../../../shared/session/types'

export const GeneralSettingsPanel: React.FC = () => {
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

  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h3 className="settings-panel__title">通用</h3>
        <p className="settings-panel__desc">应用级偏好设置，重启后仍然生效。</p>
      </header>

      <div className="settings-modal__form settings-panel__scroll">
        {/* 默认运行模式 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">默认运行模式</label>
          <select
            className="settings-modal__input settings-modal__select"
            value={settings.defaultMode}
            onChange={e => void update('defaultMode', e.target.value as Mode)}
            disabled={saving}
          >
            <option value="default">default（协作模式，写入需确认）</option>
            <option value="auto">auto（全自动，危险命令仍拦截）</option>
            <option value="plan">plan（只读分析）</option>
          </select>
          <span className="settings-modal__help">新建会话时使用的默认模式。</span>
        </div>

        {/* bash 默认 shell */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">默认 Shell（bash 工具）</label>
          <input
            type="text"
            className="settings-modal__input"
            value={settings.defaultShell}
            onChange={e => void update('defaultShell', e.target.value)}
            placeholder="留空使用系统默认（如 cmd / bash / zsh）"
            disabled={saving}
          />
          <span className="settings-modal__help">为空时使用系统默认 shell。</span>
        </div>

        {/* bash 超时 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">Shell 命令超时（毫秒）</label>
          <input
            type="number"
            className="settings-modal__input"
            value={settings.defaultShellTimeout}
            min={0}
            step={1000}
            onChange={e => void update('defaultShellTimeout', Number(e.target.value))}
            disabled={saving}
          />
          <span className="settings-modal__help">0 表示不超时。默认 120000ms（2 分钟）。</span>
        </div>

        {/* verification 开关 */}
        <div className="settings-modal__field settings-modal__field--inline">
          <label className="settings-modal__label">修改后自动验证</label>
          <input
            type="checkbox"
            checked={settings.verificationEnabled}
            onChange={e => void update('verificationEnabled', e.target.checked)}
            disabled={saving}
          />
          <span className="settings-modal__help">文件修改后自动运行验证命令检查结果。</span>
        </div>

        {/* diff 自动展开 */}
        <div className="settings-modal__field settings-modal__field--inline">
          <label className="settings-modal__label">Diff 自动展开</label>
          <input
            type="checkbox"
            checked={settings.diffAutoExpand}
            onChange={e => void update('diffAutoExpand', e.target.checked)}
            disabled={saving}
          />
          <span className="settings-modal__help">默认展开文件变更审查区域。</span>
        </div>

        {/* 编辑器字号 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">编辑器字号（px）</label>
          <input
            type="number"
            className="settings-modal__input"
            value={settings.editorFontSize}
            min={8}
            max={32}
            onChange={e => void update('editorFontSize', Number(e.target.value))}
            disabled={saving}
          />
          <span className="settings-modal__help">范围 8~32。</span>
        </div>

        {/* 编辑器字体族 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">编辑器字体族</label>
          <input
            type="text"
            className="settings-modal__input"
            value={settings.editorFontFamily}
            onChange={e => void update('editorFontFamily', e.target.value)}
            disabled={saving}
          />
          <span className="settings-modal__help">CSS font-family 值，多个用逗号分隔。</span>
        </div>

        {/* 主题 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">主题</label>
          <select
            className="settings-modal__input settings-modal__select"
            value={settings.theme}
            onChange={e => void update('theme', e.target.value as NovaSettingsDto['theme'])}
            disabled={saving}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
          <span className="settings-modal__help">界面主题外观。</span>
        </div>

        {error && <div className="settings-modal__error">{error}</div>}
        {saved && <div className="settings-modal__help" style={{ color: '#2e7d32' }}>已保存</div>}
      </div>
    </div>
  )
}
