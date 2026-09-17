/**
 * 上下文装配（07_2 序 0：从 loop.ts 拆出）。
 *
 * 职责：应用定位 → 模型/厂商解析 → 会话定位 → 记忆拼装 → 附件预处理
 * → Skill 装配 → 记忆回溯工具 → systemPrompt 组装 → 工具装配 → 思考档位
 * → ModelMessage[] 构建。纯装配无执行（streamText 在 loop-control）。
 */
import { prisma } from '../db/client'
import type { ModelMessage } from 'ai'
import { defaultEffort, effortBudget } from '../llm/thinking'
import { locateOrCreate } from '../memory/service'
import { store, type DecodedAttachment } from '../memory/attachment'
import { ACK_TOOL_NAME } from '../tools/builtin/ack'
import type { ChatRequest } from './loop'

/** 装配失败（应用/模型/厂商不存在等）——loop.ts 捕获转 evError */
export class ContextError extends Error {}

/** 装配完成的单轮上下文 */
export interface ChatContext {
  app: { appCode: string; mcpTools: string | null }
  model: { modelCode: string; thinkingEffort: string | null }
  provider: { providerCode: string; protocol: string }
  conv: { id: number; conversationId: string; summary: string | null; summaryUptoId: number | null }
  systemPrompt: string | undefined
  tools: any[]
  ackEnabled: boolean
  messages: ModelMessage[]
  queryText: string
  attachmentsJson: string
}

/**
 * 记忆拼装（02+14 方案）：水位线（summary_upto_id）后的全部消息进上下文；
 * 每条消息带 [#主键ID] 前缀（供模型直接调 query_tool_calls / query_media 精查）；
 * 水位线前的历史已压缩进 conv.summary（由 systemPrompt 注入）。
 */
async function assembleHistory(
  conversationPk: number,
  summaryUptoId: number | null,
): Promise<ModelMessage[]> {
  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: conversationPk, id: { gt: summaryUptoId ?? 0 } },
    orderBy: { id: 'asc' },
  }).catch((): never[] => [])
  const result: ModelMessage[] = []
  for (const m of messages) {
    if (m.question?.trim()) result.push({ role: 'user', content: `[#${m.id}] ${m.question.trim()}` })
    if (m.answerPure?.trim()) result.push({ role: 'assistant', content: m.answerPure.trim() })
  }
  console.log(`[记忆] 会话 pk=${conversationPk} 水位线=${summaryUptoId ?? '无'} 未摘要消息 ${messages.length} 条，拼装 ${result.length} 条`)
  return result
}

/**
 * 单轮上下文装配总入口。任何定位失败抛 ContextError（含用户可读消息）。
 */
export async function assembleContext(appCode: string, request: ChatRequest, messageId: string): Promise<ChatContext> {
  // ① 应用定位
  const app = await prisma.aiApp.findFirst({ where: { appCode, delFlag: '0', enabled: true } })
  if (!app) throw new ContextError(`未配置或已停用的应用 [${appCode}]`)

  // ② 模型 → 厂商解析
  const model = await prisma.aiModel.findFirst({ where: { id: app.modelId, delFlag: '0' } })
  if (!model) throw new ContextError(`应用 [${appCode}] 绑定的模型不存在 model-id=${app.modelId}`)
  const provider = await prisma.aiProvider.findFirst({ where: { providerCode: model.providerCode, delFlag: '0' } })
  if (!provider) throw new ContextError(`模型 [${model.modelCode}] 的厂商不存在：${model.providerCode}`)

  // ③ 会话定位/创建（embedKey：嵌出链路传入 → 新会话落 reserve2 做来源标记与隔离）
  const titleSource = request.query?.trim() || request.attachments?.[0]?.name || null
  const conv = await locateOrCreate(appCode, titleSource, request.conversationId || null, request.embedKey)

  // ④ 记忆拼装（02 方案：水位线后全量 + 摘要进 system）
  const history = await assembleHistory(conv.id, conv.summaryUptoId)

  // ⑤ 附件预处理（图片走 image part；文本注入 queryText，8000 字上限）
  const decoded: DecodedAttachment[] = []
  let attachmentsJson = '[]'
  let imageParts: { type: 'image'; image: Buffer; mimeType: string }[] = []
  let queryText = request.query || ''

  if (request.attachments?.length) {
    for (const a of request.attachments) {
      const bytes = Buffer.from(a.data.replace(/\s/g, ''), 'base64')
      const mime = (a.mime || '').toLowerCase().trim()
      if (mime.startsWith('image/')) {
        imageParts.push({ type: 'image', image: bytes, mimeType: mime })
      } else {
        const content = bytes.toString('utf-8').substring(0, 8000)
        queryText += `\n\n[附件 ${a.name}]\n${content}`
      }
      decoded.push({ mime, name: a.name, bytes })
    }
    try {
      const stored = store(conv.conversationId, messageId, decoded)
      if (stored.length) attachmentsJson = JSON.stringify(stored)
    } catch (e) {
      console.warn('[附件] 落盘失败（降级：不影响本轮对话）', e)
    }
  }

  // ⑥a @ 触发处理（15 号：@ 系统指令 / @ 应用绑定技能）
  // trigger 格式："mode:skill-craft"（系统指令）或 "skill:chart-generation"（技能点名）；
  // 系统指令型查 ai_at_command 入口 + MODE_REGISTRY 配方；技能型不预注册（应用绑定关系即真源）。
  let modePrompt = ''
  let isMode = false
  let modeCode: string | null = null
  const triggeredEntryLabel = request.trigger
    ? `（@ ${request.trigger.split(':')[1]}）` : ''
  try {
    if (request.trigger) {
      const [kind, code] = request.trigger.split(':')
      if (kind === 'mode') {
        // ---------- @ 系统指令：入口校验（决策 #16 前置体检，防无效调用） ----------
        const entry = await prisma.aiAtCommand.findFirst({ where: { triggerCode: code, enabled: true, delFlag: '0' } })
        if (!entry) throw new ContextError(`未知或未启用的系统指令 [${code}]`)
        const { checkModeDeps, setConversationMode } = await import('./modes')
        const check = await checkModeDeps(entry.targetCode || code)
        if (!check.ok) throw new ContextError(check.error!)
        // 注入：剧本 + 附属技能全文（inlineSkills 代码常量，决策 #15：仅系统内置资产）
        modePrompt = [check.recipe!.script, ...check.recipe!.inlineSkills].join('\n\n---\n\n')
        isMode = true
        modeCode = entry.targetCode || code
        await setConversationMode(conv.id, modeCode)
        console.log(`[编排] @ 系统指令进入：${modeCode}（剧本+附属技能已注入）`)
      } else if (kind === 'skill') {
        // ---------- @ 技能：应用绑定范围内点名（授权=绑定即可见；本轮强制注入全文） ----------
        const skill = await prisma.aiSkill.findFirst({ where: { skillCode: code, delFlag: '0' } })
        if (!skill) throw new ContextError(`技能 [${code}] 不存在`)
        if (!skill.enabled) throw new ContextError(`技能 [${code}] 已停用`)
        let binds: Array<{ code?: string }> = []
        try { binds = app.skills ? JSON.parse(app.skills) : [] } catch { binds = [] }
        if (!Array.isArray(binds) || !binds.some(b => b?.code === code)) {
          throw new ContextError(`技能 [${code}] 未绑定到当前应用 [${appCode}]，不可 @ 点名`)
        }
        modePrompt = skill.content
        console.log(`[编排] @ 技能点名注入：${code}（${skill.content.length} 字）`)
      }
    } else if (conv.mode) {
      // ---------- 续跑轮（ack 挂起后回来 / 普通续聊）：mode 标记保持注入 ----------
      const { checkModeDeps, clearConversationMode } = await import('./modes')
      const check = await checkModeDeps(conv.mode)
      if (check.ok) {
        modePrompt = [check.recipe!.script, ...check.recipe!.inlineSkills].join('\n\n---\n\n')
        isMode = true
        modeCode = conv.mode
        console.log(`[编排] 续跑轮保持系统指令：${modeCode}`)
      } else {
        // 依赖中途失效（决策 #16 ③）：清 mode 降级普通对话，明确告知（不静默不崩对话）
        await clearConversationMode(conv.id)
        modePrompt = `（系统提示：此前进入的 [${conv.mode}] 流程因系统依赖变更已中止，请按普通对话继续，并在回复开头向用户说明这一点。）`
        console.warn(`[编排] 续跑轮依赖失效，剧本降级：${conv.mode} — ${check.error}`)
      }
    }
  } catch (e) {
    if (e instanceof ContextError) throw e
    console.warn('[编排] @ 触发处理异常（降级为普通对话）：', e)
  }
  // @ 触发轮 query 为空时补占位（空 messages 会被模型 API 拒绝）
  if (request.trigger && !queryText.trim()) queryText = `(用户通过 @ 进入${triggeredEntryLabel}，未附加主题输入)`

  // ⑥ Skill 装配（注入式全文 + 目录式目录进 system prompt；目录式生成 load_skill 工具）
  // 决策 #15：mode 期间停用——只注入剧本附属技能（⑥a 已注入），app 用户技能与 load_skill 通道不挂
  let skillPrompt = ''
  let extraTools: any[] = []
  if (!isMode) {
    try {
      const { assembleSkills } = await import('../tools/skill/loader')
      const skillResult = await assembleSkills(app)
      skillPrompt = skillResult.prompt
      if (skillResult.tool) extraTools.push(skillResult.tool)
    } catch (e) {
      console.warn('[编排] Skill 装配失败（降级为无技能）：', e)
    }
  }

  // ⑥" 记忆回溯工具（14 号方案）：会话有历史消息时挂载——历史轮的工具/图表数据从来就不进上下文
  let hasHistory = false
  try {
    const historyCount = await prisma.aiMessage.count({ where: { conversationId: conv.id } })
    hasHistory = historyCount > 0
    if (hasHistory) {
      const { buildMemoryQueryTools } = await import('../tools/memory/queries')
      extraTools.push(...buildMemoryQueryTools(conv.id, conv.conversationId))
    }
  } catch (e) {
    console.warn('[编排] 记忆回溯工具装配失败（降级）：', e)
  }

  // ⑥a" 指令附属 sink 工具（15 号：闭包注入会话上下文——模型在剧本流程内调用）
  if (isMode && modeCode === 'skill-craft') {
    const { buildCreateSkillTool } = await import('../tools/builtin/createSkill')
    extraTools.push(buildCreateSkillTool({ conversationPk: conv.id, appCode: app.appCode }))
  }
  if (isMode && modeCode === 'session-summary') {
    const { buildExportFileTool } = await import('../tools/builtin/exportFile')
    extraTools.push(buildExportFileTool({ conversationPk: conv.id }))
  }

  // ⑥' System Prompt = 应用提示词 + 技能注入文本 + 会话记忆摘要（02：水位线前历史压缩进摘要）+ 回查告知（14：强措辞防编造）
  const memorySummaryBlock = conv.summary
    ? `以下是本会话较早对话的摘要（用户目标、关键结论与约束）：\n${conv.summary}`
    : ''
  const memoryQueryHint = hasHistory
    ? [
        '⚠️ 数据边界提示：本会话历史消息中的工具调用明细与图表数据不进入对话上下文（上下文仅有文本）。',
        '当用户追问图表具体数值、工具查询的原始结果等细节时，你极大概率不知道（数据不在上下文中）——',
        '必须调用 query_tool_calls / query_media 获取原始数据后才能回答，禁止根据正文猜测或编造数值。',
        '消息 ID 获取途径：上下文中 [#N] 前缀、摘要条目"（来源消息 #N）"标注；不知道 ID 时先用 query_recent_messages 按关键字定位。',
      ].join('\n')
    : ''

  // ⑦ 工具装配（内置 + MCP 白名单过滤 + load_skill + ack_user 人机协同（07_1：平台能力无条件挂载））
  // 决策 #15：mode 期间 MCP 一律不挂（用户级外部服务不稳定，不进剧本依赖面）——白名单清空即可
  let mcpTools: string[] = []
  if (!isMode) {
    try { mcpTools = app.mcpTools ? JSON.parse(app.mcpTools) : [] } catch { /* 脏数据忽略 */ }
  }
  let tools: any[] = []
  let ackEnabled = false
  try {
    const { getTools } = await import('../tools/registry')
    const { ackUserTool } = await import('../tools/builtin/ack')
    tools = await getTools(mcpTools, [...extraTools, ackUserTool])
    ackEnabled = tools.some(t => t.name === ACK_TOOL_NAME)
  } catch (e) {
    console.warn('[编排] 工具装配失败（降级为无工具）：', e)
  }

  // plan-ack 原子协议（07_2 修正：计划与确认同一次调用，原子绑定——模型要确认就必须带计划数据，
  // 消除"跳过计划"的结构性可能；取代原 ```plan 代码块 + ack 两步协议）
  const planAckHint = ackEnabled
    ? [
        '📋 决策协议：复杂任务（3 步以上或多工具编排）执行前，调用 ack_user 一次性携带计划与确认：',
        'type=approval + plan 参数（步骤数组）+ question（一句话）+ risk（风险）。前端在同一张卡片展示步骤+确认按钮。',
        '',
        '严格模仿以下调用格式（示例中的工具名仅为占位——实际用当前应用可用的工具）：',
        'ack_user(type=approval, question="是否按以下计划执行？", risk="只读查询，无风险", plan=[',
        '  {"index":1,"desc":"查询数据源表结构","tool":"查询类工具全名"},',
        '  {"index":2,"desc":"统计各状态订单数","tool":"查询/统计类工具全名"},',
        '  {"index":3,"desc":"生成对比图表"}',
        '])',
        '',
        '⚠️ 计划步骤只放在 ack_user 的 plan 参数里（不要输出 ```plan 代码块，不要写在正文）；正文只需一句引导语。',
        '简单任务（1-2 步）无需计划直接执行；用户确认后严格按计划执行。',
      ].join('\n')
    : ''
  // ⑥'' System Prompt = 应用提示词 + 系统指令剧本（15 号：mode 时优先注入）+ 技能 + 记忆摘要 + 回查告知 + 计划协议
  const systemPrompt = [app.systemPrompt, modePrompt, skillPrompt, memorySummaryBlock, memoryQueryHint, planAckHint]
    .filter(Boolean).join('\n\n') || undefined

  // ⑧ 思考档位（读档拼日志；执行参数在 loop.ts streamText 处组装）
  const effort = model.thinkingEffort?.trim() || (await defaultEffort().catch((): null => null))
  const budget = effort ? await effortBudget(effort).catch((): null => null) : null
  console.log(`[编排] app=${appCode} tools=${tools.length} mcpWhitelist=${mcpTools.length} effort=${effort} budget=${budget}`)

  // ⑨ 构建 ModelMessage[]（v7：system 不进 messages，走 streamText 的 system 参数）
  const messages: ModelMessage[] = []
  messages.push(...history)
  if (imageParts.length) {
    messages.push({
      role: 'user',
      content: [
        ...imageParts,
        { type: 'text', text: queryText || '请分析图片' },
      ],
    })
  } else if (queryText.trim()) {
    messages.push({ role: 'user', content: queryText })
  }

  return {
    app: { appCode: app.appCode, mcpTools: app.mcpTools },
    model: { modelCode: model.modelCode, thinkingEffort: model.thinkingEffort },
    provider: { providerCode: provider.providerCode, protocol: provider.protocol },
    conv: { id: conv.id, conversationId: conv.conversationId, summary: conv.summary, summaryUptoId: conv.summaryUptoId },
    systemPrompt,
    tools,
    ackEnabled,
    messages,
    queryText,
    attachmentsJson,
  }
}
