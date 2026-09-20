/**
 * E2E：AI 部署助手结果区的排版（真实 Electron）
 *
 * 需求：体检结果各区块的排版混乱——说明与卡片被压成一条，内容读不全。
 *
 * 根因：.ai-deploy 是 flex column + max-height + overflow:auto，但子项没 pin 住，
 * 内容超出时 flex 先压缩子项而不是滚动。
 *
 * 验收标准（源自需求）：
 *   L1 打开对话框后操作栏为 sticky（滚动时不丢失「重新体检 / 结论来源」）
 *   L2 容器内放入高内容后，各子项保持自身高度、不被压缩
 *   L3 此时容器可滚动（内容靠滚动查看，而不是被压扁）
 *
 * 用法：node scripts/deploy-ai-layout-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const REAL = path.join(process.env.APPDATA, 'dev-project-manager')
const SANDBOX = path.join(os.tmpdir(), `pm-ailayout-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed += 1 }
}

function prepare() {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  fs.mkdirSync(USER_DATA, { recursive: true })
  for (const f of fs.readdirSync(REAL)) {
    const src = path.join(REAL, f)
    if (fs.statSync(src).isFile() && f.endsWith('.json')) fs.copyFileSync(src, path.join(USER_DATA, f))
  }
}

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('AI 部署助手'))
  if (!btn) { out.error = '未找到「AI 部署助手」按钮'; return out }
  btn.click()
  await sleep(1000)
  const box = document.querySelector('.ai-deploy')
  if (!box) { out.error = '对话框未打开'; return out }
  const ops = box.querySelector('.ops')
  out.opsPosition = ops ? getComputedStyle(ops).position : null
  out.opsShrink = ops ? getComputedStyle(ops).flexShrink : null
  // 模拟「体检结果很长」：往容器里塞高块，看它们是否被 flex 压缩
  const probes = []
  for (let i = 0; i < 3; i += 1) {
    const d = document.createElement('div')
    d.style.height = '300px'
    d.style.background = '#eef1f4'
    d.style.flexShrink = ''
    box.appendChild(d)
    probes.push(d)
  }
  await sleep(400)
  out.probeHeights = probes.map((d) => d.offsetHeight)
  out.container = { scroll: box.scrollHeight, client: box.clientHeight }
  box.scrollTop = 200
  await sleep(200)
  out.opsTopAfterScroll = ops ? Math.round(ops.getBoundingClientRect().top - box.getBoundingClientRect().top) : null
  probes.forEach((d) => d.remove())
  return out
})()`

async function run() {
  prepare()
  const child = spawn(process.execPath, [ELECTRON, '.'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_MANAGER_USER_DATA: USER_DATA,
      SMOKE_WIDTH: '1400',
      SMOKE_HEIGHT: '900',
      SMOKE_VIEW: '部署',
      SMOKE_CLICK_MS: '3200',
      SMOKE_EVAL: PROBE,
      SMOKE_EVAL_MS: '7000',
      SMOKE_EXIT_MS: '18000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('exit', resolve))

  const line = out.split('\n').find((l) => l.includes('[SMOKE][eval]'))
  if (!line) { console.log('  FAIL  探针未返回'); return }
  const r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  if (r.error) { console.log(`  FAIL  ${r.error}`); failed += 1; return }

  assert('L1 操作栏 sticky', r.opsPosition === 'sticky', `实得 ${r.opsPosition}`)
  assert('L1 操作栏不参与压缩', r.opsShrink === '0', `实得 ${r.opsShrink}`)
  const clamped = (r.probeHeights || []).filter((h) => h < 290)
  assert('L2 子项未被压缩（各 300px）', clamped.length === 0, `实得 ${JSON.stringify(r.probeHeights)}`)
  assert('L3 内容靠滚动而非压扁', r.container.scroll > r.container.client, JSON.stringify(r.container))
  assert('L1 滚动后操作栏仍在顶部', r.opsTopAfterScroll !== null && r.opsTopAfterScroll <= 12, `偏移 ${r.opsTopAfterScroll}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
}

run().catch((e) => { console.error(e); process.exit(1) }).finally(() => {
  console.log(`沙箱可清理：${SANDBOX}`)
  process.exit(failed ? 1 : 0)
})
