/**
 * MemoryDb 窄端口：纯逻辑层（FtsQueryBuilder / MemoryReconciler 等）只依赖此接口，
 * 不得在单元测试中 import 原生 better-sqlite3 实现。
 */

/** 预编译语句的最小抽象 */
export interface MemoryDbStatement {
  run(...params: unknown[]): { changes: number }
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

/** 记忆索引底层存储端口（Spike S0 骨架，业务方法在 P1 补齐） */
export interface MemoryDb {
  /** 执行 DDL / 无参 SQL */
  exec(sql: string): void

  /** 预编译 DML / 查询 */
  prepare(sql: string): MemoryDbStatement

  /** 关闭连接并释放文件锁 */
  close(): void

  /** 内置 SQLite 版本字符串，如 "3.45.1" */
  readonly sqliteVersion: string
}
