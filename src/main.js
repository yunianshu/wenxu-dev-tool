import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import './styles.css'

const app = createApp(App)
const bridgeReady = window.__TAURI_INTERNALS__
  ? import('./tauri-bridge.generated.js')
  : Promise.resolve()

bridgeReady.then(() => {
  app.use(ElementPlus, { locale: zhCn })
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }
  app.mount('#app')
}).catch((error) => {
  console.error('桌面后台连接失败', error)
})
