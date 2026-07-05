/**
 * better-sqlite3 原生实现（仅 Electron 主进程实例化，勿在 Vitest 默认套件 import）。
 */

import Database from 'better-sqlite3'
import type { MemoryDb, MemoryDbStatement } from './MemoryDb'

/** 将 better-sqlite3 Statement 适配为 MemoryDbStatement */
class BetterSqliteStatement implements MemoryDbStatement {
  constructor(private readonly stmt: Database.Statement) {}

  run(...params: unknown[]): { changes: number } {
    const info = this.stmt.run(...params)
    return { changes: info.changes }
  }

  get<T = unknown>(...params: unknown[]): T | undefined {
    return this.stmt.get(...params) as T | undefined
  }

  all<T = unknown>(...params: unknown[]): T[] {
    return this.stmt.all(...params) as T[]
  }
}

/**
 * MemoryDb 的 better-sqlite3 实现骨架。
 * P1 将在此扩展 search / upsert 等记忆业务方法。
 */
export class BetterSqliteMemoryDb implements MemoryDb {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
  }

  get sqliteVersion(): string {
    const row = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return row.v
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): MemoryDbStatement {
    return new BetterSqliteStatement(this.db.prepare(sql))
  }

  close(): void {
    this.db.close()
  }
}
