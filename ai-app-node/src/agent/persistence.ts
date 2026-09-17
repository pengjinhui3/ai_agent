/**
 * 落库与观测轨迹（07_2 序 0：从 loop.ts 拆出）。
 *
 * 职责：content_blocks / tool_calls_json / media_json / attachments 落库
 * + ack 轮 answerPure 摘要覆盖（07_1 §4.3）+ 半截落库 + 摘要任务触发（02 §6）。
 */
import { saveMessage } from '../memory/service'
import { maybeSummarize } from '../memory/summary'
import type { RunState } from './loop-control'
import { ackSummaryText } from './loop-control'
import type { ChatRequest } from './loop'

/** 正常落库（含 ack 摘要覆盖）+ 异步摘要触发 */
export async function persistRound(params: {
  convPk: number
  messageId: string
  request: ChatRequest
  state: RunState
  attachmentsJson: string
}): Promise<void> {
  const { convPk, messageId, request, state, attachmentsJson } = params
  const blocks = state.aggregator.finalize()
  const ackText = ackSummaryText(state)

  await saveMessage({
    conversationPk: convPk,
    messageId,
    question: request.query || '',
    contentBlocks: JSON.stringify(blocks),
    answerPure: ackText ?? state.aggregator.answerPure,
    toolCallsJson: state.toolCalls.length ? JSON.stringify(state.toolCalls) : null,
    mediaJson: state.mediaBlocks.length ? JSON.stringify(state.mediaBlocks) : null,
    attachments: attachmentsJson === '[]' ? null : attachmentsJson,
    success: !state.errorMessage,
    errorMessage: state.errorMessage,
  })

  // 落库后异步触发水位线检查 + 摘要任务（02 方案 §6：fire-and-forget，绝不阻塞回复流）
  maybeSummarize(convPk).catch(() => { /* 摘要内部已静默，双保险 */ })
}

/** 半截落库（流异常中断：空 blocks + 错误信息） */
export async function persistFailedRound(params: {
  convPk: number
  messageId: string
  request: ChatRequest
  attachmentsJson: string
  errorMessage: string
}): Promise<void> {
  await saveMessage({
    conversationPk: params.convPk,
    messageId: params.messageId,
    question: params.request.query || '',
    contentBlocks: '[]',
    answerPure: '',
    toolCallsJson: null,
    mediaJson: null,
    attachments: params.attachmentsJson === '[]' ? null : params.attachmentsJson,
    success: false,
    errorMessage: params.errorMessage,
  })
}
