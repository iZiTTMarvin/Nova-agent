import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from 'node:inspector'

export function writeEvalArtifact(name: string, value: unknown): void {
  const directory = process.env.NOVA_MEMORY_EVAL_OUTPUT_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2))
}

export async function startMemoryProfile(): Promise<() => Promise<void>> {
  if (process.env.NOVA_MEMORY_PROFILE !== '1') return async () => {}
  const session = new Session()
  session.connect()
  const post = (method: string): Promise<unknown> => new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result))
  })
  await post('Profiler.enable')
  await post('Profiler.start')
  return async () => {
    try { writeEvalArtifact('search.cpuprofile', await post('Profiler.stop')) }
    finally { session.disconnect() }
  }
}
