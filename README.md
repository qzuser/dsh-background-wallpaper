# dsh-background-wallpaper

给 **DSH**（DeepSeek Harness）换背景图 + 多图轮换的客户端插件。

## 功能

- **更换背景图**：把 DSH 界面背景替换为指定图片
  - 从本机选择图片文件（自动复制到 `$DSH_HOME/.dsh-wallpaper-images/`）
  - 直接填本地绝对路径
  - 填 http(s) 图片网址
  - 扫描一个目录，把里面的图片批量加入列表
- **背景轮换**：多张图自动切换，间隔可调（秒）；「随机轮换」开关一拨就在随机 / 顺序之间切
- **入口在设置里**：DSH 设置 → **背景壁纸**（不再占着左下角）
- **样式微调**：铺满裁切 / 完整显示 / 拉伸、界面不透明度、暗化遮罩、模糊、壁纸不透明度
- **设置界面压暗（默认关）**：关着=设置界面和平时一样透，拉滑块能直接看见图；打开后整个设置弹层
  （任何分区）底色压到 90%，图只留一层色
- **实时预览**：样式区顶部一个小窗口，按当前页签的真实参数（图 → 底色 → 遮罩 → 界面示意）画出来，拖滑块即时变
- **深浅两套独立配置**：浅色、深色各存一组样式，各带默认值（浅色 42% / 深色 26%），改一边不动另一边；
  主题切换由 CSS 自己完成，前端不判断主题
- **可选悬浮按钮**：设置里打开后左下角出现 🖼️，可拖到任意位置并吸边；默认关掉
- 配置持久化在 `$DSH_HOME/.dsh-wallpaper.json`，重启后保留

## 使用

1. 打开 **DSH 设置 → 背景壁纸**
2. 点「选择文件」从本机挑图（可多选，自动复制进 `$DSH_HOME/.dsh-wallpaper-images/`）；
   也可以在输入框粘贴本地路径 / 网址后「添加」，或填目录后「扫描加入」
3. 在图片列表里点「设为当前」切换单张
4. 打开「自动轮换」并设间隔；想打乱顺序就把**随机轮换**开关拨开（关掉是按列表顺序一张张换）
5. 样式区先选页签：**浅色** 或 **深色**（带「· 当前」的就是界面正在用的那套），
   然后拖这个页签下的不透明度滑块——数值越大底色越实、图越淡；默认浅色 42%、深色 26%。
   想回到出厂值，点「把浅色/深色这套恢复默认」
6. 想要左下角那个快捷按钮，把「显示悬浮按钮」打开；它能拖动、松手吸边，位置会被记住

## 安装

### 方式一：`dsh plugin`（推荐）

```powershell
# 本地目录
dsh plugin --profile desktop add link:C:\path\to\dsh-background-wallpaper

# 直接从 GitHub 装（把 <user> 换成实际账号）
dsh plugin --profile desktop add git+https://github.com/<user>/dsh-background-wallpaper.git
```

### 方式二：手工安装

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-background-wallpaper"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item .\* $dst -Recurse -Force
```

然后编辑 `~/.dsh/profiles/desktop/package.json`，在 `dsh.profile.bundles` 数组里加入：

```json
"dsh-background-wallpaper"
```

最后**重启 DSH**（新增插件需要重启；面板里的改动不需要）。

## 开发

```powershell
npm test        # 四组自检：主题分层 / 配置归一化 / 设置页组件 / 悬浮按钮拖拽
```

四个套件都是纯 node（无框架、无依赖），在临时 `DSH_HOME` 里跑真实插件代码：主进程那套直接
`import` `lib/index.js` 并打真实 `/config.json` 路由；浏览器那两套各自搭一个极简 DOM 桩，
把 `assets/wallpaper-client.js` / `lib/client.js` 原样执行再断言。

```
test/theme-layer.mjs     深浅两套归一化、迁移、变量分组、设置界面压暗那一档（默认关）
test/ui-config.mjs       配置路由与校验（buttonPos、settingsDim、两套 style、白名单）
test/settings-panel.mjs  设置分区契约 + 组件交互 + 预览数值
test/drag.mjs            悬浮按钮拖动、吸边、点击/拖拽区分、位置持久化
```

CI（`.github/workflows/ci.yml`）在 Ubuntu / Windows × Node 20/22/24 上跑 `npm test`。

## 发布前要替换的两处

`package.json` 里的 `GITHUB_USER` 占位（`repository` / `homepage` / `bugs`）：

```powershell
npm pkg set repository.url="git+https://github.com/<user>/dsh-background-wallpaper.git"
npm pkg set homepage="https://github.com/<user>/dsh-background-wallpaper#readme"
npm pkg set bugs.url="https://github.com/<user>/dsh-background-wallpaper/issues"
```

## 实现说明

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 主进程 cordis 插件：注册 webserver 路由、向渲染层注入前端脚本、读写配置 |
| `lib/client.js` | 浏览器端客户端模块：在 DSH 设置里注册「背景壁纸」分区（`slots.inject('settings.section', …)`） |
| `assets/wallpaper-client.js` | 浏览器端：背景层渲染、轮换引擎、可选悬浮按钮/面板 |
| `cordis.patch.yml` | bundle 挂载声明（DSH 启动时按 bundle 层叠加） |

设置分区走 DSH 官方的客户端模块机制（和 `dsh-fish-memory` / `dsh-feiyu-mood` 同一套）：

```json
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": ["slots"], "external": ["react"] } }
```

```js
window.__ModuleLoader__.load({
  id: 'dsh-background-wallpaper',
  factory: (require) => {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots') || ctx.slots
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'wallpaper', order: 60, label: '背景壁纸' },
          () => () => React.createElement(Panel),
        ))
      },
    }
  },
})
```

注入通道同时覆盖两种形态：

- **桌面端（Electron）**：`webserver/index-inject` 结构化行（内联 script，吞掉 onerror，避免拖垮启动）
- **Web 形态（浏览器打开）**：`tapIndex` 注入 `<script defer src="/dsh-wallpaper/client.js">`

背景层实现：`#dsh-wallpaper-layer` 固定全屏、`z-index: 0`、放在 `body` 最前面，并把 DSH 的大面积背景 token
（`--dsw-alias-bg-base`、`--dsw-alias-bg-module-platform`、`--dsw-alias-bg-layer-1/2/3`、
`--dsw-specific-sidebar-fill`、`--dsw-alias-bg-overlay`）按「界面透明度」混成半透明，
让壁纸从界面缝隙里透出来，而不是粗暴地盖住整个 UI。

### 深浅两层：结构上就分开，不靠 JS 猜

DSH 的深浅两套主题把同一批 token 指向不同的静态色：浅色 `--dsw-alias-bg-base` = `#fff`，
深色（`body[data-ds-dark-theme]`）= `#151517`。同一个透明度混上去，浅色是「白纱」，深色是「黑纱」，
一套数值不可能同时服侍两边。所以 `style` 直接分成两组：

```json
"style": {
  "light": { "fit": "cover", "alpha": 0.42, "dim": 0.10, "blur": 0, "opacity": 1 },
  "dark":  { "fit": "cover", "alpha": 0.26, "dim": 0.06, "blur": 0, "opacity": 1 }
}
```

前端把两组分别写成 `--wp-alpha-light / --wp-dim-light / --wp-fit-light …` 和 `-dark` 那套，
CSS 里浅色块读 light 组、`body[data-ds-dark-theme]` 覆盖成 dark 组：

- **切换主题时没有任何 JS 参与**：浏览器按属性自己挑，刷新主题也不会有中间帧错位
- 两组的 `fit / alpha / dim / blur / opacity` 全部独立，改一边不会碰到另一边
- 设置页有「浅色 / 深色」两个页签，各带一个「恢复默认」，默认值随包自带
- 老版本的扁平 `style`（`alpha` / `darkAlpha` / `dim` …）会在读写时自动折算成两套：
  还是旧默认值的那几项换成新默认，用户自己调过的数值原样保留

有个坑值得记下来：这些变量必须挂在 `<html>` 上。CSS 里的 `var()` 是在 `body` 上求值的，
而自定义属性只沿祖先链继承 —— 早先写在 `<style>` 元素上，`<style>` 和 `body` 互不为祖先，
`var()` 就一路退到兜底值，滑块怎么拖都不生效（测试里 `B10` 专门守这一条）。

### 样式预览：按真实公式画一遍

样式区顶部有一个小窗口，按当前页签那套参数把最终效果叠出来，图层顺序和真实界面完全一致：

1. **图**：当前那张（`currentId`），`background-size` 用这套的铺法，带 `blur`、`scale`、`opacity`
2. **底色**：浅色 `rgba(255,255,255,alpha)`、深色 `rgba(21,21,23,alpha)`
3. **暗化遮罩**：`rgba(0,0,0,dim)`
4. **界面示意**：四条灰条模拟文字/控件，用来看这个通透度下图还看不看得清字

预览读的是面板的本地状态，拖滑块即时重画，不用等接口回来；切页签就换成那一套。
它**不含**"设置界面压暗"那一档 —— 预览要显示的是普通界面的样子，否则永远是糊的。
测试 `预览*` 四组断言钉住图源、铺法、底色/遮罩数值和实时更新。

### 设置界面压暗背景（默认关）

**默认关**：进设置弹层时和普通界面完全一样透 —— 拉滑块能直接看见背景图怎么变，这是调壁纸时最需要的。
开关在「样式」页签上方：`设置界面压暗背景`，写进配置的 `ui.settingsDim`。

打开后：整个设置弹层（任何分区，不只是本插件这一页）底色压到九成（`--wp-tint: 90%`），图只剩一层色；
弹层背后那层遮罩（`--dsw-alias-bg-mask-1`）同时压到同一档，所以整屏是一层主题色，而不是「对话框实、
四周还透」；暗化遮罩归零，避免黑上加黑。退出设置立刻回到该主题原本的数值，**普通界面里图照常显示**。

触发条件三路，互为备份 —— 全部只认稳定特征，**不碰会随构建变化的哈希类名**
（同一个弹层，旧版是 `tklpSG_overlay`，新版是 `Vn-AbG_overlay`），并且三条都还要求 `.dsh-wallpaper-dim-on`
（即 `ui.settingsDim` 为真），开关关着时一条都不匹配：

| 入口 | 覆盖范围 | 依赖 |
| --- | --- | --- |
| `html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-on body{…}` | 整个设置弹层 | `MutationObserver` 盯 `document.body` 的 `childList`，弹层开关即切换 |
| `html.dsh-wallpaper-on.dsh-wallpaper-dim-on.dsh-wallpaper-settings-panel body{…}` | 本插件设置页 | 插件设置页挂载时给 `<html>` 打标记，卸载即移除 |
| `html.dsh-wallpaper-on.dsh-wallpaper-dim-on body:has([data-shortcut-modal="settings"]){…}` | 整个设置弹层 | 纯 CSS，不依赖任何 JS |

三条都排在基础规则之后，靠顺序 + 稍高的特异性覆盖，且都带前提选择器，不会漏到普通界面。
`:has` 那条**单独成条**：万一运行时不支持 `:has()`，只是这一条整体失效，靠 class 的两条照常工作
（`C3` 测试同时钉住「无哈希类名」「`:has` 只认稳定属性」「独立成条」三件事）。

测试 `C1`（数值）、`C1b`（方向：90 必须大于浅色 42 / 深色 26）、`C2`（顺序与作用域）、`C3`（触发条件）、
`C4`（遮罩同步压）、`C5`（开关弹层时的 class 切换）、`C6`（无弹层时不动）、`C7`（开关默认关、开启才挂
`dim-on`、壁纸关掉不挂、三条规则全部带前提）钉住这一档。

设置弹层的稳定特征：`data-shortcut-modal="settings"`，以及 DSH 自己的模态层约定
`[role="dialog"][aria-modal="true"]`。

按钮拖拽（仅在设置里打开「显示悬浮按钮」后生效）用指针事件（`pointerdown/move/up`），鼠标、触屏、触控笔通用：

- 位移超过 3px 才判定为拖动，避免把点击误判成拖拽
- 拖动中加 `.wp-dragging`（`cursor:grabbing`、关掉 hover 缩放与过渡，保证跟手）
- 松手吸附到最近的左右边缘，纵向位置保持不变
- 用「拖动结束时间戳 + 250ms 窗口」吞掉 pointerup 之后浏览器补发的 click，避免拖完误开面板
- 窗口缩放时把位置夹回视口内，不会拖丢到屏幕外
- 面板跟随按钮：默认贴按钮上方，上方空间不足则翻到下方，水平方向自动收敛进视口
- 位置存进配置的 `ui.buttonPos`，后端 `normalizeConfig` 会取整并拒绝非数值/非有限值

## HTTP 接口（本机回环，供前端面板使用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-wallpaper/client.js` | 前端脚本 |
| GET/POST | `/dsh-wallpaper/config.json` | 读 / 保存配置 |
| POST | `/dsh-wallpaper/add` | 添加图片 `{source:'path'\|'url', value}` |
| POST | `/dsh-wallpaper/upload` | 上传图片 `{name, dataUrl}` |
| POST | `/dsh-wallpaper/remove` | 删除条目 `{id}` |
| POST | `/dsh-wallpaper/scan` | 扫描目录 `{dir}` |
| GET | `/dsh-wallpaper/image?src=` | 返回已登记图片字节 |

## 注意

- 插件只做本机请求：路由自带回环 Host / 同源校验，写方法仅接受回环地址。
- 上传的图片存在 `$DSH_HOME/.dsh-wallpaper-images/`，不受 DSH 升级影响。
- 若之后运行 `pnpm install` 清掉了手工放置的插件目录，请改用「方式一」重新安装。

MIT License
