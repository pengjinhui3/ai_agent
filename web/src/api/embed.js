import { consumeSse } from './chat'

/**
 * 应用嵌出 API（16 方案）：嵌入页专用（app-key 鉴权链路）。
 * - config：widget init / 嵌入页启动校验（返回 appCode/appName/modelLabel）
 * - stream：对话 SSE（POST /api/v1/embed/chat，body 带 appKey）
 * - conversations / messages：嵌入会话（reserve2=appKey 隔离）
 * - ack 续跑复用原端点（/apps/:appCode/chat/:messageId/ack，appCode 从 config 拿；
 *   taskId+messageId 匹配保护足够，见 16 方案 §5.3）
 */

/** app-key（嵌入页 URL ?app_key= 参数） */
export function embedAppKey() {
  return new URLSearchParams(window.location.search).get('app_key') || ''
}

export const embedApi = {
  /** key 校验 + 应用信息（legal=false 时 reason: invalid/domain/quota/app） */
  config: async (appKey) => {
    const res = await fetch(`/api/v1/embed/config?key=${encodeURIComponent(appKey)}`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  },

  /** 对话 SSE（与 chatApi.stream 同协议；body 带 appKey） */
  stream: async (appKey, body, onEvent, signal) => {
    const res = await fetch('/api/v1/embed/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, appKey }),
      signal
    })
    return consumeSse(res, onEvent)
  },

  /** ack 续跑（复用原端点：appCode 显式传入，taskId 保护） */
  ackRespond: async (appCode, messageId, body, onEvent, signal) => {
    const res = await fetch(`/api/v1/apps/${encodeURIComponent(appCode)}/chat/${encodeURIComponent(messageId)}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal
    })
    return consumeSse(res, onEvent)
  },

  /** 嵌入会话列表（reserve2=appKey 隔离，最近在前） */
  conversations: async (appKey) => {
    const res = await fetch(`/api/v1/embed/conversations?key=${encodeURIComponent(appKey)}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
    return data.conversations || []
  },

  /** 会话消息回放 */
  messages: async (appKey, conversationId) => {
    const res = await fetch(`/api/v1/embed/conversations/${encodeURIComponent(conversationId)}/messages?key=${encodeURIComponent(appKey)}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
    return data.messages || []
  },
}
