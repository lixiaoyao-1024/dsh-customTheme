// Inlines the packaged wallpapers into client.js as data URLs so no HTTP route
// (and no auth) is needed. Two slots:
//   bg.webp       -> DEFAULT_IMAGE (the active default, currently the animated aurora)
//   bg-anime.webp -> ANIME_IMAGE   (the original static art, offered as a built-in choice)
// Run after replacing either file:  node .dev/inline-bg.mjs
import { readFile, writeFile } from 'node:fs/promises'

const target = new URL('../client.js', import.meta.url)

const SLOTS = [
  { marker: 'inline-bg', file: new URL('../assets/backgrounds/bg.webp', import.meta.url), variable: 'DEFAULT_IMAGE' },
  { marker: 'inline-anime', file: new URL('../assets/backgrounds/bg-anime.webp', import.meta.url), variable: 'ANIME_IMAGE' },
]

const chunksOf = (url) => {
  const chunks = []
  for (let at = 0; at < url.length; at += 800) chunks.push(url.slice(at, at + 800))
  return chunks
}

let text = await readFile(target, 'utf8')
for (const slot of SLOTS) {
  let bytes
  try {
    bytes = await readFile(slot.file)
  } catch (error) {
    console.log('skip ' + slot.variable + ' (missing ' + slot.file.pathname + ')')
    continue
  }
  const url = 'data:image/webp;base64,' + bytes.toString('base64')
  const literal =
    'const ' + slot.variable + ' =\n      ' + chunksOf(url).map((chunk) => "'" + chunk + "'").join(' +\n      ')
  const pattern = new RegExp('/\\* @' + slot.marker + ':start[^\\n]*\\*/[\\s\\S]*?/\\* @' + slot.marker + ':end \\*/')
  if (!pattern.test(text)) throw new Error('markers for ' + slot.marker + ' not found in client.js')
  text = text.replace(
    pattern,
    '/* @' + slot.marker +
      ':start (generated from assets/backgrounds/' + slot.file.pathname.split('/').pop() + ') */\n    ' +
      literal +
      '\n    /* @' + slot.marker + ':end */',
  )
  console.log(slot.variable + ': ' + bytes.length + ' bytes -> ' + chunksOf(url).length + ' chunks')
}

await writeFile(target, text, 'utf8')
