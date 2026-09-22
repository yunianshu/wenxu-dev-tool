/**
 * Git 扫描与提交收集自测（无框架，node scripts/git-service-selftest.cjs 直接运行）
 * 覆盖：
 *   - 普通扫描与强制扫描并发时复用同一任务，不重复广播仓库发现事件
 *   - 重复仓库路径进入提交收集时，每个真实提交只返回一次
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-service-test-'))
  let passed = 0

  try {
    // 超过扫描批次阈值（200），确保首个扫描在事件循环让步时仍处于进行中。
    for (let i = 0; i < 220; i += 1) {
      fs.mkdirSync(path.join(tempRoot, `empty-${String(i).padStart(3, '0')}`))
    }

    const repo = path.join(tempRoot, 'sample-repo')
    fs.mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    git(repo, ['config', 'user.name', '测试用户'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    fs.writeFileSync(path.join(repo, 'README.md'), '# 测试仓库\n', 'utf8')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', '初始化测试提交'], {
      GIT_AUTHOR_DATE: '2026-09-04T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-09-04T10:00:00+08:00',
    })

    const found = []
    const firstScan = gitService.scanReposCached([tempRoot], [], {
      onRepo: (repoPath) => found.push(repoPath),
    })
    const forcedScan = gitService.scanReposCached([tempRoot], [], {
      force: true,
      onRepo: (repoPath) => found.push(repoPath),
    })
    const [firstResult, forcedResult] = await Promise.all([firstScan, forcedScan])

    assert.deepStrictEqual(firstResult, [repo], '普通扫描应只发现测试仓库')
    assert.deepStrictEqual(forcedResult, [repo], '并发强制扫描应复用同一结果')
    assert.deepStrictEqual(found, [repo], '同一进行中扫描只能广播一套仓库发现事件')
    passed += 1
    console.log('  ✓ 并发普通扫描与强制扫描不会重复广播仓库')

    const commits = await gitService.collectCommits([repo, repo], {
      since: '2026-09-04',
      until: '2026-09-05',
      authors: [],
      includeMerges: false,
    })
    assert.strictEqual(commits.length, 1, `重复仓库路径只应返回 1 条提交，实际 ${commits.length} 条`)
    assert.strictEqual(new Set(commits.map((item) => `${item.repo}\u0000${item.hash}`)).size, 1)
    assert.strictEqual(commits[0].subject, '初始化测试提交')
    passed += 1
    console.log('  ✓ 重复仓库路径不会产生重复提交')

    const options = { since: '2026-09-04', until: '2026-09-05', authors: [], includeMerges: false }
    assert.strictEqual(await gitService.collectCommits([repo], options), commits, '引用未变时应复用热缓存，不能重跑全量日志')
    const source = path.join(tempRoot, 'fetch-source')
    git(tempRoot, ['clone', '--quiet', repo, source])
    git(source, ['config', 'user.name', '测试用户'])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['commit', '--allow-empty', '-m', '拉取后补进的历史提交'], {
      GIT_AUTHOR_DATE: '2026-09-04T11:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-09-04T11:00:00+08:00',
    })
    const originalHead = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['fetch', source, 'HEAD:refs/remotes/review/main'])
    assert.strictEqual(git(repo, ['rev-parse', 'HEAD']), originalHead, '只更新远端引用，不改变当前分支')
    const fetched = await gitService.collectCommits([repo], options)
    assert.strictEqual(fetched.length, 2, 'fetch 补进历史提交后，同参数收集必须立即刷新')
    assert.strictEqual(await gitService.collectCommits([repo], options), fetched)
    passed += 1
    console.log('  ✓ 历史范围在 fetch 更新引用后立即刷新，未变化时仍命中热缓存')

    git(repo, ['checkout', '--detach', 'refs/remotes/review/main'])
    const detached = await gitService.collectCommits([repo], options)
    assert.notStrictEqual(detached, fetched, 'checkout 改变 HEAD 后必须检查新的提交图')
    git(repo, ['checkout', '--detach', originalHead])
    git(source, ['reset', '--hard', originalHead])
    git(repo, ['fetch', '--force', source, 'HEAD:refs/remotes/review/main'])
    const rewritten = await gitService.collectCommits([repo], options)
    assert.strictEqual(rewritten.length, 1, '引用改写后不得从历史增量缓存带回已移除的提交')
    const realNow = Date.now
    try {
      const now = realNow()
      Date.now = () => now + 121000
      assert.notStrictEqual(await gitService.collectCommits([repo], options), rewritten, '历史缓存达到有效期也必须重新读取')
    } finally { Date.now = realNow }
    passed += 1
    console.log('  ✓ checkout、引用改写和历史缓存到期不会复用旧结果')

    console.log(`\n结果：${passed} 通过，0 失败`)
  } finally {
    // 仅清理由本测试创建且位于系统临时目录下的隔离数据。
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`  ✗ Git 服务自测失败：${error.stack || error.message}`)
  process.exitCode = 1
})
