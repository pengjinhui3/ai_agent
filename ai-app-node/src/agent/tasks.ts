/**
 * Agent 任务服务（07_1 阶段 A：状态机基础，ack 后置接线）。
 *
 * 设计：表 + 状态常量 + 合法流转表 + transition 强校验（非法流转抛错——
 * 状态机是强约束不是注释装饰）。本阶段无运行时消费方（ack_user 工具与
 * loop 拦截在阶段 B 接入，见 docs/07_1_Ack人机协同方案）。
 */
import { prisma } from '../db/client'

// ---------- 状态与事件常量 ----------

/** 任务主状态（7 个；终态：done / failed / cancelled） */
export const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_ACK: 'waiting_ack',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const
export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS]

/** ack 子状态（waiting_ack 主状态下并行维护） */
export const ACK_STATUS = {
  WAITING: 'waiting',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  TIMEOUT: 'timeout',
} as const

/** 状态机事件（边——不是状态） */
export const TASK_EVENT = {
  START: 'start',           // pending → running
  PAUSE: 'pause',           // running → paused
  RESUME: 'resume',         // paused → running
  ASK: 'ask',               // running → waiting_ack（发起用户确认）
  APPROVE: 'approve',       // waiting_ack → running（用户放行）
  REJECT: 'reject',         // waiting_ack → cancelled（用户否决）
  SUCCEED: 'succeed',       // running → done
  FAIL: 'fail',             // running → failed
  CANCEL: 'cancel',         // pending/running/paused/waiting_ack → cancelled
} as const
export type TaskEvent = typeof TASK_EVENT[keyof typeof TASK_EVENT]

/** 读取任务结果截断长度（AiSysConfig.task_result_max_chars；缺省/非法/DB 异常回退 4000）。
 *  ack 续跑与异步任务统一使用——result 是 task 表的摘要字段，完整内容始终在消息表。 */
export async function readResultMaxChars(): Promise<number> {
  try {
    const row = await prisma.aiSysConfig.findFirst({ where: { configKey: 'task_result_max_chars', delFlag: '0' } })
    const n = Number(row?.configValue)
    return Number.isInteger(n) && n > 0 ? n : 4000
  } catch {
    return 4000
  }
}

/** 合法流转表：事件 → { from → to }（强约束核心；非法流转抛错） */
const TRANSITIONS: Record<TaskEvent, Partial<Record<TaskStatus, TaskStatus>>> = {
  [TASK_EVENT.START]:   { [TASK_STATUS.PENDING]: TASK_STATUS.RUNNING },
  [TASK_EVENT.PAUSE]:   { [TASK_STATUS.RUNNING]: TASK_STATUS.PAUSED },
  [TASK_EVENT.RESUME]:  { [TASK_STATUS.PAUSED]: TASK_STATUS.RUNNING },
  [TASK_EVENT.ASK]:     { [TASK_STATUS.RUNNING]: TASK_STATUS.WAITING_ACK },
  [TASK_EVENT.APPROVE]: { [TASK_STATUS.WAITING_ACK]: TASK_STATUS.RUNNING },
  [TASK_EVENT.REJECT]:  { [TASK_STATUS.WAITING_ACK]: TASK_STATUS.CANCELLED },
  [TASK_EVENT.SUCCEED]: { [TASK_STATUS.RUNNING]: TASK_STATUS.DONE },
  [TASK_EVENT.FAIL]:    { [TASK_STATUS.RUNNING]: TASK_STATUS.FAILED },
  [TASK_EVENT.CANCEL]:  {
    [TASK_STATUS.PENDING]: TASK_STATUS.CANCELLED,
    [TASK_STATUS.RUNNING]: TASK_STATUS.CANCELLED,
    [TASK_STATUS.PAUSED]: TASK_STATUS.CANCELLED,
    [TASK_STATUS.WAITING_ACK]: TASK_STATUS.CANCELLED,
  },
}

// ---------- 错误 ----------

export class TaskTransitionError extends Error {
  constructor(taskId: string, event: TaskEvent, from: TaskStatus) {
    super(`任务 ${taskId} 状态 ${from} 不允许事件 ${event}（合法事件：${legalEventsFrom(from).join('/') || '无（终态）'}）`)
  }
}

/** 查某状态下的全部合法事件（错误提示 + 测试用） */
export function legalEventsFrom(from: TaskStatus): TaskEvent[] {
  return (Object.keys(TRANSITIONS) as TaskEvent[]).filter(ev => TRANSITIONS[ev][from] !== undefined)
}

// ---------- 服务 ----------

/** 创建任务（初始 pending；goal 为目标摘要） */
export async function createTask(params: {
  appCode: string
  goal: string
  conversationPk?: number | null
  messageId?: string | null
}): Promise<{ id: number; taskId: string }> {
  const taskId = crypto.randomUUID()
  const row = await prisma.aiAgentTask.create({
    data: {
      taskId,
      appCode: params.appCode,
      conversationPk: params.conversationPk ?? null,
      messageId: params.messageId ?? null,
      goal: params.goal,
      status: TASK_STATUS.PENDING,
      createTime: new Date(),
      updateTime: new Date(),
    },
    select: { id: true, taskId: true },
  })
  return row
}

/**
 * 状态流转（强校验）：非法流转抛 TaskTransitionError，不落库。
 * ack 相关事件（ask/approve/reject）同步维护 ackStatus；其余事件按需带 patch（result/error 等）。
 */
export async function transitionTask(
  taskId: string,
  event: TaskEvent,
  patch: { ackPayload?: unknown; result?: string; errorMessage?: string; stepCursor?: number } = {},
): Promise<void> {
  const task = await prisma.aiAgentTask.findFirst({ where: { taskId, delFlag: '0' } })
  if (!task) throw new Error(`任务不存在：${taskId}`)
  const from = task.status as TaskStatus
  const to = TRANSITIONS[event][from]
  if (!to) throw new TaskTransitionError(taskId, event, from)

  // ack 子状态联动
  let ackStatus: string | null = task.ackStatus
  if (event === TASK_EVENT.ASK) ackStatus = ACK_STATUS.WAITING
  else if (event === TASK_EVENT.APPROVE) ackStatus = ACK_STATUS.APPROVED
  else if (event === TASK_EVENT.REJECT) ackStatus = ACK_STATUS.REJECTED

  await prisma.aiAgentTask.update({
    where: { id: task.id },
    data: {
      status: to,
      ...(ackStatus !== task.ackStatus && { ackStatus }),
      ...(patch.ackPayload !== undefined && {
        ackPayload: typeof patch.ackPayload === 'string' ? patch.ackPayload : JSON.stringify(patch.ackPayload),
      }),
      ...(patch.result !== undefined && { result: patch.result }),
      ...(patch.errorMessage !== undefined && { errorMessage: patch.errorMessage }),
      ...(patch.stepCursor !== undefined && { stepCursor: patch.stepCursor }),
      updateTime: new Date(),
    },
  })
}

/** 按业务 ID 查任务 */
export async function findTask(taskId: string) {
  return prisma.aiAgentTask.findFirst({ where: { taskId, delFlag: '0' } })
}
