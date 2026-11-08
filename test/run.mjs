// 跑全部自检：node test/run.mjs（或 npm test）
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUITES = [
  ['主题分层', 'theme-layer.mjs'],
  ['配置归一化', 'ui-config.mjs'],
  ['设置页组件', 'settings-panel.mjs'],
  ['悬浮按钮拖拽', 'drag.mjs'],
  ['真机渲染', 'paint-probe.mjs'],
]

let failed = 0
let ran = 0
for (const [label, file] of SUITES) {
  const abs = fileURLToPath(new URL('./' + file, import.meta.url))
  process.stdout.write('\n=== ' + label + ' (' + file + ')\n')
  const r = spawnSync(process.execPath, [abs], { stdio: 'inherit' })
  if (r.status === 0) ran++
  else failed++
}

process.stdout.write('\n' + (failed === 0
  ? '全部通过（' + ran + '/' + SUITES.length + ' 组）\n'
  : failed + ' 组未通过\n'))
process.exit(failed === 0 ? 0 : 1)
