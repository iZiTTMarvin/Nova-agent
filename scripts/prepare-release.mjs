import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(`[release] ${message}`)
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) fail(`无法识别参数: ${argument}`)

    const separator = argument.indexOf('=')
    const key = separator === -1 ? argument.slice(2) : argument.slice(2, separator)
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1)
    if (!value || value.startsWith('--')) fail(`参数 --${key} 需要值`)
    options[key] = value
  }
  return options
}

function canonicalHeading(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[\x60*_]/g, '')
    .replace(/^v/i, '')
    .trim()
}

function isVersionHeading(text, version) {
  const heading = canonicalHeading(text)
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escapedVersion}(?:$|\\s|[-(])`).test(heading)
}

function isHeading(line) {
  const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line)
  return match ? { level: match[1].length, text: match[2] } : null
}

function findSection(lines, predicate) {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = isHeading(lines[index])
    if (!heading || !predicate(heading)) continue

    let end = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextHeading = isHeading(lines[next])
      if (nextHeading && nextHeading.level <= heading.level) {
        end = next
        break
      }
    }

    const body = lines.slice(index + 1, end).join('\n').trim()
    if (body) return body
  }
  return null
}

function extractReleaseNotes(changelog, version) {
  const lines = changelog.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const versionHeading = findSection(lines, (heading) =>
    heading.level === 2 && isVersionHeading(heading.text, version),
  )
  const unreleasedHeading = findSection(lines, (heading) => {
    if (heading.level !== 2) return false
    const normalized = heading.text
      .replace(/[\x60*_]/g, '')
      .trim()
      .toLocaleLowerCase()
    return ['unreleased', 'next', 'next release', '未发布', '下个版本'].includes(normalized)
  })

  let body = versionHeading ?? unreleasedHeading

  if (!body) {
    const changelogTitle = lines.findIndex((line) => {
      const heading = isHeading(line)
      return heading?.level === 1 && /^changelog$/i.test(heading.text.trim())
    })
    if (changelogTitle > 0) {
      const firstSection = lines
        .slice(0, changelogTitle)
        .findIndex((line) => isHeading(line)?.level === 2)
      if (firstSection >= 0) {
        body = lines.slice(firstSection, changelogTitle).join('\n').trim()
      }
    }
  }

  if (!body) body = findSection(lines, (heading) => heading.level === 2)
  if (!body) {
    fail(`CHANGELOG.md 中没有 ${version} 的版本段或可用的未发布更新内容`)
  }

  return `## v${version} 更新日志\n\n${body}`
}

function resolveOutputPath(value) {
  return resolve(root, value)
}

function appendGithubOutputs(path, values) {
  if (!path) return
  appendFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    'utf8',
  )
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  const tagInput = options.tag ?? process.env.GITHUB_REF_NAME
  if (!tagInput) fail('缺少 --tag，或 GITHUB_REF_NAME 未设置')

  const tag = tagInput.trim().replace(/^refs\/tags\//, '')
  const packagePath = resolve(root, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`package.json version 不是有效的发布版本: ${version || '(空)'}`)
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`发布 tag 必须是 vX.Y.Z 格式: ${tag}`)
  }
  if (tag !== `v${version}`) {
    fail(`发布 tag ${tag} 与 package.json version ${version} 不一致`)
  }

  const changelogPath = resolve(root, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) fail('缺少 CHANGELOG.md')
  const notes = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version)
  if (!options.output) fail('缺少 --output，必须显式指定更新说明输出文件')
  const outputPath = resolveOutputPath(options.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${notes}\n`, 'utf8')

  appendGithubOutputs(options['github-output'], {
    tag,
    version,
    release_notes_path: outputPath,
  })

  console.log(`[release] 已校验 ${tag}，更新说明写入 ${outputPath}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
