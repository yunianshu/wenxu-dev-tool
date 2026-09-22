/** 部署表单与历史展示的共享工厂/格式化工具（DeployView 与 deploy 子组件共用） */

export function genId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function emptyTarget() {
  return {
    id: genId(),
    name: '环境 1',
    server: {
      host: '', port: 22, username: 'root', authType: 'password', keyPath: '',
      secret: '', clearSecret: false, passphrase: '', clearPassphrase: false,
      secretConfigured: false, secretMasked: '', passphraseConfigured: false,
    },
    remotePath: '',
    health: { enabled: true, url: '', timeout: 90, interval: 3 },
    // 数据库备份按环境独立配置：测试/生产是不同实例，容器名与库名必然不同
    db: { enabled: false, type: 'postgres', container: '', name: '', user: '' },
    dataSync: {
      enabled: false, localDir: 'data', remoteDir: 'shared/data',
      importMode: 'none', importCommand: '', importUser: '',
      importSecret: '', clearImportSecret: false, importSecretConfigured: false, importSecretMasked: '',
    },
  }
}

export function emptyProject() {
  const t = emptyTarget()
  return {
    id: '',
    name: '',
    localPath: '',
    version: { strategy: 'auto', manual: '' },
    // 部署形态：docker = Compose 编排；script = 项目自带脚本（发布包 + upgrade.sh）
    deployMode: 'auto',
    productionTargetId: '',
    autoDeploy: { port: 0 },
    composeFile: 'docker-compose.yml',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', bootstrapJava: false, bootstrapPgdump: false, packageCommand: '', packageTimeoutSec: 900, autoBumpVersion: true, autoReleaseNotes: true },
    deploy: {
      backupCode: true, autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [t],
  }
}

export function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDur(ms) {
  if (!ms) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 运行计时（发布进行中的秒级刷新）：mm:ss，超过 1 小时补 h:mm:ss */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const p = (n) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
