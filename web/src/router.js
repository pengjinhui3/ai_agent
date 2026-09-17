import { createRouter, createWebHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'
import SettingsView from './views/SettingsView.vue'
import EmbedChat from './views/EmbedChat.vue'

/** 路由：/ 对话页；/settings 设置页；/embed/page 应用嵌出对话页（16 方案，iframe 内运行） */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'chat', component: ChatView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/embed/page', name: 'embed', component: EmbedChat }
  ]
})

export default router
