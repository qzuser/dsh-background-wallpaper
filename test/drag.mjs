// 拖拽功能验证：位置持久化、边界收敛、点击/拖拽区分、面板跟随
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = process.argv[2]
  || fileURLToPath(new URL('../assets/wallpaper-client.js', import.meta.url))
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8')

// ---------- DOM 桩（带 getBoundingClientRect 与 pointer 事件） ----------
class ClassList {
  constructor(node) { this.node = node; this.set = new Set() }
  add(...c) { c.forEach((x) => this.set.add(x)); this._sync() }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this._sync() }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force
    on ? this.set.add(c) : this.set.delete(c); this._sync(); return on
  }
  contains(c) { return this.set.has(c) }
  _sync() { this.node._className = [...this.set].join(' ') }
}

const VIEWPORT = { w: 1200, h: 800 }
let resizeHandlers = []

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this._style = {}
    this.style = new Proxy(this._style, {
      set(t, k, v) { t[k] = v; return true },
      get(t, k) {
        if (k === 'setProperty') return (kk, vv) => { t[kk] = vv }
        if (k === 'cssText') return t.cssText || ''
        return t[k]
      },
    })
    this.id = ''
    this.dataset = {}
    this.attrs = {}
    this._className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.listeners = {}
    this.classList = new ClassList(this)
    this.parentNode = null
    this._height = 400
  }
  get className() { return this._className }
  set className(v) { this._className = v; this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)) }
  appendChild(c) { if (!c) return c; c.parentNode = this; this.children.push(c); return c }
  insertBefore(c, ref) {
    c.parentNode = this
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c)
    return c
  }
  get firstChild() { return this.children[0] || null }
  get lastChild() { return this.children[this.children.length - 1] || null }
  get nextSibling() {
    if (!this.parentNode) return null
    const s = this.parentNode.children
    return s[s.indexOf(this) + 1] || null
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v) }
  getAttribute(k) { return this.attrs[k] }
  removeChild(c) {
    const i = this.children.indexOf(c)
    if (i >= 0) this.children.splice(i, 1)
    c.parentNode = null
    return c
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  containsId(want) {
    if (this.id === want) return true
    return this.children.some((c) => c && typeof c.containsId === 'function' && c.containsId(want))
  }
  addEventListener(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb) }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  dispatch(ev, arg) { for (const cb of this.listeners[ev] || []) cb(arg || { target: this }) }
  click() { this.dispatch('click') }
  getBoundingClientRect() {
    const left = parseFloat(this._style.left) || 0
    const top = parseFloat(this._style.top) || 0
    const w = this.id === 'dsh-wallpaper-btn' ? 40 : 300
    const h = this.id === 'dsh-wallpaper-btn' ? 40 : this._height
    return { left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top }
  }
  remove() {}
}

const registry = new Map()
const origAppend = El.prototype.appendChild
El.prototype.appendChild = function (c) { if (c && c.id) registry.set(c.id, c); return origAppend.call(this, c) }
const origInsert = El.prototype.insertBefore
El.prototype.insertBefore = function (c, ref) { if (c && c.id) registry.set(c.id, c); return origInsert.call(this, c, ref) }

const document = {
  readyState: 'complete',
  documentElement: new El('html'),
  head: new El('head'),
  body: new El('body'),
  createElement: (t) => new El(t),
  getElementById: (id) => registry.get(id) || null,
  querySelector: () => null,
  addEventListener() {},
}
document.documentElement.appendChild(document.head)
document.documentElement.appendChild(document.body)

const window = {
  __dshWallpaperLoaded: false,
  innerWidth: VIEWPORT.w,
  innerHeight: VIEWPORT.h,
  _listeners: {},
  addEventListener(ev, cb) {
    (this._listeners[ev] = this._listeners[ev] || []).push(cb)
    if (ev === 'resize') resizeHandlers.push(cb)
  },
  dispatchEvent(ev) {
    for (const cb of this._listeners[ev.type] || []) cb(ev)
  },
  Image: class { set src(v) { this._src = v } get src() { return this._src } },
}

const CONFIG = {
  enabled: true,
  images: [{ id: 'a1', kind: 'path', src: 'C:/pics/one.jpg', name: 'one.jpg' }],
  currentId: 'a1',
  rotate: { enabled: false, intervalSec: 60, order: 'sequential' },
  style: { fit: 'cover', dim: 0.2, blur: 0, alpha: 0.6, opacity: 1 },
  ui: { buttonPos: null, showButton: true },
}

const posted = []
const fetch = (url, opts) => {
  const u = String(url)
  if (u.includes('/config.json')) {
    if (opts && opts.method === 'POST') {
      const b = JSON.parse(opts.body)
      posted.push(b)
      // 模拟服务端 normalizeConfig：保留 ui
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: b.config }) })
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: JSON.parse(JSON.stringify(CONFIG)) }) })
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: CONFIG, files: [] }) })
}

const intervals = []
const fn = new Function(
  'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'Image', 'console',
  'Promise', 'JSON', 'Math', 'encodeURIComponent', 'String', 'Array', 'Number', 'FileReader', 'setTimeout', 'ResizeObserver',
  SCRIPT,
)
let timers = []
const setTimeoutStub = (cb, ms) => { timers.push({ cb, ms }); if (ms === 0) cb(); return timers.length }
const FileReader = class { readAsDataURL() { this.onload && this.onload() } }
const ResizeObserver = class { observe() {} disconnect() {} }

fn(window, document, fetch, (cb, ms) => { intervals.push({ cb, ms }); return intervals.length }, () => {},
  window.Image, console, Promise, JSON, Math, encodeURIComponent, String, Array, Number, FileReader, setTimeoutStub, ResizeObserver)

await new Promise((r) => realSetTimeout(r, 150))
function realSetTimeout(fn2, ms) { setTimeout(fn2, ms) }

const btn = document.getElementById('dsh-wallpaper-btn')
const panel = document.getElementById('dsh-wallpaper-panel')

console.log('=== 初始状态 ===')
console.log('button exists =', !!btn, '| panel exists =', !!panel)
console.log('initial left/top =', btn._style.left, btn._style.top, '(expect 16px / 744px)')

// ---------- 测试 1：拖动 ----------
console.log('\n=== 测试 1：拖动 300,200 向右下 ===')
btn.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 16, clientY: 744, preventDefault() {} })
btn.dispatch('pointermove', { pointerId: 1, clientX: 316, clientY: 500, preventDefault() {} })
btn.dispatch('pointerup', { pointerId: 1 })
const afterDrag = { left: parseFloat(btn._style.left), top: parseFloat(btn._style.top) }
console.log('after drag left/top =', afterDrag.left, afterDrag.top)
console.log('has wp-dragging class =', btn.classList.contains('wp-dragging'), '(expect false)')
console.log('persisted posts =', posted.length, '| last ui =', JSON.stringify(posted[posted.length - 1]?.config?.ui))

// ---------- 测试 2：拖拽后立即的 click 不应打开面板 ----------
console.log('\n=== 测试 2：拖拽后紧随的 click 不应打开面板 ===')
btn.dispatch('click', {})
console.log('panel open =', panel.classList.contains('wp-open'), '(expect false)')

// 等过防误触窗口，普通点击应能打开
await new Promise((r) => realSetTimeout(r, 300))

// ---------- 测试 3：正常点击能打开 ----------
console.log('\n=== 测试 3：过了防误触窗口后点击应打开面板 ===')
btn.dispatch('click', {})
console.log('panel open =', panel.classList.contains('wp-open'), '(expect true)')
console.log('panel pos =', panel._style.left, panel._style.top)

// ---------- 测试 4：拖到视口外应被夹住 ----------
console.log('\n=== 测试 4：拖到右下视口外 ===')
btn.dispatch('pointerdown', { pointerId: 2, button: 0, clientX: parseFloat(btn._style.left), clientY: parseFloat(btn._style.top), preventDefault() {} })
btn.dispatch('pointermove', { pointerId: 2, clientX: 5000, clientY: 5000, preventDefault() {} })
btn.dispatch('pointerup', { pointerId: 2 })
const clamped = { left: parseFloat(btn._style.left), top: parseFloat(btn._style.top) }
console.log('clamped left/top =', clamped.left, clamped.top)
console.log('within viewport =', clamped.left + 40 <= VIEWPORT.w && clamped.top + 40 <= VIEWPORT.h)
console.log('snapped to right edge =', Math.abs(clamped.left - (VIEWPORT.w - 44)) < 2)

// ---------- 测试 5：窗口缩放后仍在视口内 ----------
console.log('\n=== 测试 5：缩小窗口后位置收敛 ===')
window.innerWidth = 400
window.innerHeight = 300
resizeHandlers.forEach((h) => h())
const afterResize = { left: parseFloat(btn._style.left), top: parseFloat(btn._style.top) }
console.log('after resize left/top =', afterResize.left, afterResize.top)
console.log('within small viewport =', afterResize.left + 40 <= 400 && afterResize.top + 40 <= 300)

console.log('\n=== DONE ===')

// ---------- 测试 6：保存过的位置能被恢复 ----------
console.log('\n=== 测试 6：重启后恢复保存的位置 ===')
{
  const savedPos = { left: 700, top: 120 }
  const CONFIG2 = JSON.parse(JSON.stringify(CONFIG))
  CONFIG2.ui = { buttonPos: savedPos, showButton: true }
  const posted2 = []
  const fetch2 = (url, opts) => {
    const u = String(url)
    if (u.includes('/config.json')) {
      if (opts && opts.method === 'POST') {
        const b = JSON.parse(opts.body)
        posted2.push(b)
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: b.config }) })
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: CONFIG2 }) })
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, files: [] }) })
  }
  // 重置 DOM 桩
  const reg2 = new Map()
  const doc2 = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: (t) => new El(t),
    getElementById: (id) => reg2.get(id) || null,
    querySelector: () => null,
    addEventListener() {},
  }
  const origAppend2 = El.prototype.appendChild
  El.prototype.appendChild = function (c) { if (c && c.id) reg2.set(c.id, c); return origAppend2.call(this, c) }
  doc2.documentElement.appendChild(doc2.head)
  doc2.documentElement.appendChild(doc2.body)
  const win2 = {
    __dshWallpaperLoaded: false,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    Image: window.Image,
  }
  const fn2 = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'Image', 'console',
    'Promise', 'JSON', 'Math', 'encodeURIComponent', 'String', 'Array', 'Number', 'FileReader', 'setTimeout', 'ResizeObserver',
    SCRIPT,
  )
  const iv2 = []
  fn2(win2, doc2, fetch2, (cb, ms) => { iv2.push({ cb, ms }); return iv2.length }, () => {},
    window.Image, console, Promise, JSON, Math, encodeURIComponent, String, Array, Number, FileReader, setTimeoutStub, ResizeObserver)
  await new Promise((r) => realSetTimeout(r, 150))
  const btn2 = reg2.get('dsh-wallpaper-btn')
  console.log('restored left/top =', btn2._style.left, btn2._style.top, '(expect 700px 120px)')
  console.log('match saved =', btn2._style.left === '700px' && btn2._style.top === '120px')
  El.prototype.appendChild = origAppend2
}

console.log('\n=== 测试 7：showButton=false 时不创建按钮（入口只在设置页） ===')
{
  const CFG3 = JSON.parse(JSON.stringify(CONFIG))
  CFG3.ui = { buttonPos: null, showButton: false }
  const fetch3 = (url) => Promise.resolve({ json: () => Promise.resolve({ ok: true, config: CFG3, files: [] }) })

  const reg3 = new Map()
  const doc3 = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: (t) => new El(t),
    getElementById: (id) => reg3.get(id) || null,
    querySelector: () => null,
    addEventListener() {},
  }
  const origAppend3 = El.prototype.appendChild
  El.prototype.appendChild = function (c) { if (c && c.id) reg3.set(c.id, c); return origAppend3.call(this, c) }
  doc3.documentElement.appendChild(doc3.head)
  doc3.documentElement.appendChild(doc3.body)

  const listeners3 = {}
  const win3 = {
    __dshWallpaperLoaded: false,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(ev, cb) { (listeners3[ev] = listeners3[ev] || []).push(cb) },
    dispatchEvent(ev) { for (const cb of listeners3[ev.type] || []) cb(ev) },
    Image: window.Image,
  }
  const fn3 = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'Image', 'console',
    'Promise', 'JSON', 'Math', 'encodeURIComponent', 'String', 'Array', 'Number', 'FileReader', 'setTimeout', 'ResizeObserver',
    SCRIPT,
  )
  fn3(win3, doc3, fetch3, () => 0, () => {},
    window.Image, console, Promise, JSON, Math, encodeURIComponent, String, Array, Number, FileReader, setTimeoutStub, ResizeObserver)
  await new Promise((r) => realSetTimeout(r, 150))

  console.log('button created =', doc3.body.containsId('dsh-wallpaper-btn'), '(expect false)')
  console.log('panel created  =', doc3.body.containsId('dsh-wallpaper-panel'), '(expect false)')
  // 背景层仍然要工作
  console.log('bg layer exists =', doc3.body.containsId('dsh-wallpaper-layer'), '(expect true)')

  // 从设置页打开开关（派发事件）→ 按钮应出现
  win3.dispatchEvent({ type: 'dsh-wallpaper:config', detail: { ...JSON.parse(JSON.stringify(CFG3)), ui: { buttonPos: null, showButton: true } } })
  await new Promise((r) => realSetTimeout(r, 60))
  console.log('button after enable =', doc3.body.containsId('dsh-wallpaper-btn'), '(expect true)')

  // 再关掉 → 按钮应移除
  win3.dispatchEvent({ type: 'dsh-wallpaper:config', detail: { ...JSON.parse(JSON.stringify(CFG3)), ui: { buttonPos: null, showButton: false } } })
  await new Promise((r) => realSetTimeout(r, 60))
  console.log('button after disable =', doc3.body.containsId('dsh-wallpaper-btn'), '(expect false)')

  El.prototype.appendChild = origAppend3
}

console.log('\n=== ALL DONE ===')
process.exit(0)
