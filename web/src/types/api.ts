/**
 * 前端 API 类型体系（19_0 序 3，源自 20 号 §3.4 研判共识）
 *
 * - SSE 事件对齐后端真源 `ai-app-node/src/agent/events.ts`（ChatEvent 全字段）
 * - 请求体对齐 ChatRequest / ack 路由
 * - 实体类型为后端返回的 DTO 概貌（高频消费场景）
 * - 约束：19_1 起新增前端代码必须 TS 并导入本文件类型
 */

// ========== SSE 事件协议（与后端 ChatEvent 一一对应） ==========

export type SseEventType =
  | 'MESSAGE'
  | 'THINKING'
  | 'TOOL_START'
  | 'TOOL_RESULT'
  | 'MEDIA_START'
  | 'MEDIA_END'
  | 'DONE'
  | 'ERROR'

export interface SseEvent {
  type: SseEventType
  /** MESSAGE/THINKING/ERROR：增量文本；MEDIA_END：媒体标题 */
  content?: string
  /** MESSAGE 首帧 / DONE */
  messageId?: string
  /** MESSAGE 首帧 / DONE */
  conversationId?: string
  /** TOOL_START/TOOL_RESULT：工具名（全名编码） */
  tool?: string
  /** TOOL_START：展示名 */
  displayName?: string
  /** TOOL_START：工具参数（对象或字符串化 JSON） */
  args?: Record<string, unknown> | string
  /** TOOL_RESULT：工具结果文本 */
  result?: string
  /** TOOL_RESULT：耗时 */
  costMs?: number
  /** MEDIA_START/MEDIA_END：媒体块序号 */
  mediaIndex?: number
  /** MEDIA_START/MEDIA_END：媒体类型（chart/mermaid/...） */
  mediaType?: string
  /** MEDIA_END：媒体块数据 */
  mediaData?: unknown
  /** TOOL_RESULT：失败时的错误信息 */
  toolError?: string
  /** THINKING：思考新段首帧标记 */
  thinkingRestart?: boolean
}

// ========== 请求体 ==========

export interface ChatRequestBody {
  query: string
  conversationId?: string
  /** 附件：{ mime, name, data(base64) } */
  attachments?: { mime: string; name: string; data: string }[]
  /** @ 触发：mode:{code} | skill:{code}（15 号方案） */
  trigger?: string
}

export interface AckRequestBody {
  taskId: string
  /** ack 选项的标识 */
  choice?: string
  /** 文本反馈 */
  feedback?: string
}

// ========== 实体类型（后端返回 DTO 概貌） ==========

export interface AppInfo {
  appCode: string
  name: string
  modelId: number
  systemPrompt?: string
  /** JSON 字符串（字符串化的数组） */
  mcpTools?: string
  /** JSON 字符串（技能绑定） */
  skills?: string
  enabled: boolean
}

export interface ConversationInfo {
  conversationId: string
  title: string
  appCode: string
  updateTime: string
}

/** @ 指令列表项（GET /at-commands，15 号方案） */
export interface AtCommandInfo {
  triggerCode: string
  label: string
  description?: string
  targetType: 'mode' | 'skill'
  targetCode?: string
  enabled: boolean
}

export interface SkillInfo {
  skillCode: string
  name: string
  description?: string
  content: string
  enabled: boolean
  skillType?: string
}

export interface McpServerInfo {
  serverCode: string
  name: string
  type: string
  url?: string
  command?: string
  argsJson?: string
  enabled: boolean
}

export interface KbDocInfo {
  id: number
  fileName: string
  status: string
  chunkCount?: number
  createTime: string
}
