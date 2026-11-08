// 真机渲染验收：拿插件产出的真实 CSS，在 Chromium 内核（Edge/Chrome）里算设置界面的实际颜色。
//
// 为什么要有这一组：前面几次改「设置界面颜色」都是字符串断言全绿、实际观感却不对
// （哈希类名换了、方向搞反了、90% 混色不是纯白）。颜色这种事只有真引擎算过才算数。
//
// 找不到浏览器时自动跳过（Linux CI 上不会红）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'assets', 'wallpaper-client.js')
const OUT = path.join(os.tmpdir(), 'dsh-wallpaper-paint-probe')

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]
const BROWSER = process.env.DSH_PAINT_BROWSER || CANDIDATES.find((p) => fs.existsSync(p))

if (!BROWSER) {
  console.log('SKIP  没找到 Edge/Chrome（可用 DSH_PAINT_BROWSER 指定路径），跳过真机渲染验收')
  process.exit(0)
}

/* ---------- 1. 用极简 DOM 桩执行前端脚本，取出它写进页面的 CSS 文本 ---------- */
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
    const self = this
    this.style = new Proxy(this._style, {
      set(t, k, v) { t[k] = v; return true },
      get(t, k) { if (k === 'setProperty') return (kk, vv) => { t[kk] = vv }; return t[k] },
    })
    this.dataset = {}
    this.attrs = {}
    this.textContent = ''
    this.classList = new ClassList()
    this.parentNode = null
    this.id = ''
    this._className = ''
    Object.defineProperty(this, 'className', {
      get() { return self._className },
      set(v) {
        self._className = String(v)
        self.classList = new ClassList()
        String(v).split(/\s+/).filter(Boolean).forEach((c) => self.classList.add(c))
      },
    })
  }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c }
  insertBefore(c) { return this.appendChild(c) }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null }
  querySelectorAll() { return [] }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 } }
  contains() { return false }
  focus() {}
}

const findById = (el, id) => {
  if (!el) return null
  if (el.id === id) return el
  for (const c of el.children || []) {
    const hit = findById(c, id)
    if (hit) return hit
  }
  return null
}

async function cssOf(cfg) {
  const doc = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
  }
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  const win = {
    __dshWallpaperLoaded: false,
    innerWidth: 1200,
    innerHeight: 800,
    _l: {},
    addEventListener(e, cb) { (this._l[e] = this._l[e] || []).push(cb) },
    dispatchEvent(ev) { for (const cb of this._l[ev.type] || []) cb(ev) },
    Image: class { set src(v) { this._s = v } get src() { return this._s } },
    location: { href: 'http://127.0.0.1:3080/' },
  }
  const fetchStub = (u) => Promise.resolve({
    json: () => Promise.resolve(String(u).includes('/config.json')
      ? { ok: true, config: JSON.parse(JSON.stringify(cfg)) }
      : { ok: true, files: [] }),
  })
  const fn = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'Image', 'console',
    'Promise', 'JSON', 'Math', 'encodeURIComponent', 'String', 'Array', 'Number', 'FileReader',
    'setTimeout', 'ResizeObserver', 'MutationObserver', fs.readFileSync(CLIENT, 'utf8'),
  )
  fn(win, doc, fetchStub, () => 1, () => {}, win.Image, console, Promise, JSON, Math,
    encodeURIComponent, String, Array, Number, class { readAsDataURL() {} }, (cb) => 1,
    class { observe() {} disconnect() {} }, class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} })
  await new Promise((r) => setTimeout(r, 150))
  const tag = findById(doc.documentElement, 'dsh-wallpaper-style')
  return tag ? tag.textContent : ''
}

/* ---------- 2. 拼页面：DSH 的 token 色板 + 插件真实 CSS + 仿 DSH 设置弹层结构 ---------- */
const TOKENS = `
:root{
  --dsw-static-neutral-bluish-00:#fff; --dsw-static-neutral-bluish-50:#f9fafb;
  --dsw-static-neutral-bluish-60:#f5f6f7; --dsw-static-neutral-bluish-150:#e9ecf2;
  --dsw-static-neutral-bluish-700:#61666b; --dsw-static-neutral-bluish-800:#353638;
  --dsw-static-neutral-bluish-850:#2c2c2e; --dsw-static-neutral-bluish-875:#232324;
  --dsw-static-neutral-bluish-900:#1b1b1c; --dsw-static-neutral-bluish-950:#151517;
  --dsw-alias-bg-mask-1:#0000003d; --dsw-mask-blur:none;
  --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-2:#fff;
}
`

// overlay：'attr' = 带 data-shortcut-modal（DSH 真实结构）；'bare' = 两个属性都没有（只剩插件打的 class）
const VARIANTS = [
  { name: 'light-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on dsh-wallpaper-settings-on', dark: false, overlay: 'attr' },
  { name: 'light-normal', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on', dark: false, overlay: 'none' },
  { name: 'dark-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on dsh-wallpaper-settings-on', dark: true, overlay: 'attr' },
  { name: 'switch-off-open', html: 'dsh-wallpaper-on dsh-wallpaper-settings-on', dark: false, overlay: 'attr' },
  { name: 'class-only-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on dsh-wallpaper-settings-panel', dark: false, overlay: 'bare' },
  { name: 'css-only-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on', dark: false, overlay: 'attr' },
  // 最坏情况：把带 settings-on / :has 的规则全删掉，只剩「按 data 属性重设实色 token」那一条兜底
  { name: 'attr-only-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on', dark: false, overlay: 'attr', strip: true },
  // 对照：既没有触发规则、面板也没有 data 属性 → 应该还是半透明
  { name: 'nothing-open', html: 'dsh-wallpaper-on dsh-wallpaper-dim-on', dark: false, overlay: 'bare', strip: true },
]

const overlayHtml = (kind) => (kind === 'none' ? '' : `
<div class="sim_overlay" style="position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center">
  <div id="sim_mask" style="position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)"></div>
  <div id="sim_panel"${kind === 'attr' ? ' data-shortcut-modal="settings" role="dialog" aria-modal="true"' : ''}
       style="position:relative;z-index:1;width:400px;height:300px;background:var(--dsw-alias-bg-layer-2)"></div>
</div>`)

const PLUGIN_CSS = await cssOf({ enabled: true, images: [{ id: 'a', kind: 'path', src: 'a.jpg', name: 'a.jpg' }], currentId: 'a', style: {} })

// 模拟「所有全局触发都失效」：把带 settings-on / settings-panel / :has( 的规则整条删掉
const stripTriggers = (css) => css.split('}').map((r) => (r && !/settings-on|settings-panel|:has\(/.test(r) ? r + '}' : '')).join('')

const probe = (v) => `<!doctype html>
<html class="${v.html}">
<head><meta charset="utf-8"><style>${TOKENS}</style><style id="wpcss">${v.strip ? stripTriggers(PLUGIN_CSS) : PLUGIN_CSS}</style></head>
<body${v.dark ? ' data-ds-dark-theme' : ''}>
<div id="dsh-wallpaper-layer" style="background-color:#ff0000"></div>
<div id="dsh-wallpaper-dim"></div>
<div id="maskprobe" style="width:1px;height:1px;background:var(--dsw-alias-bg-mask-1)"></div>
${overlayHtml(v.overlay)}
<pre id="out">pending</pre>
<script>
  const cs = (el) => getComputedStyle(el);
  const panel = document.getElementById('sim_panel');
  const out = {
    variant: ${JSON.stringify(v.name)},
    tint: cs(document.body).getPropertyValue('--wp-tint').trim(),
    tintDark: cs(document.body).getPropertyValue('--wp-tint-dark').trim(),
    layerOpacity: cs(document.getElementById('dsh-wallpaper-layer')).opacity,
    panelBg: panel ? cs(panel).backgroundColor : 'n/a',
    maskBg: cs(document.getElementById('maskprobe')).backgroundColor,
  };
  document.getElementById('out').textContent = JSON.stringify(out);
</script>
</body></html>`

fs.mkdirSync(OUT, { recursive: true })
const results = []
for (const v of VARIANTS) {
  const file = path.join(OUT, v.name + '.html')
  fs.writeFileSync(file, probe(v), 'utf8')
  const url = 'file:///' + file.replace(/\\/g, '/')
  let dom = ''
  try {
    dom = execFileSync(BROWSER, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
      '--virtual-time-budget=1500', '--dump-dom', url,
    ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    console.log('SKIP  浏览器没能跑起来：' + err.message.split('\n')[0])
    process.exit(0)
  }
  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)
  results.push(m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : { variant: v.name, error: 'no output' })
}

/* ---------- 3. 判定 ---------- */
const byName = Object.fromEntries(results.map((r) => [r.variant, r]))

// 浏览器可能给 rgb() 也可能给 color(srgb …)：统一成 [r,g,b,a]
const parse = (c) => {
  let m = /^rgba?\(([^)]+)\)$/.exec(c)
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
  }
  m = /^color\(srgb ([^)]+)\)$/.exec(c)
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r: Math.round(p[0] * 255), g: Math.round(p[1] * 255), b: Math.round(p[2] * 255), a: p[3] === undefined ? 1 : p[3] }
  }
  return null
}
const white = (c) => { const p = parse(c); return !!p && p.a === 1 && p.r === 255 && p.g === 255 && p.b === 255 }
const themeDark = (c) => { const p = parse(c); return !!p && p.a === 1 && p.r === 44 && p.g === 44 && p.b === 46 } // bluish-850 = DSH 深色 layer-2
const translucent = (c) => { const p = parse(c); return !!p && p.a > 0.3 && p.a < 0.9 }

const checks = [
  ['浅色 + 设置打开 → 面板纯白不透明', white(byName['light-open'].panelBg), byName['light-open'].panelBg],
  ['浅色 + 设置打开 → 遮罩纯白', white(byName['light-open'].maskBg), byName['light-open'].maskBg],
  ['浅色 + 设置打开 → 壁纸层让开', byName['light-open'].layerOpacity === '0', byName['light-open'].layerOpacity],
  ['浅色 + 普通界面 → 底色仍是该主题的 42%', byName['light-normal'].tint === '42%', byName['light-normal'].tint],
  ['浅色 + 普通界面 → 壁纸层可见', byName['light-normal'].layerOpacity === '1', byName['light-normal'].layerOpacity],
  ['浅色 + 普通界面 → 遮罩没被动过', byName['light-normal'].maskBg === 'rgba(0, 0, 0, 0.24)', byName['light-normal'].maskBg],
  ['深色 + 设置打开 → 面板是深色实色', themeDark(byName['dark-open'].panelBg), byName['dark-open'].panelBg],
  ['深色 + 设置打开 → 遮罩深色实色', byName['dark-open'].maskBg === 'rgb(21, 21, 23)', byName['dark-open'].maskBg],
  ['深色 + 设置打开 → 壁纸层让开', byName['dark-open'].layerOpacity === '0', byName['dark-open'].layerOpacity],
  ['开关关掉 → 面板仍半透明', translucent(byName['switch-off-open'].panelBg), byName['switch-off-open'].panelBg],
  ['开关关掉 → 壁纸层仍可见', byName['switch-off-open'].layerOpacity === '1', byName['switch-off-open'].layerOpacity],
  ['只靠插件 class（无 data 属性）→ 也纯白', white(byName['class-only-open'].panelBg) && byName['class-only-open'].layerOpacity === '0',
    byName['class-only-open'].panelBg],
  ['只靠 :has（无 class）→ 也纯白', white(byName['css-only-open'].panelBg) && byName['css-only-open'].layerOpacity === '0',
    byName['css-only-open'].panelBg],
  // 最坏情况：全局触发规则全被删掉（模拟浏览器不认 :has、弹层不在 body 直接子节点、JS 也没打上 class）
  // → 只剩按 data 属性重设实色 token 那条兜底，面板也必须是不透明白的
  ['触发全失效 + 只有 data 属性 → 面板仍纯白', white(byName['attr-only-open'].panelBg), byName['attr-only-open'].panelBg],
  ['触发全失效 + 没有 data 属性 → 面板半透明（对照）', translucent(byName['nothing-open'].panelBg), byName['nothing-open'].panelBg],
]

let bad = 0
for (const [name, pass, val] of checks) {
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + '  →  ' + val)
  if (!pass) bad++
}
console.log(bad === 0 ? '真机渲染 ' + checks.length + ' 条全部符合' : bad + ' 条不符合')
process.exit(bad === 0 ? 0 : 1)
