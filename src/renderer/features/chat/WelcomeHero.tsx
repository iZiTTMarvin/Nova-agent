import React, { useRef } from 'react'
import { LEFT_EYE, RIGHT_EYE, useWelcomeMascotGaze } from './useWelcomeMascotGaze'
import './WelcomeHero.css'

/**
 * 空会话主画布：淡网格 + 会看人的星。标语与教程由 Composer 承担，这里不再重复。
 */
export const WelcomeHero: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const leftPupilRef = useRef<SVGGElement>(null)
  const rightPupilRef = useRef<SVGGElement>(null)

  useWelcomeMascotGaze({ rootRef, svgRef, leftPupilRef, rightPupilRef })

  return (
    <>
      <div className="welcome-hero-bg" aria-hidden />
      <div ref={rootRef} className="welcome-mascot-slot" aria-hidden="true">
        <svg
          ref={svgRef}
          className="welcome-mascot"
          viewBox="0 0 128 128"
          focusable="false"
        >
          <path
            className="welcome-mascot__body"
            d="M72 14 C74 11 78 12 78 16 L77 36 C76 44 80 48 88 49 L111 51 C115 51 116 55 112 58 L94 72 C88 76 86 81 88 88 L92 107 C93 111 89 114 86 111 L69 99 C63 94 58 94 51 98 L30 108 C26 110 23 107 25 103 L33 82 C36 75 34 70 28 66 L13 54 C9 51 11 47 15 47 L38 46 C46 46 51 42 55 36 Z"
          />
          <g ref={leftPupilRef} className="welcome-mascot__pupil">
            <ellipse
              className="welcome-mascot__eye"
              cx={LEFT_EYE.x}
              cy={LEFT_EYE.y}
              rx="2.1"
              ry="4.2"
            />
          </g>
          <g ref={rightPupilRef} className="welcome-mascot__pupil">
            <ellipse
              className="welcome-mascot__eye"
              cx={RIGHT_EYE.x}
              cy={RIGHT_EYE.y}
              rx="2.1"
              ry="4.2"
            />
          </g>
        </svg>
      </div>
    </>
  )
}
