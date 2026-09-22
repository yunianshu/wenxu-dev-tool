/** 真实 Electron：全局服务器仅录入一次，两个项目选择复用；不连接服务器。 */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert')
const { spawnSync } = require('child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-ui-'))
const data = path.join(root, 'userdata'), project = path.join(root, 'project')
fs.mkdirSync(data); fs.mkdirSync(project)
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ roots: [], harness: { autoStart: false } }))
fs.writeFileSync(path.join(data, 'deploy-projects.json'), JSON.stringify({ projects: [{ id: 'auto-ui', name: 'A自动发布验证', localPath: project, deployMode: 'auto' }, { id: 'second-ui', name: 'B共享服务器验证', localPath: project, deployMode: 'auto' }] }))
const evaluate = `(async () => {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text));
  const open = button('服务器管理'); if (!open) throw new Error('缺少服务器管理入口'); open.click(); await pause(400);
  const set = (selector, value) => { const el=document.querySelector(selector); if (!el) throw new Error(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
  set('input[placeholder="服务器 IP 或域名（SSH）"]','example.invalid');
  set('input[placeholder="例如：正式服务器"]','正式服务器');
  set('input[placeholder="服务器登录密码"]','test-fixture-only');
  await pause(200);
  if (button('保存服务器').disabled) throw new Error('保存按钮仍禁用');
  button('保存服务器').click(); await pause(800);
  const created = await window.gitReport.deployServersList();
  if (!created.length) throw new Error('服务器未保存：'+document.body.innerText.slice(-700));
  button('完成').click(); await pause(300);
  const pick = async (selector, label) => {
    const select=document.querySelector(selector); if (!select) throw new Error(selector);
    select.querySelector('.el-select__wrapper').click(); await pause(250);
    const options=[...document.querySelectorAll('.el-select-dropdown__item')].filter(e=>e.getBoundingClientRect().height>0);
    const option=options.find(e=>e.textContent.includes(label)); if (!option) throw new Error('没有选项：'+label);
    option.click(); await pause(600);
  };
  await pick('.topbar-project-select','A自动发布验证');
  await pick('.bar-card .el-select','正式服务器');
  await pick('.topbar-project-select','B共享服务器验证');
  await pick('.bar-card .el-select','正式服务器');
  const list=await window.gitReport.deployProjectsList(); const p=list.find(p=>p.id==='auto-ui');
  const allServers=await window.gitReport.deployServersList();
  const publish=[...document.querySelectorAll('button')].find(b=>/发布/.test(b.textContent) && b.classList.contains('publish-btn')) || button('发布版本') || button('发布');
  return {mode:p.deployMode,production:p.productionTargetId,targets:p.targets.map(t=>({id:t.id,host:t.server.host,remotePath:t.remotePath,secretConfigured:t.server.secretConfigured})),version:p.version,port:p.autoDeploy.port,publishEnabled:!!publish&&!publish.disabled,serverCount:allServers.length,references:allServers[0].projects.length,serverIds:list.map(p=>p.targets[0].serverId),body:document.body.innerText.slice(-200)};
})()`
const r = spawnSync(process.execPath, [path.resolve('node_modules/electron/cli.js'), '.'], {
  encoding: 'utf8', timeout: 40000, env: { ...process.env, USERPROFILE: root, PROJECT_MANAGER_USER_DATA: data,
    SMOKE_EXIT_MS: '16000', SMOKE_VIEW: '部署', SMOKE_CLICK_MS: '1500', SMOKE_EVAL: evaluate, SMOKE_EVAL_MS: '3500',
    SMOKE_SCREENSHOT_PATH: path.join(root, 'formal-server.png'), SMOKE_SHOT_MS: '11000' },
})
try {
  const line = String(r.stdout).split('\n').find(l=>l.includes('[SMOKE][eval]'))
  assert(line, String(r.stdout).slice(-2000) + String(r.stderr).slice(-500))
  const result = JSON.parse(line.split('[SMOKE][eval]')[1])
  assert.equal(result.mode, 'auto')
  const target = result.targets.find(t=>t.id===result.production)
  assert(target && target.host==='example.invalid' && target.remotePath==='' && target.secretConfigured, '正式服务器保存结果：' + JSON.stringify(result))
  assert.equal(result.version.strategy,'auto'); assert.equal(result.port,0)
  assert.equal(result.serverCount,1); assert.equal(result.references,2); assert.equal(new Set(result.serverIds).size,1)
  assert(result.publishEnabled, '未填写版本/构建参数时仍应可一键发布：' + JSON.stringify(result))
  console.log('PASS 一次新增全局服务器→两个项目选择复用→凭据持久化→发布按钮可用；无真实服务器操作')
  console.log('界面截图：'+path.join(root,'formal-server.png'))
} catch (e) { console.error(e.message); process.exitCode=1 }
