/**
 * 任务 API（07_2 序 2：任务化收尾）。
 *
 * POST /apps/:appCode/tasks      创建（异步执行，立即返回 taskId）
 * GET  /tasks/:taskId            状态+进度查询
 * POST /tasks/:taskId/resume      断点续跑（paused/failed → running，goal 重发，会话历史恢复上下文）
 * POST /tasks/:taskId/cancel      取消（执行竞态：完成后不覆盖终态）
 */
import { Hono } from 'hono'
import { prisma } from '../db/client'
import { createTask, findTask, transitionTask, TASK_EVENT, TASK_STATUS } from './tasks'
import { submitTask } from './task-runner'

export const taskRoutes = new Hono()

/** 创建任务：pending → 立即 START → 异步执行（fire-and-forget） */
taskRoutes.post('/apps/:appCode/tasks', async (c) => {
  const appCode = c.req.param('appCode')
  const b: any = await c.req.json().catch((): null => null)
  const goal = String(b?.goal || '').trim()
  if (!goal) return c.json({ error: 'goal 必填（任务目标）' }, 400)

  const app = await prisma.aiApp.findFirst({ where: { appCode, delFlag: '0', enabled: true } })
  if (!app) return c.json({ error: `未配置或已停用的应用 [${appCode}]` }, 404)

  const task = await createTask({ appCode, goal })
  await transitionTask(task.taskId, TASK_EVENT.START)
  submitTask(task.taskId, appCode, goal)
  return c.json({ taskId: task.taskId, status: 'running' })
})

/** 状态查询（含关联会话业务 ID，前端可跳会话查看消息流） */
taskRoutes.get('/tasks/:taskId', async (c) => {
  const task = await findTask(c.req.param('taskId'))
  if (!task) return c.json({ error: '任务不存在' }, 404)
  let conversationId: string | null = null
  if (task.conversationPk) {
    const conv = await prisma.aiConversation.findFirst({
      where: { id: task.conversationPk, delFlag: '0' },
      select: { conversationId: true },
    })
    conversationId = conv?.conversationId ?? null
  }
  return c.json({
    taskId: task.taskId, appCode: task.appCode, goal: task.goal,
    status: task.status, result: task.result, errorMessage: task.errorMessage,
    conversationId, ackStatus: task.ackStatus,
    createTime: task.createTime, updateTime: task.updateTime,
  })
})

/** 断点续跑：paused/failed → running（goal 重发，会话历史已在上下文） */
taskRoutes.post('/tasks/:taskId/resume', async (c) => {
  const task = await findTask(c.req.param('taskId'))
  if (!task) return c.json({ error: '任务不存在' }, 404)
  try {
    await transitionTask(task.taskId, task.status === TASK_STATUS.FAILED ? TASK_EVENT.START : TASK_EVENT.RESUME)
  } catch (e: any) {
    return c.json({ error: e?.message || '状态流转失败' }, 409)
  }
  submitTask(task.taskId, task.appCode, task.goal)
  return c.json({ taskId: task.taskId, status: 'running' })
})

/** 取消（终态保护：已 done/failed/cancelled 拒绝） */
taskRoutes.post('/tasks/:taskId/cancel', async (c) => {
  const task = await findTask(c.req.param('taskId'))
  if (!task) return c.json({ error: '任务不存在' }, 404)
  try {
    await transitionTask(task.taskId, TASK_EVENT.CANCEL)
  } catch (e: any) {
    return c.json({ error: e?.message || '状态流转失败' }, 409)
  }
  return c.json({ taskId: task.taskId, status: 'cancelled' })
})
