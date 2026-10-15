const { italentPage } = require('./italent-page')
const { randomUUID } = require('node:crypto')

const ATTENDANCE_URL = 'https://cloud.italent.cn/attendance?metaObjName=Attendance.AttendanceStatistics&app=Attendance&viewName=Attendance.AttendanceDataRecordNavView&_qpt=indexpage#/indexPage'
const SESSION = 'personnel-plm-leave'

class ItalentBrowser {
  constructor({ fetchImpl = globalThis.fetch, endpoint = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086' } = {}) {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('浏览器桥接必须使用本机地址')
    this.endpoint = url.origin
    this.fetch = fetchImpl
    this.pageReady = false
    this.session = `${SESSION}-${randomUUID()}`
  }

  async command(action, args = {}) {
    let response
    try {
      response = await this.fetch(`${this.endpoint}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args, session: this.session }), signal: AbortSignal.timeout(45000) })
    } catch { throw new Error('无法连接浏览器：请开启 Kimi Browser Extension 的本地连接，并在浏览器登录北森') }
    let result
    try { result = await response.json() } catch { throw new Error('本机浏览器桥接响应无法识别，请检查连接地址') }
    if (!response.ok || !result?.ok) {
      // 不输出底层脚本、签名、Cookie 或原始页面响应。
      const message = String(result?.error?.message || '')
      if (/update.*Kimi|Kimi.*update/i.test(message)) throw new Error('请更新 Kimi Browser Extension 后重试连接')
      const business = /(?:Error: )([^\n]+)(?:\n|$)/.exec(message)
      throw new Error(business?.[1]?.slice(0, 300) || '浏览器操作失败，请检查扩展连接和北森登录状态')
    }
    return result.data
  }

  async connect() {
    const result = await this.command('navigate', { url: ATTENDANCE_URL, newTab: !this.pageReady, group_title: 'Personnel PLM · 一键请假' })
    this.tabId = result.tabId
    this.pageReady = true
    return { connected: true }
  }

  async select() {
    if (!this.pageReady) return this.connect()
    // find_tab 只定位本功能自己的标签，不借用用户的其他页面。
    const { tabs = [] } = await this.command('list_tabs')
    const tab = tabs.find((item) => item.tabId === this.tabId)
    if (!tab) { this.pageReady = false; this.session = `${SESSION}-${randomUUID()}`; return this.connect() }
    await this.command('find_tab', { url: tab.url })
  }

  async run(action, options) {
    try { await this.select() } catch (error) { if (action === 'apply') error.submissionState = 'notSubmitted'; throw error }
    const code = `(async()=>{try{if(document.readyState==='loading')await new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true}));return JSON.stringify({success:true,data:await (${italentPage.toString()})(${JSON.stringify(action)},${JSON.stringify(options || {})})})}catch(e){return JSON.stringify({success:false,message:String(e.message||'北森操作失败').replace(/https?:\\/\\/\\S+/g,'[请求地址已隐藏]').slice(0,300),submissionState:e.submissionState==='notSubmitted'?'notSubmitted':'unknown'})}})()`
    const result = await this.command('evaluate', { code })
    if (result?.type !== 'string') throw new Error('北森页面返回异常，请重新连接')
    let data
    try { data = JSON.parse(result.value) } catch { throw new Error('北森业务数据无法识别') }
    if (data?.success !== true) {
      const error = new Error(data?.message || '北森业务数据无法识别')
      if (data?.submissionState === 'notSubmitted') error.submissionState = 'notSubmitted'
      throw error
    }
    return data.data
  }

  read(options) { return this.run('read', options) }
  prepare(options) { return this.run('prepare', options) }
  apply(options) { return this.run('apply', options) }
}

module.exports = { ItalentBrowser, ATTENDANCE_URL }
