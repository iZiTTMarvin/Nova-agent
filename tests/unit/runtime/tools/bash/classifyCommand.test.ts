/**
 * bash 破坏性命令分类器单测。
 */
import { describe, expect, it } from 'vitest'
import { isDestructiveBashCommand } from '../../../../../src/runtime/tools/bash/classifyCommand'

describe('isDestructiveBashCommand', () => {
  it('纯读命令判为非破坏性', () => {
    expect(isDestructiveBashCommand('ls -la')).toBe(false)
    expect(isDestructiveBashCommand('cat README.md')).toBe(false)
    expect(isDestructiveBashCommand('grep foo src/')).toBe(false)
    expect(isDestructiveBashCommand('git status')).toBe(false)
    expect(isDestructiveBashCommand('git diff')).toBe(false)
    expect(isDestructiveBashCommand('git log --oneline')).toBe(false)
    expect(isDestructiveBashCommand('pwd')).toBe(false)
    expect(isDestructiveBashCommand('echo hello')).toBe(false)
  })

  it('文件删除 / 移动 / 复制判为破坏性', () => {
    expect(isDestructiveBashCommand('rm -rf dist')).toBe(true)
    expect(isDestructiveBashCommand('mv a.txt b.txt')).toBe(true)
    expect(isDestructiveBashCommand('cp src.txt dst.txt')).toBe(true)
    expect(isDestructiveBashCommand('mkdir build')).toBe(true)
    expect(isDestructiveBashCommand('touch newfile')).toBe(true)
  })

  it('写入重定向判为破坏性', () => {
    expect(isDestructiveBashCommand('echo hello > out.txt')).toBe(true)
    expect(isDestructiveBashCommand('cat in.txt >> log.txt')).toBe(true)
    expect(isDestructiveBashCommand('printf "x" | tee config.json')).toBe(true)
  })

  it('git 写操作判为破坏性', () => {
    expect(isDestructiveBashCommand('git commit -m "x"')).toBe(true)
    expect(isDestructiveBashCommand('git push')).toBe(true)
    expect(isDestructiveBashCommand('git checkout feature')).toBe(true)
    expect(isDestructiveBashCommand('git reset --hard')).toBe(true)
  })

  it('包安装判为破坏性', () => {
    expect(isDestructiveBashCommand('npm install')).toBe(true)
    expect(isDestructiveBashCommand('yarn add lodash')).toBe(true)
    expect(isDestructiveBashCommand('pip install requests')).toBe(true)
  })

  it('管道 / 链式命令中只要有一节破坏性即判为破坏性', () => {
    expect(isDestructiveBashCommand('ls -la && rm temp.txt')).toBe(true)
    expect(isDestructiveBashCommand('cat foo | grep bar; rm out')).toBe(true)
  })

  it('纯读链式命令判为非破坏性', () => {
    expect(isDestructiveBashCommand('ls -la | grep foo')).toBe(false)
    expect(isDestructiveBashCommand('git status && git log')).toBe(false)
  })

  it('PowerShell 写 cmdlet 判为破坏性（Windows 平台覆盖）', () => {
    expect(isDestructiveBashCommand('Set-Content -Path out.txt -Value "x"')).toBe(true)
    expect(isDestructiveBashCommand('Add-Content log.txt "line"')).toBe(true)
    expect(isDestructiveBashCommand('Out-File -FilePath r.txt "data"')).toBe(true)
    expect(isDestructiveBashCommand('Remove-Item -Recurse dist')).toBe(true)
    expect(isDestructiveBashCommand('New-Item -ItemType File x.txt')).toBe(true)
    expect(isDestructiveBashCommand('Move-Item a.txt b.txt')).toBe(true)
    expect(isDestructiveBashCommand('Copy-Item src dst')).toBe(true)
  })

  it('Windows CMD 别名判为破坏性', () => {
    expect(isDestructiveBashCommand('del /q temp.txt')).toBe(true)
    expect(isDestructiveBashCommand('copy a.txt b.txt')).toBe(true)
    expect(isDestructiveBashCommand('move a.txt b.txt')).toBe(true)
    expect(isDestructiveBashCommand('md newdir')).toBe(true)
    expect(isDestructiveBashCommand('rd /s /q temp')).toBe(true)
    expect(isDestructiveBashCommand('ren old.txt new.txt')).toBe(true)
  })

  it('sed -i 原地改写判为破坏性；非 -i 输出到 stdout 不破坏', () => {
    expect(isDestructiveBashCommand('sed -i "s/a/b/g" file.txt')).toBe(true)
    expect(isDestructiveBashCommand('sed --in-place "s/a/b/" f')).toBe(true)
    expect(isDestructiveBashCommand('sed "s/a/b/g" file.txt')).toBe(false)
  })

  it('node / npx / make 可能跑构建改文件，判为破坏性', () => {
    expect(isDestructiveBashCommand('node build.js')).toBe(true)
    expect(isDestructiveBashCommand('npx tsc')).toBe(true)
    expect(isDestructiveBashCommand('make build')).toBe(true)
  })

  it('git branch -D / tag 判为破坏性', () => {
    expect(isDestructiveBashCommand('git branch -D feature')).toBe(true)
    expect(isDestructiveBashCommand('git tag v1.0')).toBe(true)
  })

  it('PowerShell 纯读 cmdlet 不判为破坏性', () => {
    expect(isDestructiveBashCommand('Get-Content README.md')).toBe(false)
    expect(isDestructiveBashCommand('dir')).toBe(false)
  })
})
