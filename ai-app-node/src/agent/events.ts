/**
 * 基座 SSE 事件模型（12 方案：与前端 ChatView 消费的事件格式一一对应）。
 *
 * 事件（type 字段值）：
 * - MESSAGE     文本增量（首帧附 messageId/conversationId）
 * - THINKING    思考增量（thinkingRestart = 新段首帧）
 * - TOOL_START  工具调用开始
 * - TOOL_RESULT 工具调用结果（失败时 toolError 携带错误信息）
 * - MEDIA_START 富媒体块开始（mediaIndex 占位）
 * - MEDIA_END   富媒体块完成（mediaData 携带块数据）
 * - DONE        流结束
 * - ERROR       错误信息
 */
export type ChatEventType =
  | 'MESSAGE'
  | 'THINKING'
  | 'TOOL_START'
  | 'TOOL_RESULT'
  | 'MEDIA_START'
  | 'MEDIA_END'
  | 'DONE'
  | 'ERROR'

export interface ChatEvent {
  type: ChatEventType
  content?: string
  messageId?: string
  conversationId?: string
  tool?: string
  displayName?: string
  args?: Record<string, unknown> | string
  result?: string
  costMs?: number
  mediaIndex?: number
  mediaType?: string
  mediaData?: unknown
  toolError?: string
  thinkingRestart?: boolean
}

// ---------- 工厂函数 ----------

export const evMessage = (content: string, messageId?: string, conversationId?: string): ChatEvent => ({
  type: 'MESSAGE', content, ...(messageId && { messageId }), ...(conversationId && { conversationId }),
})

export const evThinking = (content: string, restart?: boolean): ChatEvent => ({
  type: 'THINKING', content, ...(restart && { thinkingRestart: true }),
})

export const evToolStart = (tool: string, args: Record<string, unknown> | string, displayName?: string): ChatEvent => ({
  type: 'TOOL_START', tool, args, ...(displayName && { displayName }),
})

export const evToolResult = (tool: string, result: string | null, costMs: number, toolError?: string): ChatEvent => ({
  type: 'TOOL_RESULT', tool, ...(result !== null && { result }), costMs, ...(toolError && { toolError }),
})

export const evMediaStart = (index: number, mediaType: string): ChatEvent => ({
  type: 'MEDIA_START', mediaIndex: index, mediaType,
})

export const evMediaEnd = (index: number, mediaType: string, title: string | null, data: unknown): ChatEvent => ({
  type: 'MEDIA_END', mediaIndex: index, mediaType, ...(title && { content: title }), ...(data != null && { mediaData: data }),
})

export const evDone = (messageId: string, conversationId: string): ChatEvent => ({
  type: 'DONE', messageId, conversationId,
})

export const evError = (content: string): ChatEvent => ({
  type: 'ERROR', content,
})
