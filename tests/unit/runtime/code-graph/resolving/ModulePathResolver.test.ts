import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODULE_PATH_RESOLVER_SIGNATURE,
  ModulePathResolver
} from '@runtime/code-graph/resolving/ModulePathResolver'

describe('ModulePathResolver', () => {
  let tempDir: string | null = null

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('唯一解析相对路径、目录 index 与 TypeScript 的 .js 源码映射', async () => {
    const resolver = await ModulePathResolver.create({
      workspaceRoot: '/workspace',
      workspaceFiles: [
        'src/dep.ts',
        'src/exact.js',
        'src/exact.cjs',
        'src/common.js',
        'src/common.cjs',
        'src/view.tsx',
        'src/pkg/index.ts',
        'src/main.ts'
      ],
      configFiles: []
    })

    expect(resolver.signature).toBe(MODULE_PATH_RESOLVER_SIGNATURE)
    expect(resolver.resolve('src/main.ts', './dep')).toEqual({
      kind: 'resolved',
      path: 'src/dep.ts',
      resolver: 'relative-path'
    })
    expect(resolver.resolve('src/main.ts', './view.js')).toEqual({
      kind: 'resolved',
      path: 'src/view.tsx',
      resolver: 'relative-path'
    })
    expect(resolver.resolve('src/main.ts', './pkg')).toEqual({
      kind: 'resolved',
      path: 'src/pkg/index.ts',
      resolver: 'relative-path'
    })
    expect(resolver.resolve('src/main.ts', './exact.js')).toEqual({
      kind: 'resolved',
      path: 'src/exact.js',
      resolver: 'relative-path'
    })
    expect(resolver.resolve('src/main.ts', './common.cjs')).toEqual({
      kind: 'resolved',
      path: 'src/common.cjs',
      resolver: 'relative-path'
    })
  })

  it('tsconfig paths/baseUrl 只在唯一命中时返回 resolved', async () => {
    const resolver = await ModulePathResolver.create({
      workspaceRoot: '/workspace',
      workspaceFiles: [
        'apps/web/src/main.ts',
        'apps/web/src/lib/cache.ts',
        'apps/web/src/lib/cache/index.ts',
        'shared/log.ts'
      ],
      configFiles: ['apps/web/tsconfig.json'],
      readConfig: async () => ({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@lib/*': ['src/lib/*'],
            '@shared/*': ['../../shared/*']
          }
        }
      })
    })

    expect(resolver.resolve('apps/web/src/main.ts', '@shared/log')).toEqual({
      kind: 'resolved',
      path: 'shared/log.ts',
      resolver: 'tsconfig-paths'
    })
    expect(resolver.resolve('apps/web/src/main.ts', '@lib/cache')).toEqual({
      kind: 'ambiguous',
      candidates: [
        'apps/web/src/lib/cache.ts',
        'apps/web/src/lib/cache/index.ts'
      ],
      reason: 'ambiguous_module',
      resolver: 'tsconfig-paths'
    })
  })

  it('从工作区内安全读取带注释和尾逗号的真实配置', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-module-resolver-'))
    mkdirSync(join(tempDir, 'apps', 'web'), { recursive: true })
    writeFileSync(join(tempDir, 'apps', 'web', 'tsconfig.json'), `{
      // JSONC comments are allowed by TypeScript configs.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@shared/*": ["../shared/*"], },
      },
    }`)

    const resolver = await ModulePathResolver.create({
      workspaceRoot: tempDir,
      workspaceFiles: ['apps/web/main.ts', 'apps/shared/log.ts'],
      configFiles: ['apps/web/tsconfig.json']
    })

    expect(resolver.resolve('apps/web/main.ts', '@shared/log')).toEqual({
      kind: 'resolved',
      path: 'apps/shared/log.ts',
      resolver: 'tsconfig-paths'
    })
  })

  it('project references、条件 imports 与外部包保持 unresolved', async () => {
    const resolver = await ModulePathResolver.create({
      workspaceRoot: '/workspace',
      workspaceFiles: ['app/main.ts', 'shared/index.ts'],
      configFiles: ['app/tsconfig.json'],
      readConfig: async () => ({
        references: [{ path: '../shared' }]
      })
    })

    expect(resolver.resolve('app/main.ts', 'shared')).toMatchObject({
      kind: 'unresolved',
      reason: 'unsupported_project_reference'
    })
    expect(resolver.resolve('app/main.ts', '#internal')).toMatchObject({
      kind: 'unresolved',
      reason: 'unsupported_conditional_export'
    })
    expect(resolver.resolve('app/main.ts', 'react')).toMatchObject({
      kind: 'unresolved',
      reason: 'external_module'
    })
  })

})
