// dsh-background-wallpaper —— 浏览器端（web / desktop 渲染层）
// 由主进程经 /dsh-wallpaper/client.js 下发，独立 IIFE，无外部依赖。
// 职责：
//   1. 渲染背景层（固定全屏、置于内容之下）+ 暗化遮罩 + 模糊/适应方式
//   2. 把 DSH 大面积背景 token 半透明化（--wp-alpha），让壁纸透出
//   3. 多图轮换（顺序/随机 + 间隔），预加载下一张
//   4. 悬浮设置面板：开关、图片增删、轮换、样式调节
//   5. 定时轮询配置（检测外部/重启后的变更）
(function () {
  'use strict'

  if (window.__dshWallpaperLoaded) return
  window.__dshWallpaperLoaded = true

  var API = '/dsh-wallpaper'
  var POLL_MS = 10000

  var state = null // 最近一次配置
  var layerEl = null
  var dimEl = null
  var panelEl = null
  var btnEl = null
  var rotateTimer = null
  var preloaded = null

  // ---------- 小工具 ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (k === 'style') node.style.cssText = attrs[k]
        else if (k === 'class') node.className = attrs[k]
        else if (k === 'html') node.innerHTML = attrs[k]
        else if (k === 'text') node.textContent = attrs[k]
        else node.setAttribute(k, attrs[k])
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i])
      }
    }
    return node
  }

  function apiGet(path) {
    return fetch(API + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .catch(function () { return null })
  }

  function apiPost(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() }).catch(function () { return null })
  }

  function saveConfig(next) {
    if (!next) return Promise.resolve(null)
    state = next
    applyConfig()
    return apiPost('/config.json', { config: next }).then(function (res) {
      if (res && res.config) { state = res.config; applyConfig() }
      return res
    })
  }

  function imageUrlOf(entry) {
    if (!entry) return ''
    if (entry.kind === 'url') return entry.src
    return API + '/image?src=' + encodeURIComponent(entry.src)
  }

  function currentEntry() {
    if (!state || !state.images || !state.images.length) return null
    var cur = null
    if (state.currentId) {
      for (var i = 0; i < state.images.length; i++) {
        if (state.images[i].id === state.currentId) { cur = state.images[i]; break }
      }
    }
    return cur || state.images[0]
  }

  function nextIndex() {
    var n = state.images.length
    if (n <= 1) return 0
    var curIdx = 0
    for (var i = 0; i < n; i++) if (state.images[i].id === state.currentId) { curIdx = i; break }
    if (state.rotate.order === 'random') {
      var r = curIdx
      while (r === curIdx && n > 1) r = Math.floor(Math.random() * n)
      return r
    }
    return (curIdx + 1) % n
  }

  function preloadImage(url) {
    if (!url || url === preloaded) return
    preloaded = url
    var img = new Image()
    img.src = url
  }

  // ---------- 深浅两套默认值（host 端 normalizeStyle 里有同样的数） ----------
  var THEME_DEFAULTS = {
    light: { fit: 'cover', alpha: 0.42, dim: 0.10, blur: 0, opacity: 1 },
    dark: { fit: 'cover', alpha: 0.26, dim: 0.06, blur: 0, opacity: 1 },
  }

  function isDark() {
    var b = document.body
    if (b && typeof b.hasAttribute === 'function') return b.hasAttribute('data-ds-dark-theme')
    return false
  }

  function clamp(v, fb, min, max) {
    var n = typeof v === 'number' && isFinite(v) ? v : fb
    return Math.min(max, Math.max(min, n))
  }

  function normalizeTheme(raw, def) {
    var s = (raw && typeof raw === 'object') ? raw : {}
    return {
      fit: s.fit === 'cover' || s.fit === 'contain' || s.fit === 'fill' ? s.fit : def.fit,
      alpha: clamp(s.alpha, def.alpha, 0.05, 1),
      dim: clamp(s.dim, def.dim, 0, 1),
      blur: clamp(s.blur, def.blur, 0, 40),
      opacity: clamp(s.opacity, def.opacity, 0.05, 1),
    }
  }

  // 取某一套样式；如果配置还是老的扁平结构，就就地折算成两套
  function themeStyleOf(cfg, name) {
    var def = THEME_DEFAULTS[name]
    var style = (cfg && cfg.style) || {}
    if (style.light || style.dark) return normalizeTheme(style[name], def)
    // v1 扁平结构兜底
    if (name === 'dark') {
      return normalizeTheme({
        fit: style.fit,
        alpha: style.darkAlpha,
        dim: typeof style.dim === 'number' ? style.dim * 0.3 : def.dim,
        blur: style.blur,
        opacity: style.opacity,
      }, def)
    }
    return normalizeTheme({
      fit: style.fit, alpha: style.alpha, dim: style.dim, blur: style.blur, opacity: style.opacity,
    }, def)
  }

  // ---------- CSS ----------
  // 设置界面单独一档：底色压到 90%，图只剩一层色，方便看清设置项。
  // 只在这一屏生效；离开设置立刻回到该主题原本的数值，图正常显示。
  var SETTINGS_VIEW_TINT = '90%'

  // 设置弹层的稳定特征。CSS module 的类名每版构建都会换（tklpSG_overlay → Vn-AbG_overlay），
  // 属性不会换：DSH 自己的模态层约定就是 [role="dialog"][aria-modal="true"]，
  // 设置弹层另外还带 data-shortcut-modal="settings"。
  var SETTINGS_DIALOG_SELECTOR = '[data-shortcut-modal="settings"],[role="dialog"][aria-modal="true"]'

  var STYLE_ID = 'dsh-wallpaper-style'
  var CSS_BASE =
    // 壁纸层：尺寸/模糊/缩放/不透明度全部走变量，浅色读 light 那组
    '#dsh-wallpaper-layer{position:fixed;inset:0;z-index:0;pointer-events:none;background-position:center;background-repeat:no-repeat;' +
    'background-size:var(--wp-fit-light,cover);filter:blur(var(--wp-blur-light,0px));' +
    'transform:scale(var(--wp-scale-light,1));opacity:var(--wp-opacity-light,1)}' +
    '#dsh-wallpaper-dim{position:fixed;inset:0;z-index:1;pointer-events:none;background:#000;opacity:var(--wp-dim-light,0)}' +
    'html:not(.dsh-wallpaper-on) #dsh-wallpaper-dim{opacity:0}' +
    'html.dsh-wallpaper-on body{background:transparent !important}' +

    // 浅色这一层：所有背景 token 都按 --wp-tint（浅色组）混成半透明
    'html.dsh-wallpaper-on body{' +
    '--wp-tint:var(--wp-alpha-light,42%);' +
    '--dsw-alias-bg-base:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--wp-tint), transparent);' +
    '--dsw-alias-bg-module-platform:color-mix(in srgb, var(--dsw-static-neutral-bluish-60) var(--wp-tint), transparent);' +
    '--dsw-alias-bg-layer-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--wp-tint), transparent);' +
    '--dsw-alias-bg-layer-2:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--wp-tint), transparent);' +
    '--dsw-alias-bg-layer-3:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--wp-tint), transparent);' +
    '--dsw-specific-sidebar-fill:color-mix(in srgb, var(--dsw-static-neutral-bluish-50) var(--wp-tint), transparent);' +
    '--dsw-alias-bg-overlay:color-mix(in srgb, var(--dsw-static-neutral-bluish-150) var(--wp-tint), transparent)' +
    '}' +

    // 深色这一层：同一批 token 换深色色源，读 --wp-tint-dark（深色组），与浅色互不影响
    'html.dsh-wallpaper-on body[data-ds-dark-theme]{' +
    '--wp-tint-dark:var(--wp-alpha-dark,26%);' +
    '--dsw-alias-bg-base:color-mix(in srgb, var(--dsw-static-neutral-bluish-950) var(--wp-tint-dark), transparent);' +
    '--dsw-alias-bg-module-platform:color-mix(in srgb, var(--dsw-static-neutral-bluish-800) var(--wp-tint-dark), transparent);' +
    '--dsw-alias-bg-layer-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-875) var(--wp-tint-dark), transparent);' +
    '--dsw-alias-bg-layer-2:color-mix(in srgb, var(--dsw-static-neutral-bluish-850) var(--wp-tint-dark), transparent);' +
    '--dsw-alias-bg-layer-3:color-mix(in srgb, var(--dsw-static-neutral-bluish-800) var(--wp-tint-dark), transparent);' +
    '--dsw-specific-sidebar-fill:color-mix(in srgb, var(--dsw-static-neutral-bluish-900) var(--wp-tint-dark), transparent);' +
    '--dsw-alias-bg-overlay:color-mix(in srgb, var(--dsw-static-neutral-bluish-700) var(--wp-tint-dark), transparent)' +
    '}' +

    // 图层的其余参数也按主题换：深色下这套只在 body 带深色标记时生效
    'html.dsh-wallpaper-on body[data-ds-dark-theme] #dsh-wallpaper-layer{' +
    'background-size:var(--wp-fit-dark,cover);filter:blur(var(--wp-blur-dark,0px));' +
    'transform:scale(var(--wp-scale-dark,1));opacity:var(--wp-opacity-dark,1)}' +
    'html.dsh-wallpaper-on body[data-ds-dark-theme] #dsh-wallpaper-dim{opacity:var(--wp-dim-dark,0)}' +

    // 设置界面单独一档（默认关，设置里打开「设置界面压暗」才生效）：
    // 底色压到 90%（图只剩一层色），连弹层背后那层遮罩一起压，整屏是一层主题色。
    // 默认关 = 设置界面和普通界面一样透 —— 改壁纸时能自己看见效果。
    // 三个入口互为兜底，全部只认稳定特征，不碰会随构建变化的哈希类名（tklpSG_overlay → Vn-AbG_overlay）：
    //   .dsh-wallpaper-settings-on    设置弹层开着（MutationObserver 维护，见 watchSettingsView）
    //   .dsh-wallpaper-settings-panel 本插件设置页挂载时的标记
    //   :has([data-shortcut-modal="settings"])  纯 CSS 兜底，不依赖任何 JS
    // 三条都还要 .dsh-wallpaper-dim-on（配置里的 ui.settingsDim）—— 开关关着时这些规则一条都不匹配。
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-on body,' +
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-panel body' +
    '{--wp-tint:' + SETTINGS_VIEW_TINT + ';--wp-dim-light:0;' +
    '--dsw-alias-bg-mask-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + SETTINGS_VIEW_TINT + ', transparent)}' +
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-on body[data-ds-dark-theme],' +
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-panel body[data-ds-dark-theme]' +
    '{--wp-tint-dark:' + SETTINGS_VIEW_TINT + ';--wp-dim-dark:0;' +
    '--dsw-alias-bg-mask-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-950) ' + SETTINGS_VIEW_TINT + ', transparent)}' +
    // 纯 CSS 兜底：独立成条，万一 :has() 不被支持，只是这一条整体失效，上面靠 class 的照常生效。
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on body:has([data-shortcut-modal="settings"])' +
    '{--wp-tint:' + SETTINGS_VIEW_TINT + ';--wp-dim-light:0;' +
    '--dsw-alias-bg-mask-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + SETTINGS_VIEW_TINT + ', transparent)}' +
    'html.dsh-wallpaper-on.dsh-wallpaper-dim-on body[data-ds-dark-theme]:has([data-shortcut-modal="settings"])' +
    '{--wp-tint-dark:' + SETTINGS_VIEW_TINT + ';--wp-dim-dark:0;' +
    '--dsw-alias-bg-mask-1:color-mix(in srgb, var(--dsw-static-neutral-bluish-950) ' + SETTINGS_VIEW_TINT + ', transparent)}'

  // 悬浮控件样式（面板、按钮；z-index 取极高值，确保盖住所有内容）
  // 按钮位置由 JS 写 left/top（可拖动），CSS 只给默认兜底与拖拽态样式
  var UI_CSS =
    '#dsh-wallpaper-btn{position:fixed;left:16px;bottom:16px;width:40px;height:40px;border-radius:12px;' +
    'background:rgba(32,34,40,.72);border:1px solid rgba(255,255,255,.14);color:#fff;font-size:18px;line-height:1;' +
    'cursor:grab;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.28);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
    'transition:transform .12s ease,background .12s ease;touch-action:none;user-select:none;-webkit-user-select:none}' +
    '#dsh-wallpaper-btn:hover{transform:scale(1.06);background:rgba(50,52,60,.85)}' +
    // 拖拽中：禁用 hover 缩放与过渡，避免跟手迟滞
    '#dsh-wallpaper-btn.wp-dragging{cursor:grabbing;transform:none !important;transition:none !important;' +
    'background:rgba(86,134,254,.92);box-shadow:0 8px 28px rgba(0,0,0,.5)}' +
    // 拖拽时给个轻微视觉提示（拖回边缘会吸附）
    '#dsh-wallpaper-panel{position:fixed;left:16px;bottom:64px;width:300px;max-height:min(620px,calc(100vh - 96px));' +
    'overflow-y:auto;border-radius:16px;background:rgba(28,30,36,.92);border:1px solid rgba(255,255,255,.12);' +
    'color:#e8eaed;font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'z-index:2147483001;box-shadow:0 12px 40px rgba(0,0,0,.45);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);' +
    'padding:14px 14px 16px;box-sizing:border-box;display:none}' +
    '#dsh-wallpaper-panel.wp-open{display:block}' +
    '#dsh-wallpaper-panel .wp-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}' +
    '#dsh-wallpaper-panel .wp-title{font-size:14px;font-weight:600;flex:1}' +
    '#dsh-wallpaper-panel .wp-close{background:transparent;border:0;color:#9aa0a6;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px}' +
    '#dsh-wallpaper-panel .wp-close:hover{background:rgba(255,255,255,.08);color:#fff}' +
    '#dsh-wallpaper-panel .wp-sec{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}' +
    '#dsh-wallpaper-panel .wp-label{display:flex;align-items:center;gap:6px;font-size:12px;color:#b6bcc4;margin:6px 0 4px}' +
    '#dsh-wallpaper-panel .wp-row{display:flex;align-items:center;gap:8px;margin:6px 0}' +
    '#dsh-wallpaper-panel input[type=text],#dsh-wallpaper-panel input[type=number]{flex:1;min-width:0;background:rgba(255,255,255,.07);' +
    'border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#e8eaed;padding:5px 8px;font:inherit;outline:none}' +
    '#dsh-wallpaper-panel input[type=text]:focus,#dsh-wallpaper-panel input[type=number]:focus{border-color:#5686fe}' +
    '#dsh-wallpaper-panel input[type=range]{flex:1;accent-color:#5686fe}' +
    '#dsh-wallpaper-panel select{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#e8eaed;padding:4px 6px;font:inherit;outline:none}' +
    '#dsh-wallpaper-panel button.wp-btn{background:rgba(86,134,254,.9);border:0;border-radius:8px;color:#fff;padding:5px 12px;font:inherit;cursor:pointer;white-space:nowrap}' +
    '#dsh-wallpaper-panel button.wp-btn:hover{background:#6b92ff}' +
    '#dsh-wallpaper-panel button.wp-btn:disabled{opacity:.45;cursor:default}' +
    '#dsh-wallpaper-panel .wp-list{margin-top:4px}' +
    '#dsh-wallpaper-panel .wp-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px;margin:3px 0}' +
    '#dsh-wallpaper-panel .wp-item:hover{background:rgba(255,255,255,.06)}' +
    '#dsh-wallpaper-panel .wp-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#c8cdd4}' +
    '#dsh-wallpaper-panel .wp-item-cur{font-size:10px;color:#5686fe;border:1px solid rgba(86,134,254,.5);border-radius:5px;padding:0 4px}' +
    '#dsh-wallpaper-panel .wp-item button{background:transparent;border:0;color:#9aa0a6;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:6px}' +
    '#dsh-wallpaper-panel .wp-item button:hover{background:rgba(255,255,255,.08);color:#fff}' +
    '#dsh-wallpaper-panel .wp-item button.wp-del:hover{color:#ff7b72}' +
    '#dsh-wallpaper-panel .wp-hint{font-size:11px;color:#8b9099;margin-top:2px}' +
    '#dsh-wallpaper-panel .wp-file{font-size:12px;color:#c8cdd4}'

  // ---------- 开关控件（简易 checkbox 样式） ----------
  function makeSwitch(onChange, initial) {
    var box = el('label', {
      style: 'position:relative;display:inline-block;width:34px;height:18px;flex:none;cursor:pointer',
    })
    var input = el('input', {
      type: 'checkbox',
      style: 'opacity:0;width:0;height:0;position:absolute',
    })
    input.checked = !!initial
    var track = el('span', {
      style: 'position:absolute;inset:0;border-radius:999px;background:rgba(255,255,255,.18);transition:background .15s ease',
    })
    var knob = el('span', {
      style: 'position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease',
    })
    function sync() {
      if (input.checked) {
        track.style.background = '#5686fe'
        knob.style.transform = 'translateX(16px)'
      } else {
        track.style.background = 'rgba(255,255,255,.18)'
        knob.style.transform = 'translateX(0)'
      }
    }
    sync()
    input.addEventListener('change', function () { sync(); onChange(input.checked) })
    box.appendChild(input); box.appendChild(track); box.appendChild(knob)
    box._input = input
    // 外部同步用：改状态的同时把滑块外观一起刷新（只改 _input.checked 不会重绘轨道）
    box._set = function (v) { input.checked = !!v; sync() }
    return box
  }

  // ---------- 设置弹层探测 ----------
  // 设置弹层是 createPortal 到 document.body 的直接子节点：开关都会让 body 的子节点变动，
  // 所以只监听 childList 就够，不用 subtree（聊天流一直在吐节点，subtree 监听太贵）。
  var settingsObserver = null

  function settingsDialogOpen() {
    if (typeof document === 'undefined' || !document.querySelector) return false
    try {
      return !!document.querySelector(SETTINGS_DIALOG_SELECTOR)
    } catch (e) {
      return false
    }
  }

  /** 把「设置界面是否开着」同步成 <html> 上的 class（CSS 全靠这个 class 切档）。 */
  function markSettingsView() {
    if (typeof document === 'undefined' || !document.documentElement) return
    var root = document.documentElement
    if (!root.classList) return
    root.classList.toggle('dsh-wallpaper-settings-on', settingsDialogOpen())
  }

  function watchSettingsView() {
    markSettingsView()
    if (settingsObserver || typeof MutationObserver === 'undefined') return
    if (typeof document === 'undefined' || !document.body) return
    settingsObserver = new MutationObserver(markSettingsView)
    settingsObserver.observe(document.body, { childList: true })
  }

  // ---------- 配置应用 ----------
  function ensureDom() {
    if (layerEl) return
    var styleTag = document.getElementById(STYLE_ID)
    if (!styleTag) {
      styleTag = document.createElement('style')
      styleTag.id = STYLE_ID
      styleTag.textContent = CSS_BASE + UI_CSS
      document.head.appendChild(styleTag)
    }
    layerEl = document.createElement('div')
    layerEl.id = 'dsh-wallpaper-layer'
    dimEl = document.createElement('div')
    dimEl.id = 'dsh-wallpaper-dim'
    // 放在 body 最前：内容 DOM 在其后 → 正常绘制在其上
    var body = document.body || document.documentElement
    body.insertBefore(layerEl, body.firstChild)
    body.insertBefore(dimEl, layerEl.nextSibling)
  }

  function applyConfig() {
    if (!state) return
    ensureDom()
    var on = !!(state.enabled && state.images && state.images.length)
    document.documentElement.classList.toggle('dsh-wallpaper-on', on)
    // 设置界面压暗（默认关）：打开时才让上面那组 90% 规则有机会匹配
    var ui = state.ui || {}
    document.documentElement.classList.toggle('dsh-wallpaper-dim-on', !!(on && ui.settingsDim))

    // 两套样式各自成组喂给 CSS：浅色的全部写 -light 后缀，深色的写 -dark 后缀。
    // 浏览器按 body[data-ds-dark-theme] 自己挑，前端不需要判断当前是哪个主题，
    // 主题切换时也不会有一帧的错位。
    //
    // 变量必须挂在 <html> 上：CSS 里的 var() 是在 body 上求值的，而自定义属性只沿着
    // 祖先链继承 —— 写在 <style> 元素上的属性传不到 body，只会让 var() 一路退到兜底值。
    var rootStyle = document.documentElement.style
    ;['light', 'dark'].forEach(function (name) {
      var set = themeStyleOf(state, name)
      rootStyle.setProperty('--wp-alpha-' + name, Math.round(set.alpha * 100) + '%')
      rootStyle.setProperty('--wp-dim-' + name, String(set.dim))
      rootStyle.setProperty('--wp-blur-' + name, set.blur + 'px')
      rootStyle.setProperty('--wp-scale-' + name, String(1 + set.blur * 0.02))
      rootStyle.setProperty('--wp-opacity-' + name, String(set.opacity))
      rootStyle.setProperty('--wp-fit-' + name, set.fit)
    })

    if (on) {
      var entry = currentEntry()
      var url = entry ? imageUrlOf(entry) : ''
      layerEl.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '\\"') + '")' : 'none'
      // 尺寸、模糊、不透明度都交给 CSS 的变量，这里不写内联值，免得盖掉主题切换
      // 预加载下一张
      if (state.images.length > 1) {
        var nx = state.images[nextIndex()]
        preloadImage(nx ? imageUrlOf(nx) : '')
      }
    } else {
      layerEl.style.backgroundImage = 'none'
    }
    syncPanel()
  }

  // ---------- 轮换 ----------
  function restartRotate() {
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null }
    if (state && state.rotate && state.rotate.enabled && state.enabled && state.images && state.images.length > 1) {
      var sec = Math.max(5, Number(state.rotate.intervalSec) || 60)
      rotateTimer = setInterval(function () {
        if (!state || !state.images.length) return
        var idx = nextIndex()
        var entry = state.images[idx]
        var next = JSON.parse(JSON.stringify(state))
        next.currentId = entry.id
        saveConfig(next)
      }, sec * 1000)
    }
  }

  // ---------- 设置面板 ----------
  function syncPanel() {
    if (!panelEl || !state) return
    var listEl = document.getElementById('wp-list')
    if (!listEl) return
    listEl.innerHTML = ''
    state.images.forEach(function (img) {
      var isCur = img.id === currentEntry().id
      var row = el('div', { class: 'wp-item' })
      row.appendChild(el('span', { class: 'wp-item-name', text: img.name || img.src }))
      if (isCur) row.appendChild(el('span', { class: 'wp-item-cur', text: '当前' }))
      var setBtn = el('button', { text: isCur ? '' : '设为当前' })
      setBtn.title = '设为当前背景'
      setBtn.addEventListener('click', function () {
        var next = JSON.parse(JSON.stringify(state))
        next.currentId = img.id
        saveConfig(next)
      })
      if (!isCur) row.appendChild(setBtn)
      var delBtn = el('button', { class: 'wp-del', text: '✕' })
      delBtn.title = '删除'
      delBtn.addEventListener('click', function () {
        apiPost('/remove', { id: img.id }).then(function (res) {
          if (res && res.config) { state = res.config; applyConfig() }
        })
      })
      row.appendChild(delBtn)
      listEl.appendChild(row)
    })
    if (!state.images.length) {
      listEl.appendChild(el('div', { class: 'wp-hint', text: '还没有图片，从下方添加（支持本地路径 / 图片文件 / 网址）' }))
    }
  }

  function buildPanel() {
    panelEl = el('div', { id: 'dsh-wallpaper-panel' })

    // 头部
    var head = el('div', { class: 'wp-head' })
    head.appendChild(el('span', { class: 'wp-title', text: '🖼️ 背景壁纸' }))
    var closeBtn = el('button', { class: 'wp-close', text: '✕' })
    closeBtn.addEventListener('click', function () { panelEl.classList.remove('wp-open') })
    head.appendChild(closeBtn)
    panelEl.appendChild(head)

    // 启用开关
    var enabledRow = el('div', { class: 'wp-row' })
    enabledRow.appendChild(el('span', { style: 'flex:1', text: '启用壁纸' }))
    var enabledSwitch = makeSwitch(function (v) {
      var next = JSON.parse(JSON.stringify(state))
      next.enabled = v
      saveConfig(next).then(restartRotate)
    })
    enabledRow.appendChild(enabledSwitch)
    panelEl.appendChild(enabledRow)

    // 图片列表
    panelEl.appendChild(el('div', { class: 'wp-sec' }))
    var secList = panelEl.lastChild
    secList.appendChild(el('div', { class: 'wp-label', text: '图片列表（' + (state ? state.images.length : 0) + '）' }))
    secList.appendChild(el('div', { id: 'wp-list', class: 'wp-list' }))

    // 添加：文件选择
    var addRow1 = el('div', { class: 'wp-row' })
    var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' })
    var pickBtn = el('button', { class: 'wp-btn', text: '选择图片…' })
    pickBtn.addEventListener('click', function () { fileInput.click() })
    addRow1.appendChild(pickBtn)
    addRow1.appendChild(el('span', { class: 'wp-file', text: '从本机选择图片（自动保存）' }))
    secList.appendChild(addRow1)
    secList.appendChild(fileInput)
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files || [])
      if (!files.length) return
      pickBtn.disabled = true
      pickBtn.textContent = '上传中…'
      var chain = Promise.resolve()
      files.forEach(function (f) {
        chain = chain.then(function () {
          return new Promise(function (resolve) {
            var reader = new FileReader()
            reader.onload = function () {
              apiPost('/upload', { name: f.name, dataUrl: reader.result }).then(function (res) {
                if (res && res.config) { state = res.config; applyConfig() }
                resolve()
              })
            }
            reader.onerror = function () { resolve() }
            reader.readAsDataURL(f)
          })
        })
      })
      chain.then(function () {
        pickBtn.disabled = false
        pickBtn.textContent = '选择图片…'
        fileInput.value = ''
      })
    })

    // 添加：路径 / URL
    var addRow2 = el('div', { class: 'wp-row' })
    var pathInput = el('input', { type: 'text', placeholder: '本地路径 或 https://…' })
    var addBtn = el('button', { class: 'wp-btn', text: '添加' })
    addBtn.addEventListener('click', function () {
      var v = pathInput.value.trim()
      if (!v) return
      var isUrl = /^https?:\/\//i.test(v)
      addBtn.disabled = true
      apiPost('/add', { source: isUrl ? 'url' : 'path', value: v }).then(function (res) {
        addBtn.disabled = false
        if (res && res.config) {
          state = res.config
          applyConfig()
          if (!res.duplicate) pathInput.value = ''
        }
      })
    })
    addRow2.appendChild(pathInput)
    addRow2.appendChild(addBtn)
    secList.appendChild(addRow2)

    // 添加：扫描目录
    var scanRow = el('div', { class: 'wp-row' })
    var dirInput = el('input', { type: 'text', placeholder: '扫描目录（批量列出图片）' })
    var scanBtn = el('button', { class: 'wp-btn', text: '扫描' })
    var scanOut = el('div', { class: 'wp-hint', text: '' })
    scanBtn.addEventListener('click', function () {
      var d = dirInput.value.trim()
      if (!d) return
      scanBtn.disabled = true
      scanOut.textContent = '扫描中…'
      apiPost('/scan', { dir: d }).then(function (res) {
        scanBtn.disabled = false
        if (res && res.ok) {
          if (!res.files.length) { scanOut.textContent = '目录中没有图片文件'; return }
          scanOut.textContent = '找到 ' + res.files.length + ' 张，已加入列表'
          // 逐个加入
          var chain = Promise.resolve()
          res.files.forEach(function (f) {
            chain = chain.then(function () {
              return apiPost('/add', { source: 'path', value: f }).then(function (r) {
                if (r && r.config) state = r.config
              })
            })
          })
          chain.then(function () { applyConfig() })
        } else {
          scanOut.textContent = '扫描失败：' + ((res && res.error) || '未知错误')
        }
      })
    })
    scanRow.appendChild(dirInput)
    scanRow.appendChild(scanBtn)
    secList.appendChild(scanRow)
    secList.appendChild(scanOut)

    // 轮换
    panelEl.appendChild(el('div', { class: 'wp-sec' }))
    var secRot = panelEl.lastChild
    secRot.appendChild(el('div', { class: 'wp-label', text: '轮换' }))
    var rotRow1 = el('div', { class: 'wp-row' })
    rotRow1.appendChild(el('span', { style: 'flex:1', text: '开启轮换' }))
    var rotSwitch = makeSwitch(function (v) {
      var next = JSON.parse(JSON.stringify(state))
      next.rotate.enabled = v
      saveConfig(next).then(restartRotate)
    })
    rotRow1.appendChild(rotSwitch)
    secRot.appendChild(rotRow1)

    var rotRow2 = el('div', { class: 'wp-row' })
    rotRow2.appendChild(el('span', { text: '间隔(秒)' }))
    var intervalInput = el('input', { type: 'number', min: 5, step: 5, style: 'width:72px' })
    intervalInput.addEventListener('change', function () {
      var next = JSON.parse(JSON.stringify(state))
      next.rotate.intervalSec = Math.max(5, Number(intervalInput.value) || 60)
      saveConfig(next).then(restartRotate)
    })
    rotRow2.appendChild(intervalInput)
    var nextBtn = el('button', { class: 'wp-btn', text: '下一张' })
    nextBtn.addEventListener('click', function () {
      if (!state || !state.images.length) return
      var entry = state.images[nextIndex()]
      var next = JSON.parse(JSON.stringify(state))
      next.currentId = entry.id
      saveConfig(next)
    })
    rotRow2.appendChild(nextBtn)
    secRot.appendChild(rotRow2)

    // 随机轮换：开关就是 rotate.order 的 random / sequential
    var rotRow3 = el('div', { class: 'wp-row' })
    rotRow3.appendChild(el('span', { style: 'flex:1', text: '随机轮换' }))
    var randomSwitch = makeSwitch(function (v) {
      var next = JSON.parse(JSON.stringify(state))
      next.rotate.order = v ? 'random' : 'sequential'
      saveConfig(next).then(restartRotate)
    }, !!(state && state.rotate && state.rotate.order === 'random'))
    rotRow3.appendChild(randomSwitch)
    secRot.appendChild(rotRow3)

    // 样式（面板里改的是「当前界面主题」那一套：深色界面改深色那组，浅色改浅色那组）
    panelEl.appendChild(el('div', { class: 'wp-sec' }))
    var secSty = panelEl.lastChild
    var styLabel = el('div', { class: 'wp-label' })
    secSty.appendChild(styLabel)

    function editingTheme() { return isDark() ? 'dark' : 'light' }

    function writeStyle(key, value) {
      var name = editingTheme()
      var next = JSON.parse(JSON.stringify(state))
      if (!next.style || (!next.style.light && !next.style.dark)) {
        next.style = { light: themeStyleOf(state, 'light'), dark: themeStyleOf(state, 'dark') }
      }
      next.style[name] = next.style[name] || themeStyleOf(state, name)
      next.style[name][key] = value
      saveConfig(next)
    }

    var fitRow = el('div', { class: 'wp-row' })
    fitRow.appendChild(el('span', { text: '适应方式' }))
    var fitSelect = el('select')
    fitSelect.appendChild(el('option', { value: 'cover', text: '铺满(裁切)' }))
    fitSelect.appendChild(el('option', { value: 'contain', text: '完整显示' }))
    fitSelect.appendChild(el('option', { value: 'fill', text: '拉伸' }))
    fitSelect.addEventListener('change', function () {
      writeStyle('fit', fitSelect.value)
    })
    fitRow.appendChild(fitSelect)
    secSty.appendChild(fitRow)

    function rangeRow(label, key, min, max, step, fmt) {
      var row = el('div', { class: 'wp-row' })
      row.appendChild(el('span', { style: 'flex:1', text: label }))
      var val = el('span', { style: 'width:44px;text-align:right;font-size:12px;color:#b6bcc4' })
      var input = el('input', { type: 'range', min: min, max: max, step: step })
      function sync() {
        val.textContent = fmt ? fmt(Number(input.value)) : input.value
      }
      input.addEventListener('input', function () {
        sync()
        writeStyle(key, Number(input.value))
      })
      row.appendChild(input)
      row.appendChild(val)
      secSty.appendChild(row)
      return { input: input, sync: sync }
    }

    var alphaRange = rangeRow('界面透明度', 'alpha', 0.05, 1, 0.01, function (v) { return Math.round(v * 100) + '%' })
    var dimRange = rangeRow('暗化遮罩', 'dim', 0, 0.8, 0.01, function (v) { return Math.round(v * 100) + '%' })
    var blurRange = rangeRow('模糊', 'blur', 0, 20, 1, function (v) { return v + 'px' })
    var opacityRange = rangeRow('壁纸不透明度', 'opacity', 0.1, 1, 0.01, function (v) { return Math.round(v * 100) + '%' })

    panelEl._syncControls = function () {
      if (!state) return
      enabledSwitch._set(!!state.enabled)
      rotSwitch._set(!!(state.rotate && state.rotate.enabled))
      intervalInput.value = state.rotate.intervalSec || 60
      randomSwitch._set(state.rotate.order === 'random')
      var name = editingTheme()
      var set = themeStyleOf(state, name)
      if (styLabel) styLabel.textContent = '样式 ·' + (name === 'dark' ? '深色' : '浅色') + '（深浅各一套）'
      fitSelect.value = set.fit
      alphaRange.input.value = set.alpha
      dimRange.input.value = set.dim
      blurRange.input.value = set.blur
      opacityRange.input.value = set.opacity
      alphaRange.sync(); dimRange.sync(); blurRange.sync(); opacityRange.sync()
    }

    document.body.appendChild(panelEl)

    // 面板内容变化（图片列表增删、展开折叠）会改变高度 —— 保持贴在按钮旁
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () {
        if (panelEl.classList.contains('wp-open')) positionPanelNearButton()
      })
      ro.observe(panelEl)
    }
  }

  // ---------- 按钮位置（可拖动 + 持久化） ----------
  var BTN_SIZE = 40
  var EDGE = 16
  var dragState = null   // { pointerId, startX, startY, originLeft, originTop, moved }
  var dragEndedAt = 0    // 上次拖动结束的时间戳（用于吞掉紧随其后的 click）

  // 读取保存的位置；返回 { left, top } 或 null
  function savedButtonPos() {
    try {
      var pos = state && state.ui && state.ui.buttonPos
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') return pos
    } catch (err) { /* ignore */ }
    return null
  }

  // 把坐标夹到视口内（留 4px 余量，避免完全贴边难以抓取）
  function clampPos(left, top) {
    var maxLeft = Math.max(4, window.innerWidth - BTN_SIZE - 4)
    var maxTop = Math.max(4, window.innerHeight - BTN_SIZE - 4)
    return {
      left: Math.min(Math.max(4, left), maxLeft),
      top: Math.min(Math.max(4, top), maxTop),
    }
  }

  // 应用按钮位置：显式 left/top，并清掉 bottom 以免互相干扰
  function applyButtonPos(pos) {
    if (!btnEl) return
    var p = clampPos(pos.left, pos.top)
    btnEl.style.left = p.left + 'px'
    btnEl.style.top = p.top + 'px'
    btnEl.style.right = 'auto'
    btnEl.style.bottom = 'auto'
    positionPanelNearButton()
    return p
  }

  // 面板跟随按钮：优先在按钮上方，空间不足则翻到下方；水平方向做边界收敛
  function positionPanelNearButton() {
    if (!panelEl || !btnEl) return
    var b = btnEl.getBoundingClientRect()
    var panelW = 300
    var gap = 8
    var ph = panelEl.classList.contains('wp-open') ? panelEl.getBoundingClientRect().height : 0

    var left = b.left
    // 水平收敛：不超出视口
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8
    if (left < 8) left = 8

    var top
    var spaceAbove = b.top - gap - 8
    if (ph > 0 && spaceAbove < ph && b.bottom + gap + ph < window.innerHeight - 8) {
      // 上方放不下、下方放得下 → 放到按钮下方
      top = b.bottom + gap
    } else {
      top = Math.max(8, b.top - gap - ph)
      // 没有高度信息时（未展开）给一个基于按钮上方的估算
      if (ph === 0) top = Math.max(8, b.top - gap - 400)
    }
    panelEl.style.left = left + 'px'
    panelEl.style.top = top + 'px'
    panelEl.style.right = 'auto'
    panelEl.style.bottom = 'auto'
  }

  function persistButtonPos(pos) {
    var p = clampPos(pos.left, pos.top)
    if (state) {
      var next = JSON.parse(JSON.stringify(state))
      next.ui = next.ui || {}
      next.ui.buttonPos = { left: Math.round(p.left), top: Math.round(p.top) }
      saveConfig(next)
    }
  }

  function buildButton() {
    btnEl = el('button', { id: 'dsh-wallpaper-btn', title: '背景壁纸设置（可拖动）', text: '🖼️' })

    // 初始位置：有保存值用它，否则左下角（换算成 left/top）
    var saved = savedButtonPos()
    if (saved) {
      applyButtonPos(saved)
    } else {
      applyButtonPos({ left: EDGE, top: window.innerHeight - BTN_SIZE - EDGE })
    }

    // —— 拖拽：pointer 事件，兼容鼠标 / 触屏 / 触控笔 ——
    btnEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return
      var rect = btnEl.getBoundingClientRect()
      dragState = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        moved: false,
      }
      try { btnEl.setPointerCapture(ev.pointerId) } catch (err) { /* ignore */ }
      btnEl.classList.add('wp-dragging')
    })

    btnEl.addEventListener('pointermove', function (ev) {
      if (!dragState || ev.pointerId !== dragState.pointerId) return
      var dx = ev.clientX - dragState.startX
      var dy = ev.clientY - dragState.startY
      // 超过 3px 才算拖动，避免误吞点击
      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true
      if (!dragState.moved) return
      ev.preventDefault()
      applyButtonPos({ left: dragState.originLeft + dx, top: dragState.originTop + dy })
    })

    function endDrag(ev) {
      if (!dragState || (ev && ev.pointerId !== undefined && ev.pointerId !== dragState.pointerId)) return
      var moved = dragState.moved
      // 位置来源用实际渲染矩形，比读 style 字符串可靠（style 可能被外部改写或带单位差异）
      var rect = btnEl.getBoundingClientRect()
      var left = rect.left
      var top = rect.top
      dragState = null
      btnEl.classList.remove('wp-dragging')
      try { btnEl.releasePointerCapture(ev && ev.pointerId) } catch (err) { /* ignore */ }
      if (moved) {
        // 拖动结束：吸附到最近的左右边缘更顺手（保持纵向位置）
        var snapped = snapToNearestEdge({ left: left, top: top })
        applyButtonPos(snapped)
        persistButtonPos(snapped)
        // 记录结束时刻：紧随其后的 click 要忽略（浏览器在 pointerup 后仍会派发 click）
        dragEndedAt = Date.now()
      }
    }

    btnEl.addEventListener('pointerup', endDrag)
    btnEl.addEventListener('pointercancel', endDrag)

    btnEl.addEventListener('click', function () {
      // 拖动刚结束的 click 是拖拽动作的副产物，忽略它
      if (Date.now() - dragEndedAt < 250) return
      if (panelEl) {
        var opening = !panelEl.classList.contains('wp-open')
        panelEl.classList.toggle('wp-open')
        if (opening) positionPanelNearButton()
      }
    })

    document.body.appendChild(btnEl)

    // 窗口尺寸变化：把按钮和面板收敛回视口内
    window.addEventListener('resize', function () {
      if (!btnEl) return
      var left = parseFloat(btnEl.style.left)
      var top = parseFloat(btnEl.style.top)
      if (isNaN(left) || isNaN(top)) return
      applyButtonPos({ left: left, top: top })
    })
  }

  // 吸附到左右边缘：选距离更近的一侧
  function snapToNearestEdge(pos) {
    var leftDist = pos.left
    var rightDist = window.innerWidth - pos.left - BTN_SIZE
    var left = leftDist <= rightDist ? 4 : window.innerWidth - BTN_SIZE - 4
    return clampPos(left, pos.top)
  }

  // ---------- 同步面板（含控件状态） ----------
  var _lastSyncSig = ''
  function syncPanel() {
    if (!panelEl || !state) return
    var listEl = document.getElementById('wp-list')
    if (!listEl) return
    listEl.innerHTML = ''
    state.images.forEach(function (img) {
      var cur = currentEntry()
      var isCur = cur && img.id === cur.id
      var row = el('div', { class: 'wp-item' })
      row.appendChild(el('span', { class: 'wp-item-name', text: img.name || img.src, title: img.src }))
      if (isCur) row.appendChild(el('span', { class: 'wp-item-cur', text: '当前' }))
      if (!isCur) {
        var setBtn = el('button', { text: '设为当前' })
        setBtn.addEventListener('click', function () {
          var next = JSON.parse(JSON.stringify(state))
          next.currentId = img.id
          saveConfig(next)
        })
        row.appendChild(setBtn)
      }
      var delBtn = el('button', { class: 'wp-del', text: '✕' })
      delBtn.title = '删除'
      delBtn.addEventListener('click', function () {
        apiPost('/remove', { id: img.id }).then(function (res) {
          if (res && res.config) { state = res.config; applyConfig(); restartRotate() }
        })
      })
      row.appendChild(delBtn)
      listEl.appendChild(row)
    })
    if (!state.images.length) {
      listEl.appendChild(el('div', { class: 'wp-hint', text: '还没有图片：选择图片、填路径/网址，或扫描目录' }))
    }
    if (panelEl._syncControls) panelEl._syncControls()
  }

  // ---------- 悬浮按钮：按配置出现/隐藏 ----------
  // 入口默认在 DSH 设置页；这里的按钮只是可选的快捷键。
  function wantsButton() {
    return !!(state && state.ui && state.ui.showButton)
  }

  function syncButtonVisibility() {
    var want = wantsButton()
    if (want) {
      if (!panelEl) buildPanel()
      if (!btnEl) {
        buildButton()
        var saved = savedButtonPos()
        if (saved) applyButtonPos(saved)
      }
      if (panelEl && panelEl._syncControls) panelEl._syncControls()
    } else {
      if (btnEl && btnEl.parentNode) btnEl.parentNode.removeChild(btnEl)
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl)
      btnEl = null
      panelEl = null
    }
  }

  // ---------- 启动 ----------
  function boot() {
    if (typeof fetch === 'undefined') return

    // 设置弹层开/关 → 切 90% 那一档（含初始化时弹层已经开着的情况）
    watchSettingsView()

    // 设置页改完配置会派发这个事件：立刻按新配置重画，不用等轮询
    window.addEventListener('dsh-wallpaper:config', function (ev) {
      try {
        var cfg = ev && ev.detail
        if (!cfg) return
        var prevId = state ? state.currentId : null
        state = cfg
        applyConfig()
        syncButtonVisibility()
        if (!prevId || prevId !== cfg.currentId) restartRotate()
      } catch (err) { /* non-fatal */ }
    })

    apiGet('/config.json').then(function (res) {
      if (res && res.config) {
        state = res.config
        applyConfig()
        restartRotate()
        syncButtonVisibility()
      }
      // 轮询：检测外部/重启后的配置变更
      setInterval(function () {
        apiGet('/config.json').then(function (res) {
          if (!res || !res.config) return
          var sig = JSON.stringify(res.config)
          if (sig !== _lastSyncSig) {
            _lastSyncSig = sig
            var prevId = state ? state.currentId : null
            state = res.config
            applyConfig()
            syncButtonVisibility()
            if (prevId !== res.config.currentId) restartRotate()
          }
        })
      }, POLL_MS)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
