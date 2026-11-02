// Unit checks for the pure half of client.js: palette math, skin validation and
// the luminance guard. Runs in Node with a stubbed browser surface.
//   node .dev/test-client.cjs
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

let captured
const storage = new Map()
const sandbox = {
  console,
  setTimeout,
  Blob: class {},
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  window: {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    __DSH_MY_THEME_TEST__: true,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    indexedDB: {},
    Image: class {},
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  },
  document: {
    createElement: () => ({
      style: {},
      dataset: {},
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
      toBlob: (done) => done(null),
      appendChild() {},
      remove() {},
    }),
    head: { appendChild() {} },
    body: null,
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
  },
}
sandbox.window.document = sandbox.document
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (captured === undefined || captured.id !== '@local/dsh-my-theme') {
  console.error('FAIL loader: factory was not registered')
  process.exit(1)
}

const react = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}
captured.factory((name) => (name === 'react' ? react : {}))

const api = sandbox.window.__dshMyThemeTest
if (api === undefined) {
  console.error('FAIL test hook missing')
  process.exit(1)
}

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) + ' vs ' + JSON.stringify(expected))

/* palette math */
equal('hexToRgb short', api.hexToRgb('#abc'), [170, 187, 204])
equal('hexToRgb long', api.hexToRgb('#fff4f9'), [255, 244, 249])
equal('hexToRgb invalid', api.hexToRgb('rose'), undefined)
equal('tintRgb fallback', api.tintRgb(undefined, 'dark'), [15, 17, 21])
equal('tintRgb uses scheme', api.tintRgb({ light: '#ff0000', dark: '#0000ff' }, 'dark'), [0, 0, 255])

/* skin validation */
const minimal = api.normalizeSkin({ name: '夕港' })
check('normalizeSkin keeps name', minimal !== undefined && minimal.name === '夕港', JSON.stringify(minimal))
check('normalizeSkin defaults alpha', minimal.alpha === 0.5 && minimal.blur === 8, String(minimal.alpha) + '/' + String(minimal.blur))
check('normalizeSkin rejects nameless', api.normalizeSkin({ alpha: 0.3 }) === undefined, 'undefined expected')
check('normalizeSkin clamps', api.normalizeSkin({ name: 'x', alpha: 9, blur: -3, dim: 5 }).alpha === 1, 'alpha clamp')
check('normalizeSkin bad tint falls back', api.normalizeSkin({ name: 'x', tint: { light: 'nope' } }).tint.light === '#fafafc', JSON.stringify(api.normalizeSkin({ name: 'x', tint: { light: 'nope' } }).tint))
const slug = api.normalizeSkin({ name: 'y', id: 'bad id!' })
check('normalizeSkin replaces bad id', /^skin-/.test(slug.id), slug.id)

/* token building */
const tokens = api.buildTokens(0.5, { light: '#fff4f9', dark: '#1b131f' })
equal('canvas alpha is a third of cards', tokens['--dsw-alias-bg-base'].light, 'rgba(255, 244, 249, 0.170)')
equal('cards alpha', tokens['--dsw-alias-bg-layer-1'].light, 'rgba(255, 255, 255, 0.600)')
check('dark base uses dark tint', tokens['--dsw-alias-bg-base'].dark.startsWith('rgba(27, 19, 31'), tokens['--dsw-alias-bg-base'].dark)
check('sixteen surfaces', Object.keys(tokens).length === 16, String(Object.keys(tokens).length))
check('no text token touched', Object.keys(tokens).every((name) => !/label|font/.test(name)), Object.keys(tokens).join(','))

/* luminance guard */
equal('bright gets 30%', api.autoDimFor(0.8), 0.3)
equal('mid gets 12%', api.autoDimFor(0.5), 0.12)
equal('dark gets 2%', api.autoDimFor(0.2), 0.02)
equal('unknown is 0', api.autoDimFor(undefined), 0)

/* state normalization keeps legacy documents working */
const migrated = api.normalize({ bg: 'builtin', preset: 'glass', alpha: 0.3, tint: 'rose' })
check('legacy tint string ignored', typeof migrated.tint === 'object' && migrated.tint.light === '#fff4f9', JSON.stringify(migrated.tint))
check('legacy alpha kept', migrated.alpha === 0.3, String(migrated.alpha))

/* formatting */
equal('bytes small', api.formatBytes(1536), '2 KB')
equal('bytes large', api.formatBytes(3 * 1024 * 1024), '3.0 MB')

/* the official contract list stays in sync with the built-in skins */
check('official tokens counted', api.OFFICIAL_TOKENS.length === 14, String(api.OFFICIAL_TOKENS.length))

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.ok ? '' : ' :: ' + result.detail))
}
/* dynamic background state */
const videoState = api.normalize({ bg: 'bg-1', bgKind: 'video', motion: false, wallpaper: true })
check('video kind kept', videoState.bgKind === 'video', videoState.bgKind)
check('motion off kept', videoState.motion === false, String(videoState.motion))
check('unknown kind is image', api.normalize({ bgKind: 'gif' }).bgKind === 'image', api.normalize({ bgKind: 'gif' }).bgKind)
check('motion defaults on', api.normalize({}).motion === true, String(api.normalize({}).motion))

/* boot smoke test: mount the plugin with stubbed services */
const registered = []
const written = new Map()
sandbox.document.documentElement.style.setProperty = (name, value) => written.set(name, value)
sandbox.document.body = {
  dataset: {},
  hasAttribute: () => false,
  style: { setProperty: () => {}, removeProperty: () => {} },
}
const themeStub = {
  overrideTokens: (source, tokens) => {
    check('overrideTokens shape', typeof source === 'string' && tokens['--dsw-alias-bg-base'] !== undefined, source)
    return () => {}
  },
  getTheme: () => ({ preference: 'system', active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [] }),
}
const localeStub = {
  getLocale: () => ({ active: 'zh' }),
  register: () => () => {},
}
const services = { theme: themeStub, locale: localeStub, slots: { inject: (key, run) => run() } }
const ctxStub = {
  get: (name) => services[name],
  effect: (run) => run(),
  slots: {
    inject: (key, run) => run(),
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  },
}
let bootError
try {
  captured.factory((name) => (name === 'react' ? react : {})).apply(ctxStub)
} catch (error) {
  bootError = error
}
check('plugin mounts', bootError === undefined, bootError !== undefined ? String(bootError && bootError.message) : 'ok')
check('footer entry registered', registered.length === 1 && registered[0].id === 'my-theme', JSON.stringify(registered))
check('wallpaper var written', String(written.get('--dmt-image') || '').startsWith('url("data:image/webp;base64,'), String(written.get('--dmt-image') || '').slice(0, 40))
check('blur var written', written.get('--dmt-blur') === '8px', String(written.get('--dmt-blur')))
check('dim var written', Number(written.get('--dmt-dim')) > 0, String(written.get('--dmt-dim')))

console.log(failed === 0 ? 'all ' + results.length + ' checks passed' : failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
