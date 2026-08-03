import React from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { FolderIcon } from '../../components/Icons'
import { IconButton } from '@astryxdesign/core/IconButton'
import './ProjectPicker.css'

export const ProjectPicker: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const selectProject = useSettingsStore(state => state.selectProject)

  return (
    <div className="project-picker-narrow">
      <div className="project-picker-narrow__control">
        <IconButton
          label="选择本地项目工作区"
          icon={<FolderIcon size={20} />}
          variant="ghost"
          size="md"
          className={`project-picker-narrow__btn ${currentProject ? 'project-picker-narrow__btn--active' : ''}`}
          onClick={selectProject}
          tooltip={currentProject ? `当前项目: ${currentProject}\n点击更换工作区` : '选择本地项目工作区'}
        />
        {currentProject && <span className="project-picker-narrow__badge" aria-hidden="true" />}
      </div>
    </div>
  )
}
