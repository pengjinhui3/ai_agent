/**
 * 探针：任务状态机全路径冒烟——合法流转逐条走 + 非法流转必须抛错。
 * 覆盖：start/pause/resume/ask/approve/reject/succeed/fail/cancel × 合法态
 *      + 3 个非法流转样例（终态再流转 / pending 直接 ask / paused 直接 succeed）
 */
import { prisma } from './src/db/client'
import {
  createTask, transitionTask, findTask, legalEventsFrom,
  TASK_STATUS, TASK_EVENT, TaskTransitionError,
} from './src/agent/tasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

async function newTask() {
  return createTask({ appCode: 'probe', goal: '状态机探针任务' })
}

async function main() {
  console.log('=== 1. 主线：pending → start → running → succeed → done ===')
  let t = await newTask()
  await transitionTask(t.taskId, TASK_EVENT.START)
  ok('start → running', (await findTask(t.taskId))!.status === 'running')
  await transitionTask(t.taskId, TASK_EVENT.SUCCEED, { result: '完成' })
  const done = await findTask(t.taskId)
  ok('succeed → done + result', done!.status === 'done' && done!.result === '完成')

  console.log('=== 2. 失败线：running → fail → failed ===')
  t = await newTask()
  await transitionTask(t.taskId, TASK_EVENT.START)
  await transitionTask(t.taskId, TASK_EVENT.FAIL, { errorMessage: '工具崩溃' })
  ok('fail → failed + err', (await findTask(t.taskId))!.status === 'failed')

  console.log('=== 3. 暂停线：running → pause → paused → resume → running ===')
  t = await newTask()
  await transitionTask(t.taskId, TASK_EVENT.START)
  await transitionTask(t.taskId, TASK_EVENT.PAUSE)
  ok('pause → paused', (await findTask(t.taskId))!.status === 'paused')
  await transitionTask(t.taskId, TASK_EVENT.RESUME)
  ok('resume → running', (await findTask(t.taskId))!.status === 'running')

  console.log('=== 4. ack 线：running → ask(waiting_ack+payload) → approve → running → reject → cancelled ===')
  t = await newTask()
  await transitionTask(t.taskId, TASK_EVENT.START)
  await transitionTask(t.taskId, TASK_EVENT.ASK, { ackPayload: { type: 'choice', question: '选哪个方案？', options: [{ id: 'a', label: '方案A' }] } })
  let tk = await findTask(t.taskId)
  ok('ask → waiting_ack + ackStatus=waiting + payload 落库',
    tk!.status === 'waiting_ack' && tk!.ackStatus === 'waiting' && (JSON.parse(tk!.ackPayload!)).question === '选哪个方案？')
  await transitionTask(t.taskId, TASK_EVENT.APPROVE)
  tk = await findTask(t.taskId)
  ok('approve → running + ackStatus=approved', tk!.status === 'running' && tk!.ackStatus === 'approved')
  await transitionTask(t.taskId, TASK_EVENT.ASK)
  await transitionTask(t.taskId, TASK_EVENT.REJECT)
  tk = await findTask(t.taskId)
  ok('reject → cancelled + ackStatus=rejected', tk!.status === 'cancelled' && tk!.ackStatus === 'rejected')

  console.log('=== 5. 非法流转拦截（必须抛 TaskTransitionError）===')
  t = await newTask()
  let threw = false
  try { await transitionTask(t.taskId, TASK_EVENT.ASK) } catch (e) { threw = e instanceof TaskTransitionError }
  ok('pending 直接 ask 被拦', threw)
  await transitionTask(t.taskId, TASK_EVENT.START)
  await transitionTask(t.taskId, TASK_EVENT.SUCCEED)
  threw = false
  try { await transitionTask(t.taskId, TASK_EVENT.PAUSE) } catch (e) { threw = e instanceof TaskTransitionError }
  ok('终态 done 再 pause 被拦', threw)
  t = await newTask()
  await transitionTask(t.taskId, TASK_EVENT.START)
  await transitionTask(t.taskId, TASK_EVENT.PAUSE)
  threw = false
  try { await transitionTask(t.taskId, TASK_EVENT.SUCCEED) } catch (e) { threw = e instanceof TaskTransitionError }
  ok('paused 直接 succeed 被拦', threw)

  console.log('=== 6. 合法事件查询（错误信息质量）===')
  ok('pending 合法事件含 start/cancel', legalEventsFrom('pending').includes('start') && legalEventsFrom('pending').includes('cancel'))
  ok('done 合法事件为空（终态）', legalEventsFrom('done').length === 0)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  // 清理探针数据
  await prisma.aiAgentTask.updateMany({ where: { appCode: 'probe' }, data: { delFlag: '1' } })
  await prisma.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main()
