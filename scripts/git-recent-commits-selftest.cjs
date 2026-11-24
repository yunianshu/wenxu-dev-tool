/**
 * 每仓库最近提交自测（无框架，node scripts/git-recent-commits-selftest.cjs 直接运行）
 * 覆盖：
 *   - 单仓库返回最近提交且按时间倒序，字段与 collectCommits 的提交对象一致
 *   - 多仓库时结果与传入仓库顺序一一对应，单仓库查询失败不影响其它仓库
 */
const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const gitService = require('../electron/git-service')

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  }).trim()
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-recent-test-'))
  let passed = 0

  try {
    const repo = path.join(tempRoot, 'sample-repo')
    fs.mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    git(repo, ['config', 'user.name', '测试用户'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    const subjects = ['初始化仓库', '补充说明', '修复缺陷']
    subjects.forEach((subject, index) => {
      fs.writeFileSync(path.join(repo, `file-${index}.txt`), `${index}\n`, 'utf8')
      git(repo, ['add', '.'])
      git(repo, ['commit', '-m', subject], {
        GIT_AUTHOR_DATE: `2026-09-0${index + 1}T10:00:00+08:00`,
        GIT_COMMITTER_DATE: `2026-09-0${index + 1}T10:00:00+08:00`,
      })
    })

    const [single] = await gitService.recentCommits([repo])
    assert.ok(Array.isArray(single?.commits), 'recentCommits 应返回 [{ repo, commits }] 结构')
    assert.strictEqual(single.repo, repo, '结果仓库路径应与传入一致')
    assert.strictEqual(single.commits.length, 3, `应返回全部 3 条提交，实际 ${single.commits.length}`)
    assert.deepStrictEqual(
      single.commits.map((item) => item.subject),
      ['修复缺陷', '补充说明', '初始化仓库'],
      '单仓库内应按时间倒序排列'
    )
    assert.strictEqual(single.commits[0].date, '2026-09-03', '提交日期应为 YYYY-MM-DD')
    assert.ok(/^[0-9a-f]{10}$/.test(single.commits[0].hash), '哈希应截短为 10 位，与 collectCommits 一致')
    passed += 1
    console.log('  ✓ 单仓库最近提交按时间倒序返回')

    // 不存在的仓库路径：查询失败返回空数组，不影响其它仓库
    const multi = await gitService.recentCommits([path.join(tempRoot, 'not-a-repo'), repo])
    assert.strictEqual(multi.length, 2, '结果应与传入仓库数量一致')
    assert.deepStrictEqual(multi[0], { repo: path.join(tempRoot, 'not-a-repo'), commits: [] }, '失败仓库应返回空提交列表')
    assert.strictEqual(multi[1].commits.length, 3, '有效仓库结果不受失败仓库影响')
    passed += 1
    console.log('  ✓ 多仓库结果与传入顺序对应，失败仓库不影响其它仓库')

    console.log(`\n结果：${passed} 通过，0 失败`)
  } finally {
    // 仅清理由本测试创建且位于系统临时目录下的隔离数据。
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`  ✗ 最近提交自测失败：${error.stack || error.message}`)
  process.exitCode = 1
})
