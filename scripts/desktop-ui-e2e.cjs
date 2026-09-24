/** 桌面 v2 视觉验收：运行真实 Vue 页面，IPC 使用明确的隔离数据，不连接业务平台。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'output', 'desktop-v2-review')
const PORT = 4178

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE)
  try { return require('playwright-core') } catch { /* 可复用本机 CLI 的依赖，无需修改产品依赖 */ }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const file = path.join(cache, entry, 'node_modules', 'playwright-core')
    if (fs.existsSync(file)) return require(file)
  }
  throw new Error('请安装 Playwright CLI，或设置 PLAYWRIGHT_MODULE 指向 playwright-core')
}

function installFixture({ projects, reports, deployments }) {
  const events = new Map()
  const prefs = () => JSON.parse(localStorage.getItem('ui-test-prefs') || '{"theme":"light","sidebarCollapsed":false,"terminalFontSize":13,"terminalFontFamily":""}')
  const repos = projects.filter(p => p.localPath).map(p => p.localPath)
  const terminalSessions = new Map()
  window.__uiCalls = []
  window.__uiUnknown = []
  const config = {
    roots: ['D:/Projects'], excludes: ['node_modules', '.git'], identities: [{ name: '开发者', email: 'developer@example.invalid' }],
    ai: { baseUrl: 'https://ai.example.invalid/v1', model: 'team-model', keyConfigured: true, keyMasked: '已配置', temperature: 0.7 },
    zentao: { baseUrl: 'https://zentao.example.invalid', account: 'developer', pwdConfigured: true, workStart: '08:30', lunchStart: '12:00', lunchEnd: '13:00' },
    hanprint: { baseUrl: 'https://work.example.invalid', account: 'developer', pwdConfigured: true },
    harness: { port: 3080, autoStart: false, fullscreen: false }, closeAction: 'ask',
  }
  const skills = ['daily-report', 'git-commit', 'project-diagrams', 'project-packager', 'repo-cleanup', 'sample-linked-skill'].map((name, index) => ({ name, description: ['按 Git 提交生成工作日报', '检查差异并生成规范提交', '依据仓库维护技术图表', '构建与校验发布产物', '清理证据明确的可再生文件', '链接目标不可用'][index], enabled: index < 3, hasSkillMd: index !== 5, linkBroken: index === 5, linkTarget: index === 5 ? 'D:/missing-skill' : '', dir: 'D:/skills/' + name }))
  const platforms = ['Claude Code', 'Codex', 'Kimi CLI', 'ZCode'].map((name, index) => ({ id: ['claude', 'codex', 'kimi', 'zcode'][index], name, installed: true, dir: 'D:/extensions/' + name, pluginsSupported: index !== 2, pluginNote: '该平台暂不支持插件', skills: structuredClone(skills), plugins: [{ id: 'workspace', name: 'Workspace tools', enabled: true, version: '1.0.0', installPath: 'D:/plugins/workspace' }] }))
  const api = {
    projectsList: () => projects,
    configLoad: () => config, configSave: value => Object.assign(config, value),
    uiPrefsLoad: prefs, uiPrefsSave: value => { localStorage.setItem('ui-test-prefs', JSON.stringify(value)); return { ok: true, prefs: value } },
    getIdentity: () => config.identities[0], winIsFullScreen: () => false, winIsMaximized: () => false,
    appUiReady: () => {}, harnessUpdateStatus: () => ({}), reposSnapshot: () => repos, warmup: () => repos,
    collectCommits: () => projects.slice(0, 3).flatMap((p, index) => Array.from({ length: 4 - index }, (_, n) => ({ hash: `b${index}d${n}9ea`, subject: ['优化项目工作区布局', '完善界面主题与交互状态', '修复报告范围显示', '更新开发文档'][n], message: '改进桌面工作区', author: '开发者', email: 'developer@example.invalid', date: new Date().toISOString(), repo: p.localPath, shortName: p.name }))),
    listHistory: () => reports, readHistory: id => ({ ...reports.find(row => row.id === id), content: '# 活动报告\n\n完成项目列表、主题和桌面工作区的调整。' }),
    deployHistoryList: () => deployments, deployServersList: () => [{ id: 'server-test', name: '测试服务器', host: '192.0.2.10', port: 22, username: 'deploy', authType: 'password', secretConfigured: true }],
    deployDetectVersion: () => ({ version: '1.4.98', source: 'package.json' }), deployReleases: () => ({ ok: true, current: '1.4.97', releases: ['1.4.97', '1.4.96'] }),
    debugStatus: () => ({ hasStartBat: true, running: false }), fillBindings: () => ({ [projects[0].id]: { taskId: 1042, taskName: '工作区界面优化' } }), fillLog: () => ({ ok: true, entries: [] }),
    fillPlan: payload => {
      const selectedIds = payload.selectedIds || [projects[0].id, projects[1].id]
      const dayProjects = projects.slice(0, 3).map((project, index) => ({ projectId: project.id, projectName: project.name, selected: selectedIds.includes(project.id), taskId: index < 2 ? 1042 + index : null, taskName: ['工作区界面优化', '文档规范更新'][index] || '', commitCount: 4 - index, hours: index === 0 ? 5 : 3, work: '完成工作区布局、主题与交互状态调整。\n保留现有业务流程，验证窗口适配。' }))
      const planned = dayProjects.filter(project => project.selected)
      return { ok: true, date: payload.date, rangeStart: payload.startTime || '08:30', rangeEnd: payload.endTime || '17:30', crossDay: false, commitCount: 9, selectedIds, dayProjects, planned, tasks: planned.filter(project => project.taskId).map(project => ({ taskId: project.taskId, taskName: project.taskName, consumed: project.hours, taskLeft: 12, left: 12 - project.hours, rows: [] })), hpItems: [{ ProjectName: '桌面工具', TaskName: '开发与验证', Percent: 100, TaskId: 1 }], hpExisting: [], ztTasks: [{ id: 1042, name: '工作区界面优化', status: 'doing', project: '项目工作台', left: 12 }], unmatched: planned.filter(project => !project.taskId) }
    },
    repoInfo: repo => ({ branch: 'main', remote: 'https://example.invalid/team/' + repo.split('/').pop(), lastCommit: '完善项目工作区' }),
    extensionsList: () => ({ platforms }), extensionsReadSkill: (id, name) => ({ ok: true, hasSkillMd: true, content: '# ' + name + '\n\n这是用于隔离界面验证的本地技能内容。' }),
    harnessStatus: () => ({ status: 'stopped', installed: false }),
    terminalShellOptions: () => ({ options: [{ id: 'powershell', name: 'PowerShell', label: 'PowerShell' }] }),
    terminalLayoutGet: () => ({ layout: { gridMode: '2x2', columnWidths: [0.5, 0.5], rowHeights: [0.5, 0.5], panes: projects.slice(0, 2).map((p, index) => ({ paneId: 'test-pane-' + index, projectId: p.id, shellId: 'powershell' })) } }),
    terminalLayoutSave: () => ({ ok: true }), terminalList: () => [...terminalSessions.values()],
    terminalCreate: payload => { const session = { ...payload, id: payload.paneId || 'test-session', cwd: payload.cwd, shell: 'PowerShell', shellName: 'PowerShell' }; terminalSessions.set(session.id, session); setTimeout(() => { for (const fn of events.get('onTerminalData') || []) fn({ id: session.id, sessionId: session.id, data: '\x1b[32m✓\x1b[0m 项目工作区已就绪\r\nPS ' + payload.cwd + '> ' }) }, 100); return { ok: true, session, replay: '' } },
    terminalAttach: id => ({ ok: true, session: terminalSessions.get(id), replay: 'PS D:/Projects> ' }), terminalResize: () => ({ ok: true }),
    aiModels: () => ({ ok: true, models: ['team-model'] }),
    openPath: () => ({ ok: true }), copyText: () => ({ ok: true }),
  }
  window.gitReport = new Proxy(api, { get(target, name) {
    if (String(name).startsWith('on')) return fn => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name).delete(fn) }
    if (!(name in target)) return async () => { window.__uiUnknown.push(String(name)); throw new Error('未配置的测试 IPC：' + String(name)) }
    return async (...args) => { window.__uiCalls.push(String(name)); return target[name](...args) }
  } })
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const factory = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(ROOT, 'src/components/deploy/deploy-form.js'), 'utf8')).toString('base64'))
  const names = ['Personnel PLM', '组件文档站', '内部 API 服务', '交付脚本', '实验项目', '归档项目']
  const projects = names.map((name, index) => ({ ...factory.emptyProject(), id: 'project-' + index, name, description: ['项目资料、Git 活动与部署的统一工作区', '前端组件与交互规范', '业务接口与后台服务', '自动化构建和交付工具', '探索新的开发流程', '历史项目资料'][index], localPath: 'D:/Projects/' + ['personnel-plm', 'design-system', 'api-service', 'release-tools', 'sandbox', 'archive'][index], status: index === 4 ? 'paused' : index === 5 ? 'archived' : 'active', tags: ['桌面工具', 'Vue'], notes: '保留项目目录与既有工作流程。', deployMode: 'docker', version: { strategy: 'manual', manual: '1.4.98' }, targets: [{ ...factory.emptyTarget(), id: 'test', name: '测试环境', serverId: 'server-test', server: { ...factory.emptyTarget().server, host: '192.0.2.10', port: 22, username: 'deploy', secretConfigured: true }, remotePath: '/opt/apps/personnel-plm' }] }))
  const reports = Array.from({ length: 18 }, (_, index) => ({ id: 'report-' + index, title: (index % 3 ? '工作日报' : '工作周报') + ' · 2026-09-' + String(23 - index).padStart(2, '0'), createdAt: '2026-09-' + String(23 - index).padStart(2, '0') + ' 18:30:00', period: index % 3 ? 'daily' : 'weekly', dateRange: '2026-09-23', commitCount: 12 + index, projectCount: 3, projectId: '' }))
  const deployments = Array.from({ length: 4 }, (_, index) => ({ id: 'deploy-' + index, projectId: projects[0].id, projectName: projects[0].name, targetId: 'test', targetName: '测试环境', version: '1.4.' + (97 - index), type: 'deploy', status: index === 2 ? 'failed' : 'success', startedAt: Date.now() - index * 86400000, finishedAt: Date.now() - index * 86400000 + 42000, durationMs: 42000, summary: '部署完成', server: '192.0.2.10' }))
  const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, windowsHide: true, stdio: 'pipe' })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += chunk })
  server.stderr.on('data', chunk => { serverLog += chunk })
  let browser
  const errors = []
  const checks = []
  try {
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      try { if ((await fetch(`http://127.0.0.1:${PORT}`)).ok) break } catch { /* 等待测试服务就绪 */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    browser = await playwright().chromium.launch({ channel: 'msedge', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()) })
    await page.addInitScript(installFixture, { projects, reports, deployments })
    await page.goto(`http://127.0.0.1:${PORT}`)
    await page.locator('.dashboard-metrics').waitFor()
    const navigate = async name => { await page.locator('.app-menu .el-menu-item').filter({ has: page.locator('span', { hasText: new RegExp('^' + name + '$') }) }).click(); await page.waitForTimeout(250) }
    const capture = async (name, theme, width, height) => {
      await page.waitForTimeout(150)
      await page.waitForFunction(() => [...document.querySelectorAll('.el-loading-mask')].every(element => getComputedStyle(element).display === 'none' || element.getBoundingClientRect().height === 0))
      const layout = await page.evaluate(() => {
        const box = selector => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
        return { titlebar: box('.app-titlebar'), sidebar: box('.app-sidebar'), topbar: box('.app-topbar'), status: box('.app-statusbar'), documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, theme: document.documentElement.dataset.theme, overflowing: [...document.querySelectorAll('.topbar-slot, .app-menu, .content-area')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className) }
      })
      assert.equal(layout.titlebar.height, 40, '窗口标题栏40px')
      assert.equal(layout.sidebar.width, 208, '侧栏208px')
      assert.equal(layout.topbar.height, 64, '页面工具栏64px')
      assert.equal(layout.status.height, 24, '状态栏24px')
      assert.equal(layout.status.bottom, height, '状态栏必须完整显示')
      assert.equal(layout.theme, theme)
      assert.equal(layout.documentWidth, width, '窗口不得出现横向溢出')
      assert.deepEqual(layout.overflowing, [], name + ' 不得横向溢出')
      checks.push({ name, theme, width, height, layout })
      await page.screenshot({ path: path.join(OUTPUT, `${theme}-${width}-${name}.png`), fullPage: false })
    }
    const pages = [['工作台', 'dashboard'], ['项目', 'projects'], ['AI 助手', 'chat'], ['DeepSeek Harness', 'harness'], ['终端工作台', 'terminal'], ['活动报告', 'report'], ['一键填报', 'fillreport'], ['部署', 'deploy'], ['扩展管理', 'extensions'], ['设置', 'settings']]
    for (const theme of ['light', 'dark']) {
      await navigate('设置')
      await page.getByRole('tab', { name: '界面', exact: true }).click()
      await page.locator('.theme-options .el-radio-button').filter({ hasText: theme === 'dark' ? '黑色' : '浅色' }).click()
      for (const [width, height] of [[1440, 900], [1280, 720]]) {
        await page.setViewportSize({ width, height })
        for (const [label, name] of pages) {
          await navigate(label)
          if (name === 'settings') {
            for (const section of ['AI 服务', 'Git 活动', '个人身份', '一键填报', '界面', '应用信息']) {
              await page.getByRole('tab', { name: section, exact: true }).click()
              await capture('settings-' + section, theme, width, height)
            }
          } else {
            await capture(name, theme, width, height)
            if (name === 'fillreport') {
              await page.getByRole('button', { name: /生成报告|重新生成/ }).click()
              await page.locator('.fill-summary').waitFor()
              await capture('fillreport-generated', theme, width, height)
            }
          }
        }
      }
    }
    for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height })
      for (const [label, name] of [['项目', 'projects'], ['终端工作台', 'terminal'], ['部署', 'deploy']]) { await navigate(label); await capture(name, 'dark', width, height) }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await navigate('项目')
    await page.getByRole('textbox', { name: '搜索项目' }).fill('API')
    assert.equal(await page.getByRole('option', { name: /内部 API/ }).count(), 1, '项目搜索保留真实匹配项')
    assert.equal(await page.locator('.project-list-item').count(), 1)
    await page.getByRole('textbox', { name: '搜索项目' }).fill('')
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.locator('.el-dialog').last().waitFor()
    assert(await page.locator('.el-dialog').getByRole('button', { name: /创建项目/ }).isDisabled(), '空名称不可创建项目')
    await page.screenshot({ path: path.join(OUTPUT, 'dark-project-dialog.png') })
    await page.keyboard.press('Escape')
    await navigate('一键填报')
    const firstProject = page.locator('.prow').filter({ hasText: 'Personnel PLM' })
    await firstProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.summary-total strong')?.textContent.includes('3.00'))
    await firstProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.summary-total strong')?.textContent.includes('8.00'))
    const unboundProject = page.locator('.prow').filter({ hasText: '内部 API 服务' })
    await unboundProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.binding-warning'))
    assert(await page.getByRole('button', { name: '预览提交', exact: true }).isDisabled(), '未绑定项目阻止预览')
    assert(await page.getByRole('button', { name: '一键提交', exact: true }).isDisabled(), '未绑定项目阻止写入')
    await page.getByRole('button', { name: '定位未绑定' }).click()
    await page.getByRole('textbox', { name: '搜索禅道任务' }).fill('1042')
    assert.equal(await page.locator('.bind-task').count(), 1, '绑定抽屉搜索真实任务')
    await page.screenshot({ path: path.join(OUTPUT, 'dark-fill-bind-drawer.png') })
    await page.keyboard.press('Escape')
    await navigate('扩展管理')
    await page.getByRole('textbox', { name: '搜索扩展' }).fill('git-commit')
    assert.equal(await page.locator('.ext-table-wrap .el-table__body tr').count(), 1, '扩展搜索必须真正过滤')
    await page.locator('.ext-table-wrap .el-table__body tr').dblclick()
    await page.locator('.skill-doc').waitFor()
    assert((await page.locator('.skill-doc').innerText()).includes('git-commit'))
    await page.keyboard.press('Escape')
    const unknown = await page.evaluate(() => window.__uiUnknown)
    await page.reload()
    await page.locator('.dashboard-metrics').waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', '主题在重载后恢复')
    unknown.push(...await page.evaluate(() => window.__uiUnknown))
    assert.deepEqual(unknown, [], '所有测试 IPC 都应明确建模')
    assert.deepEqual(errors, [], '页面不能发生运行时错误')
    fs.writeFileSync(path.join(OUTPUT, 'verification.json'), JSON.stringify({ timestamp: new Date().toISOString(), checks, errors, unknown, screenshots: checks.length + 2 }, null, 2))
    console.log(`通过：${checks.length} 个页面/主题/尺寸检查，项目与扩展交互、弹窗门禁和主题重载；截图：${OUTPUT}`)
  } finally {
    if (browser) await browser.close()
    server.kill()
    if (errors.length) console.error(JSON.stringify(errors, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
