// 按落地页展示标题（.display 元素与胶片 data-title）取字，向 Google Fonts 请求 Noto Serif SC 子集。
// 用法：仓库根目录执行 `node scripts/subset-landing-font.mjs`；需要联网。
import { readFile, writeFile } from 'node:fs/promises'

const html = await readFile('landing/index.html', 'utf8')
const pieces = []
for (const m of html.matchAll(/<(\w+)[^>]*class="[^"]*\bdisplay\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) pieces.push(m[2])
for (const m of html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)) pieces.push(m[1])
for (const m of html.matchAll(/<b>([\s\S]*?)<\/b>/g)) pieces.push(m[1])
for (const m of html.matchAll(/data-title="([^"]+)"/g)) pieces.push(m[1])

// 只保留 CJK 区段，西文由 STIX Two Text 负责
const text = [...new Set(pieces.join('').replace(/<[^>]+>/g, '').replace(/\s/g, ''))]
  .filter((ch) => ch.charCodeAt(0) > 0x2e7f)
  .join('')
console.log(`chars ${text.length}: ${text}`)

// 不带浏览器 UA 时 Google Fonts 返回 ttf 而不是 woff2
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600&text=${encodeURIComponent(text)}`
const css = await (await fetch(cssUrl, { headers: { 'user-agent': ua } })).text()
const url = css.match(/url\((https:[^)]+)\)/)?.[1]
if (!url) throw new Error(`字体 CSS 中没有找到 woff2 地址：${css}`)

const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
await writeFile('landing/fonts/noto-serif-sc-display.woff2', buf)
console.log(`bytes ${buf.length}`)
