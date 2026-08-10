const DEFAULT_MAX_TOOL_ROUNDS = 100

export function resolveHeadlessMaxToolRounds(
  value: string | undefined,
  deadlineSeconds: number | undefined
): number {
  if (value === undefined) {
    return deadlineSeconds === undefined
      ? DEFAULT_MAX_TOOL_ROUNDS
      : Number.POSITIVE_INFINITY
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('--max-tool-rounds 必须是正整数')
  }
  return parsed
}
