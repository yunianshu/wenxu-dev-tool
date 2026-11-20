/** 与主进程 deploy-service.STAGES 保持一致。 */
const STAGE_LIST = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
  { id: 'openclaw', label: 'OpenClaw 同步' },
  { id: 'datasync', label: '数据同步' },
]

export function deployProgress(run, deployMode) {
  const stages = deployMode === 'script'
    ? STAGE_LIST.map((stage) => stage.id === 'build' ? { ...stage, label: '项目脚本' } : stage)
    : STAGE_LIST
  const counts = { success: 0, skipped: 0, failed: 0, rollback: 0 }
  for (const { id } of stages) {
    const status = run.stages[id]?.status
    if (Object.hasOwn(counts, status)) counts[status] += 1
  }
  const doneCount = counts.success + counts.skipped + counts.failed + counts.rollback
  const stageTotal = stages.length
  const activeStage = stages.find(({ id }) => run.stages[id]?.status === 'running')
  let detail = ''
  if (activeStage?.id === 'package' && run.packageCount) detail = `已处理 ${run.packageCount} 个文件`
  if (activeStage?.id === 'upload' && run.uploadPercent) detail = `已上传 ${run.uploadPercent}%`
  if (activeStage?.id === 'datasync' && run.datasyncPercent) detail = `已同步 ${run.datasyncPercent}%`
  return { stages, counts, doneCount, stageTotal, percent: Math.round(doneCount / stageTotal * 100), activeStage, detail }
}
