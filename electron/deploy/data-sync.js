/** 数据同步的项目目录边界。目录内链接一律拒绝，避免覆盖另一个项目的数据。 */
const fs = require('fs')
const path = require('path')

function isChild(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
}

/** 本地项目根可使用已有目录别名；数据目录及其子项不能再通过链接跳转。 */
function resolveLocalDataDir(projectDir, localDir) {
  if (!projectDir) throw new Error('项目目录未填写')
  if (!localDir || typeof localDir !== 'string') throw new Error('数据目录未填写')
  const projectRoot = path.resolve(projectDir)
  const sourceDir = path.resolve(projectRoot, localDir)
  if (sourceDir === projectRoot) throw new Error('数据目录不能是项目根目录本身')
  if (!isChild(projectRoot, sourceDir)) throw new Error(`数据目录必须在项目目录内: ${localDir}`)
  let current = projectRoot
  for (const segment of path.relative(projectRoot, sourceDir).split(path.sep)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) throw new Error(`数据目录不存在: ${sourceDir}`)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`数据目录不能包含符号链接或目录联接: ${current}`)
  }
  if (!fs.statSync(sourceDir).isDirectory()) throw new Error(`数据目录不是文件夹: ${sourceDir}`)
  if (!isChild(fs.realpathSync(projectRoot), fs.realpathSync(sourceDir))) throw new Error(`数据目录实际位置必须在项目目录内: ${localDir}`)
  return sourceDir
}

/** 打包前完整检查数据树，不能悄悄跳过链接而让同步数据不完整。 */
function collectDataEntries(sourceDir) {
  const entries = []
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory)) {
      if (/[\\\x00-\x1f]/.test(name)) throw new Error(`数据文件名不能包含反斜杠或控制字符: ${name}`)
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`数据目录包含符号链接或目录联接，无法安全同步: ${relative}`)
      if (stat.isFile() && stat.nlink > 1) throw new Error(`数据文件包含硬链接，无法确认项目归属: ${relative}`)
      if (stat.isDirectory()) { entries.push({ absolute, relative, directory: true }); walk(absolute, relative) }
      else if (stat.isFile()) entries.push({ absolute, relative, directory: false })
      else throw new Error(`数据目录包含不支持的特殊文件: ${relative}`)
    }
  }
  walk(sourceDir, '')
  return entries
}

function assertRemoteRelative(remoteDir) {
  if (typeof remoteDir !== 'string' || !remoteDir || /[\\\x00-\x1f:]/.test(remoteDir) || path.posix.isAbsolute(remoteDir) || remoteDir.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`远程数据目录必须是安装目录内的相对路径: ${remoteDir || '空'}`)
  }
  return remoteDir
}

function assertRemoteHome(remoteHome) {
  if (typeof remoteHome !== 'string' || !remoteHome.startsWith('/') || remoteHome === '/' || /[\\\x00-\x1f]/.test(remoteHome) || path.posix.normalize(remoteHome).replace(/\/$/, '') !== remoteHome) {
    throw new Error('远程安装目录必须是规范的绝对路径，且不能为根目录')
  }
}

function validateDataSync(project, dataSync) {
  try {
    const sourceDir = resolveLocalDataDir(project && project.localPath, dataSync && dataSync.localDir)
    assertRemoteRelative(dataSync && dataSync.remoteDir)
    collectDataEntries(sourceDir)
    return { ok: true, sourceDir }
  } catch (error) { return { ok: false, problem: error.message || String(error) } }
}

function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'` }

/** Linux readlink -m 检查现存父路径；find 检查目标树，包含已有文件和目录链接。 */
function boundaryChecks(remoteHome, remoteDir) {
  remoteHome = String(remoteHome || '').replace(/\/+$/, '')
  assertRemoteHome(remoteHome)
  assertRemoteRelative(remoteDir)
  const destination = path.posix.join(remoteHome, remoteDir)
  const uploads = path.posix.join(remoteHome, 'uploads')
  return [
    'set -eu',
    'ds_fail() { printf "%s\\n" "数据同步目录检查失败：$*" >&2; exit 1; }',
    `ds_home=${quote(remoteHome)}`, `ds_dest=${quote(destination)}`, `ds_uploads=${quote(uploads)}`,
    'for ds_path in "$ds_home" "$ds_uploads" "$ds_dest"; do [ "$(readlink -m -- "$ds_path")" = "$ds_path" ] || ds_fail "路径含链接或实际位置越界：$ds_path"; [ ! -e "$ds_path" ] || [ -d "$ds_path" ] || ds_fail "目标不是目录：$ds_path"; done',
    'for ds_tree in "$ds_uploads" "$ds_dest"; do if [ -d "$ds_tree" ]; then ds_link=$(find "$ds_tree" \\( -type l -o -type f -links +1 \\) -print -quit) || ds_fail "无法检查目录：$ds_tree"; [ -z "$ds_link" ] || ds_fail "已有目录或文件包含链接：$ds_link"; fi; done',
  ]
}

function buildDataSyncPreflightCommand(remoteHome, remoteDir) {
  return [...boundaryChecks(remoteHome, remoteDir), 'echo __DATA_SYNC_PATH_OK__'].join('; ')
}

function buildDataSyncCommand(dataZipRemote, remoteDestDir, remoteHome = path.posix.dirname(path.posix.dirname(dataZipRemote))) {
  remoteHome = String(remoteHome || '').replace(/\/+$/, '')
  assertRemoteHome(remoteHome)
  if (path.posix.normalize(remoteDestDir) !== remoteDestDir || path.posix.normalize(dataZipRemote) !== dataZipRemote || /[\\\x00-\x1f]/.test(dataZipRemote)) throw new Error('数据同步路径必须规范化，不能包含相对跳转或非法字符')
  if (!isChild(remoteHome, remoteDestDir, path.posix) || !isChild(path.posix.join(remoteHome, 'uploads'), dataZipRemote, path.posix)) throw new Error('数据同步包和目标必须位于当前项目安装目录内')
  const remoteDir = path.posix.relative(remoteHome, remoteDestDir)
  const checks = boundaryChecks(remoteHome, remoteDir)
  checks.push(`[ "$(readlink -m -- ${quote(dataZipRemote)})" = ${quote(dataZipRemote)} ] && [ -f ${quote(dataZipRemote)} ] || ds_fail "数据包路径不安全或不存在"`)
  checks.push(`mkdir -p ${quote(remoteDestDir)} && unzip -o ${quote(dataZipRemote)} -d ${quote(remoteDestDir)} && rm -f ${quote(dataZipRemote)} && echo __DATA_SYNC_OK__`)
  return checks.join('; ')
}

module.exports = { resolveLocalDataDir, collectDataEntries, validateDataSync, buildDataSyncPreflightCommand, buildDataSyncCommand }
