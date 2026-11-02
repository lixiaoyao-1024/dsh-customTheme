/**
 * Host half of the theme bundle: owns the user's wallpaper files.
 *
 * The desktop window runs on `dsh-app://app/`, and that protocol forwards
 * same-origin requests to this HTTP server with the session cookie, so the
 * browser half can use plain `fetch('/dsh-my-theme/...')` without any token.
 *
 * Files live in `<package>/wallpapers/` — a real folder the user can open,
 * back up or drop pictures into, independent of browser storage.
 *
 * Routes (all under `/dsh-my-theme/`):
 *   GET    list              -> { items: WallpaperItem[], dir }
 *   GET    file/<name>       -> bytes
 *   POST   upload?name=<n>   -> stores the request body, answers { item }
 *   DELETE delete?id=<name>  -> removes one file
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { extname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/* URLs use the trailing slash, but the route table builds `${prefix}/` itself,
   so the registered path must not end with one. */
const PREFIX = '/dsh-my-theme/'
const ROUTE_PATH = '/dsh-my-theme'
const STORE_DIR = fileURLToPath(new URL('./wallpapers/', import.meta.url))
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_VIDEO_BYTES = 160 * 1024 * 1024

const IMAGE_TYPES = new Map([
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
])
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mov', 'video/quicktime'],
])

/** Sniff a supported format from the leading bytes; undefined rejects the upload. */
function sniff(bytes) {
  if (bytes.length < 12) return undefined
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1')
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: '.webp', kind: 'image' }
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return { ext: '.png', kind: 'image' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: '.jpg', kind: 'image' }
  if (ascii(0, 4) === 'GIF8') return { ext: '.gif', kind: 'image' }
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return { ext: '.avif', kind: 'image' }
  if (ascii(0, 2) === 'BM') return { ext: '.bmp', kind: 'image' }
  if (ascii(4, 8) === 'ftyp') return { ext: '.mp4', kind: 'video' }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { ext: '.webm', kind: 'video' }
  if (ascii(0, 4) === 'OggS') return { ext: '.ogv', kind: 'video' }
  return undefined
}

/** Keep a human-readable stem without allowing separators or control characters. */
function safeStem(input) {
  const stem = String(input || '')
    .replace(/\.[^.]*$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 60)
  return stem === '' ? 'wallpaper' : stem
}

/** Resolve one stored file by id, refusing anything that escapes the store. */
function storeFile(id) {
  const name = basename(String(id))
  if (name !== String(id) || name === '.' || name === '..') return undefined
  const ext = extname(name).toLowerCase()
  if (!IMAGE_TYPES.has(ext) && !VIDEO_TYPES.has(ext)) return undefined
  return join(STORE_DIR, name)
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Parse one `bytes=` range against a known size; undefined means "serve all". */
function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return undefined
  let start = match[1] === '' ? undefined : Number(match[1])
  let end = match[2] === '' ? undefined : Number(match[2])
  if (start === undefined && end === undefined) return { invalid: true }
  if (start === undefined) {
    /* suffix range: last N bytes */
    start = Math.max(0, size - end)
    end = size - 1
  } else if (end === undefined || end >= size) {
    end = size - 1
  }
  if (start > end || start >= size) return { invalid: true }
  return { start, end }
}

/**
 * Serve one stored file, honouring `Range` requests: video thumbnails and
 * seeking both depend on partial responses instead of full downloads.
 */
function sendFile(req, res, file) {
  const ext = extname(file).toLowerCase()
  const type = IMAGE_TYPES.get(ext) || VIDEO_TYPES.get(ext)
  if (type === undefined) return writeJson(res, 404, { error: 'not found' })
  return fsp.stat(file).then(
    (stat) => {
      if (!stat.isFile()) return writeJson(res, 404, { error: 'not found' })
      const size = stat.size
      const range = parseRange(req.headers.range, size)
      if (range !== undefined && range.invalid === true) {
        res.writeHead(416, { 'content-range': 'bytes */' + size, 'cache-control': 'no-store' })
        return res.end()
      }
      const headers = {
        'content-type': type,
        'cache-control': 'private, max-age=86400',
        'accept-ranges': 'bytes',
      }
      if (range === undefined) {
        res.writeHead(200, { ...headers, 'content-length': size })
        if (req.method === 'HEAD') return res.end()
        const stream = createReadStream(file)
        stream.on('error', () => res.destroy())
        return stream.pipe(res)
      }
      res.writeHead(206, {
        ...headers,
        'content-length': range.end - range.start + 1,
        'content-range': 'bytes ' + range.start + '-' + range.end + '/' + size,
      })
      if (req.method === 'HEAD') return res.end()
      const stream = createReadStream(file, { start: range.start, end: range.end })
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    },
    () => writeJson(res, 404, { error: 'not found' }),
  )
}

async function listItems() {
  await fsp.mkdir(STORE_DIR, { recursive: true })
  const dirents = await fsp.readdir(STORE_DIR, { withFileTypes: true })
  const items = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    const file = join(STORE_DIR, dirent.name)
    const ext = extname(file).toLowerCase()
    const kind = IMAGE_TYPES.has(ext) ? 'image' : VIDEO_TYPES.has(ext) ? 'video' : undefined
    if (kind === undefined) continue
    const stat = await fsp.stat(file).catch(() => undefined)
    if (stat === undefined) continue
    items.push({
      id: dirent.name,
      name: dirent.name,
      kind,
      size: stat.size,
      mtime: stat.mtimeMs,
      url: PREFIX + 'file/' + encodeURIComponent(dirent.name),
    })
  }
  items.sort((a, b) => b.mtime - a.mtime)
  return items
}

/** Stream the request body into a new file, enforcing the byte cap. */
async function receive(req, limit, target) {
  const out = createWriteStream(target, { flags: 'wx' })
  let total = 0
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      out.destroy()
      reject(error)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) return fail(new Error('file too large'))
      if (!out.write(chunk)) {
        req.pause()
        out.once('drain', () => req.resume())
      }
    })
    req.on('end', () => out.end(resolve))
    req.on('error', fail)
    out.on('error', fail)
  })
  return total
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname
  const method = req.method || 'GET'

  if (method === 'GET' && path === PREFIX + 'list') {
    return writeJson(res, 200, { items: await listItems(), dir: STORE_DIR })
  }

  if ((method === 'GET' || method === 'HEAD') && path.startsWith(PREFIX + 'file/')) {
    const id = decodeURIComponent(path.slice((PREFIX + 'file/').length))
    const file = storeFile(id)
    if (file === undefined) return writeJson(res, 404, { error: 'not found' })
    return sendFile(req, res, file)
  }

  if (method === 'POST' && path === PREFIX + 'upload') {
    /* Stream to a temp file first, then identify it: the body can be 160 MB,
       so nothing is buffered in memory and a rejected file is unlinked. */
    await fsp.mkdir(STORE_DIR, { recursive: true })
    const stamp = Date.now().toString(36)
    const stem = safeStem(url.searchParams.get('name'))
    const temp = join(STORE_DIR, stamp + '-' + stem + '.part')
    let size
    try {
      size = await receive(req, MAX_VIDEO_BYTES, temp)
    } catch (error) {
      await fsp.unlink(temp).catch(() => undefined)
      return writeJson(res, 413, { error: String((error && error.message) || error) })
    }
    const handle = await fsp.open(temp, 'r')
    const head = Buffer.alloc(64)
    await handle.read(head, 0, 64, 0)
    await handle.close()
    const sniffed = sniff(head)
    if (sniffed === undefined) {
      await fsp.unlink(temp).catch(() => undefined)
      return writeJson(res, 415, { error: 'unsupported image or video format' })
    }
    if (sniffed.kind === 'image' && size > MAX_IMAGE_BYTES) {
      await fsp.unlink(temp).catch(() => undefined)
      return writeJson(res, 413, { error: 'image larger than 32 MiB' })
    }
    const name = stamp + '-' + stem + sniffed.ext
    await fsp.rename(temp, join(STORE_DIR, name))
    return writeJson(res, 200, {
      item: { id: name, name, kind: sniffed.kind, size, mtime: Date.now(), url: PREFIX + 'file/' + encodeURIComponent(name) },
    })
  }

  if (method === 'DELETE' && path === PREFIX + 'delete') {
    const id = url.searchParams.get('id') || ''
    const file = storeFile(id)
    if (file === undefined) return writeJson(res, 400, { error: 'invalid id' })
    await fsp.unlink(file).catch(() => undefined)
    return writeJson(res, 200, { ok: true })
  }

  return writeJson(res, 404, { error: 'not found' })
}

const ROUTE = {
  kind: 'prefix',
  path: ROUTE_PATH,
  handler: (req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) writeJson(res, 500, { error: String((error && error.message) || error) })
      else res.destroy()
    })
  },
}

/**
 * Host plugin body. The web server may mount after this plugin, so registration
 * waits for the service instead of reading it once at apply time.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(ROUTE), 'my-theme: wallpaper routes')
  })
}
