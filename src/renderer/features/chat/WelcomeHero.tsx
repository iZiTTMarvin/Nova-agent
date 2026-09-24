import React, { useRef } from 'react'
import { LEFT_EYE, RIGHT_EYE, useWelcomeMascotGaze } from './useWelcomeMascotGaze'
import './WelcomeHero.css'

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
        <svg className="welcome-wordmark" viewBox="0 0 580 244" focusable="false">
          <g transform="translate(454 10) scale(.9) rotate(15 64 64)">
            <svg ref={svgRef} className="welcome-mascot" width="128" height="128" viewBox="0 0 128 128" focusable="false">
              <path
                className="welcome-mascot__body"
                d="M72 14 C74 11 78 12 78 16 L77 36 C76 44 80 48 88 49 L111 51 C115 51 116 55 112 58 L94 72 C88 76 86 81 88 88 L92 107 C93 111 89 114 86 111 L69 99 C63 94 58 94 51 98 L30 108 C26 110 23 107 25 103 L33 82 C36 75 34 70 28 66 L13 54 C9 51 11 47 15 47 L38 46 C46 46 51 42 55 36 Z"
              />
              <g ref={leftPupilRef} className="welcome-mascot__pupil">
                <ellipse className="welcome-mascot__eye" cx={LEFT_EYE.x} cy={LEFT_EYE.y} rx="2.4" ry="4.3" />
              </g>
              <g ref={rightPupilRef} className="welcome-mascot__pupil">
                <ellipse className="welcome-mascot__eye" cx={RIGHT_EYE.x} cy={RIGHT_EYE.y} rx="2.4" ry="4.3" />
              </g>
            </svg>
          </g>
          <g className="welcome-wordmark__letters">
            <path d="M20 225V72H50L104 167V72H134V225H104L50 130V225Z" />
            <path fillRule="evenodd" d="M214 68C255 68 278 96 278 148C278 200 255 229 214 229C173 229 150 200 150 148C150 96 173 68 214 68ZM214 100C193 100 182 116 182 148C182 181 193 197 214 197C235 197 246 181 246 148C246 116 235 100 214 100Z" />
            <path d="M290 72H324L358 184L392 72H426L375 225H341Z" />
            <path fillRule="evenodd" d="M424 225L475 72H511L562 225H528L518 192H468L458 225ZM478 161H508L493 113Z" />
          </g>
        </svg>
      </div>
    </>
  )
}
