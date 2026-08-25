/**
 * 交互式入口检测单测：命中即「持久会话安全承重墙」的创建时点判定。
 */
import { describe, expect, it } from 'vitest'
import { isInteractiveEntryCommand } from '../../../../../src/runtime/tools/bash'

describe('isInteractiveEntryCommand', () => {
  it('裸 REPL / 交互 shell 命中', () => {
    expect(isInteractiveEntryCommand('python')).toBe(true)
    expect(isInteractiveEntryCommand('python3')).toBe(true)
    expect(isInteractiveEntryCommand('node')).toBe(true)
    expect(isInteractiveEntryCommand('bash')).toBe(true)
    expect(isInteractiveEntryCommand('sh')).toBe(true)
    expect(isInteractiveEntryCommand('zsh')).toBe(true)
    expect(isInteractiveEntryCommand('pwsh')).toBe(true)
    expect(isInteractiveEntryCommand('irb')).toBe(true)
    expect(isInteractiveEntryCommand('lua')).toBe(true)
    expect(isInteractiveEntryCommand('cmd')).toBe(true)
  })

  it('白名单 flag 命中', () => {
    expect(isInteractiveEntryCommand('python -i')).toBe(true)
    expect(isInteractiveEntryCommand('python3 -q')).toBe(true)
    expect(isInteractiveEntryCommand('node --interactive')).toBe(true)
    expect(isInteractiveEntryCommand('zsh -i')).toBe(true)
    expect(isInteractiveEntryCommand('bash -l')).toBe(true)
    expect(isInteractiveEntryCommand('bash --login -i')).toBe(true)
    expect(isInteractiveEntryCommand('python -q -u -B')).toBe(true)
    expect(isInteractiveEntryCommand('pwsh -NoLogo')).toBe(true)
    expect(isInteractiveEntryCommand('pwsh -NoLogo -NoProfile')).toBe(true)
    expect(isInteractiveEntryCommand('cmd /k')).toBe(true)
    expect(isInteractiveEntryCommand('cmd /K')).toBe(true)
    expect(isInteractiveEntryCommand('powershell -NoProfile')).toBe(true)
  })

  it('pwsh/cmd 的非交互形态不命中', () => {
    expect(isInteractiveEntryCommand('pwsh -NonInteractive')).toBe(false)
    expect(isInteractiveEntryCommand('powershell -NonInteractive -Command "ls"')).toBe(false)
    expect(isInteractiveEntryCommand('cmd /c echo hi')).toBe(false)
  })

  it('带脚本 / -c / -Command 参数不命中（命令文本仍受 denylist 约束）', () => {
    expect(isInteractiveEntryCommand('bash -c "npm test"')).toBe(false)
    expect(isInteractiveEntryCommand('sh -c "echo hi"')).toBe(false)
    expect(isInteractiveEntryCommand('python script.py')).toBe(false)
    expect(isInteractiveEntryCommand('node server.js')).toBe(false)
    expect(isInteractiveEntryCommand('pwsh -Command "Get-Process"')).toBe(false)
    expect(isInteractiveEntryCommand('python -c "print(1)"')).toBe(false)
    expect(isInteractiveEntryCommand('python --unknown-flag')).toBe(false)
  })

  it('普通命令与引号内的 REPL 名词不误伤', () => {
    expect(isInteractiveEntryCommand('npm test')).toBe(false)
    expect(isInteractiveEntryCommand('echo "python"')).toBe(false)
    expect(isInteractiveEntryCommand('grep bash README.md')).toBe(false)
    expect(isInteractiveEntryCommand('git commit -m "node fix"')).toBe(false)
    expect(isInteractiveEntryCommand('cat notes.txt')).toBe(false)
  })

  it('复合命令任一段命中即命中', () => {
    expect(isInteractiveEntryCommand('npm test && python')).toBe(true)
    expect(isInteractiveEntryCommand('ls || node')).toBe(true)
    expect(isInteractiveEntryCommand('echo hi; bash -i')).toBe(true)
    expect(isInteractiveEntryCommand('npm test && python script.py')).toBe(false)
  })

  it('环境变量前缀与绝对路径形态', () => {
    expect(isInteractiveEntryCommand('PYTHONUNBUFFERED=1 python -i')).toBe(true)
    expect(isInteractiveEntryCommand('/bin/bash')).toBe(true)
    expect(isInteractiveEntryCommand('"C:/Program Files/PowerShell/7/pwsh.exe"')).toBe(true)
    expect(isInteractiveEntryCommand('/usr/bin/env python script.py')).toBe(false)
    expect(isInteractiveEntryCommand('/bin/bash -c "ls"')).toBe(false)
  })

  it('heredoc 喂脚本的形态不命中', () => {
    expect(isInteractiveEntryCommand('python << EOF')).toBe(false)
    expect(isInteractiveEntryCommand('bash <<\'EOF\'')).toBe(false)
  })

  it('绕过形态同样命中：前缀包装 / 版本化 / 括号 / 重定向 / 内嵌脚本', () => {
    expect(isInteractiveEntryCommand('node -i')).toBe(true)
    expect(isInteractiveEntryCommand('env python')).toBe(true)
    expect(isInteractiveEntryCommand('env VAR=1 bash')).toBe(true)
    expect(isInteractiveEntryCommand('exec bash')).toBe(true)
    expect(isInteractiveEntryCommand('nohup bash')).toBe(true)
    expect(isInteractiveEntryCommand('setsid python')).toBe(true)
    expect(isInteractiveEntryCommand('timeout 600 bash')).toBe(true)
    expect(isInteractiveEntryCommand('nice -n 5 python')).toBe(true)
    expect(isInteractiveEntryCommand('python3.11')).toBe(true)
    expect(isInteractiveEntryCommand('python3.12 -q')).toBe(true)
    expect(isInteractiveEntryCommand('pypy3')).toBe(true)
    expect(isInteractiveEntryCommand('py')).toBe(true)
    expect(isInteractiveEntryCommand('( python )')).toBe(true)
    expect(isInteractiveEntryCommand('(python)')).toBe(true)
    expect(isInteractiveEntryCommand('python<&0')).toBe(true)
    expect(isInteractiveEntryCommand('bash -c "python"')).toBe(true)
    expect(isInteractiveEntryCommand('cmd /c python')).toBe(true)
    expect(isInteractiveEntryCommand('python -')).toBe(true)
    expect(isInteractiveEntryCommand('sqlite3')).toBe(true)
  })

  it('绕过补强不误伤正常命令', () => {
    expect(isInteractiveEntryCommand('env GIT_TRACE=1 git status')).toBe(false)
    expect(isInteractiveEntryCommand('timeout 30 npm test')).toBe(false)
    expect(isInteractiveEntryCommand('nice git commit -m "python fix"')).toBe(false)
    expect(isInteractiveEntryCommand('bash -c "npm test"')).toBe(false)
    expect(isInteractiveEntryCommand('cmd /c echo hi')).toBe(false)
    expect(isInteractiveEntryCommand('python script.py')).toBe(false)
    expect(isInteractiveEntryCommand('sqlite3 data.db ".tables"')).toBe(false)
    expect(isInteractiveEntryCommand('echo "(python)"')).toBe(false)
  })
})
