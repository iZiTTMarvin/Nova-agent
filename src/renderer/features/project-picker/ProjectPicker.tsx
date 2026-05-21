import React from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { FolderIcon } from '../../components/Icons'
import './ProjectPicker.css'

export const ProjectPicker: React.FC = () => {
  const currentProject = useAppStore(state => state.currentProject)
  const selectProject = useAppStore(state => state.selectProject)

  // 提取文件夹名称
  const getFolderName = (pathStr: string) => {
    if (!pathStr) return ''
    // 适配 Windows 和 Unix 路径分隔符
    const parts = pathStr.split(/[/\\]/)
    return parts[parts.length - 1] || pathStr
  }

  return (
    <div className="project-picker">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="project-picker__title">工作区项目</h3>
        {currentProject && (
          <button 
            className="project-picker__btn project-picker__btn--secondary"
            onClick={selectProject}
            title="更换工作区"
          >
            更换
          </button>
        )}
      </div>

      {currentProject ? (
        <div className="project-picker__path-box" title={currentProject}>
          <FolderIcon size={16} style={{ color: 'var(--color-brand)', flexShrink: 0 }} />
          <span className="project-picker__path">
            {getFolderName(currentProject)}
          </span>
        </div>
      ) : (
        <>
          <p className="project-picker__desc">
            尚未选择本地代码库目录。请选择一个工作区以允许 Nova 载入只读工具进行上下文理解。
          </p>
          <button className="project-picker__btn" onClick={selectProject}>
            <FolderIcon size={16} />
            选择本地项目
          </button>
        </>
      )}
    </div>
  )
}
