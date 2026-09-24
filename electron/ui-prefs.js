/**
 * 界面偏好持久化 —— 读写 userData/ui-prefs.json
 *
 * 为什么单独一个文件而不是塞进 config.json：
 * config.json 由设置页整体回写（store.save 以整份配置为单位），
 * 侧栏收起这类随时切换的界面状态混在里面，会被「保存设置」的旧快照覆盖
 * （与 terminal-layout.js 同一个理由）。
 *
 * 存什么：纯外观状态（主题、侧栏是否收起、终端字号与字体）。不含任何业务数据与凭据。
 *
 * 注意：save() 是以整份偏好为单位写入的（normalize 会补齐缺失键），
 * 因此调用方改一个字段时必须把**当前完整的偏好**一起传回，
 * 只传被改的字段会把其他字段重置为默认值。
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

function file() {
  return path.join(app.getPath('userData'), 'ui-prefs.json')
}

/** 终端字号范围（与渲染层的加减按钮共用同一组边界） */
const FONT_SIZE_MIN = 11
const FONT_SIZE_MAX = 22
const FONT_SIZE_DEFAULT = 13

/** 只保存单个本机字体名称，空字符串表示使用终端默认回退字体。 */
function normalizeFontFamily(value) {
  if (typeof value !== 'string' || /["',;{}\\\u0000-\u001f\u007f-\u009f]/.test(value)) return ''
  const family = value.trim()
  return family.length <= 100 ? family : ''
}

/** 只认已知键：脏值一律回落默认，不把不可信内容带回渲染层 */
function normalize(raw) {
  const size = Number(raw?.terminalFontSize)
  return {
    theme: raw?.theme === 'dark' ? 'dark' : 'light',
    sidebarCollapsed: raw?.sidebarCollapsed === true,
    terminalFontSize: Number.isFinite(size)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
      : FONT_SIZE_DEFAULT,
    terminalFontFamily: normalizeFontFamily(raw?.terminalFontFamily),
  }
}

/** 读取界面偏好；文件缺失/损坏时返回默认值 */
function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(file(), 'utf8')))
  } catch {
    return normalize(null)
  }
}

/** 写入界面偏好（原子替换：先写临时文件再 rename，避免半截文件） */
function save(prefs) {
  const data = normalize(prefs)
  const target = file()
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, target)
    return { ok: true, prefs: data }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响主流程 */ }
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

module.exports = { load, save, file }
