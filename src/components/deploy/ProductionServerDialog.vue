<template>
  <el-dialog :model-value="modelValue" title="正式服务器" width="520px" @update:model-value="$emit('update:modelValue', $event)">
    <p class="server-hint">保存一次，之后点击发布即可自动准备环境、构建和上线。</p>
    <el-form label-width="100px" @submit.prevent="save">
      <el-form-item label="服务器地址"><el-input v-model="draft.server.host" placeholder="服务器 IP 或域名（SSH）" /></el-form-item>
      <el-form-item label="登录账号"><el-input v-model="draft.server.username" placeholder="root" /></el-form-item>
      <el-form-item label="登录方式"><el-radio-group v-model="draft.server.authType"><el-radio value="password">密码</el-radio><el-radio value="key">私钥</el-radio></el-radio-group></el-form-item>
      <el-form-item v-if="draft.server.authType === 'password'" label="登录密码"><el-input v-model="draft.server.secret" type="password" show-password :placeholder="draft.server.secretConfigured ? '已保存，留空保持' : '服务器登录密码'" /></el-form-item>
      <template v-else>
        <el-form-item label="私钥路径"><el-input v-model="draft.server.keyPath" placeholder="本机 SSH 私钥文件" /></el-form-item>
        <el-form-item label="私钥口令"><el-input v-model="draft.server.passphrase" type="password" show-password placeholder="如有，填写私钥口令" /></el-form-item>
      </template>
      <el-collapse><el-collapse-item title="更多设置" name="advanced">
        <el-form-item label="SSH 端口"><el-input-number v-model="draft.server.port" :min="1" :max="65535" /></el-form-item>
        <el-form-item label="服务端口"><el-input-number v-model="port" :min="0" :max="65535" /><span class="server-hint">0 为自动分配</span></el-form-item>
      </el-collapse-item></el-collapse>
    </el-form>
    <p class="server-hint">正式服务器需可通过 SSH 登录。首次发布会自动安装缺少的 Docker 等环境，账号需具备 root 或免密 sudo 权限；已有环境会直接复用。</p>
    <template #footer><el-button @click="$emit('update:modelValue', false)">取消</el-button><el-button type="primary" :disabled="!draft.server.host.trim() || !draft.server.username.trim()" @click="save">保存正式服务器</el-button></template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { emptyTarget } from './deploy-form'
const props = defineProps({ modelValue: Boolean, target: Object, servicePort: Number })
const emit = defineEmits(['update:modelValue', 'save'])
const draft = reactive(emptyTarget())
const port = ref(0)
watch(() => props.modelValue, (open) => {
  if (!open) return
  const t = props.target ? JSON.parse(JSON.stringify(props.target)) : emptyTarget()
  Object.assign(draft, t, { server: { ...emptyTarget().server, ...t.server, secret: '', passphrase: '' } })
  port.value = props.servicePort || 0
})
function save() { emit('save', { target: JSON.parse(JSON.stringify(draft)), port: port.value }); emit('update:modelValue', false) }
</script>

<style scoped>
.server-hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
</style>
