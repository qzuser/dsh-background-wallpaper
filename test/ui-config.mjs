// End-to-end: run the real plugin code, exercise the real /config.json route,
// verify ui.buttonPos persistence and validation.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const tmpHome = path.join(os.tmpdir(), 'dsh-wp-ui-' + Date.now())
fs.mkdirSync(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const mod = await import(
  new URL('../lib/index.js', import.meta.url).href
)
const plugin = mod.default

const CFG = '/dsh-wallpaper/config.json'

// ---- minimal ctx stub: only what apply() actually touches ----
const routes = new Map()
const injectHandlers = []

function makeCtx() {
  const ctx = {
    provide() {},
    set() {},
    effect(cb) { const d = cb(); return () => { if (typeof d === 'function') d() } },
    on(ev, cb) { if (ev === 'webserver/index-inject') injectHandlers.push(cb); return () => {} },
    inject(deps, cb) { cb(ctx) },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex() { return () => {} },
      port: 1,
    },
  }
  return ctx
}

plugin.apply(makeCtx())

function callRoute(routePath, opts) {
  const o = opts || {}
  const method = o.method || 'GET'
  const body = o.body === undefined ? null : o.body
  const extraHeaders = o.headers || {}
  return new Promise((resolve) => {
    const route = routes.get(routePath)
    if (!route) return resolve({ status: 404, json: null, note: 'route missing' })
    const req = {
      method,
      headers: { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...extraHeaders },
      on(ev, cb) {
        if (ev === 'data' && body !== null) {
          cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        }
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }
    let status = 0
    const chunks = []
    const res = {
      writeHead(s) { status = s },
      end(payload) {
        if (payload) chunks.push(String(payload))
        let json = null
        try { json = JSON.parse(chunks.join('')) } catch (err) { /* not json */ }
        resolve({ status, json })
      },
      setHeader() {},
    }
    route.handler(req, res)
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''))
}

function getCfg() {
  return callRoute(CFG).then((r) => r.json && r.json.config)
}

function postCfg(config) {
  return callRoute(CFG, { method: 'POST', body: { config }, headers: { origin: 'http://127.0.0.1:3006' } })
}

// 1. default config carries ui.buttonPos = null
{
  const cfg = await getCfg()
  const ui = cfg && cfg.ui
  check('default has ui.buttonPos null', !!ui && ui.buttonPos === null, JSON.stringify(ui))
}

// 2. saving a valid position round-trips
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: { left: 700, top: 120 } }
  await postCfg(next)
  const back = await getCfg()
  const got = JSON.stringify(back.ui.buttonPos)
  check('save+reload keeps pos', got === '{"left":700,"top":120}', got)
}

// 3. fractional coordinates get rounded
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: { left: 700.6, top: 120.4 } }
  await postCfg(next)
  const back = await getCfg()
  const got = JSON.stringify(back.ui.buttonPos)
  check('floats rounded', got === '{"left":701,"top":120}', got)
}

// 4. string coordinates are rejected (become null) instead of polluting config
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: { left: '700', top: '120' } }
  await postCfg(next)
  const back = await getCfg()
  check('string coords rejected', back.ui.buttonPos === null, JSON.stringify(back.ui.buttonPos))
}

// 5. unknown ui fields are stripped
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: { left: 10, top: 20, evil: 'x' }, junk: 1 }
  await postCfg(next)
  const back = await getCfg()
  const got = JSON.stringify(back.ui)
  check('extra fields stripped', got === '{"buttonPos":{"left":10,"top":20},"showButton":false}', got)
}

// 6. Infinity coordinates are rejected
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: { left: null, top: 20 } }
  await postCfg(next)
  const back = await getCfg()
  check('non-finite coord rejected', back.ui.buttonPos === null, JSON.stringify(back.ui.buttonPos))
}

// 7. showButton defaults to false and round-trips
{
  const cur = await getCfg()
  check('showButton defaults false', cur.ui.showButton === false, JSON.stringify(cur.ui))

  const on = JSON.parse(JSON.stringify(cur))
  on.ui = { buttonPos: null, showButton: true }
  await postCfg(on)
  check('showButton true persists', (await getCfg()).ui.showButton === true)

  const off = JSON.parse(JSON.stringify(await getCfg()))
  off.ui = { buttonPos: null, showButton: false }
  await postCfg(off)
  check('showButton false persists', (await getCfg()).ui.showButton === false)
}

// 8. non-boolean showButton falls back to default
{
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.ui = { buttonPos: null, showButton: 'yes' }
  await postCfg(next)
  check('non-boolean showButton coerced to false', (await getCfg()).ui.showButton === false)
}

// 9. unrelated fields survive the ui change
{
  const cfg = await getCfg()
  const ok = cfg.enabled === true
    && Array.isArray(cfg.images)
    && cfg.rotate && typeof cfg.rotate.intervalSec === 'number'
    && cfg.style && cfg.style.light && typeof cfg.style.light.alpha === 'number'
  check('other fields intact', ok, JSON.stringify({ enabled: cfg.enabled, imgs: cfg.images.length, alpha: cfg.style && cfg.style.light && cfg.style.light.alpha }))
}

// 9b. 深浅两套样式：结构、默认、往返、夹取、白名单
{
  const cur = await getCfg()
  const st = cur.style
  check('style 是两套结构', !!st.light && !!st.dark, JSON.stringify(st))
  check('两套默认值不同', st.light.alpha === 0.42 && st.dark.alpha === 0.26,
    `light=${st.light.alpha} dark=${st.dark.alpha}`)

  const on = JSON.parse(JSON.stringify(cur))
  on.style.dark.alpha = 0.5
  await postCfg(on)
  const back = (await getCfg()).style
  check('dark.alpha 往返且不串浅色', back.dark.alpha === 0.5 && back.light.alpha === 0.42, JSON.stringify(back))

  const over = JSON.parse(JSON.stringify(await getCfg()))
  over.style.light.dim = 5
  await postCfg(over)
  check('dim 夹到 <=1', (await getCfg()).style.light.dim === 1, String((await getCfg()).style.light.dim))

  const under = JSON.parse(JSON.stringify(await getCfg()))
  under.style.light.alpha = 0
  await postCfg(under)
  check('alpha 夹到 >=0.05', (await getCfg()).style.light.alpha === 0.05, String((await getCfg()).style.light.alpha))

  const junk = JSON.parse(JSON.stringify(await getCfg()))
  junk.style.light.evil = 'x'
  junk.style.blendMode = 'screen'
  await postCfg(junk)
  const stripped = (await getCfg()).style
  check('style 白名单剔除多余字段',
    stripped.light.evil === undefined && stripped.blendMode === undefined && stripped.blendModeDark === undefined,
    JSON.stringify(Object.keys(stripped)))

  const badFit = JSON.parse(JSON.stringify(await getCfg()))
  badFit.style.light.fit = 'wat'
  await postCfg(badFit)
  check('非法 fit 回落 cover', (await getCfg()).style.light.fit === 'cover', (await getCfg()).style.light.fit)
}

// 10. injection row stays idempotent
{
  const table = []
  for (const h of injectHandlers) h(table)
  for (const h of injectHandlers) h(table)
  check('inject row idempotent (1 row)', table.length === 1 && table[0].kind === 'script', 'rows=' + table.length)
}

const fail = results.filter((r) => !r.ok).length
console.log('\n' + (results.length - fail) + ' passed, ' + fail + ' failed')
fs.rmSync(tmpHome, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
