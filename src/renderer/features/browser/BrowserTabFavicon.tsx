/**
 * 标签 favicon：直接引用 guest 投影的 URL，加载失败或被拦截时降为地球占位。
 */
import { useState, type ReactNode } from 'react'
import { GlobeIcon } from '../../components/Icons'

export function BrowserTabFavicon(props: {
  faviconUrl: string | null
}): ReactNode {
  const { faviconUrl } = props
  if (!faviconUrl) {
    return <GlobeIcon size={14} className="browser-panel__tab-favicon-fallback" aria-hidden />
  }
  return <BrowserTabFaviconImage key={faviconUrl} faviconUrl={faviconUrl} />
}

function BrowserTabFaviconImage(props: { faviconUrl: string }): ReactNode {
  const { faviconUrl } = props
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <GlobeIcon size={14} className="browser-panel__tab-favicon-fallback" aria-hidden />
  }
  return (
    <img
      className="browser-panel__tab-favicon"
      data-testid="browser-tab-favicon"
      src={faviconUrl}
      alt=""
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
