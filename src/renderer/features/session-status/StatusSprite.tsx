import React from 'react'

/** 空闲显示活动脉冲，运行中显示旋转进度，全部完成显示勾选。 */
export function StatusSprite({ awake, running, complete }: { awake: number; running: boolean; complete: boolean }) {
  return (
    <span className="status-sprite" data-running={running} data-complete={complete} aria-hidden="true">
      <svg
        key={awake}
        className={awake > 0 ? 'status-sprite__drawing status-sprite__drawing--wake' : 'status-sprite__drawing'}
        viewBox="0 0 16 16"
        fill="none"
      >
        {(running || complete) && <circle className="status-sprite__body" cx="8" cy="8" r="5.75" />}
        <g className="status-sprite__face">
          {complete ? (
            <path d="M5.5 8.1 7.2 9.8 10.6 6.3" />
          ) : running ? (
            <path d="M8 2.25A5.75 5.75 0 0 1 13.75 8" />
          ) : (
            <path d="M1.5 8h2.7l1.7-4 3.1 8 1.8-4h2.7" />
          )}
        </g>
      </svg>
    </span>
  )
}
