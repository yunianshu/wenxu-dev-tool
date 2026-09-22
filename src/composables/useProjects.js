import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { toPlain } from '../utils/ipc'

const currentProject = computed(() =>
  state.projects.items.find((project) => project.id === state.projects.currentId) || null
)

let loadingProjects = null

function loadProjects({ preserveSelection = true } = {}) {
  if (loadingProjects) return loadingProjects
  state.projects.loading = true
  const requestedId = state.projects.currentId
  loadingProjects = Promise.resolve().then(async () => {
    try {
      const items = await window.gitReport.projectsList()
      state.projects.items = Array.isArray(items) ? items : []
      // 部署模块沿用同一份项目对象，避免两个项目列表产生偏差。
      state.deploy.projects = state.projects.items
      // 以响应时的选择为准：请求期间切换项目不能被旧 ID 覆盖。
      const keepCurrent = (preserveSelection || state.projects.currentId !== requestedId)
        && state.projects.items.some((item) => item.id === state.projects.currentId)
      if (!keepCurrent) {
        state.projects.currentId = state.projects.items[0]?.id || ''
      }
      state.deploy.currentProjectId = state.projects.currentId
      return state.projects.items
    } catch (error) {
      console.error('加载项目失败', error)
      ElMessage.error('加载项目失败')
      return []
    } finally {
      state.projects.loading = false
      loadingProjects = null
    }
  })
  return loadingProjects
}

function selectProject(projectId) {
  state.projects.currentId = projectId || ''
  state.deploy.currentProjectId = state.projects.currentId
}

async function saveProject(project) {
  const result = await window.gitReport.projectsSave(toPlain(project))
  if (!result?.ok) throw new Error(result?.error || '保存项目失败')
  state.projects.currentId = result.id
  await loadProjects()
  return currentProject.value
}

async function removeProject(projectId) {
  const result = await window.gitReport.projectsRemove(projectId)
  if (!result?.ok) throw new Error(result?.error || '删除项目失败')
  if (state.projects.currentId === projectId) state.projects.currentId = ''
  await loadProjects()
}

export function useProjects() {
  return { currentProject, loadProjects, selectProject, saveProject, removeProject }
}
