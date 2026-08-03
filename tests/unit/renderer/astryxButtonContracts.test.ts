import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function listTsxFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listTsxFiles(entryPath)
    return entry.name.endsWith('.tsx') ? [entryPath] : []
  })
}

describe('Astryx Button content contract', () => {
  it('does not use Button as a multi-child layout container', () => {
    const rendererRoot = path.resolve(__dirname, '../../../src/renderer')
    const violations: string[] = []

    for (const filePath of listTsxFiles(rendererRoot)) {
      const sourceText = fs.readFileSync(filePath, 'utf8')
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )

      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'Button') {
          const structuralChildren = node.children.filter(
            child => !ts.isJsxText(child) || child.text.trim().length > 0
          )
          if (structuralChildren.length > 1) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            violations.push(`${path.relative(rendererRoot, filePath)}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }

      visit(sourceFile)
    }

    expect(violations).toEqual([])
  })
})
