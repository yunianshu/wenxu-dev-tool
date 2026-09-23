<template>
  <el-dialog :model-value="modelValue" title="服务器管理" width="760px" @update:model-value="$emit('update:modelValue', $event)">
    <p class="server-hint">服务器由所有项目共用。登录信息只需维护一次，安装目录与服务端口在各项目中独立配置。</p>
    <el-alert v-if="servers.some(s => s.secretNeedsReentry || s.passphraseNeedsReentry)" title="旧版服务器凭据无法由新版直接解密，请编辑对应服务器重新输入密码或私钥口令；项目与原密文仍保留。" type="warning" :closable="false" show-icon />
    <el-table :data="servers" empty-text="还没有服务器，添加后即可在项目中选择">
      <el-table-column prop="name" label="名称" width="150" />
      <el-table-column label="连接"><template #default="{ row }">{{ row.username }}@{{ row.host }}:{{ row.port }}</template></el-table-column>
      <el-table-column label="使用项目"><template #default="{ row }">{{ row.projects.map(p => p.name).join('、') || '未使用' }}</template></el-table-column>
      <el-table-column label="操作" width="125"><template #default="{ row }">
        <el-button link type="primary" :disabled="busy" @click="edit(row)">编辑</el-button>
        <el-button link type="danger" :disabled="busy || row.projects.length > 0" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <el-button class="add-server" :disabled="busy" @click="edit()">新增服务器</el-button>
    <el-form v-if="draft" label-width="100px" class="server-editor" @submit.prevent="save">
      <el-form-item label="服务器名称"><el-input v-model="draft.name" placeholder="例如：正式服务器" /></el-form-item>
      <el-form-item label="服务器地址"><el-input v-model="draft.host" placeholder="服务器 IP 或域名（SSH）" /></el-form-item>
      <el-form-item label="SSH 端口"><el-input-number v-model="draft.port" :min="1" :max="65535" /></el-form-item>
      <el-form-item label="登录账号"><el-input v-model="draft.username" placeholder="root" /></el-form-item>
      <el-form-item label="登录方式"><el-radio-group v-model="draft.authType"><el-radio value="password">密码</el-radio><el-radio value="key">私钥</el-radio></el-radio-group></el-form-item>
      <el-form-item v-if="draft.authType === 'password'" label="登录密码">
        <el-input v-model="draft.secret" type="password" show-password :placeholder="draft.secretNeedsReentry ? '旧版密码需重新输入' : draft.secretConfigured ? '已保存，留空保持' : '服务器登录密码'" />
        <el-checkbox v-if="draft.secretConfigured" v-model="draft.clearSecret">清除已保存密码</el-checkbox>
      </el-form-item>
      <template v-else>
        <el-form-item label="私钥路径"><el-input v-model="draft.keyPath" placeholder="本机 SSH 私钥文件" /></el-form-item>
        <el-form-item label="私钥口令"><el-input v-model="draft.passphrase" type="password" show-password :placeholder="draft.passphraseNeedsReentry ? '旧版口令需重新输入' : draft.passphraseConfigured ? '已保存，留空保持' : '如有，填写私钥口令'" /><el-checkbox v-if="draft.passphraseConfigured" v-model="draft.clearPassphrase">清除已保存口令</el-checkbox></el-form-item>
      </template>
      <p v-if="draft.projects?.length" class="server-hint">保存将更新 {{ draft.projects.map(p => p.name).join('、') }} 的服务器连接，项目目录保持不变。</p>
      <el-form-item><el-button @click="draft = null">取消编辑</el-button><el-button type="primary" :loading="saving" :disabled="busy || !draft.host.trim() || !draft.username.trim()" @click="save">保存服务器</el-button></el-form-item>
    </el-form>
    <p class="server-hint">首次自动安装环境支持 Ubuntu/Debian，账号需 root 或免密 sudo。删除仅移除未被项目引用的本地服务器配置。</p>
    <template #footer><el-button @click="$emit('update:modelValue', false)">完成</el-button></template>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
const props = defineProps({ modelValue: Boolean, servers: { type: Array, default: () => [] }, busy: Boolean })
const emit = defineEmits(['update:modelValue', 'changed'])
const draft = ref(null), saving = ref(false)
watch(() => props.modelValue, open => { draft.value = null; if (open && !props.servers.length) edit() })
function edit(server) {
  draft.value = { name: '', host: '', port: 22, username: 'root', authType: 'password', keyPath: '', ...JSON.parse(JSON.stringify(server || {})), secret: '', passphrase: '', clearSecret: false, clearPassphrase: false }
}
async function save() {
  saving.value = true
  try {
    const result = await window.gitReport.deployServersSave(JSON.parse(JSON.stringify(draft.value)))
    if (!result?.ok) return ElMessage.error(result?.error || '保存失败')
    draft.value = null; emit('changed'); ElMessage.success('服务器已保存，所有引用项目共用此连接')
  } catch (e) { ElMessage.error(e.message) } finally { saving.value = false }
}
async function remove(server) {
  try { await ElMessageBox.confirm(`删除服务器「${server.name}」的本地配置？不会操作远端文件。`, '删除服务器', { type: 'warning' }) } catch { return }
  try {
    const result = await window.gitReport.deployServersRemove(server.id)
    if (!result?.ok) return ElMessage.error(result?.error || '删除失败')
    draft.value = null; emit('changed'); ElMessage.success('服务器已删除')
  } catch (e) { ElMessage.error(e.message) }
}
</script>

<style scoped>
.server-hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.add-server { margin: 14px 0; }
.server-editor { border-top: 1px solid var(--el-border-color-lighter); padding-top: 20px; }
</style>
