import { describe, expect, it } from 'vitest'
import {
  decideBrowserNetworkRequest,
  previewOriginsMatch
} from '../../../../src/shared/browser'

describe('预览 origin 归一化', () => {
  it('同一 IPv4 的不同字面量收成一个 origin，三种 loopback 写法和不同端口互不授权', () => {
    expect(previewOriginsMatch('http://127.1:5173/a', 'http://127.0.0.1:5173/')).toBe(true)
    expect(previewOriginsMatch('http://0x7f.0.0.1:5173/', 'http://127.0.0.1:5173/')).toBe(true)
    expect(previewOriginsMatch('http://[0:0:0:0:0:0:0:1]:5173/', 'http://[::1]:5173/')).toBe(true)
    expect(previewOriginsMatch('http://localhost:5173/', 'http://127.0.0.1:5173/')).toBe(false)
    expect(previewOriginsMatch('http://127.0.0.1:5173/', 'http://[::1]:5173/')).toBe(false)
    expect(previewOriginsMatch('http://localhost:5173/', 'http://[::1]:5173/')).toBe(false)
    expect(previewOriginsMatch('http://127.0.0.1:5173/', 'http://127.0.0.1:5174/')).toBe(false)
    expect(previewOriginsMatch('http://127.0.0.1/', 'http://127.0.0.1:80/')).toBe(true)
  })

  it('公网页面不能借用预览授权访问私网、元数据或另一种 loopback', () => {
    const granted = ['http://127.0.0.1:5173']
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://10.0.0.8/secret',
      initiatorOrigin: 'https://example.com',
      resourceType: 'xhr',
      grantedOrigins: granted
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://169.254.169.254/latest',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'xhr',
      grantedOrigins: granted
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://localhost:5173/',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'script',
      grantedOrigins: granted
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://127.0.0.1:5174/hmr',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'xhr',
      grantedOrigins: [...granted, 'http://127.0.0.1:5174']
    })).toBe('deny')
  })

  it('已确认预览可以访问自己的资源和对应 HMR，危险 scheme 与重定向后的私网请求被拒绝', () => {
    const granted = ['http://127.0.0.1:5173']
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://127.0.0.1:5173/src/main.tsx',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'script',
      grantedOrigins: granted
    })).toBe('allow')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'ws://127.0.0.1:5173/',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'webSocket',
      grantedOrigins: granted
    })).toBe('allow')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'file:///C:/secret.txt',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'image',
      grantedOrigins: granted
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://192.168.1.20/redirected',
      initiatorOrigin: 'https://example.com',
      resourceType: 'script',
      grantedOrigins: granted
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'https://cdn.example.com/app.js',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'script',
      grantedOrigins: granted
    })).toBe('allow')
  })
})
