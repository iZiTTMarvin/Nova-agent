/**
 * framer-motion 共享 mock：将 motion 组件替换为普通 HTML 元素，AnimatePresence 替换为 Fragment。
 * 用于 renderer 层测试中避免 framer-motion 的 DOM 依赖（document is not defined）。
 *
 * 使用方式：在测试文件顶部添加
 *   vi.mock('framer-motion', () => import('./_framerMotionMock'))
 */
import React from 'react'

export const motion = new Proxy({}, {
  get: (_target, key) => {
    const Comp = React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(key as any, { ref, ...props }, children)
    )
    Comp.displayName = `motion.${String(key)}`
    return Comp
  }
})

export const AnimatePresence = ({ children }: any) => React.createElement(React.Fragment, null, children)
