import { describe, expect, it } from 'vitest'
import {
  PYTHON_RESOLVER_SIGNATURE,
  PythonResolver
} from '@runtime/code-graph/resolving/PythonResolver'
import { WorkspaceModuleFileIndex } from '@runtime/code-graph/resolving/WorkspaceModuleFileIndex'

describe('PythonResolver', () => {
  it('相对与绝对模块只解析唯一 .py 或 __init__.py', () => {
    const resolver = new PythonResolver(new WorkspaceModuleFileIndex([
      'pkg/service.py',
      'pkg/dep.py',
      'pkg/tools/__init__.py',
      'shared/base.py'
    ]))

    expect(resolver.signature).toBe(PYTHON_RESOLVER_SIGNATURE)
    expect(resolver.resolve('pkg/service.py', '.dep')).toEqual({
      kind: 'resolved',
      path: 'pkg/dep.py',
      resolver: 'python-import'
    })
    expect(resolver.resolve('pkg/service.py', 'pkg.tools')).toEqual({
      kind: 'resolved',
      path: 'pkg/tools/__init__.py',
      resolver: 'python-import'
    })
    expect(resolver.resolve('pkg/service.py', '..shared.base')).toEqual({
      kind: 'resolved',
      path: 'shared/base.py',
      resolver: 'python-import'
    })
  })
})
