// Minimal asar reader for the installed DSH app (read-only).
// usage: node tools/asar.cjs list [prefix] | cat <file> | grep <regex> [limit]
const fs = require('fs')

const ASAR = process.env.DSH_ASAR || 'D:/software/dsh/resources/app.asar'
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const hb = Buffer.alloc(jsonLen)
fs.readSync(fd, hb, 0, jsonLen, 16)
let header
try {
  header = JSON.parse(hb.toString('utf8'))
} catch (error) {
  console.error('header parse failed at length ' + jsonLen + ': ' + String(error).slice(0, 200))
  process.exit(1)
}
const base = 16 + jsonLen

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, offset: entry.offset, size: entry.size })
  }
  return out
}
const entries = walk(header, '', [])

function readFile(entry) {
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
  return buf
}

function decode(buf) {
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le' }
  if (buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), enc: 'utf8bom' }
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  let zeros = 0
  for (const byte of sample) if (byte === 0) zeros++
  if (sample.length > 8 && zeros > sample.length / 3) return { text: buf.toString('utf16le').replace(/^./, ''), enc: 'utf16le-guess' }
  return { text: buf.toString('utf8'), enc: 'utf8' }
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'list') {
  const sel = entries.filter((e) => !arg || e.path.startsWith(arg))
  for (const e of sel.slice(0, 400)) console.log(e.size + '\t' + e.path)
  console.error('total ' + sel.length)
} else if (cmd === 'cat') {
  const e = entries.find((x) => x.path === arg)
  if (!e) { console.error('not found: ' + arg); process.exit(1) }
  process.stdout.write(decode(readFile(e)).text)
} else if (cmd === 'save') {
  const e = entries.find((x) => x.path === process.argv[3])
  if (!e) { console.error('not found: ' + process.argv[3]); process.exit(1) }
  fs.writeFileSync(process.argv[4], decode(readFile(e)).text, 'utf8')
  console.error('saved ' + process.argv[4] + ' (' + e.size + ' bytes)')
} else if (cmd === 'grep') {
  const re = new RegExp(arg, 'i')
  const limit = Number(process.argv[4] || 40)
  let n = 0
  for (const e of entries) {
    if (e.size > 8 * 1024 * 1024) continue
    let text
    try { text = decode(readFile(e)).text } catch { continue }
    if (!re.test(text)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      console.log(e.path + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 240))
      if (++n >= limit) process.exit(0)
    }
  }
  console.error('matches ' + n)
} else {
  console.error('usage: list|cat|grep')
}
