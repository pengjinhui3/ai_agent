import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite 配置：
// - Vue3 单文件组件插件
// - dev server 代理到后端：环境变量 API_PORT 切换目标后端
//   默认（不传）→ Node :8081（Node 版为活跃开发线，Java 版已冻结）
//   如需代理 Java 版：API_PORT=8080 npm run dev
const API_PORT = process.env.API_PORT || '8081'
// 显式 IPv4：Node 22 的 localhost 解析会只绑 ::1（IPv6 loopback），
// 浏览器解析 localhost → 127.0.0.1 时连接被拒（ERR_CONNECTION_REFUSED）——两处都写死 IPv4
const API_TARGET = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true
      },
      // 11 方案：附件静态资源（历史回放图片）同源代理到后端
      '/uploads': {
        target: API_TARGET,
        changeOrigin: true
      }
    }
  }
})
