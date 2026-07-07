import React, { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染层根级错误边界：捕获 React 树内未处理异常，避免整页白屏。
 * 会话数据在主进程磁盘上，reload 不会丢失。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 渲染层未捕获异常', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            background: '#fafafa',
            color: '#333'
          }}
        >
          <h2 style={{ marginBottom: 8 }}>界面遇到问题</h2>
          <p style={{ marginBottom: 16, maxWidth: 480, textAlign: 'center', color: '#666' }}>
            {this.state.error.message || '未知错误'}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: 'none',
              background: '#c96442',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            重新加载
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
