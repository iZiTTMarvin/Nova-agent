/**
 * Economy / heavy 提示文案。
 * 仅 headless 注入硬约束；interactive 不注入任何任务策略文案。
 */

export function buildEconomyHardConstraints(): string {
  return [
    'Economy task constraints (must follow):',
    '- Use a single shallow Glob/find; do not use recursive **/* patterns.',
    '- Read at most 2 sample files, and at most 5 lines from each.',
    '- Write one script, run it once, then stop exploring.',
    '- After the output artifact exists, perform at most one light verification.',
    '- Independent verifiers check correctness; your job is to produce the artifact.'
  ].join('\n')
}

export function buildHeavyGuidance(): string {
  return [
    'Heavy task guidance:',
    'Prefer a structured loop: inventory → runnable artifact → public check',
    '→ repair_or_continue → semantic self-check → finish.',
    'Trust public command/test output over self-reported status.'
  ].join(' ')
}
