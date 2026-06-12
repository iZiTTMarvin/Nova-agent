/**
 * SkillImportBar — zip 选择 / 拖拽 / URL 导入（Task 8）
 */
import React, { useCallback, useState } from 'react'
import type { SkillCreateLocation } from '../../../shared/skills/types'
import { skillsI18n } from './i18n'
import './CreateSkillDialog.css'
import './SkillImportBar.css'

interface SkillImportBarProps {
  hasProject: boolean
  onImported: (name: string) => void
}

export const SkillImportBar: React.FC<SkillImportBarProps> = ({ hasProject, onImported }) => {
  const [location, setLocation] = useState<SkillCreateLocation>('global')
  const [url, setUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runImport = useCallback(
    async (input: { zipPath?: string; url?: string }) => {
      if (location === 'project' && !hasProject) {
        setError(skillsI18n.createNeedProject)
        return
      }

      setBusy(true)
      setError(null)
      setStatus(skillsI18n.importing)

      try {
        const imported = await window.nova.skill.import({
          ...input,
          location
        })
        await window.nova.skill.reload()
        setStatus(skillsI18n.importSuccess(imported.name))
        setUrl('')
        onImported(imported.name)
      } catch (err) {
        setError((err as Error).message)
        setStatus(null)
      } finally {
        setBusy(false)
      }
    },
    [hasProject, location, onImported]
  )

  const handlePickZip = async () => {
    const zipPath = await window.nova.skill.pickImportFile()
    if (zipPath) {
      await runImport({ zipPath })
    }
  }

  const handleUrlImport = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    await runImport({ url: trimmed })
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return

    // Electron 拖拽文件带 path
    const filePath = (file as File & { path?: string }).path
    if (!filePath?.toLowerCase().endsWith('.zip')) {
      setError(skillsI18n.importZipOnly)
      return
    }
    await runImport({ zipPath: filePath })
  }

  return (
    <section className="skill-import-bar">
      <div className="skill-import-bar__location">
        <span className="settings-modal__label">{skillsI18n.importLocationLabel}</span>
        <div className="skill-dialog__template-row">
          <button
            type="button"
            className={`skill-dialog__template-btn ${location === 'global' ? 'skill-dialog__template-btn--active' : ''}`}
            onClick={() => setLocation('global')}
            disabled={busy}
          >
            {skillsI18n.createLocationGlobal}
          </button>
          <button
            type="button"
            className={`skill-dialog__template-btn ${location === 'project' ? 'skill-dialog__template-btn--active' : ''}`}
            onClick={() => setLocation('project')}
            disabled={busy || !hasProject}
          >
            {skillsI18n.createLocationProject}
          </button>
        </div>
      </div>

      <div
        className={`skill-import-bar__dropzone ${dragOver ? 'skill-import-bar__dropzone--active' : ''}`}
        onDragOver={e => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => void handleDrop(e)}
      >
        <p className="skill-import-bar__hint">{skillsI18n.importDropHint}</p>
        <button
          type="button"
          className="settings-panel__ghost-btn"
          onClick={() => void handlePickZip()}
          disabled={busy}
        >
          {skillsI18n.importPickZip}
        </button>
      </div>

      <form className="skill-import-bar__url" onSubmit={e => void handleUrlImport(e)}>
        <input
          type="url"
          className="settings-modal__input"
          placeholder={skillsI18n.importUrlPlaceholder}
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className="settings-panel__primary-btn"
          disabled={busy || !url.trim()}
        >
          {skillsI18n.importFromUrl}
        </button>
      </form>

      {status && <p className="settings-panel__status">{status}</p>}
      {error && <p className="settings-panel__status settings-panel__status--error">{error}</p>}
    </section>
  )
}
