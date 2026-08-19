/**
 * QuickJS/WASM 模块懒加载单例。使用 singlefile 变体（WASM 内联为 base64），
 * 无外部 .wasm 文件依赖，bundle / worker / 测试环境行为一致。
 */
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import QUICKJS_VARIANT from '@jitl/quickjs-singlefile-cjs-release-sync'

let modulePromise: Promise<QuickJSWASMModule> | null = null

export function loadQuickJsModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(QUICKJS_VARIANT)
  return modulePromise
}
