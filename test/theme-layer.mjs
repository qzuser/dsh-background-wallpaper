// 深浅两套样式：host 归一化/迁移 + 前端变量分组验证
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const CLIENT = fileURLToPath(new URL('../assets/wallpaper-client.js', import.meta.url))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''))
}

// ══════════════════ Part A：host 端 ══════════════════
const tmpHome = path.join(os.tmpdir(), 'dsh-wp-theme-' + Date.now())
fs.mkdirSync(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const mod = await import(pathToFileURL(HOST).href)
const plugin = mod.default

const CFG = '/dsh-wallpaper/config.json'
const routes = new Map()
const ctx = {
  provide() {}, set() {},
  effect(cb) { const d = cb(); return () => { if (typeof d === 'function') d() } },
  on() { return () => {} },
  inject(deps, cb) { cb(ctx) },
  webServer: {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex() { return () => {} },
    port: 1,
  },
}
plugin.apply(ctx)

function callRoute(routePath, opts) {
  const o = opts || {}
  const body = o.body === undefined ? null : o.body
  return new Promise((resolve) => {
    const route = routes.get(routePath)
    if (!route) return resolve({ status: 404, json: null })
    const req = {
      method: o.method || 'GET',
      headers: { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' },
      on(ev, cb) {
        if (ev === 'data' && body !== null) cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }
    let status = 0
    const chunks = []
    const res = {
      writeHead(s) { status = s },
      end(p) {
        if (p) chunks.push(String(p))
        let json = null
        try { json = JSON.parse(chunks.join('')) } catch (e) { /* ignore */ }
        resolve({ status, json })
      },
      setHeader() {},
    }
    route.handler(req, res)
  })
}
const getCfg = () => callRoute(CFG).then((r) => r.json && r.json.config)
const postCfg = (config) => callRoute(CFG, { method: 'POST', body: { config } })
const saveStyle = async (style) => {
  const cur = await getCfg()
  const next = JSON.parse(JSON.stringify(cur))
  next.style = style
  await postCfg(next)
  return (await getCfg()).style
}

console.log('=== Part A：host 归一化 ===')

// A1 默认两套
{
  const st = (await getCfg()).style
  const ok = st.light.alpha === 0.42 && st.light.dim === 0.10
    && st.dark.alpha === 0.26 && st.dark.dim === 0.06
  check('A1 默认带两套且数值不同', ok, JSON.stringify(st))
}

// A2 老结构 + 全默认 → 换成新默认
{
  const st = await saveStyle({ fit: 'cover', alpha: 0.55, dim: 0.25, blur: 0, darkAlpha: 0.28, opacity: 1 })
  const ok = st.light.alpha === 0.42 && st.light.dim === 0.10 && st.dark.alpha === 0.26 && st.dark.dim === 0.06
  check('A2 老默认值 → 新默认值', ok, JSON.stringify(st))
}

// A3 老结构 + 自定义值 → 保留，深色遮罩按 dim*0.3 落成显式值
{
  const st = await saveStyle({ fit: 'cover', alpha: 0.7, dim: 0.4, blur: 3, darkAlpha: 0.2, opacity: 0.8 })
  const ok = st.light.alpha === 0.7 && st.light.dim === 0.4 && st.light.blur === 3
    && st.dark.alpha === 0.2 && Math.abs(st.dark.dim - 0.12) < 1e-9
  check('A3 自定义值迁移保留', ok, JSON.stringify(st))
}

// A4 越界值夹取
{
  const st = await saveStyle({ light: { alpha: 5, dim: -1, blur: 999, opacity: 0 }, dark: { alpha: 0.001, dim: 2, opacity: 9 } })
  const ok = st.light.alpha === 1 && st.light.dim === 0 && st.light.blur === 40 && st.light.opacity === 0.05
    && st.dark.alpha === 0.05 && st.dark.dim === 1 && st.dark.opacity === 1
  check('A4 两套各自夹取', ok, JSON.stringify(st))
}

// A5 fit 白名单
{
  const st = await saveStyle({ light: { fit: 'bogus' }, dark: { fit: 'contain' } })
  check('A5 fit 白名单', st.light.fit === 'cover' && st.dark.fit === 'contain', JSON.stringify(st))
}

// A6 存回去再读，稳定不变
{
  const st1 = await saveStyle({ light: { fit: 'fill', alpha: 0.33, dim: 0.22, blur: 5, opacity: 0.9 }, dark: { fit: 'contain', alpha: 0.15, dim: 0.04, blur: 2, opacity: 0.7 } })
  const st2 = await saveStyle(st1)
  check('A6 两套结构幂等', JSON.stringify(st1) === JSON.stringify(st2), JSON.stringify(st2))
}

// ══════════════════ Part B：前端 ══════════════════
console.log('\n=== Part B：前端变量分组 ===')

const SCRIPT = fs.readFileSync(CLIENT, 'utf8')

class ClassList {
  constructor() { this.set = new Set() }
  add(...c) { c.forEach((x) => this.set.add(x)) }
  remove(...c) { c.forEach((x) => this.set.delete(x)) }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; on ? this.set.add(c) : this.set.delete(c); return on }
  contains(c) { return this.set.has(c) }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this._style = {}
    this.style = new Proxy(this._style, {
      set(t, k, v) { t[k] = v; return true },
      get(t, k) {
        if (k === 'setProperty') return (kk, vv) => { t[kk] = vv }
        return t[k]
      },
    })
    this.id = ''
    this.dataset = {}
    this.attrs = {}
    this._className = ''
    this.textContent = ''
    this.classList = new ClassList()
    this.parentNode = null
    this.listeners = {}
  }
  get className() { return this._className }
  set className(v) { this._className = v }
  appendChild(c) { if (!c) return c; c.parentNode = this; this.children.push(c); if (c.id) registry.set(c.id, c); return c }
  insertBefore(c, ref) {
    c.parentNode = this
    const i = ref ? this.children.indexOf(ref) : -1
    i < 0 ? this.children.push(c) : this.children.splice(i, 0, c)
    if (c.id) registry.set(c.id, c)
    return c
  }
  get firstChild() { return this.children[0] || null }
  get lastChild() { return this.children[this.children.length - 1] || null }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v) }
  getAttribute(k) { return this.attrs[k] }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  containsId(want) { return this.id === want || this.children.some((c) => c && typeof c.containsId === 'function' && c.containsId(want)) }
  addEventListener(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb) }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  dispatch(ev, arg) { for (const cb of this.listeners[ev] || []) cb(arg || { target: this }) }
  click() { this.dispatch('click') }
  getBoundingClientRect() { return { left: 0, top: 0, width: 40, height: 40, right: 40, bottom: 40 } }
}
let registry = new Map()

// 启动一次前端：注入指定配置，回读 <style> 上写下的变量
async function bootClient(cfg, darkBody) {
  registry = new Map()
  const doc = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: (t) => new El(t),
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    addEventListener() {},
  }
  if (darkBody) doc.body.setAttribute('data-ds-dark-theme', '')
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)

  const win = {
    __dshWallpaperLoaded: false,
    innerWidth: 1200,
    innerHeight: 800,
    _listeners: {},
    addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb) },
    dispatchEvent(ev) { for (const cb of this._listeners[ev.type] || []) cb(ev) },
    Image: class { set src(v) { this._src = v } get src() { return this._src } },
    location: { href: 'http://127.0.0.1:3006/' },
  }
  const fetchStub = (url) => {
    const u = String(url)
    if (u.includes('/config.json')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: JSON.parse(JSON.stringify(cfg)) }) })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, files: [] }) })
  }
  const fn = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'Image', 'console',
    'Promise', 'JSON', 'Math', 'encodeURIComponent', 'String', 'Array', 'Number', 'FileReader', 'setTimeout', 'ResizeObserver',
    SCRIPT,
  )
  fn(win, doc, fetchStub, () => 1, () => {}, win.Image, console, Promise, JSON, Math,
    encodeURIComponent, String, Array, Number, class { readAsDataURL() {} }, (cb, ms) => (ms === 0 ? cb() : 1),
    class { observe() {} disconnect() {} })
  await new Promise((r) => setTimeout(r, 60))
  const tag = registry.get('dsh-wallpaper-style')
  return {
    // 变量必须落在 <html> 上（body 的 var() 才继承得到）
    vars: doc.documentElement._style,
    tagVars: tag ? tag._style : {},
    css: tag ? tag.textContent : '',
    layer: registry.get('dsh-wallpaper-layer'),
    dim: registry.get('dsh-wallpaper-dim'),
    doc,
  }
}

const BASE_IMG = { images: [{ id: 'a1', kind: 'path', src: 'C:/pics/one.jpg', name: 'one.jpg' }], currentId: 'a1' }

// B1 CSS：浅色块 / 深色块各读各的变量
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const light = r.css.includes('--wp-tint:var(--wp-alpha-light,42%)')
  const dark = r.css.includes('--wp-tint-dark:var(--wp-alpha-dark,26%)')
  const stale = /--wp-alpha,55%/.test(r.css)
  check('B1 CSS 浅/深各用一组变量', light && dark && !stale, `light=${light} dark=${dark} stale=${stale}`)
}

// B2 CSS：深色块换深色色源、图层参数也按主题换
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const darkTokens = r.css.includes('bluish-950) var(--wp-tint-dark)')
  const darkLayer = r.css.includes('body[data-ds-dark-theme] #dsh-wallpaper-layer{background-size:var(--wp-fit-dark')
  const darkDim = r.css.includes('body[data-ds-dark-theme] #dsh-wallpaper-dim{opacity:var(--wp-dim-dark')
  check('B2 深色独立 token + 图层参数', darkTokens && darkLayer && darkDim,
    `tokens=${darkTokens} layer=${darkLayer} dim=${darkDim}`)
}

// B3 CSS：关掉壁纸时遮罩必须消失（不再靠内联样式）
{
  const r = await bootClient({ enabled: false, ...BASE_IMG, style: {} })
  const rule = r.css.includes('html:not(.dsh-wallpaper-on) #dsh-wallpaper-dim{opacity:0}')
  const noInline = !r.dim || r.dim._style.opacity === undefined
  check('B3 关闭态靠 class 归零', rule && noInline, `rule=${rule} inline=${r.dim && r.dim._style.opacity}`)
}

// B4 显式两套配置 → 变量各归各的
{
  const r = await bootClient({
    enabled: true, ...BASE_IMG,
    style: { light: { fit: 'contain', alpha: 0.9, dim: 0.3, blur: 6, opacity: 0.8 },
      dark: { fit: 'fill', alpha: 0.1, dim: 0.05, blur: 2, opacity: 0.6 } },
  })
  const v = r.vars
  const ok = v['--wp-alpha-light'] === '90%' && v['--wp-alpha-dark'] === '10%'
    && v['--wp-dim-light'] === '0.3' && v['--wp-dim-dark'] === '0.05'
    && v['--wp-fit-light'] === 'contain' && v['--wp-fit-dark'] === 'fill'
    && v['--wp-blur-light'] === '6px' && v['--wp-blur-dark'] === '2px'
    && v['--wp-opacity-light'] === '0.8' && v['--wp-opacity-dark'] === '0.6'
  check('B4 两套变量互不串味', ok, JSON.stringify(v))
}

// B5 图层不写内联尺寸/模糊/不透明度（否则会盖掉主题切换）
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: { light: { fit: 'contain' } } })
  const s = r.layer._style
  const clean = s.backgroundSize === undefined && s.filter === undefined && s.transform === undefined && s.opacity === undefined
  check('B5 图层只写 background-image', clean, JSON.stringify(Object.keys(s)))
}

// B6 老扁平配置 → 前端也能折算成两套
{
  const r = await bootClient({
    enabled: true, ...BASE_IMG,
    style: { fit: 'cover', alpha: 0.55, dim: 0.25, blur: 0, darkAlpha: 0.28, opacity: 1 },
  })
  const v = r.vars
  const ok = v['--wp-alpha-light'] === '55%' && v['--wp-alpha-dark'] === '28%'
    && Math.abs(parseFloat(v['--wp-dim-dark']) - 0.075) < 1e-9
  check('B6 老结构前端折算', ok, `light=${v['--wp-alpha-light']} dark=${v['--wp-alpha-dark']} dimDark=${v['--wp-dim-dark']}`)
}

// B7 完全没有 style → 用内置默认
{
  const r = await bootClient({ enabled: true, ...BASE_IMG })
  const v = r.vars
  check('B7 无配置走内置默认', v['--wp-alpha-light'] === '42%' && v['--wp-alpha-dark'] === '26%'
    && v['--wp-dim-light'] === '0.1' && v['--wp-dim-dark'] === '0.06', JSON.stringify(v))
}

// B8 深色界面下 DOM 标记存在时，两套变量仍在（CSS 自己挑，不靠 JS 猜主题）
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} }, true)
  const ok = r.vars['--wp-alpha-light'] === '42%' && r.vars['--wp-alpha-dark'] === '26%'
  check('B8 深色 body 下两套并存', ok, JSON.stringify(r.vars))
}

// B9 两套 token 覆盖完整：各 7 条，一条不漏
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const count = (s, needle) => s.split(needle).length - 1
  const light = count(r.css, 'var(--wp-tint)')
  const dark = count(r.css, 'var(--wp-tint-dark)')
  const darkSources = ['bluish-950', 'bluish-800', 'bluish-875', 'bluish-850', 'bluish-900', 'bluish-700']
    .every((t) => r.css.includes(t + ') var(--wp-tint-dark)'))
  check('B9 七条 token 两两对齐', light === 7 && dark === 7 && darkSources,
    `light=${light} dark=${dark} sources=${darkSources}`)
}

// B10 变量必须挂在 html 上，不能挂在 <style> 上（挂错了 var() 只会退到兜底值）
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: { light: { alpha: 0.5 } } })
  const onHtml = r.vars['--wp-alpha-light'] === '50%'
  const onTag = Object.keys(r.tagVars).filter((k) => k.indexOf('--wp-') === 0)
  check('B10 变量落在 <html> 上', onHtml && onTag.length === 0,
    `html=${r.vars['--wp-alpha-light']} tagKeys=${onTag.join(',') || 'none'}`)
}

// C1 设置界面：底色压到 90%（图只剩一层色），深浅各一条
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const lightRule = r.css.includes('html.dsh-wallpaper-on.dsh-wallpaper-settings-on body')
    && r.css.includes('--wp-tint:90%;--wp-dim-light:0')
  const darkRule = r.css.includes('html.dsh-wallpaper-on.dsh-wallpaper-settings-on body[data-ds-dark-theme]')
    && r.css.includes('--wp-tint-dark:90%;--wp-dim-dark:0')
  check('C1 设置页压到 90%（浅/深各一条）', lightRule && darkRule,
    `light=${lightRule} dark=${darkRule}`)
}

// C1b 方向：设置页必须比普通界面「更实」——设置里图变淡、平时正常显示
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const num = (re) => { const m = r.css.match(re); return m ? parseFloat(m[1]) : NaN }
  const settingsTint = num(/--wp-tint:(\d+)%/)
  const lightTint = num(/--wp-alpha-light,(\d+)%/)
  const darkTint = num(/--wp-alpha-dark,(\d+)%/)
  check('C1b 设置页比普通界面更实', settingsTint > lightTint && settingsTint > darkTint,
    `settings=${settingsTint} light=${lightTint} dark=${darkTint}`)
}

// C2 覆盖顺序在基础规则之后，且不带无前提的选择器（不能影响其他界面）
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const baseDark = r.css.indexOf('body[data-ds-dark-theme]{--wp-tint-dark:')
  const settingsRule = r.css.indexOf('.dsh-wallpaper-settings-on body')
  const strayRule = r.css.includes('}body{--wp-tint:90%') || r.css.startsWith('body{--wp-tint:90%')
  check('C2 顺序正确且只在设置屏生效', baseDark > 0 && settingsRule > baseDark && !strayRule,
    `base=${baseDark} settings=${settingsRule} stray=${strayRule}`)
}

// C3 另一个入口：DSH 设置弹层的 :has 触发（纯 CSS，不依赖 JS 或私有类名之外的猜测）
{
  const r = await bootClient({ enabled: true, ...BASE_IMG, style: {} })
  const hasLight = r.css.includes('body:has(.tklpSG_overlay)')
  const hasDark = r.css.includes('body[data-ds-dark-theme]:has(.tklpSG_overlay)')
  check('C3 :has 触发存在（浅/深）', hasLight && hasDark, `light=${hasLight} dark=${hasDark}`)
}

console.log('\n' + results.filter((r) => r.ok).length + ' passed, ' + results.filter((r) => !r.ok).length + ' failed')
if (results.some((r) => !r.ok)) process.exitCode = 1
