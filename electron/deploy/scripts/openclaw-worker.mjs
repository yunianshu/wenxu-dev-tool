// 在目标容器内执行；只更新清单文件，保留其他插件和用户配置。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const safeId = value => /^[a-z0-9][a-z0-9_-]{0,100}$/.test(value || '');
function noLinks(file) {
  let parent = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(parent.length).split(path.sep)) {
    parent = path.join(parent, part);
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('OpenClaw 目标不能经过符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function relativeFile(base, name) {
  if (!name || name.includes('\\') || name.split('/').some(s => !s || s === '.' || s === '..') || path.isAbsolute(name)) throw new Error('OpenClaw 文件路径无效');
  const file = path.resolve(base, name);
  if (!file.startsWith(path.resolve(base) + path.sep)) throw new Error('OpenClaw 文件路径越界');
  noLinks(file);
  return file;
}
function readManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.format !== 1 || !path.isAbsolute(m.home) || !path.isAbsolute(m.workspace) || !Array.isArray(m.resources) || !m.resources.length) throw new Error('OpenClaw 清单无效');
  noLinks(m.home); noLinks(m.workspace);
  const entries = [];
  for (const resource of m.resources) {
    if (!safeId(resource.id) || !['plugin', 'skill'].includes(resource.kind) || !resource.files?.length) throw new Error('OpenClaw 资源标识无效');
    const targets = resource.kind === 'plugin' ? [path.join(m.home, 'extensions', resource.id)]
      : [path.join(m.home, 'plugin-skills', resource.id), path.join(m.workspace, 'skills', resource.id)];
    for (const entry of resource.files) {
      const source = relativeFile(path.join(path.dirname(file), resource.kind), entry.path);
      const data = fs.readFileSync(source);
      if (digest(data) !== entry.sha256) throw new Error('OpenClaw 来源文件校验失败');
      for (const base of targets) entries.push({ file: relativeFile(base, entry.path), data, sha256: entry.sha256, mode: entry.mode });
    }
  }
  if (new Set(entries.map(e => e.file)).size !== entries.length) throw new Error('OpenClaw 目标文件重复');
  return { ...m, entries };
}
function atomicWrite(file, data, mode = 0o644) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.onedeploy-${process.pid}`;
  let created = false;
  try { fs.writeFileSync(temporary, data, { mode, flag: 'wx' }); created = true; fs.renameSync(temporary, file); }
  finally { if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function synchronize(action, manifestFile, transaction, verifyRuntime = true, runCommand = spawnSync) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(transaction || '')) throw new Error('OpenClaw 同步事务无效');
  const m = readManifest(manifestFile);
  const backupRoot = path.join(m.home, '.project-tool-sync');
  const lock = path.join(backupRoot, 'lock');
  const backupFile = path.join(backupRoot, `${transaction}.json`);
  noLinks(backupRoot);
  const owner = () => { try { return fs.readFileSync(path.join(lock, 'owner'), 'utf8'); } catch { return ''; } };
  function release() { if (owner() === transaction) { fs.unlinkSync(path.join(lock, 'owner')); fs.rmdirSync(lock); } }
  function verify() {
    if (m.entries.some(e => !fs.existsSync(e.file) || digest(fs.readFileSync(e.file)) !== e.sha256)) throw new Error('OpenClaw 目标文件校验失败');
    if (!verifyRuntime) return;
    const sibling = path.join(path.dirname(process.execPath), 'openclaw');
    const cli = fs.existsSync(sibling) ? sibling : 'openclaw';
    const command = args => {
      const result = runCommand(cli, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`OpenClaw ${args.slice(0, 2).join(' ')} 检查失败`);
      return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    };
    for (const resource of m.resources) {
      if (resource.kind === 'plugin') {
        const result = command(['plugins', 'inspect', resource.id, '--runtime', '--json']);
        if (result.plugin?.status !== 'loaded' || result.plugin?.version !== resource.version || !Array.isArray(result.diagnostics) || result.diagnostics.length) throw new Error('OpenClaw 插件版本或加载状态不符合本次发布');
      } else {
        const skill = command(['skills', 'info', resource.id, '--json']);
        if (!skill.eligible || !skill.modelVisible || skill.disabled || path.resolve(skill.filePath || '') !== path.resolve(m.workspace, 'skills', resource.id, 'SKILL.md')) throw new Error('OpenClaw Skill 未正确加载或对模型不可见');
      }
    }
  }
  if (action === 'apply') {
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('另一个 OpenClaw 同步尚未结束，请先核实该事务'); }
    fs.writeFileSync(path.join(lock, 'owner'), transaction, { mode: 0o600 });
    if (fs.existsSync(backupFile)) throw new Error('OpenClaw 同步事务已存在，不能覆盖恢复记录');
    const changes = m.entries.filter(e => !fs.existsSync(e.file) || digest(fs.readFileSync(e.file)) !== e.sha256);
    const dirs = new Set();
    const entries = changes.map(e => {
      let dir = path.dirname(e.file);
      while (!fs.existsSync(dir)) { dirs.add(dir); dir = path.dirname(dir); }
      const old = fs.existsSync(e.file) ? fs.statSync(e.file) : null;
      return { file: e.file, data: old ? fs.readFileSync(e.file).toString('base64') : null, mode: old?.mode & 0o777, uid: old?.uid, gid: old?.gid };
    });
    fs.writeFileSync(backupFile, JSON.stringify({ entries, dirs: [...dirs] }), { mode: 0o600, flag: 'wx' });
    for (const entry of changes) atomicWrite(entry.file, entry.data, entry.mode || 0o644);
    // 重启前先确认新产物可以被同一 OpenClaw 配置加载，尽量在旧网关仍运行时发现问题。
    verify();
    return { changed: changes.length, verifiedFiles: m.entries.length };
  }
  if (action === 'verify') { verify(); return { verifiedFiles: m.entries.length }; }
  if (action === 'commit') { release(); return { committed: true }; }
  if (action === 'restore') {
    if (owner() && owner() !== transaction) throw new Error('不能恢复其他 OpenClaw 同步事务');
    if (!fs.existsSync(backupFile)) { release(); return { restored: 0 }; }
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const managed = new Set(m.entries.map(e => e.file));
    for (const entry of backup.entries) {
      if (!managed.has(entry.file)) throw new Error('恢复记录包含范围外文件');
      noLinks(entry.file);
      if (entry.data === null) { if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file); }
      else { atomicWrite(entry.file, Buffer.from(entry.data, 'base64'), entry.mode); if (process.getuid?.() === 0) fs.chownSync(entry.file, entry.uid, entry.gid); }
    }
    for (const dir of backup.dirs.sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } }
    release(); return { restored: backup.entries.length };
  }
  throw new Error('OpenClaw 同步操作无效');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(synchronize(process.argv[2], process.argv[3], process.argv[4]))); }
  catch (error) { console.error(`[ERROR] OpenClaw 同步失败：${error.message}`); process.exitCode = 1; }
}
