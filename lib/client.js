/**
 * dsh-background-wallpaper — 浏览器半边（DSH 设置里的「背景壁纸」一项）
 * ============================================================================
 * 自注册约定（与 dsh-feiyu-mood / dsh-fish-memory 一致）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 这一版的入口从「左下角悬浮按钮」搬进了 **DSH 自己的设置页**：
 *   - 设置 → 背景壁纸：开关、图片列表、添加/扫描、轮换、样式
 *   - 悬浮按钮改成设置里的一个开关（默认关），想留着的自己打开
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-background-wallpaper',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-wallpaper'

    const getJson = async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const postJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    const imageUrl = (entry) => {
      if (!entry) return ''
      if (entry.kind === 'url') return entry.src
      return API + '/image?src=' + encodeURIComponent(entry.src)
    }

    // 深浅两套默认值，与主进程 defaultConfig 保持一致
    const THEME_DEFAULTS = {
      light: { fit: 'cover', alpha: 0.42, dim: 0.10, blur: 0, opacity: 1 },
      dark: { fit: 'cover', alpha: 0.26, dim: 0.06, blur: 0, opacity: 1 },
    }
    const THEME_LABEL = { light: '浅色', dark: '深色' }

    const clamp = (v, fb, min, max) => {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : fb
      return Math.min(max, Math.max(min, n))
    }

    // 取某一套（兼容老的扁平结构）
    const themeSetOf = (cfg, name) => {
      const def = THEME_DEFAULTS[name]
      const style = (cfg && cfg.style) || {}
      let raw
      if (style.light || style.dark) {
        raw = style[name]
      } else if (name === 'dark') {
        raw = {
          fit: style.fit,
          alpha: style.darkAlpha,
          dim: typeof style.dim === 'number' ? style.dim * 0.3 : undefined,
          blur: style.blur,
          opacity: style.opacity,
        }
      } else {
        raw = { fit: style.fit, alpha: style.alpha, dim: style.dim, blur: style.blur, opacity: style.opacity }
      }
      const s = (raw && typeof raw === 'object') ? raw : {}
      return {
        fit: s.fit === 'cover' || s.fit === 'contain' || s.fit === 'fill' ? s.fit : def.fit,
        alpha: clamp(s.alpha, def.alpha, 0.05, 1),
        dim: clamp(s.dim, def.dim, 0, 1),
        blur: clamp(s.blur, def.blur, 0, 40),
        opacity: clamp(s.opacity, def.opacity, 0.05, 1),
      }
    }

    // DSH 现在显示的是哪一套：body 带 data-ds-dark-theme 就是深色
    const currentTheme = () => {
      const b = typeof document !== 'undefined' ? document.body : null
      return b && typeof b.hasAttribute === 'function' && b.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
    }

    // 改动落到宿主后，顺手通知背景层立刻重画（不用等它的轮询）
    const publish = (cfg) => {
      try {
        window.dispatchEvent(new CustomEvent('dsh-wallpaper:config', { detail: cfg }))
      } catch (err) { /* ignore */ }
    }

    const CSS = `
[data-wp-wrap]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;max-width:640px}
[data-wp-sec]{display:flex;flex-direction:column;gap:8px}
[data-wp-h]{font-size:13px;font-weight:600;opacity:.85;padding-top:10px;border-top:1px solid rgba(127,127,127,.18)}
[data-wp-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[data-wp-label]{font-size:13px;min-width:76px}
[data-wp-note]{font-size:12px;opacity:.62;line-height:1.55}
[data-wp-input]{padding:6px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;min-width:130px}
[data-wp-input]:focus{outline:none;border-color:rgba(86,134,254,.9)}
[data-wp-grow]{flex:1;min-width:180px}
[data-wp-btn]{padding:5px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer}
[data-wp-btn]:hover{background:rgba(127,127,127,.14)}
[data-wp-btn][data-primary]{background:rgba(86,134,254,.92);border-color:transparent;color:#fff}
[data-wp-btn][data-primary]:hover{background:rgba(107,146,255,1)}
[data-wp-btn]:disabled{opacity:.42;cursor:default}
[data-wp-tabs]{display:flex;gap:6px;margin:2px 0 2px}
[data-wp-tab]{padding:5px 14px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:12px;cursor:pointer}
[data-wp-tab]:hover{background:rgba(127,127,127,.14)}
[data-wp-tab][data-active="1"]{background:rgba(86,134,254,.92);border-color:transparent;color:#fff}
[data-wp-list]{display:flex;flex-direction:column;gap:6px}
[data-wp-item]{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:8px}
[data-wp-item]:hover{background:rgba(127,127,127,.10)}
[data-wp-thumb]{width:38px;height:26px;border-radius:5px;object-fit:cover;flex:none;background:rgba(127,127,127,.18)}
[data-wp-name]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.9}
[data-wp-cur]{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid rgba(86,134,254,.55);color:rgba(86,134,254,1);flex:none}
[data-wp-range]{flex:1;min-width:120px;accent-color:#5686fe}
[data-wp-val]{font-size:12px;opacity:.7;width:42px;text-align:right;flex:none}
[data-wp-msg]{font-size:12px;min-height:16px;opacity:.8}
[data-wp-msg][data-err]{color:#ff7b72}
[data-wp-msg][data-ok]{color:#4ec9a0}
[data-wp-sw]{position:relative;display:inline-block;width:34px;height:18px;flex:none;cursor:pointer}
[data-wp-sw] input{opacity:0;width:0;height:0;position:absolute}
[data-wp-sw] i{position:absolute;inset:0;border-radius:999px;background:rgba(127,127,127,.42);transition:background .15s}
[data-wp-sw] i:before{content:"";position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:2px;left:2px;transition:transform .15s}
[data-wp-sw] input:checked + i{background:rgba(86,134,254,.95)}
[data-wp-sw] input:checked + i:before{transform:translateX(16px)}
[data-wp-empty]{font-size:12px;opacity:.55;padding:4px 2px}
[data-wp-prev]{position:relative;height:136px;border-radius:10px;overflow:hidden;border:1px solid rgba(127,127,127,.3);background:#000;margin:8px 0 2px;isolation:isolate}
[data-wp-prev-img]{position:absolute;inset:-24px;background-position:center;background-repeat:no-repeat;transform-origin:center;z-index:0}
[data-wp-prev-tint],[data-wp-prev-dim]{position:absolute;inset:0;z-index:1;pointer-events:none}
[data-wp-prev-dim]{z-index:2}
[data-wp-prev-ui]{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;justify-content:center;gap:9px;padding:0 18px;pointer-events:none}
[data-wp-prev-bar]{display:block;height:9px;border-radius:5px}
[data-wp-prev-tag]{position:absolute;right:8px;top:8px;z-index:4;font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(0,0,0,.42);color:#fff;letter-spacing:.02em}
`

    // ---------- 小控件 ----------
    function Row(props) {
      return h('div', { 'data-wp-row': '' }, props.children)
    }
    function Label(props) {
      return h('span', { 'data-wp-label': '' }, props.children)
    }
    function Switch(props) {
      return h('label', { 'data-wp-sw': '' },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: (e) => props.onChange(e.target.checked),
        }),
        h('i', {}),
      )
    }
    function Btn(props) {
      return h('button', {
        'data-wp-btn': '',
        ...(props.primary ? { 'data-primary': '' } : {}),
        disabled: !!props.disabled,
        onClick: props.onClick,
      }, props.children)
    }
    function Range(props) {
      return h(Row, {},
        h(Label, {}, props.label),
        h('input', {
          'data-wp-range': '',
          type: 'range',
          min: props.min, max: props.max, step: props.step,
          value: props.value,
          onChange: (e) => props.onChange(Number(e.target.value)),
        }),
        h('span', { 'data-wp-val': '' }, props.display != null ? props.display : String(props.value)),
      )
    }

    // 样式预览：把当前页签那套参数按真实公式画进一个小窗口。
    // 顺序和主界面一致：图 → 底色（白/深色，alpha）→（可选的）暗化遮罩 → 界面内容。
    function Preview(props) {
      const st = props.st || THEME_DEFAULTS[props.theme]
      const dark = props.theme === 'dark'
      const src = imageUrl(props.entry)
      const uiInk = dark ? 'rgba(255,255,255,.34)' : 'rgba(0,0,0,.30)'
      return h('div', { 'data-wp-prev': '', 'data-wp-prev-theme': props.theme },
        h('div', {
          'data-wp-prev-img': '',
          'data-wp-prev-has': src ? '1' : '0',
          style: {
            backgroundImage: src ? 'url("' + src + '")' : 'none',
            backgroundSize: st.fit,
            filter: 'blur(' + st.blur + 'px)',
            transform: 'scale(' + (1 + st.blur * 0.02).toFixed(3) + ')',
            opacity: String(st.opacity),
          },
        }),
        h('div', {
          'data-wp-prev-tint': '',
          style: { background: 'rgba(' + (dark ? '21,21,23' : '255,255,255') + ',' + st.alpha + ')' },
        }),
        h('div', {
          'data-wp-prev-dim': '',
          style: { background: 'rgba(0,0,0,' + st.dim + ')' },
        }),
        h('div', { 'data-wp-prev-ui': '' },
          [38, 72, 54, 64].map((w, i) => h('i', {
            key: i,
            'data-wp-prev-bar': '',
            style: { width: w + '%', background: uiInk },
          })),
        ),
        h('span', { 'data-wp-prev-tag': '' },
          THEME_LABEL[props.theme] + '预览' + (src ? '' : ' · 还没选图')),
      )
    }

    // ---------- 设置面板 ----------
    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [pathInput, setPathInput] = React.useState('')
      const [dirInput, setDirInput] = React.useState('')
      // 样式编辑目标：浅色 / 深色 两套，互不影响；默认落在当前界面用的那套
      const [theme, setTheme] = React.useState(currentTheme)

      const say = (text, isErr) => { setMsg(text || ''); setErr(!!isErr) }

      const load = async () => {
        try {
          const res = await getJson(API + '/config.json')
          setCfg(res.config)
        } catch (e) {
          say('读取配置失败：' + e.message, true)
        }
      }
      React.useEffect(() => { load() }, [])

      // 本设置页挂载期间在 <html> 上打个兜底标记：背景层据此把这一屏固定成 90% 底色。
      // 整个设置弹层的开关由背景层的 MutationObserver 负责（认 data-shortcut-modal="settings"），
      // 这里只是插件自己的页面标记，两者互不覆盖。
      React.useEffect(() => {
        const root = typeof document !== 'undefined' ? document.documentElement : null
        if (!root || !root.classList) return undefined
        root.classList.add('dsh-wallpaper-settings-panel')
        return () => { if (root.classList) root.classList.remove('dsh-wallpaper-settings-panel') }
      }, [])

      // 用最新配置整体保存（宿主会做归一化，回写后以宿主为准）
      const save = async (next) => {
        setCfg(next)
        publish(next)
        try {
          const res = await postJson(API + '/config.json', { config: next })
          if (res && res.config) { setCfg(res.config); publish(res.config) }
          return res
        } catch (e) {
          say('保存失败：' + e.message, true)
          return null
        }
      }

      const patch = (fn) => {
        if (!cfg) return
        const next = JSON.parse(JSON.stringify(cfg))
        fn(next)
        return save(next)
      }

      const withBusy = async (fn, okText) => {
        setBusy(true)
        try {
          const out = await fn()
          if (okText) say(okText, false)
          return out
        } catch (e) {
          say(e.message || String(e), true)
        } finally {
          setBusy(false)
        }
      }

      const onPickFiles = async (fileList) => {
        const files = Array.from(fileList || [])
        if (!files.length) return
        await withBusy(async () => {
          let added = 0
          for (const f of files) {
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader()
              fr.onload = () => resolve(String(fr.result))
              fr.onerror = () => reject(new Error('读取文件失败'))
              fr.readAsDataURL(f)
            })
            const res = await postJson(API + '/upload', { name: f.name, dataUrl })
            if (res && res.config) { setCfg(res.config); publish(res.config) }
            if (res && res.entry) added++
          }
          say(added ? ('已添加 ' + added + ' 张') : '没有新增（可能重复）', false)
        })
      }

      const onAddPath = () => withBusy(async () => {
        const v = pathInput.trim()
        if (!v) throw new Error('先填路径或网址')
        const isUrl = /^https?:\/\//i.test(v)
        const res = await postJson(API + '/add', { source: isUrl ? 'url' : 'path', value: v })
        if (res && res.config) { setCfg(res.config); publish(res.config) }
        if (res && res.duplicate) say('这张已经在列表里了', false)
        else { say('已添加', false); setPathInput('') }
      })

      const onScan = () => withBusy(async () => {
        const d = dirInput.trim()
        if (!d) throw new Error('先填目录')
        const res = await postJson(API + '/scan', { dir: d })
        const files = (res && res.files) || []
        if (!files.length) { say('这个目录里没找到图片', true); return }
        let added = 0
        for (const f of files) {
          const r = await postJson(API + '/add', { source: 'path', value: f })
          if (r && r.config) { setCfg(r.config); publish(r.config) }
          if (r && r.entry) added++
        }
        say('扫描到 ' + files.length + ' 张，新增 ' + added + ' 张', false)
      })

      const onRemove = (id) => withBusy(async () => {
        const res = await postJson(API + '/remove', { id })
        if (res && res.config) { setCfg(res.config); publish(res.config) }
        say('已删除', false)
      })

      const onNext = () => {
        if (!cfg || !cfg.images.length) return
        const idx = cfg.images.findIndex((i) => i.id === cfg.currentId)
        const nextIdx = (idx + 1) % cfg.images.length
        patch((n) => { n.currentId = n.images[nextIdx].id })
      }

      if (!cfg) {
        return h('div', { 'data-wp-wrap': '' },
          h('div', { 'data-wp-note': '' }, '正在读取配置…'),
          msg ? h('div', { 'data-wp-msg': '', 'data-err': err ? '' : undefined }, msg) : null,
        )
      }

      const rotate = cfg.rotate || {}
      const ui = cfg.ui || {}
      const cur = cfg.images.find((i) => i.id === cfg.currentId) || null

      // 当前编辑的那一套（浅色 / 深色）
      const st = themeSetOf(cfg, theme)

      const writeTheme = (key, value) => patch((n) => {
        if (!n.style || (!n.style.light && !n.style.dark)) {
          // 老结构先摊平成两套，避免半截数据
          n.style = { light: themeSetOf(n, 'light'), dark: themeSetOf(n, 'dark') }
        }
        n.style[theme] = n.style[theme] || themeSetOf(n, theme)
        n.style[theme][key] = value
      })

      const resetTheme = () => patch((n) => {
        if (!n.style) n.style = {}
        n.style[theme] = { ...THEME_DEFAULTS[theme] }
      })

      return h('div', { 'data-wp-wrap': '' },

        h('div', { 'data-wp-note': '' },
          '把 DSH 的界面背景换成自己的图。DSH 的大块背景会被调成半透明，让图从缝隙里透出来，' +
          '输入框和气泡这些小块仍保持原样，不影响阅读。'),

        /* —— 总开关 —— */
        h(Row, {},
          h(Switch, {
            checked: !!cfg.enabled,
            onChange: (v) => patch((n) => { n.enabled = v }),
          }),
          h(Label, {}, '启用背景壁纸'),
        ),

        /* —— 图片列表 —— */
        h('div', { 'data-wp-sec': '' },
          h('div', { 'data-wp-h': '' }, '图片'),
          cfg.images.length === 0
            ? h('div', { 'data-wp-empty': '' }, '还没有图片，从下面添加（本机文件 / 路径 / 网址 / 扫目录）')
            : h('div', { 'data-wp-list': '' },
              cfg.images.map((img) => h('div', { 'data-wp-item': '', key: img.id },
                h('img', { 'data-wp-thumb': '', src: imageUrl(img), alt: '', loading: 'lazy' }),
                h('span', { 'data-wp-name': '', title: img.src }, img.name || img.src),
                img.id === cfg.currentId ? h('span', { 'data-wp-cur': '' }, '当前') : null,
                img.id === cfg.currentId ? null : h(Btn, {
                  onClick: () => patch((n) => { n.currentId = img.id }),
                }, '设为当前'),
                h(Btn, { onClick: () => onRemove(img.id), disabled: busy }, '✕'),
              )),
            ),
        ),

        /* —— 添加 —— */
        h('div', { 'data-wp-sec': '' },
          h('div', { 'data-wp-h': '' }, '添加'),
          h(Row, {},
            h('input', {
              'data-wp-input': '', type: 'file', multiple: true,
              accept: 'image/*',
              onChange: (e) => { onPickFiles(e.target.files); e.target.value = '' },
            }),
            h('span', { 'data-wp-note': '' }, '选本机图片，会复制进 DSH 目录'),
          ),
          h(Row, {},
            h('input', {
              'data-wp-input': '', 'data-wp-grow': '', type: 'text',
              placeholder: '本机路径 或 图片网址',
              value: pathInput,
              onChange: (e) => setPathInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') onAddPath() },
            }),
            h(Btn, { onClick: onAddPath, disabled: busy }, '添加'),
          ),
          h(Row, {},
            h('input', {
              'data-wp-input': '', 'data-wp-grow': '', type: 'text',
              placeholder: '目录路径，例如 D:\\Pictures\\wallpaper',
              value: dirInput,
              onChange: (e) => setDirInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') onScan() },
            }),
            h(Btn, { onClick: onScan, disabled: busy }, '扫描加入'),
          ),
        ),

        /* —— 轮换 —— */
        h('div', { 'data-wp-sec': '' },
          h('div', { 'data-wp-h': '' }, '轮换'),
          h(Row, {},
            h(Switch, {
              checked: !!rotate.enabled,
              onChange: (v) => patch((n) => { n.rotate.enabled = v }),
            }),
            h(Label, {}, '自动轮换'),
            h(Btn, { onClick: onNext, disabled: busy || cfg.images.length < 2 }, '下一张'),
          ),
          h(Row, {},
            h(Label, {}, '间隔（秒）'),
            h('input', {
              'data-wp-input': '', type: 'number', min: 5, max: 86400,
              value: rotate.intervalSec != null ? rotate.intervalSec : 60,
              onChange: (e) => {
                const v = Number(e.target.value)
                if (!Number.isFinite(v)) return
                patch((n) => { n.rotate.intervalSec = Math.max(5, Math.min(86400, Math.round(v))) })
              },
            }),
          ),
          // 随机轮换：开关就是 rotate.order 的 random / sequential
          h(Row, {},
            h(Switch, {
              checked: (rotate.order || 'sequential') === 'random',
              onChange: (v) => patch((n) => { n.rotate.order = v ? 'random' : 'sequential' }),
            }),
            h(Label, {}, '随机轮换'),
            h('span', { 'data-wp-val': '' }, (rotate.order || 'sequential') === 'random' ? '随机' : '顺序'),
          ),
          h('div', { 'data-wp-note': '' },
            '开：每次从列表里随机挑一张，不会连着重复同一张；关：按列表顺序一张张往下换。' +
            '改完立刻按新方式继续，不用等下一个间隔。'),
        ),

        /* —— 样式：深浅两套 —— */
        h('div', { 'data-wp-sec': '' },
          h('div', { 'data-wp-h': '' }, '样式'),
          h('div', { 'data-wp-tabs': '' },
            ['light', 'dark'].map((t) => h('button', {
              key: t,
              type: 'button',
              'data-wp-tab': '',
              'data-active': theme === t ? '1' : '0',
              onClick: () => setTheme(t),
            }, THEME_LABEL[t] + (currentTheme() === t ? ' · 当前' : ''))),
          ),
          h(Preview, { entry: cur, theme, st }),
          h('div', { 'data-wp-note': '' },
            '预览按当前页签这套参数画（不受设置界面那档 90% 影响）。深浅各一套，各自独立保存；' +
            '进设置界面时底色会临时压到 90%（图只剩一层色），退出设置就恢复，不影响这里设的值。'),
          h(Row, {},
            h(Label, {}, '铺法'),
            h('select', {
              'data-wp-input': '',
              value: st.fit,
              onChange: (e) => writeTheme('fit', e.target.value),
            },
              h('option', { value: 'cover' }, '铺满裁切'),
              h('option', { value: 'contain' }, '完整显示'),
              h('option', { value: 'fill' }, '拉伸填满'),
            ),
          ),
          h(Range, {
            label: THEME_LABEL[theme] + '界面不透明度', min: 5, max: 100, step: 1,
            value: Math.round(st.alpha * 100),
            display: Math.round(st.alpha * 100) + '%',
            onChange: (v) => writeTheme('alpha', v / 100),
          }),
          h('div', { 'data-wp-note': '' },
            theme === 'light'
              ? '底色盖在图上：数值越大底色越实、图越淡；越小则图越明显。浅色默认 42%。'
              : '底色盖在图上：数值越大底色越实、图越淡。深色底色接近纯黑，所以默认比浅色低（26%）。'),
          h(Range, {
            label: THEME_LABEL[theme] + '暗化遮罩', min: 0, max: 100, step: 1,
            value: Math.round(st.dim * 100),
            display: Math.round(st.dim * 100) + '%',
            onChange: (v) => writeTheme('dim', v / 100),
          }),
          h('div', { 'data-wp-note': '' }, '在图上面压一层黑，用来压住过亮的图；浅色默认 10%，深色 6%。'),
          h(Range, {
            label: THEME_LABEL[theme] + '模糊', min: 0, max: 40, step: 1,
            value: Math.round(st.blur),
            display: Math.round(st.blur) + 'px',
            onChange: (v) => writeTheme('blur', v),
          }),
          h(Range, {
            label: THEME_LABEL[theme] + '图不透明度', min: 10, max: 100, step: 1,
            value: Math.round(st.opacity * 100),
            display: Math.round(st.opacity * 100) + '%',
            onChange: (v) => writeTheme('opacity', v / 100),
          }),
          h(Row, {},
            h(Btn, { onClick: resetTheme }, '把' + THEME_LABEL[theme] + '这套恢复默认'),
          ),
          cur ? h('div', { 'data-wp-note': '' }, '当前图：' + (cur.name || cur.src)) : null,
        ),

        /* —— 悬浮按钮 —— */
        h('div', { 'data-wp-sec': '' },
          h('div', { 'data-wp-h': '' }, '快捷按钮'),
          h(Row, {},
            h(Switch, {
              checked: !!ui.showButton,
              onChange: (v) => patch((n) => { n.ui.showButton = v }),
            }),
            h(Label, {}, '显示悬浮按钮'),
          ),
          h('div', { 'data-wp-note': '' },
            '默认关掉 —— 入口就在这一页。打开后左下角会出现 🖼️ 按钮，可以拖到任意位置，位置会被记住。'),
        ),

        h('div', { 'data-wp-msg': '', ...(msg ? (err ? { 'data-err': '' } : { 'data-ok': '' }) : {}) }, msg),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-background-wallpaper')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-background-wallpaper: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'wallpaper', order: 60, label: '背景壁纸' },
          () => h(Panel),
        ))
      },
    }
  },
})
