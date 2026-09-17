/**
 * 流式对话（POST + SSE）。
 *
 * 注意：此接口必须用 fetch 而非 axios——POST 场景不能用 EventSource（仅支持 GET），
 * 且 axios 浏览器端不支持 ReadableStream 增量读取；fetch + getReader 按块读、
 * TextDecoder 增量解码、按行切分缓冲，"data: {...}" 行 JSON.parse 后按事件类型回调。
 *
 * SSE 事件协议（design.md §6）：MESSAGE / THINKING / TOOL_START / TOOL_RESULT / DONE / ERROR
 */
export const chatApi = {
  /**
   * @ 可唤起对象（15 号：@ 弹层数据源——系统指令组 + 当前应用绑定的技能组）
   * @param {string} appCode 当前应用编码（技能组按绑定关系动态计算）
   * @returns {Promise<{commands: Array<{triggerCode: string, label: string, description: string}>, skills: Array<{code: string, name: string}>}>}
   */
  atCommands: async (appCode) => {
    const res = await fetch(`/api/v1/at-commands?appCode=${encodeURIComponent(appCode)}`)
    if (!res.ok) throw new Error(`at-commands HTTP ${res.status}`)
    return res.json()
  },

  /**
   * 发起一轮流式对话。
   * @param {string} appCode 应用编码
   * @param {{query: string, conversationId?: string, trigger?: string}} body trigger=@ 触发标记（mode:xxx / skill:xxx，15 号）
   * @param {(evt: object) => void} onEvent SSE 事件回调（已 JSON.parse）
   * @param {AbortSignal} [signal] 用户中断信号（停止按钮触发）
   * @returns {Promise<void>} 流结束（含 DONE）后 resolve；网络/HTTP 错误 reject；中断 reject AbortError
   */
  stream: async (appCode, body, onEvent, signal) => {
    const res = await fetch(`/api/v1/apps/${encodeURIComponent(appCode)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal
    })
    return consumeSse(res, onEvent)
  },

  /**
   * ack 用户响应（07_1）：驱动续跑，返回续跑轮的 SSE 流。
   * @param {string} appCode 应用编码
   * @param {string} messageId ack 触发消息 ID
   * @param {{choice?: string, input?: string, reject?: boolean}} body
   * @param {(evt: object) => void} onEvent 续跑轮 SSE 事件回调
   * @param {AbortSignal} [signal] 用户中断信号
   */
  ackRespond: async (appCode, messageId, body, onEvent, signal) => {
    const res = await fetch(`/api/v1/apps/${encodeURIComponent(appCode)}/chat/${encodeURIComponent(messageId)}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal
    })
    return consumeSse(res, onEvent)
  },
}

/** 消费 SSE 响应流（stream / ackRespond / embed 共用）：按行切分缓冲，data: 载荷解析分发 */
export async function consumeSse(res, onEvent) {
  if (!res.ok || !res.body) {
    let msg = 'HTTP ' + res.status
    try {
      const data = await res.json()
      msg = data.error || msg
    } catch { /* 非 JSON 错误体 */ }
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 按行切分；最后一段可能是半行，留在 buffer 等下一块拼齐
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      dispatchSseLine(line, onEvent)
    }
  }
  // 冲刷解码器与残余缓冲
  buffer += decoder.decode()
  if (buffer) dispatchSseLine(buffer, onEvent)
}

/** 处理一行 SSE 文本：提取 data: 载荷并 JSON 解析分发 */
function dispatchSseLine(line, onEvent) {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return // 忽略空行/注释行/其他字段行
  const payload = trimmed.slice(5).trim()               // 兼容 "data:" 与 "data: " 两种前缀
  if (!payload || payload === '[DONE]') return
  let evt
  try {
    evt = JSON.parse(payload)
  } catch {
    console.warn('SSE 载荷不是合法 JSON，已跳过：', payload)
    return
  }
  onEvent(evt)
}
