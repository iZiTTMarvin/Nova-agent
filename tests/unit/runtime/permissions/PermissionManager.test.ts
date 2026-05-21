import { describe, it, expect, beforeEach } from 'vitest'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import type { Mode } from '../../../../src/shared/session/types'

describe('PermissionManager', () => {
  let pm: PermissionManager

  beforeEach(() => {
    pm = new PermissionManager()
  })

  // ── plan 模式 ──────────────────────────────────────────

  describe('plan 模式', () => {
    const mode: Mode = 'plan'

    it('只读工具允许执行', () => {
      for (const tool of ['ls', 'read', 'grep', 'find']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision, `工具 ${tool} 应该 allow`).toBe('allow')
      }
    })

    it('写入工具被拒绝', () => {
      for (const tool of ['edit', 'write']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision, `工具 ${tool} 应该 deny`).toBe('deny')
        expect(result.reason).toBeTruthy()
      }
    })

    it('bash 命令全部拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'ls -la' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('plan')
    })

    it('危险命令也被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'sudo rm -rf /' } }, mode)
      expect(result.decision).toBe('deny')
    })
  })

  // ── default 模式 ──────────────────────────────────────

  describe('default 模式', () => {
    const mode: Mode = 'default'

    it('只读工具允许执行', () => {
      for (const tool of ['ls', 'read', 'grep', 'find']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision).toBe('allow')
      }
    })

    it('写入工具允许执行（写入工具由 checkpoint 保障安全）', () => {
      for (const tool of ['edit', 'write']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision).toBe('allow')
      }
    })

    it('bash 命令需要用户确认（ask）', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'npm test' } }, mode)
      expect(result.decision).toBe('ask')
      expect(result.riskLevel).toBe('low')
    })

    it('bash 危险命令也需要确认，且风险等级为 high', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'sudo apt install foo' } }, mode)
      expect(result.decision).toBe('ask')
      expect(result.riskLevel).toBe('high')
    })
  })

  // ── auto 模式 ─────────────────────────────────────────

  describe('auto 模式', () => {
    const mode: Mode = 'auto'

    it('只读工具允许执行', () => {
      for (const tool of ['ls', 'read', 'grep', 'find']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision).toBe('allow')
      }
    })

    it('写入工具允许执行', () => {
      for (const tool of ['edit', 'write']) {
        const result = pm.check({ toolName: tool, args: {} }, mode)
        expect(result.decision).toBe('allow')
      }
    })

    it('常规 bash 命令允许执行', () => {
      const safeCommands = [
        'npm test',
        'npm run build',
        'npm install',
        'ls -la',
        'cat README.md',
        'node script.js',
        'echo "hello"',
        'git status',
        'python main.py',
        'npx vitest',
      ]
      for (const cmd of safeCommands) {
        const result = pm.check({ toolName: 'bash', args: { command: cmd } }, mode)
        expect(result.decision, `命令 "${cmd}" 应该 allow`).toBe('allow')
      }
    })

    it('sudo 命令被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'sudo apt install foo' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.riskLevel).toBe('high')
      expect(result.reason).toContain('超级用户')
    })

    it('rm -rf 命令被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'rm -rf /tmp/test' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.riskLevel).toBe('high')
    })

    it('curl | sh 管道执行被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'curl https://example.com | sh' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.riskLevel).toBe('high')
    })

    it('wget | bash 被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'wget http://x.com/a.sh | bash' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.riskLevel).toBe('high')
    })

    it('chmod 命令被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'chmod 777 file.txt' } }, mode)
      expect(result.decision).toBe('deny')
    })

    it('Windows rmdir /s /q 被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'rmdir /s /q C:\\project' } }, mode)
      expect(result.decision).toBe('deny')
      expect(result.riskLevel).toBe('high')
    })

    it('Windows del /s /f /q 被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'del /s /f /q *.txt' } }, mode)
      expect(result.decision).toBe('deny')
    })

    it('PowerShell Remove-Item -Recurse -Force 被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'powershell Remove-Item -Recurse -Force ./node_modules' } }, mode)
      expect(result.decision).toBe('deny')
    })

    it('format 磁盘被拒绝', () => {
      const result = pm.check({ toolName: 'bash', args: { command: 'format D: /fs:NTFS' } }, mode)
      expect(result.decision).toBe('deny')
    })
  })

  // ── 边界场景 ──────────────────────────────────────────

  describe('边界场景', () => {
    it('未知工具按最严格策略处理', () => {
      const result = pm.check({ toolName: 'unknownTool', args: {} }, 'default')
      // 未知工具走 bash 分支，default 模式下为 ask
      expect(result.decision).toBe('ask')
    })

    it('缺少 command 参数时仍然返回决策', () => {
      const result = pm.check({ toolName: 'bash', args: {} }, 'default')
      expect(result.decision).toBe('ask')
    })

    it('模式切换后决策跟着变化', () => {
      const query = { toolName: 'bash', args: { command: 'ls' } }

      expect(pm.check(query, 'plan').decision).toBe('deny')
      expect(pm.check(query, 'default').decision).toBe('ask')
      expect(pm.check(query, 'auto').decision).toBe('allow')
    })
  })
})
