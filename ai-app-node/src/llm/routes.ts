/**
 * 模块职责：LLM 模块 HTTP 路由（Hono 子应用）。
 *
 * 挂载方式（main.ts）：app.route('/api/v1', llmRoutes)
 * - POST /api/v1/models/:id/test → 测试模型连通性，通过自动启用
 *   成功返回 {"tested": true, "enabled": true, "reply": "..."}
 *   失败返回 {"tested": false, "enabled": false, "error": "原因"}（消息透传前端展示）
 */
import { Hono } from 'hono'
import { testModel } from './test'

export const llmRoutes = new Hono()

llmRoutes.post('/models/:id/test', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ tested: false, enabled: false, error: '非法的模型 id' }, 400)
  }

  try {
    const { reply } = await testModel(id)
    return c.json({ tested: true, enabled: true, reply })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ tested: false, enabled: false, error: message }, 500)
  }
})

export default llmRoutes
