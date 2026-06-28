/**
 * webSearch 输出解析 — 兼容层 re-export
 * 业务逻辑在 runtime/tools/webSearch/parseOutput.ts 单点维护
 *
 * ⚠️ 维护约束：本文件仅做 re-export，禁止在此引入 Node 依赖或 runtime 具体实现。
 *    parseOutput 须保持纯字符串逻辑，确保 renderer 可安全打包。
 */
export {
  parseWebSearchOutput,
  type ParsedWebSearchOutput
} from '../../runtime/tools/webSearch/parseOutput'
