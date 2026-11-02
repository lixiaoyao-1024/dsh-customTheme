// Probe a client bundle for the surface tokens and dialog semantics it uses.
// usage: node .dev/probe.cjs <bundle.js>
const fs = require('fs')

const file = process.argv[2]
if (!fs.existsSync(file)) {
  console.log('missing ' + file)
  process.exit(0)
}
const text = fs.readFileSync(file, 'utf8')
const tokens = new Set()
for (const match of text.matchAll(/background(?:-color)?:[^;{}]*?var\((--dsw-[a-z0-9-]+)\)/g)) tokens.add(match[1])
console.log('size ' + text.length)
console.log('bg tokens: ' + [...tokens].join(', '))

for (const marker of ['role: "dialog"', "role: 'dialog'", 'aria-modal', 'data-modal', 'backdrop', 'scrim']) {
  const at = text.indexOf(marker)
  if (at === -1) continue
  console.log('--- ' + marker + ' @' + at)
  console.log(text.slice(Math.max(0, at - 260), at + 220).replace(/\s+/g, ' '))
}
