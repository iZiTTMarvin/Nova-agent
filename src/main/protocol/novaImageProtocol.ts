/**
 * nova-image:// 自定义协议注册
 *
 * 渲染层 <img src="nova-image://{sessionId}/{hash}.{ext}"> 加载时，
 * 协议 handler 在主进程读盘并流式返回，避免 base64 进 renderer 堆。
 *
 * 接线约定（index.ts）：
 * 1. registerNovaImageScheme() 必须在 app.whenReady() 之前调用（模块顶层）
 *    —— 否则 registerSchemesAsPrivileged 静默失败，协议不生效
 * 2. registerNovaImageHandler() 在 app.whenReady() 内、createMainWindow() 之前调用
 */
import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { NOVA_IMAGE_SCHEME, type ImageStore } from '../../runtime/storage/ImageStore'

/**
 * 注册 scheme 属性。必须在 app ready 之前调用（模块顶层）。
 * supportFetchAPI：允许 fetch/XHR 访问（<img> 本身不强制需要，但保留兼容）
 * stream：允许响应为流（handler 返回 ReadableStream）
 * standard：按标准 URL 解析（host/path 正确分割）
 */
export function registerNovaImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NOVA_IMAGE_SCHEME,
      privileges: {
        supportFetchAPI: true,
        stream: true,
        standard: true
      }
    }
  ])
}

/**
 * 注册协议 handler。在 app.whenReady() 内、createMainWindow() 之前调用。
 *
 * 流式响应：用 Node 原生 Readable.toWeb 把 createReadStream 转成 Web ReadableStream，
 * 自动处理背压（pull/resume/pause），主进程不一次性持有整张图片。
 * 路径安全：由 ImageStore.resolveUrl 三重校验（sessionId 正则 + 文件名正则 + 前缀比对）。
 */
export function registerNovaImageHandler(imageStore: ImageStore): void {
  protocol.handle(NOVA_IMAGE_SCHEME, async (request) => {
    const resolved = imageStore.resolveUrl(request.url)
    if (!resolved) {
      return new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    }

    let fileStat
    try {
      fileStat = await stat(resolved.filePath)
    } catch {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' })
    }
    if (!fileStat.isFile()) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' })
    }

    // Readable.toWeb 自动处理 Node stream → Web ReadableStream 的背压与错误传播。
    // 类型断言：Node stream/web 的 ReadableStream 与 DOM 的 ReadableStream 运行时是同一全局对象，
    // 仅 TS lib 定义有细微差异（pipeThrough 泛型），此处按 DOM 类型使用。
    const nodeStream = createReadStream(resolved.filePath)
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

    return new Response(webStream, {
      headers: {
        'Content-Type': resolved.mimeType,
        'Cache-Control': 'no-cache'
      }
    })
  })
}
