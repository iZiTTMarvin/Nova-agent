import React from 'react'

/**
 * 极简状态指示器：空闲为细圆环与中心点，运行中为旋转弧线，全部完成为勾选圆环。
 */
export function StatusSprite({ awake, running, complete }: { awake: number; running: boolean; complete: boolean }) {
  return (
    <span className="status-sprite" data-running={running} data-complete={complete} aria-hidden="true">
      <svg
        key={awake}
        className={awake > 0 ? 'status-sprite__drawing status-sprite__drawing--wake' : 'status-sprite__drawing'}
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle className="status-sprite__body" cx="8" cy="8" r="5.75" />
        <g className="status-sprite__face">
          {complete ? (
            <path d="M5.5 8.1 7.2 9.8 10.6 6.3" />
          ) : running ? (
            <path d="M8 2.25A5.75 5.75 0 0 1 13.75 8" />
          ) : (
            <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
          )}
        </g>
      </svg>
      <span className="status-sprite__dot" />
    </span>
  )
}
