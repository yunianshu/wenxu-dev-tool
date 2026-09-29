import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { toPlain } from '../utils/ipc'
import { saveUiPrefs } from '../utils/ui-prefs'

const currentProject = computed(() =>
  state.projects.items.find((project) => project.id === state.projects.currentId) || null
)

let loadingProjects = null
/** 上次选中的项目：首次需要恢复选中时读一次偏好，之后由 rememberProject 维护 */
let rememberedProjectId = null

async function loadRememberedProjectId() {
  if (rememberedProjectId !== null) return rememberedProjectId
  try {
    const saved = await window.gitReport.uiPrefsLoad?.()
    rememberedProjectId = typeof saved?.lastProjectId === 'string' ? saved.lastProjectId : ''
  } catch {
    rememberedProjectId = ''
  }
  // 偏好回包晚于用户选择时以用户为准，不能把刚选的项目倒回磁盘上的旧值
  if (!state.ui.lastProjectId) state.ui.lastProjectId = rememberedProjectId
  return rememberedProjectId
}

/** 选中项目写回偏好：仅在记忆变化时落盘，重复刷新项目列表不产生额外 IO */
function rememberProject(projectId) {
  const id = projectId || ''
  if (state.ui.lastProjectId === id) return
  state.ui.lastProjectId = id
  saveUiPrefs()?.catch((error) => console.error('项目选中偏好保存失败', error))
}

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
        // 没有可用选中时先回到上次选中的项目（部署页每次都从这里恢复），它已不在列表才取第一个
        const remembered = await loadRememberedProjectId()
        state.projects.currentId = state.projects.items.some((item) => item.id === remembered)
          ? remembered
          : state.projects.items[0]?.id || ''
      }
      rememberProject(state.projects.currentId)
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
  rememberProject(state.projects.currentId)
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
