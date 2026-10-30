import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

import { invokeMain } from '../../../src/preload/remoteInvoke'

describe('preload 调用主进程的错误透出', () => {
  it.each([
    ["Error invoking remote method 'learning:command': Error: learning: text 长度无效", 'learning: text 长度无效'],
    ["Error invoking remote method 'load-session': TypeError: 会话 s1 不存在", '会话 s1 不存在'],
    ["Error invoking remote method 'workspace:get': 原因只有字符串", '原因只有字符串'],
    ['IPC 调用被拒绝：来源不可信', 'IPC 调用被拒绝：来源不可信']
  ])('渲染层只看到主进程给出的原因：%s', async (raw, expected) => {
    invoke.mockRejectedValueOnce(new Error(raw))
    await expect(invokeMain('channel')).rejects.toThrow(new Error(expected))
  })

  it('成功结果与参数原样透传', async () => {
    invoke.mockResolvedValueOnce({ ok: true })
    await expect(invokeMain('skill:delete', 'a')).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenLastCalledWith('skill:delete', 'a')
  })
})
