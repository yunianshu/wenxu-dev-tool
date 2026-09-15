/**
 * 终端工作台布局持久化 —— 读写 userData/terminal-layout.json
 *
 * 为什么单独一个文件而不是塞进 config.json：
 * config.json 由 settings 页整体回写（store.save 以整份配置为单位），
 * 布局如果混在里面，会被「保存设置」的旧快照覆盖；终端布局的写入时机
 * 完全不同（拖动分屏/换项目/加窗格时随时写），独立文件各自演进更安全。
 *
 * 存什么：窗格顺序、每个窗格绑定的项目、shell 选择、分屏尺寸。
 * 不存什么：pty 进程本身（进程不跨应用重启），下次启动按项目重开会话。
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

/** 布局版本：结构变化时递增，旧版本布局直接忽略（不猜测迁移） */
const LAYOUT_VERSION = 1

function file() {
  return path.join(app.getPath('userData'), 'terminal-layout.json')
}

/** 归一化单个窗格：脏数据一律丢弃，不把不可信内容带进渲染层 */
function normalizePane(raw) {
  if (!raw || typeof raw !== 'object') return null
  const projectId = String(raw.projectId || '')
  if (!projectId) return null
  const width = Number(raw.width)
  return {
    projectId,
    // shellId：'' = 按优先级自动（pwsh 7 → 5.1）；具体 id 由 pty-service 校验
    shellId: String(raw.shellId || ''),
    // 用户自定的窗格标题（留空则显示项目名）
    title: String(raw.title || ''),
    // 分屏比例（0~1），仅在两窗格共享一行/列时有意义
    width: Number.isFinite(width) && width > 0 && width < 1 ? width : 0.5,
  }
}

/** 分屏方式白名单：与渲染层的预设保持一致，脏值一律回落 auto */
const GRID_MODES = ['auto', '1x2', '2x1', '2x2', '3x1']

/** 单个方向的轨道数上限（四宫格 2、竖排按窗格数最多 4，留些余量） */
const MAX_TRACKS = 12

/**
 * 归一化轨道比例序列：只接受 (0,1] 之间的有限数。
 * 长度随分屏方式变化——「上下」4 个窗格就是 4 行 4 个比例，
 * 所以按 1~MAX_TRACKS 个都收，不能固定成两位（固定两位会让多出来的轨道
 * 落到隐式 auto 轨道上，把窗格挤成几像素高）。
 */
function normalizeShares(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const nums = value.slice(0, MAX_TRACKS).map((n) => Number(n))
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 1)) return fallback
  return nums
}

function normalize(raw) {
  const panes = Array.isArray(raw?.panes) ? raw.panes.map(normalizePane).filter(Boolean) : []
  const gridMode = GRID_MODES.includes(raw?.gridMode) ? raw.gridMode : 'auto'
  return {
    version: LAYOUT_VERSION,
    gridMode,
    // 分屏比例：以前只存了窗格顺序，导致「四宫格」这种手动排布重启后丢失
    columnWidths: normalizeShares(raw?.columnWidths, [0.5, 0.5]),
    rowHeights: normalizeShares(raw?.rowHeights, [0.5, 0.5]),
    panes,
    savedAt: Number(raw?.savedAt) || 0,
  }
}

/** 读取上次布局；文件缺失/损坏/版本不符时返回空布局 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (raw?.version !== LAYOUT_VERSION) return normalize(null)
    return normalize(raw)
  } catch {
    return normalize(null)
  }
}

/** 写入布局（原子替换：先写临时文件再 rename，避免半截文件） */
function save(layout) {
  const data = { ...normalize(layout), savedAt: Date.now() }
  const target = file()
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, target)
    return { ok: true, panes: data.panes.length, savedAt: data.savedAt }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响主流程 */ }
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/** 清空布局（关闭全部窗格时调用，下次启动就是干净工作台） */
function clear() {
  try {
    fs.rmSync(file(), { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

module.exports = { load, save, clear, LAYOUT_VERSION, file }
