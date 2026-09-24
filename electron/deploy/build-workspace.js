/**
 * 打包工作区准备 —— 把项目复制一份供打包命令使用：版本同步、发布说明写入都发生在副本里，
 * 不污染原项目。复制时跳过三类内容：
 *   1. 版本库/本地私有目录，以及本次要重新生成的产物包（release、releases、*.tar.gz/*.zip）
 *   2. Linux 布局的本机 Python 虚拟环境（pyvenv.cfg + bin/ 且无 Scripts/）：Windows 上执行不了
 *      其中的解释器，复制过去只会拖慢构建
 *   3. Windows 读不了的条目 —— WSL 里 `ln -s` 建的链接在 DrvFs 上是 LX_SYMLINK 重解析点，
 *      Windows 的 lstat 对它返回 EACCES，fs.cp 撞上就抛错中断整次发布
 */
const fs = require('fs')
const path = require('path')

/** 脚本部署支持的发布包扩展名（与 deploy-service 的产物解析保持一致：V2 tar.gz 优先） */
const ARTIFACT_EXTS = ['.tar.gz', '.tgz', '.zip']

/** 只按顶层名跳过：版本库、本地私有目录、历史产物目录 */
const SKIP_TOP = /^(?:\.git|\.local|release|releases)$/

/** 本机读不了条目的错误码：WSL 重解析点在 Windows 上表现为拒绝访问 */
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM'])

/** Linux 布局的 Python 虚拟环境：解释器在 bin/，没有 Windows 的 Scripts/ */
function isLinuxVenv(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return false
  }
  return names.includes('pyvenv.cfg') && names.includes('bin') && !names.includes('Scripts')
}

/**
 * 目录是否不参与复制。虚拟环境按名字对所有层级判断（子项目里也可能有），
 * 其余规则只看顶层，避免误伤业务目录中同名的子目录。
 */
function shouldSkipDir(relative, abs) {
  const name = path.basename(abs)
  if (name === '.venv' || name === 'venv') return isLinuxVenv(abs)
  return !relative.includes(path.sep) && SKIP_TOP.test(name)
}

/**
 * 预扫描出本机读不了的条目（相对项目根的路径）。
 * 只探测符号链接：普通文件在 Windows 上不会出现这种拒绝访问，遍历成本仅一次目录 readdir。
 * probe 可注入，便于在没有 WSL 的机器上验证跳过逻辑。
 */
function collectUnreadable(rootDir, probe = fs.statSync) {
  const blocked = new Set()
  const walk = (dir, relative) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const childRel = relative ? path.join(relative, ent.name) : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) {
        try {
          probe(abs)
        } catch (error) {
          if (UNREADABLE_CODES.has(error.code)) blocked.add(childRel)
        }
      } else if (ent.isDirectory() && !shouldSkipDir(childRel, abs)) {
        walk(abs, childRel)
      }
    }
  }
  walk(rootDir, '')
  return blocked
}

/** 复制项目到打包工作区；返回被跳过的条目，便于在发布日志里说明跳过了什么。 */
async function copyProject(srcDir, destDir, { artifactDir, artifactExts = ARTIFACT_EXTS, probe } = {}) {
  const artifactRoot = path.resolve(srcDir, artifactDir || 'release')
  const unreadable = collectUnreadable(srcDir, probe)
  await fs.promises.cp(srcDir, destDir, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const relative = path.relative(srcDir, source)
      if (!relative) return true
      if (unreadable.has(relative)) return false
      if (shouldSkipDir(relative, source)) return false
      const artifactRel = path.relative(artifactRoot, source)
      return !(artifactRel && !artifactRel.startsWith('..') && artifactExts.some((ext) => source.toLowerCase().endsWith(ext)))
    },
  })
  return { skipped: [...unreadable] }
}

module.exports = { copyProject, collectUnreadable, shouldSkipDir, isLinuxVenv, ARTIFACT_EXTS }
