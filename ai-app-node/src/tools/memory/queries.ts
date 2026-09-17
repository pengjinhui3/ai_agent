/**
 * 记忆回溯工具（02 方案增强：摘要轻量化 + 按需回查原始数据）。
 *
 * 设计：摘要只含 text 内容（保持压缩比）；涉及工具调用/富媒体的消息，
 * 摘要条目后标注出处消息 ID；模型追问细节时通过这四个工具回查原始数据：
 *   - query_conversation_scope：查会话摘要状态与消息 ID 范围（定位入口）
 *   - query_tool_calls：按消息 ID 查完整工具调用轨迹（含结果）
 *   - query_media：按消息 ID 查完整富媒体数据（图表 option 等）
 *   - query_recent_messages：按关键字模糊匹配（可空）查最近 N 条消息的完整内容（浏览入口）
 *
 * 工具协作：query_recent_messages 粗查（工具/媒体数据各截 2000 字防暴）→
 * 发现目标消息后用 query_tool_calls / query_media 按消息 ID 精查完整数据。
 *
 * 挂载条件：loop.ts 在会话存在历史消息时经 extraTools 条件挂载（非全局注册）。
 * 安全边界：execute 闭包绑定当前会话主键，校验目标消息属于本会话（防跨会话串数据）。
 */
import { prisma } from '../../db/client'
import type { ToolCallback } from '../builtin/index.js'

/**
 * 消息定位（主键 int / UUID 双兼容）：校验属于当前会话并返回记录。
 * 主键纯数字（如 191）走 id 查询，其余按 messageId（UUID）查询。
 */
async function findOwnedMessage(ref: string, conversationPk: number) {
  const isPk = /^\d+$/.test(ref.trim())
  const msg = await prisma.aiMessage.findFirst({
    where: isPk ? { id: Number(ref) } : { messageId: ref },
    select: { id: true, messageId: true, conversationId: true, toolCallsJson: true, mediaJson: true },
  })
  if (!msg) return { error: `消息 ${ref} 不存在` } as const
  if (msg.conversationId !== conversationPk) {
    return { error: `消息 ${ref} 不属于当前会话，无权查询` } as const
  }
  return { msg } as const
}

/**
 * 构建记忆回溯工具集（闭包绑定会话，仅当前会话可查）。
 * @param conversationPk 当前会话主键（安全边界）
 * @param conversationBusinessId 业务会话 UUID（query_conversation_scope 参数展示用）
 */
export function buildMemoryQueryTools(
  conversationPk: number,
  conversationBusinessId: string,
): ToolCallback[] {
  const scopeTool: ToolCallback = {
    name: 'query_conversation_scope',
    displayName: '查询会话记忆范围',
    description:
      '查询当前会话的记忆摘要状态：摘要内容、摘要覆盖到的消息水位线、以及水位线前后的消息 ID 范围。' +
      '当需要定位某段历史数据所在的消息时先调用本工具。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      const conv = await prisma.aiConversation.findFirst({
        where: { id: conversationPk, delFlag: '0' },
        select: { summary: true, summaryUptoId: true },
      })
      if (!conv) return '错误：会话不存在'
      const lastMsg = await prisma.aiMessage.findFirst({
        where: { conversationId: conversationPk },
        orderBy: { id: 'desc' },
        select: { id: true, messageId: true },
      })
      const firstBeyond = await prisma.aiMessage.findFirst({
        where: { conversationId: conversationPk, id: { gt: conv.summaryUptoId ?? 0 } },
        orderBy: { id: 'asc' },
        select: { id: true, messageId: true },
      })
      return JSON.stringify({
        会话ID: conversationBusinessId,
        摘要已覆盖到消息主键: conv.summaryUptoId ?? null,
        摘要内容: conv.summary ?? null,
        水位线之后的首条消息: firstBeyond ? { 主键: firstBeyond.id, 消息ID: firstBeyond.messageId } : null,
        最新消息: lastMsg ? { 主键: lastMsg.id, 消息ID: lastMsg.messageId } : null,
        提示: '水位线及之前的消息已被压缩进摘要；需要其中的工具调用明细或图表数据时，用消息ID调用 query_tool_calls / query_media 回查',
      })
    },
  }

  const toolCallsTool: ToolCallback = {
    name: 'query_tool_calls',
    displayName: '工具明细回放',
    description:
      '按消息 ID 查询该消息的完整工具调用轨迹（工具名、入参、返回结果、耗时）。' +
      '⚠️ 当用户追问工具查询的原始结果/具体数值时，数据不在对话上下文中——必须调用本工具获取真实数据后才能回答，禁止猜测或编造。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '消息 ID：主键数字（如 "191"，来自上下文 [#N] 前缀或摘要"（来源消息 #N）"标注）或 UUID 均可' },
      },
      required: ['messageId'],
    },
    async execute(args) {
      const mid = String(args.messageId || '').trim()
      if (!mid) return '错误：缺少参数 messageId'
      const r = await findOwnedMessage(mid, conversationPk)
      if ('error' in r) return r.error
      if (!r.msg.toolCallsJson) return `消息 ${mid} 没有工具调用记录`
      return r.msg.toolCallsJson
    },
  }

  const mediaTool: ToolCallback = {
    name: 'query_media',
    displayName: '数据回放',
    description:
      '按消息 ID 查询该消息的完整富媒体数据（图表 option，含全部数值系列）。' +
      '⚠️ 当用户追问图表中的具体数值时，数据不在对话上下文中——必须调用本工具获取真实数据后才能回答，禁止猜测或编造。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '消息 ID：主键数字（如 "191"，来自上下文 [#N] 前缀或摘要"（来源消息 #N）"标注）或 UUID 均可' },
      },
      required: ['messageId'],
    },
    async execute(args) {
      const mid = String(args.messageId || '').trim()
      if (!mid) return '错误：缺少参数 messageId'
      const r = await findOwnedMessage(mid, conversationPk)
      if ('error' in r) return r.error
      if (!r.msg.mediaJson) return `消息 ${mid} 没有富媒体数据`
      return r.msg.mediaJson
    },
  }

  /** 单段附加数据（toolCallsJson / mediaJson）截断：防多消息聚合爆上下文 */
  const TRUNCATE = 2000
  const truncate = (s: string | null, label: string): string | null => {
    if (!s) return null
    return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + `…（${label}已截断至 ${TRUNCATE} 字，需完整数据请按消息 ID 调 query_tool_calls / query_media）` : s
  }

  const recentTool: ToolCallback = {
    name: 'query_recent_messages',
    displayName: '消息回放',
    description:
      '按关键字模糊匹配（可空 = 不过滤）查询本会话最近 N 条消息的完整内容（ID、问题、回答纯文本、工具调用轨迹与图表数据摘要）。' +
      '⚠️ 匹配范围覆盖会话全历史（含已被摘要压缩的久远消息，其原始数据完整保留）——不确定数据在哪条消息时先用本工具定位，再按消息 ID 用 query_tool_calls / query_media 查完整数据。' +
      '关键字匹配范围：用户问题、助手回答、工具名。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近 N 条消息（默认 5，上限 10）' },
        keyWord: { type: 'string', description: '可选，模糊匹配关键字（匹配问题/回答/工具名，空则不过滤）' },
      },
      required: [],
    },
    async execute(args) {
      let n = Number(args.limit)
      if (!Number.isInteger(n) || n <= 0) n = 5
      if (n > 10) n = 10
      const kw = String(args.keyWord || '').trim().toLowerCase()

      // 拉本会话全部消息（含附加数据），内存过滤 + 取最近 N 条
      const rows = await prisma.aiMessage.findMany({
        where: { conversationId: conversationPk },
        orderBy: { id: 'desc' },
        select: { messageId: true, question: true, answerPure: true, toolCallsJson: true, mediaJson: true },
      })
      const matched = kw
        ? rows.filter(r => {
            const hay = [
              r.question || '',
              r.answerPure || '',
              ...(r.toolCallsJson ? safeToolNames(r.toolCallsJson) : []),
            ].join('\n').toLowerCase()
            return hay.includes(kw)
          })
        : rows
      const picked = matched.slice(0, n)
      if (picked.length === 0) {
        return kw ? `最近消息中没有匹配「${kw}」的内容` : '会话暂无消息'
      }
      const out = picked.map(m => ({
        messageId: m.messageId,
        问题: m.question || '',
        回答纯文本: m.answerPure || '',
        工具调用轨迹: truncate(m.toolCallsJson, '工具调用轨迹'),
        图表数据: truncate(m.mediaJson, '图表数据'),
      }))
      return JSON.stringify(out, null, 1)
    },
  }

  return [scopeTool, toolCallsTool, mediaTool, recentTool]
}

/** 从 tool_calls_json 提取工具名列表（keyWord 匹配用；解析失败返回空数组） */
function safeToolNames(toolCallsJson: string): string[] {
  try {
    const arr = JSON.parse(toolCallsJson)
    return Array.isArray(arr) ? arr.map((t: any) => String(t?.tool || '')).filter(Boolean) : []
  } catch { return [] }
}
