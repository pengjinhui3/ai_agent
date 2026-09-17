import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { chatRoutes } from './agent/chat-route'
import { ackRoutes } from './agent/ack-route'
import { taskRoutes } from './agent/task-routes'
import { scanOrphansOnBoot } from './agent/task-runner'
import { llmRoutes } from './llm/routes'
import { serverRoutes } from './server/index'
import { embedRoutes } from './embed/routes'
import { kbRoutes } from './server/kbRoutes'

const app = new Hono()

// ---------- 健康检查 ----------
app.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }))

// ---------- API 路由（批次 1-4 全量挂载 + 07_1 ack + 07_2 任务化） ----------
app.route('/api/v1', llmRoutes)        // 批次 1：模型测试
app.route('/api/v1', serverRoutes)     // 批次 2：全量 CRUD
app.route('/api/v1', chatRoutes)       // 批次 4：SSE 对话
app.route('/api/v1', ackRoutes)        // 07_1 阶段 B：ack 响应（续跑 SSE）
app.route('/api/v1', taskRoutes)       // 07_2 序 2：任务化（异步执行/断点续跑/取消）
app.route('/api/v1/embed', embedRoutes) // 16 方案：应用嵌出（app-key 鉴权链路）
app.route('/api/v1', kbRoutes)         // 18 方案：知识库管理（上传/列表/删除）

// ---------- 附件静态资源（11 方案：/uploads/**） ----------
app.use('/uploads/*', serveStatic({ root: './' }))

const port = Number(process.env.PORT || 8081)
console.log(`[ai-app-node] listening on :${port}`)
serve({ fetch: app.fetch, port })

// 07_2 序 2：启动扫描——进程重启后 running 任务标 paused（覆盖 kill -9 场景，可 resume）
scanOrphansOnBoot()
