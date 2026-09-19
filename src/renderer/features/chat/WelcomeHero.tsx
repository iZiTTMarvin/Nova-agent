import React from 'react'
import { NovaLogo } from '../../components/Icons'
import './WelcomeHero.css'

/**
 * 主画布空态组件（AgentWelcomeHero）
 * 对标 Cline Desktop 现代无衬线 Typography 与空间几何呼吸感
 */
export const WelcomeHero: React.FC = () => {
  return (
    <>
      {/* 空间感几何细线网格与巨幅星芒 Mascot 水印 */}
      <div className="welcome-hero-bg" aria-hidden>
        <svg
          className="welcome-hero-watermark"
          viewBox="0 0 100 100"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M50 0 C50 25 75 50 100 50 C75 50 50 75 50 100 C50 75 25 50 0 50 C25 50 50 25 50 0 Z" />
          <circle cx="50" cy="50" r="8" opacity="0.4" />
        </svg>
      </div>

      {/* 现代标语与引导提示 */}
      <div className="welcome-hero-content mb-8 flex flex-col items-center justify-center space-y-3">
        <NovaLogo size={44} animating={false} />
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-text-primary">
          说出你的想法，或分配编程任务
        </h1>
        <p className="text-xs md:text-sm text-text-muted mt-1 tracking-normal">
          输入 <kbd className="px-1.5 py-0.5 rounded bg-surface-muted text-[11px] font-mono border border-border-subtle">/</kbd> 唤起能力技能，
          输入 <kbd className="px-1.5 py-0.5 rounded bg-surface-muted text-[11px] font-mono border border-border-subtle">@</kbd> 引用文件
        </p>
      </div>
    </>
  )
}
