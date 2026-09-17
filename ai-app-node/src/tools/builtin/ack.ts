/**
 * ack_user 人机协同工具（07_1 方案阶段 B：Agent 循环的用户决策介入）。
 *
 * 机制：模型调用本工具 → loop 层建 task（waiting_ack）→ stopWhen:hasToolCall
 * 切断后续步 → 本轮流结束（answerPure 记 ack 摘要）→ 前端渲染 ack 卡片 →
 * 用户响应 POST /chat/:messageId/ack → task approve → 补录轨迹 → 续跑。
 *
 * execute 仅返回占位（SDK 循环在 tool-result 后被 stopWhen 停止，模型不会
 * 基于占位继续推理；真实用户响应由 ack 路由补录进 tool_calls_json）。
 */
import type { ToolCallback } from './index.js'

export const ACK_TOOL_NAME = 'ack_user'

export const ackUserTool: ToolCallback = {
  name: ACK_TOOL_NAME,
  displayName: '用户确认',
  description:
    '向用户请求决策确认（人机协同入口）。三类场景：' +
    'approval=敏感操作授权（如删数据/不可逆操作，必须先获用户放行才能执行）；' +
    'choice=多方案选择（列出选项与利弊让用户挑）；' +
    'clarify=信息澄清（关键信息不足时向用户提问）。' +
    '⚠️ 必须真实调用本工具来发起确认，严禁在正文中用文本模拟确认卡片（如手写"[等待用户确认]…"之类）——' +
    '正文文本不会渲染为可交互卡片，用户将无法响应；测试/演示场景同样必须真实调用。' +
    '⚠️ 调用时必须完整填写参数：type（三选一）、question（自包含的完整问题）、options（approval/choice 型必须提供含 id/label 的选项数组）；clarify 只需 type + question。' +
    '⚠️ clarify 多问题时的 question 格式规范：每个问题独占一行（"1. 问题一\\n2. 问题二\\n…"，行首数字编号，用换行符 \\n 分隔）——' +
    '严禁把多个问题挤在同一行文本里；已知的背景信息（日期/天气等）附在问题之后，同样逐行分隔。' +
    '⚠️ 选项必须放在 options 参数里（前端渲染为可点击的选项卡片）——不要把选项写在正文文本中，正文只做简要背景说明。' +
    'ℹ️ choice 卡片前端自动附带「✍️ 我的想法」入口：用户可能不选任何选项，而是输入自定义意见' +
    '（典型：认同某方案但要求局部调整，如"我觉得B方案不错，但这些地方需要调整"）——' +
    '此类响应以「用户回复：[我的想法] …」注入你的上下文，请按用户意见修正方案后继续。' +
    '⚠️ 多步骤任务（3 步以上）必须同时传 plan 参数（步骤数组）——计划与确认原子绑定，前端在同一张卡片展示步骤+确认按钮。' +
    '调用后本轮对话即挂起等待用户响应；用户响应后系统会以【用户已确认】消息注入你的上下文，届时继续执行。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['approval', 'choice', 'clarify'], description: '确认类型' },
      question: { type: 'string', description: '向用户展示的问题（完整、自包含，含必要背景）' },
      plan: {
        type: 'array',
        description: '执行计划步骤（多步骤任务必填；与确认原子绑定，前端同卡片渲染）',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '步骤序号（1 开始）' },
            desc: { type: 'string', description: '步骤描述' },
            tool: { type: 'string', description: '该步骤用的工具名（可空）' },
          },
          required: ['index', 'desc'],
        },
      },
      options: {
        type: 'array',
        description: '选项列表（clarify 型可为空，此时前端渲染自由输入框）',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '选项标识（如 a/b/c）' },
            label: { type: 'string', description: '选项名（简短）' },
            detail: { type: 'string', description: '选项说明/利弊（可空）' },
            recommended: { type: 'boolean', description: '是否为推荐项（前端高亮）' },
          },
          required: ['id', 'label'],
        },
      },
      default: { type: 'string', description: '无响应时的默认建议（选项 id；前端展示为「模型建议」，不自动执行）' },
      risk: { type: 'string', description: 'approval 型必填：风险说明（会做什么、是否可逆）' },
    },
    required: ['type', 'question'],
  },
  async execute(args) {
    // 载荷校验失败：返回错误文本驱动模型自纠（自定义 stopWhen 不会因非法调用停止）
    const invalid = validateAckArgs((typeof args === 'object' && args) || {})
    if (invalid) {
      return `错误：ack_user 参数不完整（${invalid}）。请重新调用并完整填写 type（approval/choice/clarify）、question（完整问题）与 options（approval/choice 型必填，含 id/label）。`
    }
    // 合法载荷：占位返回（自定义 stopWhen 在本步后停止循环，模型不会基于占位继续）
    return '（已向用户发起确认，本轮挂起等待响应）'
  },
}

/** ack 载荷校验：question 必填；options 至少含 id/label（前端渲染依赖） */
export function validateAckArgs(args: Record<string, unknown>): string | null {
  const type = String(args?.type || '')
  if (!['approval', 'choice', 'clarify'].includes(type)) return 'type 必须为 approval/choice/clarify'
  if (!String(args?.question || '').trim()) return 'question 必填'
  if (Array.isArray(args?.options)) {
    for (const o of args.options as any[]) {
      if (!o?.id || !o?.label) return 'options 每项必须含 id 与 label'
    }
  }
  return null
}

/** ack 摘要（answerPure / 历史可见性，07_1 §4.3）：[等待用户确认] 问题；选项：a·x、b·y */
export function ackSummary(args: Record<string, unknown>): string {
  const q = String(args?.question || '').trim()
  const opts = Array.isArray(args?.options)
    ? (args.options as any[]).map(o => `${o.id}·${o.label}`).join('、')
    : ''
  return `[等待用户确认] ${q}${opts ? `；选项：${opts}` : ''}`
}

/** 用户响应文本（tool_result 补录 + 续跑注入，07_1 §4.2/4.3） */
export function ackResultText(args: Record<string, unknown>, resp: { choice?: string; input?: string }): string {
  const opts = Array.isArray(args?.options) ? (args.options as any[]) : []
  const chosen = opts.find(o => o.id === resp.choice)
  if (chosen) {
    return `用户选择：${chosen.id} · ${chosen.label}${chosen.detail ? `（${chosen.detail}）` : ''}`
  }
  return `用户回复：${(resp.input || '').trim()}`
}
