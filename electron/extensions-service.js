/**
 * 扩展管理服务 —— 统一管理四个 AI CLI 平台的技能（skills）与插件（plugins）
 *
 * 平台目录约定（以用户主目录为根）：
 * - Claude Code: ~/.claude/skills；插件注册表 ~/.claude/plugins/installed_plugins.json（v2，key→entries），
 *                启用状态在 ~/.claude/settings.json 顶层 enabledPlugins（缺省视为启用，false 为禁用）
 * - Codex:       ~/.codex/skills，官方禁用机制为 ~/.codex/skills-disabled；插件启用状态在
 *                ~/.codex/config.toml 的 [plugins."名称@市场"] 段（enabled = true/false），
 *                版本信息从 ~/.codex/plugins/cache/<市场>/<名称>/<版本> 目录补充
 * - Kimi CLI:    ~/.kimi/skills（无插件体系）
 * - Zcode:       ~/.zcode/skills；插件注册表 ~/.zcode/cli/plugins/installed_plugins.json（v1，数组），
 *                启用状态在 ~/.zcode/cli/config.json 的 plugins.enabledPlugins
 *
 * 技能禁用统一采用目录迁移（skills ↔ skills-disabled）：与 Codex 官方机制一致，
 * 可逆、无侵入，不改动各 CLI 自身的配置文件。插件禁用则写入各平台真实的启用配置。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** SKILL.md 读取上限（详情预览用），防止异常超大文件拖垮渲染层 */
const SKILL_MD_LIMIT = 256 * 1024

const PLATFORMS = {
  'claude-code': { name: 'Claude Code', dir: '.claude', pluginsSupported: true },
  codex: { name: 'Codex', dir: '.codex', pluginsSupported: true },
  'kimi-cli': { name: 'Kimi CLI', dir: '.kimi', pluginsSupported: false },
  zcode: { name: 'Zcode', dir: '.zcode', pluginsSupported: true },
}

let rootDir = os.homedir()

/** 测试注入根目录（默认真实用户主目录），生产代码不调用 */
function setRoot(dir) {
  rootDir = dir
}

function platformDir(platformId) {
  return path.join(rootDir, PLATFORMS[platformId].dir)
}

function skillsEnabledDir(platformId) {
  return path.join(platformDir(platformId), 'skills')
}

function skillsDisabledDir(platformId) {
  return path.join(platformDir(platformId), 'skills-disabled')
}

/** 名称校验：只允许字母数字点横线下划线，拒绝路径分隔符与 ..（防路径穿越） */
function assertValidName(name, label = '名称') {
  if (typeof name !== 'string' || !name || name.length > 128) {
    throw new Error(`${label}不能为空且长度不超过 128`)
  }
  if (name === '.' || name === '..' || !/^[\w.-]+$/.test(name)) {
    throw new Error(`${label}含非法字符：${name}`)
  }
}

/** 插件 ID 校验（形如 name@marketplace） */
function assertValidPluginId(id) {
  if (typeof id !== 'string' || !/^[\w.-]+@[\w.-]+$/.test(id) || id.length > 200) {
    throw new Error(`插件 ID 非法：${id}`)
  }
}

function assertPlatform(platformId) {
  if (!Object.prototype.hasOwnProperty.call(PLATFORMS, platformId)) {
    throw new Error(`未知平台：${platformId}`)
  }
}

/** 读取 JSON 文件；不存在返回 null，存在但解析失败抛错（绝不静默覆盖用户配置） */
function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new Error(`配置文件解析失败（已取消写入以保护原文件）：${filePath}，${err.message}`)
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 解析 SKILL.md 头部 frontmatter 的简单键值（name/description/version 等） */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/** 判断目录项是否为可用目录：symlink/junction 需跟随 stat（Zcode 的 skills 即链接聚合层） */
function isRealDir(entry, entryPath) {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(entryPath).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/**
 * 解析链接目标归属的平台技能目录（仅认各平台启用的 skills 目录下、单层技能名）。
 * 返回 { platformId, name } 或 null：目标在外部 / 指向 skills-disabled / 多层嵌套时不级联。
 */
function matchCascadePlatform(linkTarget) {
  let target = linkTarget || ''
  if (target.startsWith('\\\\?\\')) target = target.slice(4)
  // Electron 的 libuv 创建 junction 时会给目标附加尾部分隔符，必须剥掉再匹配
  const normalized = path.normalize(target).replace(/[\\/]+$/, '')
  for (const id of Object.keys(PLATFORMS)) {
    const skillsDir = path.normalize(skillsEnabledDir(id))
    const prefix = skillsDir + path.sep
    let rest = ''
    if (process.platform === 'win32') {
      if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) rest = normalized.slice(prefix.length)
    } else if (normalized.startsWith(prefix)) {
      rest = normalized.slice(prefix.length)
    }
    // 仅接受单层技能名：指向 skills 目录本身或多层嵌套路径的不级联
    if (!rest || rest.includes(path.sep) || rest.includes('/')) continue
    return { platformId: id, name: rest }
  }
  return null
}

/** 扫描单个技能目录（启用或禁用侧），目录下允许缺少 SKILL.md（标记但不吞掉） */
function collectSkills(dir, enabled) {
  const skills = []
  if (!fs.existsSync(dir)) return skills
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const skillDir = path.join(dir, entry.name)
    let isDir = entry.isDirectory()
    let linkTarget = ''
    let linkBroken = false
    if (entry.isSymbolicLink()) {
      try {
        linkTarget = fs.readlinkSync(skillDir)
      } catch { /* 目标信息读取失败不阻断列表 */ }
      try {
        isDir = fs.statSync(skillDir).isDirectory()
      } catch {
        // 悬空链接（源已被禁用/删除）也要列出，交给用户处置
        linkBroken = true
        isDir = true
      }
    }
    if (!isDir) continue
    let meta = {}
    let hasSkillMd = false
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    if (fs.existsSync(skillMdPath)) {
      try {
        meta = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf8'))
        hasSkillMd = true
      } catch { /* 读取失败按无描述处理 */ }
    }
    skills.push({
      name: entry.name,
      description: meta.description || '',
      enabled,
      dir: skillDir,
      hasSkillMd,
      linkTarget,
      linkBroken,
    })
  }
  return skills
}

/** 路径存在性（lstat，不跟随链接）：悬空链接的本体也算存在 */
function pathExists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function isLink(dirPath) {
  try {
    return fs.lstatSync(dirPath).isSymbolicLink()
  } catch {
    return false
  }
}

/** 目录迁移；目标同名冲突时明确报错，绝不覆盖 */
function moveDir(src, dest) {
  if (pathExists(dest)) {
    throw new Error(`目标位置已存在同名目录，已取消操作：${dest}`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(src, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    fs.cpSync(src, dest, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

function createDirLink(linkPath, targetDir) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 删除链接本体（绝不递归进目标）；Windows junction 同样按链接删除 */
function removeLink(linkPath) {
  try {
    fs.unlinkSync(linkPath)
  } catch {
    fs.rmSync(linkPath, { force: true })
  }
}

/**
 * 启用/禁用技能。
 * 普通目录：直接在 skills ↔ skills-disabled 间迁移。
 * 链接技能：若目标属于某平台的 skills 目录（如 Zcode 聚合层指向 Claude Code），
 * 级联迁移源平台真实目录（禁用即同步禁用源，启用时反向恢复并重建链接）；
 * 目标为外部目录时仅移动链接本身。任何一步失败都回滚已完成的迁移。
 */
function moveSkillDir(platformId, name, enable) {
  const from = enable ? skillsDisabledDir(platformId) : skillsEnabledDir(platformId)
  const to = enable ? skillsEnabledDir(platformId) : skillsDisabledDir(platformId)
  const src = path.join(from, name)
  const dest = path.join(to, name)
  if (!pathExists(src)) {
    throw new Error(`未找到${enable ? '已禁用' : '已启用'}技能目录：${src}`)
  }
  if (pathExists(dest)) {
    throw new Error(`目标位置已存在同名目录，已取消操作：${dest}`)
  }

  // 级联目标解析（禁用看链接当前指向；启用看链接记录的原始指向，可能已悬空）
  let cascade = null
  if (isLink(src)) {
    const match = matchCascadePlatform(fs.readlinkSync(src))
    if (match && match.platformId !== platformId) {
      const cascadeSrc = enable
        ? path.join(skillsDisabledDir(match.platformId), match.name)
        : path.join(skillsEnabledDir(match.platformId), match.name)
      const cascadeDest = enable
        ? path.join(skillsEnabledDir(match.platformId), match.name)
        : path.join(skillsDisabledDir(match.platformId), match.name)
      // 源不存在（悬空链接/已被处理）时降级为仅移动链接
      if (pathExists(cascadeSrc) && !pathExists(cascadeDest)) {
        cascade = { src: cascadeSrc, dest: cascadeDest, name: match.name, platformId: match.platformId }
      }
    }
  }

  if (!cascade) {
    moveDir(src, dest)
    return
  }

  if (enable) {
    // 恢复源平台真实目录，再在本平台重建指向新位置的链接
    try {
      moveDir(cascade.src, cascade.dest)
    } catch (err) {
      throw new Error(`恢复源平台（${PLATFORMS[cascade.platformId].name}）技能「${cascade.name}」失败：${err.message}`)
    }
    try {
      createDirLink(dest, cascade.dest)
      removeLink(src)
    } catch (err) {
      try { moveDir(cascade.dest, cascade.src) } catch { /* 回滚失败保留现场并上报 */ }
      throw new Error(`重建链接失败（已回滚源平台目录）：${err.message}`)
    }
  } else {
    // 先禁用源平台真实目录，再移动链接本体
    try {
      moveDir(cascade.src, cascade.dest)
    } catch (err) {
      throw new Error(`禁用源平台（${PLATFORMS[cascade.platformId].name}）技能「${cascade.name}」失败：${err.message}`)
    }
    try {
      moveDir(src, dest)
    } catch (err) {
      try { moveDir(cascade.dest, cascade.src) } catch { /* 回滚失败保留现场并上报 */ }
      throw new Error(`移动链接失败（已回滚源平台目录）：${err.message}`)
    }
  }
}

// ─── Claude Code 插件（installed_plugins.json v2 + settings.json enabledPlugins） ───

function listClaudePlugins() {
  const registry = readJsonFile(path.join(platformDir('claude-code'), 'plugins', 'installed_plugins.json'))
  const settings = readJsonFile(path.join(platformDir('claude-code'), 'settings.json')) || {}
  const enabledMap = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {}
  const plugins = []
  for (const [id, entries] of Object.entries((registry && registry.plugins) || {})) {
    const list = Array.isArray(entries) ? entries : []
    const entry = list.find((e) => e && e.scope === 'user') || list[0] || {}
    plugins.push({
      id,
      name: id.split('@')[0],
      marketplace: id.split('@')[1] || '',
      version: entry.version || '',
      installPath: entry.installPath || '',
      installedAt: entry.installedAt || '',
      enabled: enabledMap[id] !== false,
      canToggle: true,
    })
  }
  return plugins
}

function toggleClaudePlugin(id, enable) {
  assertValidPluginId(id)
  const settingsPath = path.join(platformDir('claude-code'), 'settings.json')
  const settings = readJsonFile(settingsPath) || {}
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') settings.enabledPlugins = {}
  settings.enabledPlugins[id] = !!enable
  writeJsonFile(settingsPath, settings)
}

// ─── Zcode 插件（cli/plugins/installed_plugins.json v1 数组 + cli/config.json plugins.enabledPlugins） ───

function listZcodePlugins() {
  const registry = readJsonFile(path.join(platformDir('zcode'), 'cli', 'plugins', 'installed_plugins.json'))
  const config = readJsonFile(path.join(platformDir('zcode'), 'cli', 'config.json')) || {}
  const enabledMap = (config.plugins && config.plugins.enabledPlugins) || {}
  const plugins = []
  for (const entry of (registry && Array.isArray(registry.plugins) ? registry.plugins : [])) {
    if (!entry || !entry.id) continue
    plugins.push({
      id: entry.id,
      name: entry.name || entry.id.split('@')[0],
      marketplace: entry.marketplace || entry.id.split('@')[1] || '',
      version: entry.version || '',
      installPath: entry.installPath || '',
      installedAt: entry.installedAt || entry.updatedAt || '',
      enabled: enabledMap[entry.id] !== false,
      canToggle: true,
    })
  }
  return plugins
}

function toggleZcodePlugin(id, enable) {
  assertValidPluginId(id)
  const configPath = path.join(platformDir('zcode'), 'cli', 'config.json')
  const config = readJsonFile(configPath) || {}
  if (!config.plugins || typeof config.plugins !== 'object') config.plugins = {}
  if (!config.plugins.enabledPlugins || typeof config.plugins.enabledPlugins !== 'object') {
    config.plugins.enabledPlugins = {}
  }
  config.plugins.enabledPlugins[id] = !!enable
  writeJsonFile(configPath, config)
}

// ─── Codex 插件（config.toml [plugins."id"] 段 + plugins/cache 版本目录） ───

/** 读写共用 TOML 表头识别，保留合法缩进、空白、引号与行尾注释。 */
function codexPluginHeader(line) {
  const match = /^\s*\[\s*plugins\s*\.\s*(?:"([^"]+)"|'([^']+)')\s*\]\s*(?:#.*)?$/.exec(line)
  return match ? (match[1] || match[2]) : null
}

/** 行级解析 config.toml 中 [plugins."id"] 段的 enabled 布尔值 */
function parseCodexPluginSections(toml) {
  const out = {}
  let current = null
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim()
    const header = codexPluginHeader(line)
    if (header) {
      current = header
      if (!(current in out)) out[current] = true // 段存在但未写 enabled 时按启用处理
      continue
    }
    if (t.startsWith('[')) { current = null; continue }
    if (current) {
      const kv = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(t)
      if (kv) out[current] = kv[1] === 'true'
    }
  }
  return out
}

/** 从 cache 目录补充版本号：取该插件版本目录字典序最大的一个 */
function codexCachedVersion(id) {
  const [name, marketplace] = id.split('@')
  const pluginCacheDir = path.join(platformDir('codex'), 'plugins', 'cache', marketplace, name)
  if (!fs.existsSync(pluginCacheDir)) return ''
  const versions = fs.readdirSync(pluginCacheDir, { withFileTypes: true })
    .filter((e) => isRealDir(e, path.join(pluginCacheDir, e.name)))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return versions[0] || ''
}

function listCodexPlugins() {
  const configPath = path.join(platformDir('codex'), 'config.toml')
  if (!fs.existsSync(configPath)) return []
  const enabledMap = parseCodexPluginSections(fs.readFileSync(configPath, 'utf8'))
  return Object.entries(enabledMap).map(([id, enabled]) => ({
    id,
    name: id.split('@')[0],
    marketplace: id.split('@')[1] || '',
    version: codexCachedVersion(id),
    installPath: '',
    installedAt: '',
    enabled,
    canToggle: true,
  }))
}

/** 定向翻转 config.toml 中 [plugins."id"] 的 enabled；段不存在则追加到文件末尾 */
function toggleCodexPlugin(id, enable) {
  assertValidPluginId(id)
  const configPath = path.join(platformDir('codex'), 'config.toml')
  if (!fs.existsSync(configPath)) throw new Error('未找到 Codex 配置文件 config.toml')
  const raw = fs.readFileSync(configPath, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const header = `[plugins."${id}"]`
  const headerIndex = lines.findIndex((line) => codexPluginHeader(line) === id)
  if (headerIndex >= 0) {
    // 段边界：下一个以 [ 开头的行（含子表）之前都属于该段
    let end = lines.length
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim().startsWith('[')) { end = i; break }
    }
    let replaced = false
    for (let i = headerIndex + 1; i < end; i += 1) {
      if (/^enabled\s*=/.test(lines[i].trim())) {
        lines[i] = `enabled = ${enable ? 'true' : 'false'}`
        replaced = true
        break
      }
    }
    if (!replaced) lines.splice(headerIndex + 1, 0, `enabled = ${enable ? 'true' : 'false'}`)
  } else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    lines.push('', header, `enabled = ${enable ? 'true' : 'false'}`)
  }
  fs.writeFileSync(configPath, lines.join(eol), 'utf8')
}

// ─── 对外统一入口 ───

function listSkillsOf(platformId) {
  return collectSkills(skillsEnabledDir(platformId), true)
    .concat(collectSkills(skillsDisabledDir(platformId), false))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 汇总列出四个平台的技能与插件；单平台读取失败只降级该平台，不影响整体 */
function listAll() {
  const platforms = []
  for (const [id, plat] of Object.entries(PLATFORMS)) {
    const base = {
      id,
      name: plat.name,
      dir: platformDir(id),
      installed: fs.existsSync(platformDir(id)),
      skillsSupported: true,
      pluginsSupported: plat.pluginsSupported,
      pluginNote: plat.pluginsSupported ? '' : '该平台暂无插件体系，仅支持技能管理',
    }
    let skills = []
    let plugins = []
    let error = ''
    try {
      skills = listSkillsOf(id)
      if (plat.pluginsSupported) plugins = id === 'claude-code' ? listClaudePlugins() : id === 'zcode' ? listZcodePlugins() : listCodexPlugins()
    } catch (err) {
      error = err.message
    }
    platforms.push({ ...base, skills, plugins, error })
  }
  return { home: rootDir, platforms }
}

/** 启用/禁用技能（目录迁移法） */
function toggleSkill(platformId, name, enable) {
  assertPlatform(platformId)
  assertValidName(name, '技能名')
  moveSkillDir(platformId, name, !!enable)
  return { name, enabled: !!enable }
}

/** 启用/禁用插件（写入各平台真实启用配置） */
function togglePlugin(platformId, id, enable) {
  assertPlatform(platformId)
  if (!PLATFORMS[platformId].pluginsSupported) {
    throw new Error(`${PLATFORMS[platformId].name} 暂无插件体系`)
  }
  if (platformId === 'claude-code') toggleClaudePlugin(id, enable)
  else if (platformId === 'zcode') toggleZcodePlugin(id, enable)
  else toggleCodexPlugin(id, enable)
  return { id, enabled: !!enable }
}

/** 读取技能 SKILL.md 内容与所在位置（详情预览） */
function readSkillDoc(platformId, name) {
  assertPlatform(platformId)
  assertValidName(name, '技能名')
  const enabledDir = path.join(skillsEnabledDir(platformId), name)
  const disabledDir = path.join(skillsDisabledDir(platformId), name)
  const dir = fs.existsSync(enabledDir) ? enabledDir : fs.existsSync(disabledDir) ? disabledDir : null
  if (!dir) throw new Error(`未找到技能：${name}`)
  const skillMdPath = path.join(dir, 'SKILL.md')
  let content = ''
  let hasSkillMd = false
  if (fs.existsSync(skillMdPath)) {
    content = fs.readFileSync(skillMdPath, 'utf8').slice(0, SKILL_MD_LIMIT)
    hasSkillMd = true
  }
  return { name, dir, enabled: dir === enabledDir, hasSkillMd, content }
}

module.exports = {
  setRoot,
  listAll,
  toggleSkill,
  togglePlugin,
  readSkillDoc,
  parseFrontmatter,
  parseCodexPluginSections,
}
