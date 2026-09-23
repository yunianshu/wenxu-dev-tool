/**
 * 主进程/脚本语法自测（无框架，node scripts/syntax-check-selftest.cjs 直接运行）
 *
 * 背景：main.js 属于「只在 Electron 启动时才解析」的文件——渲染层构建、单元自测、打包冒烟
 * 都不会解析它。曾因一次编辑吞掉换行产生 `})ipcMain.handle(...)`，导致打包后应用启动即弹
 * 「A JavaScript error occurred in the main process」，而所有测试都是绿的。
 * 因此这里对 electron/、backend/ 与 scripts/ 下所有 .js/.cjs 逐个做 `node --check`，把这类语法错误
 * 拦在提交之前；同时校验打包产物里的 main.js（若存在 release 目录）能通过语法检查。
 * backend/entry.cjs 是 Tauri 版真正的后台入口（src-tauri/src/backend.rs 启动的就是它），
 * 同样属于「只在启动时才解析」的文件，必须进这份清单。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')

function listJs(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listJs(abs))
    else if (/\.(js|cjs|mjs)$/.test(ent.name)) out.push(abs)
  }
  return out
}

function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  return r.status === 0 ? null : String(r.stderr || '').split('\n').slice(0, 4).join(' | ')
}

const files = [...listJs(path.join(root, 'electron')), ...listJs(path.join(root, 'backend')), ...listJs(path.join(root, 'scripts'))]
  .filter((f) => !/node_modules/.test(f))
assert.ok(files.length > 20, `待检查的脚本数量异常：${files.length}`)

const bad = []
for (const f of files) {
  const err = checkSyntax(f)
  if (err) bad.push(`${path.relative(root, f)} → ${err}`)
}
for (const b of bad) console.error('  语法错误:', b)
assert.strictEqual(bad.length, 0, `${bad.length} 个文件存在语法错误`)

// 打包产物（存在时）里的 main.js 也必须能解析：应用启动路径的真实防线。
// 只看最新一次构建（历史版本目录可能保留着旧的、已被后续提交修复的产物）
const releaseDir = path.join(root, 'release')
let asarChecked = 0
if (fs.existsSync(releaseDir)) {
  const versions = fs.readdirSync(releaseDir)
    .filter((v) => fs.existsSync(path.join(releaseDir, v, 'win-unpacked', 'resources', 'app.asar')))
    .map((v) => ({ v, mtime: fs.statSync(path.join(releaseDir, v)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { v } of versions.slice(0, 1)) {
    const asarPath = path.join(releaseDir, v, 'win-unpacked', 'resources', 'app.asar')
    const tmp = path.join(require('os').tmpdir(), `syntax-check-${v}-main.js`)
    try {
      require('@electron/asar').extractFile(asarPath, path.join('electron', 'main.js'))
      fs.writeFileSync(tmp, require('@electron/asar').extractFile(asarPath, path.join('electron', 'main.js')))
      const err = checkSyntax(tmp)
      assert.strictEqual(err, null, `打包产物 v${v} 的 electron/main.js 语法错误：${err}`)
      asarChecked += 1
    } catch (e) {
      if (!/was not found in this archive/.test(String(e && e.message))) throw e
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
}

console.log(`语法检查通过：${files.length} 个脚本${asarChecked ? ` + ${asarChecked} 份打包产物 main.js` : ''}`)
