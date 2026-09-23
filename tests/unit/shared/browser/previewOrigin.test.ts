import { describe, expect, it } from 'vitest'
import {
  classifyPreviewHostname,
  decideBrowserNetworkRequest,
  previewOriginsMatch,
  type PreviewHostResolver
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
      targetUrl: 'http://127.0.0.1:5173/submit',
      initiatorOrigin: 'https://example.com',
      resourceType: 'mainFrame',
      grantedOrigins: granted
    })).toBe('deny')
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

  it('尾点写法不再绕过限制：localhost. 与 127.0.0.1. 仍按本机受限处理', () => {
    expect(classifyPreviewHostname('localhost.')).toBe('loopback')
    expect(classifyPreviewHostname('LOCALHOST')).toBe('loopback')
    expect(classifyPreviewHostname('127.0.0.1.')).toBe('loopback')
    expect(classifyPreviewHostname('metadata.google.internal.')).toBe('metadata')
    // 空授权下尾点 loopback 的主文档与子资源都不能借公网通道
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://localhost.:5173/',
      initiatorOrigin: null,
      resourceType: 'mainFrame',
      grantedOrigins: []
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://localhost.:5173/app.js',
      initiatorOrigin: 'http://127.0.0.1:5173',
      resourceType: 'script',
      grantedOrigins: ['http://127.0.0.1:5173']
    })).toBe('deny')
  })

  it('域名按解析结果分类：私网受限、元数据拒绝、失败拒绝、多地址不挑公网', () => {
    const table: Record<string, readonly string[] | null> = {
      'dev.internal.test': ['192.168.1.5'],
      'loopback-alias.test': ['127.0.0.1'],
      'meta-alias.test': ['169.254.169.254'],
      'mixed.test': ['93.184.216.34', '10.0.0.9'],
      'public.test': ['93.184.216.34'],
      'broken.test': null
    }
    const resolveHost: PreviewHostResolver = (hostname) => table[hostname]
    const base = {
      initiatorOrigin: null as string | null,
      grantedOrigins: [] as readonly string[],
      resolveHost
    }
    // 未提供解析信息的域名保持主机名字面分类（公网），与既有纯函数行为一致
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://dev.internal.test:3000/',
      resourceType: 'mainFrame',
      initiatorOrigin: null,
      grantedOrigins: []
    })).toBe('allow')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://dev.internal.test:3000/',
      resourceType: 'mainFrame',
      ...base
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://mixed.test:3000/',
      resourceType: 'mainFrame',
      ...base
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://meta-alias.test/latest',
      resourceType: 'xhr',
      initiatorOrigin: 'http://127.0.0.1:5173',
      grantedOrigins: ['http://127.0.0.1:5173'],
      resolveHost
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://broken.test/app.js',
      resourceType: 'script',
      initiatorOrigin: 'https://example.com',
      grantedOrigins: [],
      resolveHost
    })).toBe('deny')
    // 零地址与解析失败同样拒绝，不当作公网放行
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://empty.test/',
      resourceType: 'mainFrame',
      initiatorOrigin: null,
      grantedOrigins: [],
      resolveHost: (hostname) => (hostname === 'empty.test' ? [] : undefined)
    })).toBe('deny')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://public.test/app.js',
      resourceType: 'script',
      initiatorOrigin: 'https://example.com',
      grantedOrigins: [],
      resolveHost
    })).toBe('allow')
  })

  it('已授权的域名预览能加载自己的资源与 HMR；授权身份不跨 origin 继承', () => {
    const resolveHost: PreviewHostResolver = (hostname) =>
      hostname === 'dev.internal.test' ? ['192.168.1.5'] : undefined
    const granted = ['http://dev.internal.test:3000']
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://dev.internal.test:3000/',
      resourceType: 'mainFrame',
      initiatorOrigin: null,
      grantedOrigins: granted,
      resolveHost
    })).toBe('allow')
    expect(decideBrowserNetworkRequest({
      targetUrl: 'ws://dev.internal.test:3000/hmr',
      resourceType: 'webSocket',
      initiatorOrigin: 'http://dev.internal.test:3000',
      grantedOrigins: granted,
      resolveHost
    })).toBe('allow')
    // 即使另一个域名解析到同类本机地址，也不是同一个 origin，不能借用授权
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://loopback-alias.test:3000/x',
      resourceType: 'script',
      initiatorOrigin: 'http://dev.internal.test:3000',
      grantedOrigins: granted,
      resolveHost: (hostname) => hostname === 'dev.internal.test'
        ? ['192.168.1.5']
        : hostname === 'loopback-alias.test' ? ['127.0.0.1'] : undefined
    })).toBe('deny')
    // 发起方是未授权的公网页面时，即使目标域名解析到私网也拒绝
    expect(decideBrowserNetworkRequest({
      targetUrl: 'http://dev.internal.test:3000/x',
      resourceType: 'xhr',
      initiatorOrigin: 'https://example.com',
      grantedOrigins: granted,
      resolveHost
    })).toBe('deny')
  })
})
