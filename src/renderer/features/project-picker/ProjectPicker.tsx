import React from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { FolderIcon } from '../../components/Icons'
import './ProjectPicker.css'

export const ProjectPicker: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const selectProject = useSettingsStore(state => state.selectProject)

  return (
    <div className="project-picker-narrow">
      <button 
        className={`project-picker-narrow__btn ${currentProject ? 'project-picker-narrow__btn--active' : ''}`}
        onClick={selectProject}
        title={currentProject ? `当前项目: ${currentProject}\n点击更换工作区` : '选择本地项目工作区'}
      >
        <FolderIcon size={20} />
        {currentProject && (
          <span className="project-picker-narrow__badge" />
        )}
      </button>
    </div>
  )
}
