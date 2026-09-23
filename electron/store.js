/**
 * 配置持久化 —— 读写 userData/config.json（避免引入额外依赖）
 * 安全约定：API Key 的明文只存在于主进程（load 解密后仅下发脱敏片段，
 * 明文 Key 通过 getApiKey() 供主进程调用 AI 接口使用，绝不发给渲染层）。
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')

const nodeBackend = process.env.PLM_NODE_BACKEND === '1'
const keyring = nodeBackend ? require('@napi-rs/keyring') : null
const KEYRING_SERVICE = `com.prt.devprojectmanager.${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)}`
let legacyMigrationAttempted = false

function keyringEntry(id) {
  // Linux 禁止回退到重启即丢失的 kernel keyutils；不可用时保存失败并保留旧值。
  return process.platform === 'linux'
    ? new keyring.Entry(KEYRING_SERVICE, id, { linux: { store: 'secret-service' } })
    : new keyring.Entry(KEYRING_SERVICE, id)
}
function saveKeyring(text, id = randomUUID()) {
  keyringEntry(id).setPassword(String(text))
  return id
}
function readKeyring(id) {
  if (!id || !nodeBackend) return ''
  try { return keyringEntry(id).getPassword() || '' } catch { return '' }
}

function file() {
  return path.join(app.getPath('userData'), 'config.json')
}

const DEFAULTS = {
  roots: [],
  // 默认勾选常用排除目录，减少扫描范围（与 git-service 默认排除保持一致）
  excludes: [
    'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', 'android-sdk',
    'androidsdk', 'jdk', 'Program Files', 'Pods', '.gradle', '.idea', '.cache',
  ],
  // 本人身份（支持多个账号）：{ name, email } 列表，「只看本人」会匹配所有账号
  identities: [],
  // AI 模型配置（API Key 经 safeStorage 加密后以 keyEnc 落盘）
  ai: {
    baseUrl: 'http://ai.sysapp.prttech.com:18080/v1', // 公司内网 AI 网关（默认地址，可按需改）
    model: '',
    temperature: 0.7,
  },
  // 一键填报（禅道工时）：密码经 safeStorage 加密后以 pwdEnc 落盘，明文不出主进程
  zentao: {
    baseUrl: 'http://10.11.34.2', // 公司内网禅道（默认地址，可按需改）
    account: '',
    workStart: '08:30',   // 实际上班时间默认值（一键填报页可按天临时调整）
    lunchStart: '12:00',  // 午休区间（默认 1 小时，自动从工作分钟数中扣除）
    lunchEnd: '13:00',
  },
  // 一键填报（汉印工时平台）：密码经 safeStorage 加密后以 pwdEnc 落盘，明文不出主进程
  hanprint: {
    baseUrl: 'http://10.10.21.2:5293', // 公司内网汉印工时平台（默认地址，可按需改）
    clientId: '1',        // 1=厦门汉印 2=江西外协（默认 1）
    account: '',          // 工号
  },
  // 内置 DeepSeek Harness（dsh web 本地服务）：启动应用时自动拉起，关闭应用时一并关闭
  harness: {
    port: 3080,       // 期望端口；被占用时自动改用系统分配的空闲端口
    autoStart: true,  // 随应用启动自动开启
    registry: '',     // 内置 dsh 运行时更新的 npm 源；空=官方源（registry.npmjs.org），可换内网镜像
  },
  // 关闭窗口行为：ask=每次询问（默认按钮是最小化到托盘）/ minimize=直接最小化 / quit=直接退出
  closeAction: 'ask',
}

/** 从 AI 配置对象解密出明文 Key（keyEnc 优先，兼容旧版明文 apiKey） */
function decryptKey(ai) {
  if (!ai) return ''
  if (ai.keyRef) return readKeyring(ai.keyRef)
  if (ai.keyEnc) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(ai.keyEnc, 'base64'))
      }
    } catch {
      /* 解密失败返回空，不破坏磁盘上的 keyEnc */
    }
  }
  return ai.apiKey || ''
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '••••••'
  return `••••••${key.slice(-4)}`
}

function load() {
  if (nodeBackend && !legacyMigrationAttempted) {
    legacyMigrationAttempted = true
    try {
      const { migrateLegacyConfig } = require('./legacy-safe-storage')
      migrateLegacyConfig(file(), (plain) => saveKeyring(plain), (id) => keyringEntry(id).deletePassword())
    } catch { /* 迁移异常不影响读取旧配置，密文保留供重试或手动恢复 */ }
  }
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const cfg = { ...DEFAULTS, ...JSON.parse(raw) }
    cfg.ai = { ...DEFAULTS.ai, ...(cfg.ai || {}) }
    // 公司内网地址固定默认：历史配置里留空时回落默认值，填过其他地址则原样保留
    if (!String(cfg.ai.baseUrl || '').trim()) cfg.ai.baseUrl = DEFAULTS.ai.baseUrl
    const key = decryptKey(cfg.ai)
    // 明文 Key 不出主进程：仅下发「是否已配置 + 脱敏片段」
    cfg.ai.keyConfigured = !!key
    cfg.ai.keyNeedsReentry = nodeBackend && !!cfg.ai.keyEnc && !key
    cfg.ai.keyMasked = key ? maskKey(key) : ''
    cfg.ai.apiKey = ''
    delete cfg.ai.keyEnc
    delete cfg.ai.keyRef
    cfg.zentao = { ...DEFAULTS.zentao, ...(cfg.zentao || {}) }
    // 公司内网地址固定默认：历史配置里留空时回落默认值，填过其他地址则原样保留
    if (!String(cfg.zentao.baseUrl || '').trim()) cfg.zentao.baseUrl = DEFAULTS.zentao.baseUrl
    const pwd = decryptText(cfg.zentao.pwdEnc, { allowUnavailable: true })
    cfg.zentao.pwdConfigured = !!pwd
    cfg.zentao.pwdNeedsReentry = nodeBackend && !!cfg.zentao.pwdEnc?.enc && !pwd
    cfg.zentao.pwdMasked = pwd ? maskKey(pwd) : ''
    delete cfg.zentao.pwdEnc
    cfg.hanprint = { ...DEFAULTS.hanprint, ...(cfg.hanprint || {}) }
    if (!String(cfg.hanprint.baseUrl || '').trim()) cfg.hanprint.baseUrl = DEFAULTS.hanprint.baseUrl
    if (!String(cfg.hanprint.clientId || '').trim()) cfg.hanprint.clientId = DEFAULTS.hanprint.clientId
    const hpPwd = decryptText(cfg.hanprint.pwdEnc, { allowUnavailable: true })
    cfg.hanprint.pwdConfigured = !!hpPwd
    cfg.hanprint.pwdNeedsReentry = nodeBackend && !!cfg.hanprint.pwdEnc?.enc && !hpPwd
    cfg.hanprint.pwdMasked = hpPwd ? maskKey(hpPwd) : ''
    delete cfg.hanprint.pwdEnc
    cfg.harness = { ...DEFAULTS.harness, ...(cfg.harness || {}) }
    // 关闭行为偏好：历史配置缺失或脏值回落「每次询问」
    if (!['ask', 'minimize', 'quit'].includes(cfg.closeAction)) cfg.closeAction = DEFAULTS.closeAction
    return cfg
  } catch {
    return {
      ...DEFAULTS,
      ai: { ...DEFAULTS.ai, apiKey: '', keyConfigured: false, keyMasked: '' },
      zentao: { ...DEFAULTS.zentao, pwdConfigured: false, pwdMasked: '' },
      hanprint: { ...DEFAULTS.hanprint, pwdConfigured: false, pwdMasked: '' },
    }
  }
}

/**
 * 保存配置。Key 规则：
 * - cfg.ai.apiKey 非空 → 用新 Key 加密替换
 * - cfg.ai.apiKey 为空  → 原样保留磁盘上既有 keyEnc（不解密，杜绝解密失败丢数据）
 * - cfg.ai.clearKey=true → 显式清除 Key
 * 平台不支持 safeStorage 时回退明文（本地工具兜底，文件设 0o600）。
 */
/** 读取磁盘上的旧配置（供保留既有密文用；读取失败返回空对象） */
function readStored() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

function save(cfg) {
  try {
    const c = JSON.parse(JSON.stringify(cfg || {}))
    const old = readStored() // ai/zentao/hanprint 三段共用一次读盘
    if (c.ai) {
      const newKey = c.ai.apiKey || ''
      const clear = !!c.ai.clearKey
      delete c.ai.clearKey
      delete c.ai.keyConfigured
      delete c.ai.keyMasked
      delete c.ai.keyNeedsReentry
      delete c.ai.apiKey
      delete c.ai.keyEnc
      delete c.ai.keyRef
      if (!clear && !newKey) {
        // 未输入新 Key 也未要求清除：保留磁盘既有 Key（字节原样，不触发解密）
        const oldAi = old.ai || {}
        if (oldAi.keyRef) c.ai.keyRef = oldAi.keyRef
        else if (oldAi.keyEnc) c.ai.keyEnc = oldAi.keyEnc
        else if (oldAi.apiKey) c.ai.apiKey = oldAi.apiKey
      } else if (!clear && newKey) {
        if (nodeBackend) c.ai.keyRef = saveKeyring(newKey, 'ai-key')
        else {
        try {
          if (safeStorage.isEncryptionAvailable()) {
            c.ai.keyEnc = safeStorage.encryptString(newKey).toString('base64')
          } else {
            c.ai.apiKey = newKey // 平台不支持加密时明文兜底
          }
        } catch {
          c.ai.apiKey = newKey
        }
        }
      }
      // clear → 不带 keyEnc / apiKey，即清除
    }
    // 禅道密码与 AI Key 同规则：新值加密替换 / 留空保留磁盘旧密文 / clearPwd 显式清除
    if (c.zentao) {
      const newPwd = c.zentao.password || ''
      const clearPwd = !!c.zentao.clearPwd
      delete c.zentao.clearPwd
      delete c.zentao.pwdConfigured
      delete c.zentao.pwdMasked
      delete c.zentao.pwdNeedsReentry
      delete c.zentao.password
      delete c.zentao.pwdEnc
      if (!clearPwd && !newPwd) {
        if (old.zentao && old.zentao.pwdEnc) c.zentao.pwdEnc = old.zentao.pwdEnc
      } else if (!clearPwd && newPwd) {
        c.zentao.pwdEnc = encryptText(newPwd)
      }
      // clearPwd → 不带 pwdEnc，即清除
    }
    // 汉印密码同规则
    if (c.hanprint) {
      const newPwd = c.hanprint.password || ''
      const clearPwd = !!c.hanprint.clearPwd
      delete c.hanprint.clearPwd
      delete c.hanprint.pwdConfigured
      delete c.hanprint.pwdMasked
      delete c.hanprint.pwdNeedsReentry
      delete c.hanprint.password
      delete c.hanprint.pwdEnc
      if (!clearPwd && !newPwd) {
        if (old.hanprint && old.hanprint.pwdEnc) c.hanprint.pwdEnc = old.hanprint.pwdEnc
      } else if (!clearPwd && newPwd) {
        c.hanprint.pwdEnc = encryptText(newPwd)
      }
    }
    fs.writeFileSync(file(), JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 })
    if (nodeBackend) {
      const previous = [old.ai?.keyRef, old.zentao?.pwdEnc?.keyRef, old.hanprint?.pwdEnc?.keyRef].filter(Boolean)
      const current = new Set([c.ai?.keyRef, c.zentao?.pwdEnc?.keyRef, c.hanprint?.pwdEnc?.keyRef].filter(Boolean))
      for (const id of previous) {
        if (!current.has(id)) try { keyringEntry(id).deletePassword() } catch { /* 旧项不存在或系统暂时不可用 */ }
      }
    }
    return true
  } catch {
    return false
  }
}

/** 主进程专用：返回明文 API Key（绝不发往渲染层） */
function getApiKey() {
  return decryptKey(readStored().ai || {})
}

/** 主进程专用：返回禅道登录密码明文（绝不发往渲染层） */
function getZentaoPwd() {
  const zt = readStored().zentao
  return zt ? decryptText(zt.pwdEnc) : ''
}

/** 主进程专用：返回汉印登录密码明文（绝不发往渲染层） */
function getHanprintPwd() {
  const hp = readStored().hanprint
  return hp ? decryptText(hp.pwdEnc) : ''
}

/** 通用文本加密（safeStorage），供部署模块加密 SSH 凭据使用；失败回退明文并标记 plain */
function encryptText(text) {
  if (nodeBackend) return { keyRef: saveKeyring(text) }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(String(text)).toString('base64'), plain: '' }
    }
  } catch { /* 走明文兜底 */ }
  return { enc: '', plain: String(text) }
}

/** 通用文本解密；与 encryptText 配对 */
function decryptText(secret, options = {}) {
  if (!secret) return ''
  if (secret.keyRef) return readKeyring(secret.keyRef)
  if (secret.enc) {
    if (nodeBackend && !options.allowUnavailable) throw new Error('旧版 Electron 加密凭据需在设置中重新输入')
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(secret.enc, 'base64'))
      }
    } catch { /* 解密失败返回空 */ }
  }
  return secret.plain || ''
}

module.exports = { load, save, getApiKey, getZentaoPwd, getHanprintPwd, encryptText, decryptText }
