// dsh-background-wallpaper —— DSH 主进程插件
// 功能：
//   1. 把 DSH 界面背景替换为指定图片（本地路径 / 上传的图片 / http(s) URL）
//   2. 多图轮换（顺序 / 随机，可配间隔）
//   3. 样式调节：适应方式、界面透明度、暗化遮罩、模糊
// 架构（与 dsh-whale-widget 同款）：
//   - apply() 开头立即注册 `webserver/index-inject` 结构化注入行（桌面端唯一通道，
//     宿主启动时一次性收集，行必须尽早进表；行本身是内联 script，页面侧解释器对
//     script-src 的失败会 reject 整个 boot，所以改用内联行并吞掉 onerror）。
//   - 其余逻辑放进 root.inject(['webServer'], cb)，等 webserver 就绪后注册路由：
//       /dsh-wallpaper/client.js     前端脚本
//       /dsh-wallpaper/config.json   GET/POST 配置
//       /dsh-wallpaper/add           添加图片（path / url）
//       /dsh-wallpaper/upload        上传图片（data URL → 存 ~/.dsh/.dsh-wallpaper-images/）
//       /dsh-wallpaper/remove        删除图片条目
//       /dsh-wallpaper/scan          扫描目录里的图片文件
//       /dsh-wallpaper/image         按登记 src 返回本地图片字节
//   - web 形态（浏览器打开 DSH Web）走 tapIndex 注入 <script>。
// 配置持久化：$DSH_HOME/.dsh-wallpaper.json（候选表 $DSH_HOME 优先）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// 配置候选表：$DSH_HOME 优先，web profile 降级为兜底（与 whale-widget 同一策略）
const CONFIG_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dsh-wallpaper.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dsh-wallpaper.json'),
]

// 上传图片的存放目录（node_modules 可能被清理/只读，用户数据一律进 $DSH_HOME）
const IMG_DIR = path.join(DSH_HOME, '.dsh-wallpaper-images')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const IMAGE_EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)$/i

function defaultConfig() {
  return {
    enabled: true,
    images: [], // [{ id, kind: 'path'|'url'|'file', src, name }]
    currentId: null,
    rotate: { enabled: false, intervalSec: 60, order: 'sequential' }, // order: sequential | random
    // 深浅两套完全独立的样式，各带默认值，由 CSS 按主题直接切换，互不影响。
    // 浅色底色是纯白，通透度要够低图才透得出来；深色底色接近纯黑，要压得更低。
    style: {
      light: { fit: 'cover', alpha: 0.42, dim: 0.10, blur: 0, opacity: 1 },
      dark: { fit: 'cover', alpha: 0.26, dim: 0.06, blur: 0, opacity: 1 },
    },
    // showButton=false：入口只在 DSH 设置页
    // settingsDim=true：进设置界面（任何分区）时背景回到纯主题底色（浅色纯白 / 深色纯黑），默认开
    ui: { buttonPos: null, showButton: false, settingsDim: true },
  }
}

function clampNumber(v, fallback, min, max) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}

// v1 的扁平 style 结构，只在迁移时用得到
const LEGACY_STYLE_DEFAULTS = { fit: 'cover', alpha: 0.55, darkAlpha: 0.28, dim: 0.25, blur: 0, opacity: 1 }

function normalizeThemeStyle(raw, base) {
  const s = (raw && typeof raw === 'object') ? raw : {}
  return {
    fit: s.fit === 'cover' || s.fit === 'contain' || s.fit === 'fill' ? s.fit : base.fit,
    alpha: clampNumber(s.alpha, base.alpha, 0.05, 1),
    dim: clampNumber(s.dim, base.dim, 0, 1),
    blur: clampNumber(s.blur, base.blur, 0, 40),
    opacity: clampNumber(s.opacity, base.opacity, 0.05, 1),
  }
}

// style 走白名单 + 夹取：坏值不能把 CSS 变成一条无效声明
function normalizeStyle(raw) {
  const base = defaultConfig().style
  const s = (raw && typeof raw === 'object') ? raw : {}

  // 已经是两套结构：各归各的
  if ((s.light && typeof s.light === 'object') || (s.dark && typeof s.dark === 'object')) {
    return {
      light: normalizeThemeStyle(s.light, base.light),
      dark: normalizeThemeStyle(s.dark, base.dark),
    }
  }

  // v1 扁平结构 → 迁移。只有「还是旧默认值」的项换成新默认，
  // 用户自己动过的数值原样保留，不偷偷改掉人家的选择。
  const legacy = (v, oldDefault, nextDefault) =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v - oldDefault) > 1e-9 ? v : nextDefault
  const customDim = typeof s.dim === 'number' && Number.isFinite(s.dim)
    && Math.abs(s.dim - LEGACY_STYLE_DEFAULTS.dim) > 1e-9

  return {
    light: normalizeThemeStyle({
      fit: s.fit,
      alpha: legacy(s.alpha, LEGACY_STYLE_DEFAULTS.alpha, base.light.alpha),
      dim: legacy(s.dim, LEGACY_STYLE_DEFAULTS.dim, base.light.dim),
      blur: s.blur,
      opacity: s.opacity,
    }, base.light),
    dark: normalizeThemeStyle({
      fit: s.fit,
      alpha: legacy(s.darkAlpha, LEGACY_STYLE_DEFAULTS.darkAlpha, base.dark.alpha),
      // 旧版深色遮罩是 dim*0.3 隐式算出来的，迁移时照这个关系落成显式值
      dim: customDim ? clampNumber(s.dim * 0.3, base.dark.dim, 0, 1) : base.dark.dim,
      blur: s.blur,
      opacity: s.opacity,
    }, base.dark),
  }
}

function normalizeConfig(cfg) {
  const base = defaultConfig()
  const out = { ...base, ...(cfg || {}) }
  out.images = Array.isArray(out.images)
    ? out.images.filter((i) => i && i.src && (i.kind === 'path' || i.kind === 'url' || i.kind === 'file'))
    : []
  out.rotate = { ...base.rotate, ...(out.rotate || {}) }
  out.style = normalizeStyle(out.style)
  // 界面状态：只保留已知字段并做校验
  const ui = (out.ui && typeof out.ui === 'object') ? out.ui : {}
  const pos = ui.buttonPos
  out.ui = {
    buttonPos: pos && typeof pos.left === 'number' && typeof pos.top === 'number'
      && Number.isFinite(pos.left) && Number.isFinite(pos.top)
      ? { left: Math.round(pos.left), top: Math.round(pos.top) }
      : null,
    showButton: typeof ui.showButton === 'boolean' ? ui.showButton : base.ui.showButton,
    settingsDim: typeof ui.settingsDim === 'boolean' ? ui.settingsDim : true,
  }
  return out
}

function readConfig() {
  for (const p of CONFIG_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed === 'object') return normalizeConfig(parsed)
    } catch (err) { /* try next candidate */ }
  }
  return defaultConfig()
}

function writeConfig(cfg) {
  const body = JSON.stringify(cfg, null, 2)
  let lastErr = null
  for (const p of CONFIG_FILE_CANDIDATES) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body, 'utf8')
      return true
    } catch (err) { lastErr = err }
  }
  if (lastErr) throw lastErr
  return false
}

// —— 轻量信任栅栏（本机插件）：只接受回环 Host / 同源 Origin，写方法仅回环 ——
function selfRejection(req) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
    const hostname = hostUrl.hostname
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
      && !hostname.endsWith('.localhost') && !/^127\.\d+\.\d+\.\d+$/.test(hostname)) {
      return 403
    }
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try { originUrl = new URL(origin) } catch (err) { return 403 }
      // 桌面端页面跑在自定义协议下：宿主转发时会把 origin 改写成 target.origin，
      // 但页面直连 / 重定向等场景可能仍带 dsh-app://app。自定义协议只可能由桌面壳发出，
      // 不视为跨站，放行。
      const isDesktopShell = originUrl.protocol === 'dsh-app:'
      if (!isDesktopShell && originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return 403
    }
    return null
  } catch (err) { return 403 }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      chunks.push(c)
      size += c.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(data))
}

function sendBytes(res, status, headers, bytes) {
  res.writeHead(status, headers)
  res.end(bytes)
}

// 生成短 id（够用即可，无加密需求）
let idSeq = 0
function genId() {
  idSeq = (idSeq + 1) % 0xffff
  return 'w' + Date.now().toString(36) + idSeq.toString(36)
}

function imageFileExists(p) {
  try { return fs.statSync(p).isFile() } catch (err) { return false }
}

function listImagesInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort()
  } catch (err) { return [] }
}

// —— 桌面端（Electron）结构化注入行：内联 script 行，不是 script-src 行 ——
// 桌面壳的 index.html 从安装包静态 dist 直出，tapIndex 永远过不去；唯一通道是
// `webserver/index-inject` 推的结构化行，经 IPC 交给页面侧解释器逐行应用。
// 页面解释器对 script-src 失败会 reject 掉 __DSH_BOOT_READY__（致命启动错误），
// 所以用内联行：由我们自己建 <script src=…> 并吞掉 onerror —— 路由在就正常加载，
// 路由不在就静默失败，宿主永远不会因为我们起不来。
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-wallpaper/client.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'dsh-background-wallpaper',
  // 有意去掉对象级 inject：行注册必须立即执行（宿主一次性收集 index-inject 表），
  // 否则桌面端永远拿不到这一行。其余逻辑放 root.inject 局部等待。
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) { try { d() } catch (err) {} }
    })

    // ② 等 webserver 就绪后：注册路由 + 订阅注入表
    // 注意：`webserver/index-inject` 必须在注入了 webServer 的 ctx 上订阅
    // （内置 dsh-client-modules 也是这么做的）。在 root 上订阅收不到宿主 emit，
    // 这是之前页面拿不到注入行的真正原因。
    root.inject(['webServer'], (ctx) => {
      const disposers = []

      // ① 结构化注入行：桌面端唯一能生效的通道（web 形态另有 tapIndex，两条并存、各自去重）
      disposers.push(ctx.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === '/dsh-wallpaper/client.js') return
            if (row.kind === 'script' && typeof row.text === 'string'
              && row.text.indexOf('/dsh-wallpaper/client.js') >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        } catch (err) { /* non-fatal */ }
      }))

      // 前端脚本：按 mtime 缓存，改脚本后硬刷新页面即生效（无需重启 DSH）
      const CLIENT_FILE_CANDIDATES = [
        path.join(PACKAGE_ROOT, 'assets', 'wallpaper-client.js'),
        path.join(PACKAGE_ROOT, 'wallpaper-client.js'),
      ]
      let clientCache = null // { text, mtimeMs }
      function loadClientJs() {
        for (const p of CLIENT_FILE_CANDIDATES) {
          try {
            const st = fs.statSync(p)
            if (clientCache && clientCache.mtimeMs === st.mtimeMs) return clientCache.text
            const text = fs.readFileSync(p, 'utf8')
            clientCache = { text, mtimeMs: st.mtimeMs }
            return text
          } catch (err) { /* try next */ }
        }
        return clientCache ? clientCache.text : ''
      }

      // 统一注册入口（信任栅栏包裹）
      function registerRoute(route) {
        const inner = route && route.handler
        const wrapped = Object.assign({}, route, {
          handler: async (req, res) => {
            const rejectCode = selfRejection(req)
            if (rejectCode !== null) {
              res.writeHead(rejectCode, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'rejected' }))
              return
            }
            try {
              await inner(req, res)
            } catch (err) {
              try {
                res.writeHead(500, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
              } catch (e2) { /* socket gone */ }
            }
          },
        })
        return ctx.webServer.register(wrapped)
      }

      // —— 前端脚本 ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/client.js',
        handler: (req, res) => {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(loadClientJs())
        },
      }))

      // —— 配置：GET / POST ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/config.json',
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            const config = readConfig()
            sendJson(res, 200, { ok: true, config })
            return
          }
          if (method === 'POST' || method === 'PUT') {
            let body
            try {
              body = await readBody(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
              return
            }
            let payload = null
            try { payload = JSON.parse(body.toString('utf8')) } catch (err) { /* ignore */ }
            if (!payload || typeof payload !== 'object' || !payload.config) {
              sendJson(res, 400, { ok: false, error: 'expected { config }' })
              return
            }
            const config = normalizeConfig(payload.config)
            try {
              writeConfig(config)
            } catch (err) {
              sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
              return
            }
            sendJson(res, 200, { ok: true, config })
            return
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        },
      }))

      // —— 添加图片：{ source: 'path' | 'url', value, name? } ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/add',
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          let body
          try { body = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          let payload = null
          try { payload = JSON.parse(body.toString('utf8')) } catch (err) { /* ignore */ }
          if (!payload || typeof payload !== 'object') {
            sendJson(res, 400, { ok: false, error: 'bad json' })
            return
          }
          const source = String(payload.source || '').toLowerCase()
          const value = String(payload.value || '').trim()
          if (!value) {
            sendJson(res, 400, { ok: false, error: 'empty value' })
            return
          }
          const config = readConfig()
          let kind = ''
          let src = ''
          let name = ''
          if (source === 'url' || /^https?:\/\//i.test(value)) {
            kind = 'url'
            src = value
            try { name = new URL(value).hostname + path.extname(new URL(value).pathname) || 'url' } catch (err) { name = 'url' }
          } else {
            const abs = path.resolve(value)
            if (!imageFileExists(abs)) {
              sendJson(res, 400, { ok: false, error: 'file not found: ' + abs })
              return
            }
            if (!IMAGE_EXT_RE.test(abs)) {
              sendJson(res, 400, { ok: false, error: 'not an image file' })
              return
            }
            kind = 'path'
            src = abs
            name = path.basename(abs)
          }
          // 去重
          if (config.images.some((i) => i.src === src)) {
            sendJson(res, 200, { ok: true, config, duplicate: true })
            return
          }
          const entry = { id: genId(), kind, src, name: name || src }
          config.images.push(entry)
          if (!config.currentId) config.currentId = entry.id
          try { writeConfig(config) } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
            return
          }
          sendJson(res, 200, { ok: true, config, entry })
        },
      }))

      // —— 上传图片：{ name, dataUrl } → 存到 $DSH_HOME/.dsh-wallpaper-images/ ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/upload',
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          let body
          try { body = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          let payload = null
          try { payload = JSON.parse(body.toString('utf8')) } catch (err) { /* ignore */ }
          if (!payload || typeof payload !== 'object' || typeof payload.dataUrl !== 'string') {
            sendJson(res, 400, { ok: false, error: 'expected { name, dataUrl }' })
            return
          }
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(payload.dataUrl)
          if (!m) {
            sendJson(res, 400, { ok: false, error: 'bad data URL' })
            return
          }
          const mime = m[1] || 'application/octet-stream'
          const isBase64 = !!m[2]
          const raw = m[3]
          const bytes = isBase64 ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8')
          const baseName = String(payload.name || 'wallpaper').replace(/[^\w.\-]+/g, '_')
          const ext = IMAGE_EXT_MIME[mime] ? Object.keys(IMAGE_EXT_MIME).find((k) => IMAGE_EXT_MIME[k] === mime) : '.img'
          let fileName = baseName
          if (!IMAGE_EXT_RE.test(fileName)) fileName = baseName.replace(/\.img$/, '') + ext
          const safeName = fileName.replace(/[\\/]/g, '_')
          const filePath = path.join(IMG_DIR, safeName)
          try {
            fs.mkdirSync(IMG_DIR, { recursive: true })
            fs.writeFileSync(filePath, bytes)
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
            return
          }
          const config = readConfig()
          if (config.images.some((i) => i.kind === 'file' && i.src === safeName)) {
            sendJson(res, 200, { ok: true, config, duplicate: true })
            return
          }
          const entry = { id: genId(), kind: 'file', src: safeName, name: safeName }
          config.images.push(entry)
          if (!config.currentId) config.currentId = entry.id
          try { writeConfig(config) } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
            return
          }
          sendJson(res, 200, { ok: true, config, entry })
        },
      }))

      // —— 删除图片条目：{ id } ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/remove',
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          let body
          try { body = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          let payload = null
          try { payload = JSON.parse(body.toString('utf8')) } catch (err) { /* ignore */ }
          const id = payload && typeof payload.id === 'string' ? payload.id : ''
          const config = readConfig()
          const idx = config.images.findIndex((i) => i.id === id)
          if (idx < 0) {
            sendJson(res, 404, { ok: false, error: 'not found' })
            return
          }
          const [removed] = config.images.splice(idx, 1)
          if (config.currentId === removed.id) config.currentId = config.images.length ? config.images[0].id : null
          try { writeConfig(config) } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
            return
          }
          sendJson(res, 200, { ok: true, config, removed: removed.id })
        },
      }))

      // —— 扫描目录：{ dir } → 候选图片文件列表（不自动添加） ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/scan',
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          let body
          try { body = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          let payload = null
          try { payload = JSON.parse(body.toString('utf8')) } catch (err) { /* ignore */ }
          const dir = payload && typeof payload.dir === 'string' ? payload.dir.trim() : ''
          if (!dir) {
            sendJson(res, 400, { ok: false, error: 'empty dir' })
            return
          }
          const files = listImagesInDir(path.resolve(dir))
          sendJson(res, 200, { ok: true, dir: path.resolve(dir), files })
        },
      }))

      // —— 图片字节：?src=<登记 src>（path 绝对路径 / file 文件名；url 类型前端直连） ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-wallpaper/image',
        handler: (req, res) => {
          let url = null
          try { url = new URL(req.url, 'http://localhost') } catch (err) {
            sendJson(res, 400, { ok: false, error: 'bad url' })
            return
          }
          const src = url.searchParams.get('src') || ''
          if (!src) {
            sendJson(res, 400, { ok: false, error: 'missing src' })
            return
          }
          const config = readConfig()
          const entry = config.images.find((i) => i.src === src)
          if (!entry || entry.kind === 'url') {
            sendJson(res, 403, { ok: false, error: 'src not registered' })
            return
          }
          const filePath = entry.kind === 'file'
            ? path.join(IMG_DIR, path.basename(entry.src))
            : path.resolve(entry.src)
          let bytes = null
          try { bytes = fs.readFileSync(filePath) } catch (err) { bytes = null }
          if (!bytes) {
            sendJson(res, 404, { ok: false, error: 'image file missing' })
            return
          }
          const ext = path.extname(filePath).toLowerCase()
          const mime = IMAGE_EXT_MIME[ext] || 'application/octet-stream'
          sendBytes(res, 200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          }, bytes)
        },
      }))

      // —— web 形态注入：tapIndex ——
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (html.indexOf('/dsh-wallpaper/client.js') !== -1) return html
        const tag = '<script defer src="/dsh-wallpaper/client.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }))

      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch (err) {} }
      })
    })
  },
}
