/**
 * 任务执行器（07_2 序 2：任务化收尾）。
 *
 * 设计：
 * - 有界并发（p-limit，IO 密集不引 worker_threads——三轮研判共识）
 * - 执行体复用 chat() 完整链路（task 专用会话，消息落库即观测——观测先行）；
 *   断点续跑 = 消息历史恢复（resume 时 goal 重发，会话上下文含此前轮次）
 * - 已知边界：task 执行轮中模型调 ack_user 会挂起对话（卡片在会话内可响应），
 *   外层 task 以当前回答收尾（done）——task 与对话内 ack 状态不联动，记 07_3 backlog
 */
import pLimit from 'p-limit'
import { prisma } from '../db/client'
import { findTask, transitionTask, TASK_EVENT, TASK_STATUS, readResultMaxChars } from './tasks'
import { chat, type ChatRequest } from './loop'

/** 有界并发（3 路——同 Java 版"有界线程池"的 Node 正确翻译） */
const limit = pLimit(3)

/** 提交异步执行（fire-and-forget；并发超限自动排队） */
export function submitTask(taskId: string, appCode: string, goal: string): void {
  limit(() => executeTask(taskId, appCode, goal)).catch(err => {
    console.error(`[task] 执行异常 ${taskId}：`, err)
  })
}

/**
 * 执行任务：goal 作为 query 走 chat() 全链路（首跑建专用会话，回写 conversationPk；
 * resume 重发 goal，会话历史已在上下文）。完成取最新 answerPure 作 result。
 */
async function executeTask(taskId: string, appCode: string, goal: string): Promise<void> {
  const task = await findTask(taskId)
  if (!task) return
  if (task.status === TASK_STATUS.CANCELLED) return // 已取消（排队期间）

  // 关联会话（首跑 null → chat 内新建；事件流首帧带 conversationId 回写）
  let convId: string | null = null
  if (task.conversationPk) {
    const conv = await prisma.aiConversation.findFirst({
      where: { id: task.conversationPk, delFlag: '0' },
      select: { conversationId: true },
    })
    convId = conv?.conversationId ?? null
  }

  try {
    let seenConvId: string | null = null
    const request: ChatRequest = { query: goal, conversationId: convId }
    for await (const ev of chat(appCode, request)) {
      if (ev.type === 'MESSAGE' && ev.conversationId && !seenConvId) seenConvId = ev.conversationId
    }
    // 首跑回写 conversationPk
    if (seenConvId && !task.conversationPk) {
      const conv = await prisma.aiConversation.findFirst({
        where: { conversationId: seenConvId, delFlag: '0' },
        select: { id: true },
      })
      if (conv) {
        await prisma.aiAgentTask.update({
          where: { id: task.id },
          data: { conversationPk: conv.id, updateTime: new Date() },
        })
      }
    }
    // 取最终回答作 result（取消竞态：cancelled 则不覆盖终态）
    const fresh = await findTask(taskId)
    if (fresh?.status === TASK_STATUS.CANCELLED) return
    let lastMsg: { answerPure: string | null } | null = null
    if (seenConvId) {
      const conv = await prisma.aiConversation.findFirst({
        where: { conversationId: seenConvId, delFlag: '0' },
        select: { id: true },
      })
      if (conv) {
        lastMsg = await prisma.aiMessage.findFirst({
          where: { conversationId: conv.id },
          orderBy: { id: 'desc' },
          select: { answerPure: true },
        })
      }
    }
    await transitionTask(taskId, TASK_EVENT.SUCCEED, { result: (lastMsg?.answerPure || '').slice(0, await readResultMaxChars()) || '任务完成（无文本输出）' })
    console.log(`[task] 完成 ${taskId}`)
  } catch (e: any) {
    const fresh = await findTask(taskId).catch((): null => null)
    if (fresh?.status !== TASK_STATUS.CANCELLED) {
      try { await transitionTask(taskId, TASK_EVENT.FAIL, { errorMessage: e?.message || '任务执行失败' }) } catch { /* 状态已变 */ }
      console.error(`[task] 失败 ${taskId}：`, e?.message)
    }
  }
}

/** 进程启动扫描（07_2 序 2：main.ts 钩子）——running→paused，覆盖 kill -9 后重启场景 */
export async function scanOrphansOnBoot(): Promise<void> {
  try {
    const r = await prisma.aiAgentTask.updateMany({
      where: { status: TASK_STATUS.RUNNING, delFlag: '0' },
      data: { status: TASK_STATUS.PAUSED, updateTime: new Date() },
    })
    if (r.count > 0) console.log(`[task] 启动扫描：${r.count} 个 running 任务已标 paused（可 resume）`)
  } catch (e) {
    console.warn('[task] 启动扫描失败（不影响启动）：', e)
  }
}
