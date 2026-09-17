import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// 入口：挂载根组件 + 路由（/ 对话页，/settings 设置页）+ Pinia（setting store）
createApp(App).use(createPinia()).use(router).mount('#app')
