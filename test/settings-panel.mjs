// 设置页客户端模块测试：注册契约 + 组件逻辑 + 开关写盘
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = process.argv[2]
  || fileURLToPath(new URL('../lib/client.js', import.meta.url))

// ---------- 浏览器桩 ----------
const created = { style: [] }
class ClassSet {
  constructor() { this.set = new Set() }
  add(...c) { c.forEach((x) => this.set.add(x)) }
  remove(...c) { c.forEach((x) => this.set.delete(x)) }
  contains(c) { return this.set.has(c) }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; on ? this.set.add(c) : this.set.delete(c); return on }
}
const document = {
  head: { appendChild: (n) => created.style.push(n) },
  documentElement: { classList: new ClassSet() },
  createElement: (tag) => ({ tagName: tag, setAttribute() {}, remove() {} }),
}
const events = []
const window = {
  addEventListener() {},
  dispatchEvent: (e) => events.push(e),
}
class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail }
}
let registrations = []
window.__ModuleLoader__ = { load: (r) => registrations.push(r) }

// ---------- React 桩（带 hooks） ----------
let hookSlots = []
let hookIndex = 0
let pendingEffects = []

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (c) => {
      if (Array.isArray(c)) c.forEach(push)
      else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c)
    }
    push(children)
    return { type, props: { ...(props || {}), children: flat } }
  },
  useState(init) {
    const i = hookIndex++
    if (!(i in hookSlots)) hookSlots[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      hookSlots[i] = typeof v === 'function' ? v(hookSlots[i]) : v
    }
    return [hookSlots[i], set]
  },
  useEffect(fn) { pendingEffects.push(fn) },
}

// ---------- fetch 桩 ----------
let CONFIG = {
  enabled: true,
  images: [
    { id: 'a1', kind: 'path', src: 'C:/pics/one.jpg', name: 'one.jpg' },
    { id: 'a2', kind: 'url', src: 'https://x/two.png', name: 'two.png' },
  ],
  currentId: 'a1',
  rotate: { enabled: false, intervalSec: 60, order: 'sequential' },
  style: {
    light: { fit: 'cover', dim: 0.2, blur: 0, alpha: 0.6, opacity: 1 },
    dark: { fit: 'cover', dim: 0.08, blur: 0, alpha: 0.28, opacity: 1 },
  },
  ui: { buttonPos: null, showButton: false },
}
const calls = []
const fetch = async (url, opts) => {
  const u = String(url)
  const method = (opts && opts.method) || 'GET'
  const body = opts && opts.body ? JSON.parse(opts.body) : null
  calls.push({ url: u, method, body })
  if (u.endsWith('/config.json')) {
    if (method === 'POST') { CONFIG = body.config; return { ok: true, json: async () => ({ ok: true, config: CONFIG }) } }
    return { ok: true, json: async () => ({ ok: true, config: CONFIG }) }
  }
  return { ok: true, json: async () => ({ ok: true, config: CONFIG }) }
}

// ---------- 执行模块 ----------
const code = fs.readFileSync(SRC, 'utf8')
const fn = new Function('window', 'document', 'fetch', 'CustomEvent', 'FileReader', 'console', code)
const FileReader = class { readAsDataURL() {} }
fn(window, document, fetch, CustomEvent, FileReader, console)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''))
}

// 1. 注册了模块
check('module registered once', registrations.length === 1, 'n=' + registrations.length)
const reg = registrations[0]
check('module id is package name', reg && reg.id === 'dsh-background-wallpaper', reg && reg.id)

// 2. factory 返回面
const face = reg.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
check('face.inject includes slots', Array.isArray(face.inject) && face.inject.includes('slots'), JSON.stringify(face.inject))
check('face.apply is function', typeof face.apply === 'function')

// 3. apply 注册设置分区
let registered = null
const slots = {
  inject(key, cb) { if (key === 'settings.section') cb() },
  register(opts, comp) { registered = { opts, comp }; return () => {} },
}
const ctx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  effect: (cb) => { const d = cb(); return () => { if (typeof d === 'function') d() } },
}
face.apply(ctx)

check('style injected', created.style.length === 1 && created.style[0].setAttribute !== undefined)
check('section registered', !!registered)
if (registered) {
  const o = registered.opts
  check('section name', o.name === 'settings.section', o.name)
  check('section id', o.id === 'wallpaper', o.id)
  check('section label', o.label === '背景壁纸', o.label)
  check('section order is number', typeof o.order === 'number', String(o.order))
}

// ---------- 渲染 ----------
function render() {
  hookIndex = 0
  pendingEffects = []
  const el = registered.comp()
  const tree = el.type(el.props)      // 直接调用 Panel
  return { tree: expand(tree), effects: pendingEffects }
}
function findRangeByLabel(tree, label) {
  for (const n of walk(tree)) {
    if (n.type !== 'div') continue
    const kids = (n.props && n.props.children) || []
    if (!kids.map(textOf).includes(label)) continue
    const range = kids.find((k) => k && k.type === 'input' && k.props && k.props['data-wp-range'] !== undefined)
    if (range) return range
  }
  return null
}

// 把函数组件展开成真实元素树（子组件里没有 hooks，直接调用是安全的）
function expand(node, depth = 0) {
  if (depth > 60 || !node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props), depth + 1)
  const kids = (node.props && node.props.children) || []
  return { ...node, props: { ...node.props, children: kids.map((k) => expand(k, depth + 1)) } }
}
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const kids = node.props && node.props.children
  if (Array.isArray(kids)) kids.forEach((k) => walk(k, out))
  return out
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const kids = (node.props && node.props.children) || []
  return kids.map(textOf).join('')
}
function findSwitchByLabel(tree, label) {
  const nodes = walk(tree)
  for (const n of nodes) {
    if (n.type !== 'div') continue
    const kids = (n.props && n.props.children) || []
    const texts = kids.map(textOf)
    if (texts.includes(label)) {
      const sw = kids.find((k) => k && k.type === 'label' && k.props && k.props['data-wp-sw'] !== undefined)
      if (sw) {
        const input = (sw.props.children || []).find((c) => c && c.type === 'input')
        if (input) return input
      }
    }
  }
  return null
}

// 4. 初次渲染（配置未到）
let r = render()
check('initial loading state', textOf(r.tree).includes('正在读取配置'))

// 5. 跑 effect 拉配置 → 重渲染
r.effects.forEach((f) => f())
await new Promise((res) => setTimeout(res, 30))
r = render()
let text = textOf(r.tree)
check('renders enable switch label', text.includes('启用背景壁纸'))
check('renders section 图片', text.includes('图片'))
check('renders both image names', text.includes('one.jpg') && text.includes('two.png'))
check('marks current image', text.includes('当前'))
check('renders 轮换 section', text.includes('自动轮换') && text.includes('随机轮换'))
check('renders 样式 section', text.includes('界面不透明度') && text.includes('暗化遮罩'))
check('renders theme tabs', text.includes('浅色') && text.includes('深色'))
check('explains two independent sets', text.includes('各自独立') || text.includes('深浅各一套') || text.includes('预览按当前页签这套参数画'))
check('renders shortcut toggle', text.includes('显示悬浮按钮'))
check('default showButton off in note', text.includes('默认关掉'))
check('renders 设置界面不显示壁纸 switch', text.includes('设置界面不显示壁纸') && text.includes('不显示（默认）'))
check('explains 默认不显示', text.includes('开（默认）') && text.includes('背景图直接不显示'))

// 5b. 样式预览：按当前页签那套参数画（图 → 底色 → 遮罩 → 界面示意）
{
  const pick = (k) => walk(r.tree).find((n) => n.props && n.props[k] !== undefined)
  const prev = pick('data-wp-prev')
  check('预览区块存在', !!prev, prev ? 'theme=' + prev.props['data-wp-prev-theme'] : 'missing')
  check('预览默认跟随浅色页签', !!prev && prev.props['data-wp-prev-theme'] === 'light',
    prev ? String(prev.props['data-wp-prev-theme']) : 'n/a')
  const img = pick('data-wp-prev-img')
  check('预览用当前图 + 铺法',
    !!img && String(img.props.style.backgroundImage).includes('/image?src=C%3A%2Fpics%2Fone.jpg')
      && img.props.style.backgroundSize === 'cover' && img.props.style.filter === 'blur(0px)',
    img ? JSON.stringify(img.props.style) : 'none')
  const tint = pick('data-wp-prev-tint')
  check('预览底色 = 浅色 alpha 60%', !!tint && tint.props.style.background === 'rgba(255,255,255,0.6)',
    tint ? tint.props.style.background : 'none')
  const dim = pick('data-wp-prev-dim')
  check('预览遮罩 = 浅色 dim 20%', !!dim && dim.props.style.background === 'rgba(0,0,0,0.2)',
    dim ? dim.props.style.background : 'none')
  const bars = walk(r.tree).filter((n) => n.props && n.props['data-wp-prev-bar'] !== undefined)
  check('预览有界面示意条', bars.length === 4, 'n=' + bars.length)
  check('预览带页签标签', text.includes('浅色预览'), 'tag')
}

// 6. 切换总开关 → POST 落盘
const enabledSw = findSwitchByLabel(r.tree, '启用背景壁纸')
check('found enable switch', !!enabledSw)
if (enabledSw) {
  calls.length = 0
  enabledSw.props.onChange({ target: { checked: false } })
  await new Promise((res) => setTimeout(res, 30))
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
  check('toggle enable posts config', !!post && post.body.config.enabled === false,
    post ? 'enabled=' + post.body.config.enabled : 'no post')
}

// 7. 切换 showButton → ui.showButton 落盘 + 通知背景层
r = render()
const btnSw = findSwitchByLabel(r.tree, '显示悬浮按钮')
check('found showButton switch', !!btnSw)
if (btnSw) {
  calls.length = 0
  events.length = 0
  btnSw.props.onChange({ target: { checked: true } })
  await new Promise((res) => setTimeout(res, 30))
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
  check('toggle showButton posts ui.showButton=true',
    !!post && post.body.config.ui && post.body.config.ui.showButton === true,
    post ? JSON.stringify(post.body.config.ui) : 'no post')
  check('dispatches config event for background layer',
    events.some((e) => e.type === 'dsh-wallpaper:config'),
    events.map((e) => e.type).join(','))
}

// 7b. 随机轮换开关 → rotate.order 在 random / sequential 之间切
{
  const r2 = render()
  const randSw = findSwitchByLabel(r2.tree, '随机轮换')
  check('found 随机轮换 switch', !!randSw, randSw ? 'checked=' + randSw.props.checked : 'none')
  if (randSw) {
    check('随机轮换默认关（顺序）', randSw.props.checked === false, String(randSw.props.checked))
    calls.length = 0
    randSw.props.onChange({ target: { checked: true } })
    await new Promise((res) => setTimeout(res, 30))
    let post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
    check('打开随机轮换 → rotate.order=random',
      !!post && post.body.config.rotate.order === 'random',
      post ? 'order=' + post.body.config.rotate.order : 'no post')

    // 再关掉 → 回到顺序
    const randSw2 = findSwitchByLabel(render().tree, '随机轮换')
    check('开关回读为开', !!randSw2 && randSw2.props.checked === true, randSw2 ? String(randSw2.props.checked) : 'none')
    if (randSw2) {
      calls.length = 0
      randSw2.props.onChange({ target: { checked: false } })
      await new Promise((res) => setTimeout(res, 30))
      post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
      check('关闭随机轮换 → rotate.order=sequential',
        !!post && post.body.config.rotate.order === 'sequential',
        post ? 'order=' + post.body.config.rotate.order : 'no post')
    }
  }
}

// 8. 图片列表「设为当前」会改 currentId
r = render()
const nodes = walk(r.tree)
const setCurBtn = nodes.find((n) => n.type === 'button' && textOf(n) === '设为当前')
check('found 设为当前 button', !!setCurBtn)
if (setCurBtn) {
  calls.length = 0
  setCurBtn.props.onClick()
  await new Promise((res) => setTimeout(res, 30))
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
  check('set current posts new currentId',
    !!post && post.body.config.currentId === 'a2',
    post ? 'currentId=' + post.body.config.currentId : 'no post')
}

// 9. 浅色这套的通透度滑块 → style.light.alpha，深色不动
r = render()
const lightRange = findRangeByLabel(r.tree, '浅色界面不透明度')
check('found light alpha range', !!lightRange, lightRange ? 'value=' + lightRange.props.value : 'none')
if (lightRange) {
  check('light range shows 60 by default', lightRange.props.value === 60, String(lightRange.props.value))
  calls.length = 0
  lightRange.props.onChange({ target: { value: '70' } })
  await new Promise((res) => setTimeout(res, 30))
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
  const st = post && post.body.config.style
  check('浅色滑块只改 light.alpha', !!st && st.light.alpha === 0.7 && st.dark.alpha === 0.28,
    st ? JSON.stringify(st) : 'no post')
  // 预览要跟着滑块实时变
  const liveTint = walk(render().tree).find((n) => n.props && n.props['data-wp-prev-tint'] !== undefined)
  check('预览随滑块实时更新（70%）', !!liveTint && liveTint.props.style.background === 'rgba(255,255,255,0.7)',
    liveTint ? liveTint.props.style.background : 'none')
}

// 10. 切到深色页 → 读的是深色那套，写也只写深色
{
  const tabs = walk(r.tree).filter((n) => n.type === 'button' && textOf(n).startsWith('深色'))
  check('found dark tab', tabs.length === 1, 'n=' + tabs.length)
  if (tabs.length === 1) {
    tabs[0].props.onClick()
    r = render()
    const darkRange = findRangeByLabel(r.tree, '深色界面不透明度')
    check('深色页读到 28%', !!darkRange && darkRange.props.value === 28, darkRange ? 'value=' + darkRange.props.value : 'none')
    // 预览同时切到深色那套（底色换成深色、数值取深色的）
    const dPrev = walk(r.tree).find((n) => n.props && n.props['data-wp-prev'] !== undefined)
    check('预览跟随切到深色', !!dPrev && dPrev.props['data-wp-prev-theme'] === 'dark',
      dPrev ? String(dPrev.props['data-wp-prev-theme']) : 'none')
    const dTint = walk(r.tree).find((n) => n.props && n.props['data-wp-prev-tint'] !== undefined)
    check('深色预览底色 = 深色 28%', !!dTint && dTint.props.style.background === 'rgba(21,21,23,0.28)',
      dTint ? dTint.props.style.background : 'none')
    if (darkRange) {
      calls.length = 0
      darkRange.props.onChange({ target: { value: '45' } })
      await new Promise((res) => setTimeout(res, 30))
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
      const st = post && post.body.config.style
      check('深色滑块只改 dark.alpha', !!st && st.dark.alpha === 0.45 && st.light.alpha === 0.7,
        st ? JSON.stringify(st) : 'no post')
    }

    // 11. 恢复默认只影响当前这套
    const resetBtn = walk(r.tree).find((n) => n.type === 'button' && textOf(n).includes('恢复默认'))
    check('found reset button', !!resetBtn)
    if (resetBtn) {
      calls.length = 0
      resetBtn.props.onClick()
      await new Promise((res) => setTimeout(res, 30))
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/config.json'))
      const st = post && post.body.config.style
      check('恢复默认只重置深色这套',
        !!st && st.dark.alpha === 0.26 && st.dark.dim === 0.06 && st.light.alpha === 0.7,
        st ? JSON.stringify(st) : 'no post')
    }
  }
}

// 12. 设置页挂载 → 在 <html> 打标记（背景层据此把这一屏固定成 90% 通透）
{
  const r = render()
  check('挂载时注册了标记 effect', r.effects.length >= 1, 'n=' + r.effects.length)
  for (const fn of r.effects) fn()
  const on = document.documentElement.classList.contains('dsh-wallpaper-settings-panel')
  check('设置页挂载时 <html> 带 dsh-wallpaper-settings-panel', on, JSON.stringify([...document.documentElement.classList.set]))
}

const fail = results.filter((x) => !x.ok).length
console.log('\n' + (results.length - fail) + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
