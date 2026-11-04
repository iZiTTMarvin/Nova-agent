export function splitCells(line: string): string[] {
  const cells = line.split('|').map(cell => cell.trim())
  if (line.trimStart().startsWith('|') && cells[0] === '') cells.shift()
  if (line.trimEnd().endsWith('|') && cells.at(-1) === '') cells.pop()
  return cells
}

export function isTableDivider(cells: readonly string[]): boolean {
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

export function startsMarkdownTable(lines: readonly string[], index: number): boolean {
  const header = lines[index]?.trim() ?? ''
  if (!header.startsWith('|') || !header.endsWith('|')) return false
  const headers = splitCells(header)
  const divider = splitCells(lines[index + 1] ?? '')
  return headers.length === divider.length && isTableDivider(divider)
}
