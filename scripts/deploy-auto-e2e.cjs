/** 真实 Electron：只设置正式服务器即可启用自动发布；不连接服务器。 */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert')
const { spawnSync } = require('child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-ui-'))
const data = path.join(root, 'userdata'), project = path.join(root, 'project')
fs.mkdirSync(data); fs.mkdirSync(project)
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ roots: [], harness: { autoStart: false } }))
fs.writeFileSync(path.join(data, 'deploy-projects.json'), JSON.stringify({ projects: [{ id: 'auto-ui', name: '自动发布验证', localPath: project, deployMode: 'auto' }] }))
const evaluate = `(async () => {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text));
  const open = button('设置正式服务器'); if (!open) throw new Error('缺少正式服务器入口'); open.click(); await pause(400);
  const set = (selector, value) => { const el=document.querySelector(selector); if (!el) throw new Error(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
  set('input[placeholder="服务器 IP 或域名（SSH）"]','example.invalid');
  set('input[placeholder="服务器登录密码"]','test-fixture-only');
  await pause(100); button('保存正式服务器').click(); await pause(1000);
  const list=await window.gitReport.deployProjectsList(); const p=list.find(p=>p.id==='auto-ui');
  const publish=[...document.querySelectorAll('button')].find(b=>/发布/.test(b.textContent) && b.classList.contains('publish-btn')) || button('发布版本') || button('发布');
  return {mode:p.deployMode,production:p.productionTargetId,targets:p.targets.map(t=>({id:t.id,host:t.server.host,remotePath:t.remotePath,secretConfigured:t.server.secretConfigured})),version:p.version,port:p.autoDeploy.port,publishEnabled:!!publish&&!publish.disabled,body:document.body.innerText.slice(-200)};
})()`
const r = spawnSync(process.execPath, [path.resolve('node_modules/electron/cli.js'), '.'], {
  encoding: 'utf8', timeout: 40000, env: { ...process.env, USERPROFILE: root, PROJECT_MANAGER_USER_DATA: data,
    SMOKE_EXIT_MS: '13000', SMOKE_VIEW: '部署', SMOKE_CLICK_MS: '1500', SMOKE_EVAL: evaluate, SMOKE_EVAL_MS: '3500',
    SMOKE_SCREENSHOT_PATH: path.join(root, 'formal-server.png'), SMOKE_SHOT_MS: '7000' },
})
try {
  const line = String(r.stdout).split('\n').find(l=>l.includes('[SMOKE][eval]'))
  assert(line, String(r.stdout).slice(-2000) + String(r.stderr).slice(-500))
  const result = JSON.parse(line.split('[SMOKE][eval]')[1])
  assert.equal(result.mode, 'auto')
  const target = result.targets.find(t=>t.id===result.production)
  assert(target && target.host==='example.invalid' && target.remotePath==='' && target.secretConfigured, '正式服务器保存结果：' + JSON.stringify(result))
  assert.equal(result.version.strategy,'auto'); assert.equal(result.port,0)
  assert(result.publishEnabled, '未填写版本/构建参数时仍应可一键发布：' + JSON.stringify(result))
  console.log('PASS 正式服务器保存→自动模式→凭据持久化→发布按钮可用；无真实服务器操作')
  console.log('界面截图：'+path.join(root,'formal-server.png'))
} catch (e) { console.error(e.message); process.exitCode=1 }
