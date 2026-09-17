/**
 * ack 响应路由（07_1 阶段 B：用户决策响应 → 续跑）。
 *
 * POST /apps/:appCode/chat/:messageId/ack  body: { taskId, choice?, input? }
 *   → 校验 task（waiting_ack + 消息匹配）
 *   → approve：task → running；补录 tool_result 块 + tool_calls_json（观测轨迹）
 *     → 续跑：复用 chat()（注入【用户已确认】消息），SSE 透出；完成 → done
 *   → reject：task → cancelled；补录"用户拒绝"；不续跑
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { prisma } from '../db/client'
import { findTask, transitionTask, TASK_EVENT, TASK_STATUS, readResultMaxChars } from './tasks'
import { ACK_TOOL_NAME, ackResultText } from '../tools/builtin/ack'
import { chat, type ChatRequest } from './loop'

export const ackRoutes = new Hono()

ackRoutes.post('/apps/:appCode/chat/:messageId/ack', async (c) => {
  const appCode = c.req.param('appCode')
  const messageId = c.req.param('messageId')
  const b: any = await c.req.json().catch((): null => null)
  // taskId 可选：缺省按 messageId 定位唯一 waiting_ack 任务（前端免透传）
  let taskId = String(b?.taskId || '').trim()
  const hasChoice = b?.choice !== undefined && String(b.choice).trim() !== ''
  const hasInput = b?.input !== undefined && String(b.input).trim() !== ''
  if (!hasChoice && !hasInput && b?.reject !== true) return c.json({ error: 'choice 与 input 至少提供一个' }, 400)

  // ① 校验 task：waiting_ack + 属于该消息（taskId 缺省时按消息反查唯一挂起任务）
  let task = taskId ? await findTask(taskId) : null
  if (!task) {
    const waiting = await prisma.aiAgentTask.findFirst({
      where: { messageId, status: TASK_STATUS.WAITING_ACK, delFlag: '0' },
      orderBy: { id: 'desc' },
    })
    task = waiting
    taskId = waiting?.taskId || ''
  }
  if (!task) return c.json({ error: '该消息没有等待确认的任务' }, 404)
  if (task.status !== TASK_STATUS.WAITING_ACK) {
    return c.json({ error: `任务状态为 ${task.status}，仅 waiting_ack 可响应` }, 409)
  }
  if (task.messageId !== messageId) return c.json({ error: '任务与消息不匹配' }, 409)

  // ② 定位触发消息与 ack 载荷
  const msg = await prisma.aiMessage.findFirst({
    where: { messageId },
    select: { id: true, conversationId: true, contentBlocks: true, toolCallsJson: true },
  })
  if (!msg) return c.json({ error: `消息不存在：${messageId}` }, 404)
  let ackArgs: Record<string, unknown> = {}
  try { ackArgs = JSON.parse(task.ackPayload || '{}') } catch { /* 脏数据 */ }
  const resp = { choice: hasChoice ? String(b.choice).trim() : undefined, input: hasInput ? String(b.input).trim() : undefined }
  const resultText = ackResultText(ackArgs, resp)

  // ③ 补录观测轨迹（辉哥指示 4）：content_blocks 把 ack 的占位 tool_result 替换为真实用户选择；
  //    tool_calls_json 把最后一条 ack 记录的占位 result 覆盖为真实结果
  try {
    const blocks = JSON.parse(msg.contentBlocks || '[]') as any[]
    // 找最后一个 ack tool_result 块（SDK execute 的占位），替换为真实用户选择
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === 'tool_result') {
        // 确认它对应 ack（其前最近的 tool_use 是 ack_user）
        for (let j = i - 1; j >= 0; j--) {
          if (blocks[j]?.type === 'tool_use') {
            if (blocks[j]?.content?.name === ACK_TOOL_NAME) {
              blocks[i].content = resultText
              blocks[i].ackResolved = true
            }
            j = -1 // 只看最近一对
            break
          }
        }
        break // 只处理最后一个 tool_result
      }
    }
    // 兜底：若未找到可替换的占位块（结构异常），append 新块
    if (!blocks.some((b: any) => b?.ackResolved)) {
      blocks.push({ type: 'tool_result', content: resultText, index: blocks.length })
    }
    let tcJson = msg.toolCallsJson
    if (tcJson) {
      const tc = JSON.parse(tcJson) as any[]
      for (let i = tc.length - 1; i >= 0; i--) {
        if (tc[i]?.tool === ACK_TOOL_NAME) {
          tc[i].result = resultText
          tc[i].costMs = Math.max(0, Date.now() - new Date(task.createTime).getTime())
          break
        }
      }
      tcJson = JSON.stringify(tc)
    }
    await prisma.aiMessage.update({
      where: { id: msg.id },
      data: { contentBlocks: JSON.stringify(blocks), ...(tcJson && { toolCallsJson: tcJson }) },
    })
  } catch (e) {
    console.warn('[ack] 轨迹补录失败（不阻断续跑）：', e)
  }

  // ④ 拒绝：task → cancelled，返回结束（不续跑）
  const isReject = b?.reject === true
  if (isReject) {
    await transitionTask(taskId, TASK_EVENT.REJECT)
    return c.json({ ok: true, rejected: true })
  }

  // ⑤ 放行：task → running，复用 chat() 续跑（【用户已确认】注入），SSE 透出；完成 → done
  await transitionTask(taskId, TASK_EVENT.APPROVE)
  const conv = await prisma.aiConversation.findFirst({
    where: { id: msg.conversationId, delFlag: '0' },
    select: { conversationId: true },
  })
  // 强告知模板（07_2 序 0）：明确告知信息缺失而非礼貌建议——模型对"信息缺失"的响应比对"建议调用"更可靠
  // （实证依据：14 号三段式强措辞在 e2e 中生效，模型确实主动调了 query_media）
  const confirmQuery = `【用户已确认】${resultText}\n⚠️ 本轮此前工具调用的结果不在你的当前上下文中。如需引用，请调用 query_tool_calls 按消息 #N 回查。`
  const request: ChatRequest = { query: confirmQuery, conversationId: conv?.conversationId || null }

  return streamSSE(c, async (stream) => {
    try {
      for await (const ev of chat(appCode, request, c.req.raw.signal)) {
        await stream.writeSSE({ data: JSON.stringify(ev) })
      }
      // 续跑完成 → task done（result 取最终回答）
      const lastMsg = await prisma.aiMessage.findFirst({
        where: { conversationId: msg.conversationId },
        orderBy: { id: 'desc' },
        select: { answerPure: true },
      })
      await transitionTask(taskId, TASK_EVENT.SUCCEED, { result: (lastMsg?.answerPure || '').slice(0, await readResultMaxChars()) || '续跑完成' })
    } catch (e: any) {
      console.error('[ack] 续跑失败：', e)
      try { await transitionTask(taskId, TASK_EVENT.FAIL, { errorMessage: e?.message || '续跑失败' }) } catch { /* 状态可能已变 */ }
      await stream.writeSSE({ data: JSON.stringify({ type: 'ERROR', content: e?.message || '续跑失败' }) })
    }
  })
})
