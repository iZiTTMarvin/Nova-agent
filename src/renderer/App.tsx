import { useState } from 'react'
import { PING } from '../shared/ipc/channels'

/**
 * 应用根组件
 * S2 阶段加入 ping/pong 验证按钮，确认 IPC 链路通畅
 */
function App(): JSX.Element {
  const [pingResult, setPingResult] = useState<string>('')

  const handlePing = async () => {
    const result = await window.api.invoke(PING)
    setPingResult(result)
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      gap: '16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      <h1 style={{ fontSize: '2rem', color: '#333' }}>Hello Nova</h1>
      <button onClick={handlePing} style={{ padding: '8px 16px', cursor: 'pointer' }}>
        Ping
      </button>
      {pingResult && (
        <p style={{ color: '#666' }}>IPC 响应: {pingResult}</p>
      )}
    </div>
  )
}

export default App
