import * as path from 'node:path'
import {
  WorkspaceModuleFileIndex,
  resolutionFromCandidates,
  type ModulePathResolution
} from './WorkspaceModuleFileIndex'

export const PYTHON_RESOLVER_SIGNATURE = 'deterministic-python-resolver-v1'

/** Python import 只接受唯一的模块文件或包入口，不推断运行时注册行为。 */
export class PythonResolver {
  readonly signature = PYTHON_RESOLVER_SIGNATURE
  private readonly fileIndex: WorkspaceModuleFileIndex

  constructor(fileIndex: WorkspaceModuleFileIndex) {
    this.fileIndex = fileIndex
  }

  resolve(importerPath: string, moduleSpecifier: string): ModulePathResolution {
    let base: string
    if (moduleSpecifier.startsWith('.')) {
      const prefix = moduleSpecifier.match(/^\.+/)?.[0] ?? '.'
      const moduleName = moduleSpecifier.slice(prefix.length)
      let directory = path.posix.dirname(importerPath)
      for (let index = 1; index < prefix.length; index += 1) {
        directory = path.posix.dirname(directory)
      }
      base = path.posix.join(directory, moduleName.replace(/\./g, '/'))
    } else {
      base = moduleSpecifier.replace(/\./g, '/')
    }
    return resolutionFromCandidates(
      this.fileIndex.candidates(base, { extensions: ['.py'], indexName: '__init__' }),
      'python-import'
    )
  }
}
