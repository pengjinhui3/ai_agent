/**
 * SSE 对话路由：POST /api/v1/apps/:appCode/chat
 * 用 Hono 的 streamSSE 把 AsyncGenerator<ChatEvent> 逐帧透出。
 * 客户端断开（用户中断）→ req.raw.signal → chat() abortSignal → streamText 停止
 * 后续工具循环（当步服务商侧行为取决于其是否传播断开——本地止损确定生效）。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { chat, type ChatRequest } from '../agent/loop'

export const chatRoutes = new Hono()

chatRoutes.post('/apps/:appCode/chat', async (c) => {
  const appCode = c.req.param('appCode')
  const body: ChatRequest | null = await c.req.json<ChatRequest>().catch((): null => null)

  // 15 号：@ 触发轮允许空 query（如仅 @技能工坊 不带主题——剧本步骤 1 会 ack 询问主题）
  if (!body || ((!body.query?.trim() && !body.attachments?.length) && !body.trigger)) {
    return c.json({ error: 'query 与附件不能同时为空' }, 400)
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const evt of chat(appCode, body, c.req.raw.signal)) {
        await stream.writeSSE({ data: JSON.stringify(evt) })
      }
    } catch (e: any) {
      // 客户端断开导致的写入失败不回写（连接已不存在）；其余异常透出
      if (e?.name !== 'AbortError') {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ERROR', content: e?.message || '流式异常' }) }) } catch { /* 连接已断 */ }
      }
    }
  })
})
