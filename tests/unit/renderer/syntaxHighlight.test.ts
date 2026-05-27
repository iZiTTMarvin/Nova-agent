import { describe, expect, it } from 'vitest'
import { highlightLine, detectLanguage } from '../../../src/renderer/features/diff/syntaxHighlight'

describe('syntaxHighlight', () => {
  describe('detectLanguage', () => {
    it('识别 TypeScript 文件', () => {
      expect(detectLanguage('src/app.ts')).toBe('code')
    })

    it('识别 TSX 文件', () => {
      expect(detectLanguage('src/App.tsx')).toBe('code')
    })

    it('识别 JavaScript 文件', () => {
      expect(detectLanguage('src/app.js')).toBe('code')
    })

    it('识别 JSX 文件', () => {
      expect(detectLanguage('src/App.jsx')).toBe('code')
    })

    it('识别 CSS 文件', () => {
      expect(detectLanguage('src/styles.css')).toBe('code')
    })

    it('识别 HTML 文件', () => {
      expect(detectLanguage('public/index.html')).toBe('code')
    })

    it('识别 JSON 文件', () => {
      expect(detectLanguage('package.json')).toBe('json')
    })

    it('识别 Markdown 文件', () => {
      expect(detectLanguage('README.md')).toBe('markdown')
    })

    it('识别 Shell 脚本', () => {
      expect(detectLanguage('deploy.sh')).toBe('shell')
      expect(detectLanguage('script.bash')).toBe('shell')
      expect(detectLanguage('setup.ps1')).toBe('shell')
    })

    it('未知扩展名返回 plain', () => {
      expect(detectLanguage('file.txt')).toBe('plain')
      expect(detectLanguage('data.csv')).toBe('plain')
    })
  })

  describe('highlightLine', () => {
    it('空文本返回单 token', () => {
      const tokens = highlightLine('', 'file.ts')
      expect(tokens).toEqual([{ text: '', type: 'plain' }])
    })

    it('高亮 TypeScript 关键字', () => {
      const tokens = highlightLine('const x = 1', 'file.ts')
      const keyword = tokens.find(t => t.text === 'const')
      expect(keyword?.type).toBe('keyword')
    })

    it('高亮字符串', () => {
      const tokens = highlightLine('const s = "hello"', 'file.ts')
      const str = tokens.find(t => t.text === '"hello"')
      expect(str?.type).toBe('string')
    })

    it('高亮数字', () => {
      const tokens = highlightLine('const n = 42', 'file.ts')
      const num = tokens.find(t => t.text === '42')
      expect(num?.type).toBe('number')
    })

    it('高亮注释', () => {
      const tokens = highlightLine('// TODO', 'file.ts')
      const comment = tokens.find(t => t.text === '// TODO')
      expect(comment?.type).toBe('comment')
    })

    it('JSON 属性名高亮', () => {
      const tokens = highlightLine('"name": "value"', 'file.json')
      // 在 JSON 中，带引号的属性名被识别为 string token（与原始 DiffViewer 行为一致）
      const prop = tokens.find(t => t.text === '"name"')
      expect(prop?.type).toBe('string')
    })

    it('markdown 标题高亮', () => {
      const tokens = highlightLine('# Title', 'README.md')
      expect(tokens[0].type).toBe('keyword')
    })

    it('markdown 列表高亮', () => {
      const tokens = highlightLine('- item', 'README.md')
      expect(tokens[0].type).toBe('operator')
    })

    it('shell 注释高亮', () => {
      const tokens = highlightLine('#!/bin/bash', 'script.sh')
      const comment = tokens.find(t => t.text === '#!/bin/bash')
      expect(comment?.type).toBe('comment')
    })
  })
})
