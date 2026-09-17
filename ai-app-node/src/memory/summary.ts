/**
 * 会话记忆滚动摘要（02 方案 Node 版实施）。
 *
 * 触发：每轮回复落库后异步调用 maybeSummarize(conversationPk)——
 *   水位线（summary_upto_id）后未摘要内容总字符 > memory_summary_trigger_chars 时触发。
 * 摘要范围：水位线后全部消息（无旧摘要→直接总结；有旧摘要→增量合并）。
 *   历史兼容：待摘要总量 > 触发线 × 2 的超长会话只摘要最近部分，更早的放弃（水位线跳过）。
 * 模型：系统基础模型（base_model_id）；未配置/停用 → 降级跳过（不影响对话主流程）。
 * 并发安全：CAS（updateMany where summaryUptoId = 旧值），失败即放弃下轮重试。
 * 失败策略：全程 try-catch 静默。
 */
import { generateText } from 'ai'
import { prisma } from '../db/client'
import { getProvider } from '../llm/provider'

/** 摘要触发线（AiSysConfig.memory_summary_trigger_chars；缺省/非法/DB 异常回退 8000） */
async function readTriggerChars(): Promise<number> {
  try {
    const row = await prisma.aiSysConfig.findFirst({ where: { configKey: 'memory_summary_trigger_chars', delFlag: '0' } })
    const n = Number(row?.configValue)
    return Number.isInteger(n) && n > 0 ? n : 8000
  } catch {
    return 8000
  }
}

/** 摘要提示词（压缩规则见 02 方案 §6 + 辉哥补充 7：过滤无用信息、大幅缩减、不漏重点；
 *  数据策略（辉哥 2026-09-11 决策）：摘要不搬运数据本身，只做数据位置标记——
 *  完整数据靠 query_conversation_scope / query_tool_calls / query_media / query_recent_messages 四工具回查） */
function buildSummaryPrompt(oldSummary: string | null, content: string): string {
  return [
    '你是对话记忆压缩器，将多轮对话压缩为结构化记忆摘要。',
    '',
    '压缩规则：',
    '1. 过滤无用信息：寒暄、重复确认、纯客套、无实质内容的往返一律丢弃',
    '2. 大幅压缩：输出目标为原文的 10%~20%，宁少勿多',
    '3. 重点保留（不得遗漏）：用户身份/偏好/约束、已达成的结论与决定、进行中任务的目标与状态、重要数据的位置索引、未解决的待办',
    '4. 条目式输出，每条一个事实点，不添加原文没有的推断',
    '5. 数据位置标记（核心规则）：凡涉及"工具取回了重要数据"或"数据被加工成图表"的条目，必须标注数据位置到消息+工具粒度，格式：（数据见 #消息ID 的 工具名 结果）或（#消息ID 已将数据渲染为 图表类型）。后续对话可通过 query_conversation_scope / query_tool_calls / query_media / query_recent_messages 四个回查工具按位置索引取回完整原始数据——因此摘要只记位置，禁止把数据明细搬进摘要。普通事实类条目不需要标注来源',
    '6. 异常与教训记录：工具调用失败、流式输出中断、输出格式错误（如图表画错类型）等使用过程中出现的问题，必须记录为独立条目并附位置标记，供后续对话避免重复踩坑',
    '7. 只记录确定的事实，不得含有推测出的数值',
    '',
    oldSummary
      ? `[已有摘要]（将其中仍然有效的信息合并进新摘要，已过时的可丢弃）：\n${oldSummary}`
      : '[已有摘要]：（无，首次生成）',
    '',
    '[待压缩对话]（每条消息首行的 [#N｜含：…] 标注了消息主键与信息构成——含工具调用、工具失败、图表与消息异常——供数据位置标记用）：',
    content,
    '',
    '输出新摘要（纯文本，条目式）：',
  ].join('\n')
}

/** 消息信息构成简述：[#191｜含：工具调用×2（dbx_execute_query）、工具失败×1、图表×1、消息异常] */
function describeMessage(m: { id: number; contentBlocks: string | null; errorMessage: string | null }): string {
  let blocks: any[] = []
  try { blocks = JSON.parse(m.contentBlocks || '[]') } catch { /* 脏数据忽略 */ }
  const toolUses = blocks.filter(b => b?.type === 'tool_use')
  const tools = toolUses.map(b => b.content?.name).filter(Boolean)
  const failed = toolUses.filter(b => b.content?.status === 'error').length
  const media = blocks.filter(b => b?.type === 'media').length
  const parts: string[] = [`#${m.id}`]
  const carries: string[] = []
  if (tools.length) carries.push(`工具调用×${tools.length}（${tools.join('、')}）`)
  if (failed) carries.push(`工具失败×${failed}`)
  if (media) carries.push(`图表×${media}`)
  if (m.errorMessage) carries.push('消息异常')
  if (carries.length) parts.push(`含：${carries.join('、')}`)
  return parts.join('｜')
}

/**
 * 水位线检查 + 摘要生成 + CAS 落库。
 * 每轮回复落库后异步调用；任何失败静默吞掉（记忆摘要绝不影响主流程）。
 */
export async function maybeSummarize(conversationPk: number): Promise<void> {
  try {
    const trigger = await readTriggerChars()
    const conv = await prisma.aiConversation.findFirst({
      where: { id: conversationPk, delFlag: '0' },
      select: { id: true, summary: true, summaryUptoId: true },
    })
    if (!conv) return

    // 水位线后全部消息（含主键与 blocks：生成信息简述头 + 摘要出处标注用；errorMessage 供异常教训记录）
    const msgs = await prisma.aiMessage.findMany({
      where: { conversationId: conv.id, id: { gt: conv.summaryUptoId ?? 0 } },
      orderBy: { id: 'asc' },
      select: { id: true, question: true, answerPure: true, contentBlocks: true, errorMessage: true },
    })
    if (msgs.length === 0) return

    const charLen = (m: { question: string | null; answerPure: string | null }) =>
      (m.question?.length ?? 0) + (m.answerPure?.length ?? 0)
    const totalChars = msgs.reduce((s, m) => s + charLen(m), 0)
    if (totalChars <= trigger) return // 未达水位线，不触发

    // 历史兼容：超长会话只摘要最近 trigger×2 字符内的部分，更早的放弃（水位线跳过）
    let toSummarize = msgs
    let skippedOld = 0
    if (totalChars > trigger * 2) {
      let acc = 0
      let cut = msgs.length
      for (let i = msgs.length - 1; i >= 0; i--) {
        acc += charLen(msgs[i])
        if (acc > trigger * 2) { cut = i + 1; break }
      }
      skippedOld = cut
      toSummarize = msgs.slice(cut)
    }
    if (toSummarize.length === 0) return

    // 摘要模型：系统基础模型；未配置/不可用 → 降级跳过
    const baseCfg = await prisma.aiSysConfig.findFirst({ where: { configKey: 'base_model_id', delFlag: '0' } })
    const baseModelId = Number(baseCfg?.configValue)
    if (!Number.isInteger(baseModelId) || baseModelId <= 0) {
      console.log('[记忆摘要] 未配置基础模型（base_model_id），降级跳过')
      return
    }
    const baseModel = await prisma.aiModel.findFirst({
      where: { id: baseModelId, delFlag: '0', enabled: true },
      select: { modelCode: true, providerCode: true },
    })
    if (!baseModel) {
      console.log('[记忆摘要] 基础模型不存在或已停用，降级跳过')
      return
    }

    // 拼接待摘要文本（每条消息带信息构成简述头：[#N｜含：工具调用×2（xxx）、工具失败×1、图表×1、消息异常]）
    const content = toSummarize
      .map(m => [
        `[${describeMessage(m)}]`,
        m.question?.trim() ? `用户：${m.question.trim()}` : '',
        m.answerPure?.trim() ? `助手：${m.answerPure.trim()}` : '',
        // 消息级异常（流中断等）：附在助手行后，供"异常与教训"规则记录
        m.errorMessage?.trim() ? `【消息异常】${m.errorMessage.trim().slice(0, 200)}` : '',
      ].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n')

    // 非流式摘要生成（120s 超时防卡死：本地 Ollama 慢推理/挂起时不占资源）
    const factory = await getProvider(baseModel.providerCode)
    const result = await generateText({
      model: factory(baseModel.modelCode),
      prompt: buildSummaryPrompt(conv.summary, content),
      abortSignal: AbortSignal.timeout(120_000),
    })
    // 剥离思考型模型（qwen3 等）混入正文的思考原文：
    // ① 完整 <think>...</think> 块；② 无开标记但有闭标记（...\n正文）；
    // ③ 只有开标记无闭（截断半截思考，剥后为空则跳过落库）
    const newSummary = (result.text || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim()
    if (!newSummary) {
      console.warn('[记忆摘要] 摘要生成结果为空（或被思考内容吞没），跳过落库')
      return
    }

    // CAS 更新：并发冲突（count=0）即放弃，下轮重试天然幂等
    const newUptoId = toSummarize[toSummarize.length - 1].id
    const upd = await prisma.aiConversation.updateMany({
      where: { id: conv.id, summaryUptoId: conv.summaryUptoId ?? null },
      data: { summary: newSummary, summaryUptoId: newUptoId, updateTime: new Date() },
    })
    if (upd.count === 0) {
      console.log('[记忆摘要] CAS 并发冲突，放弃本轮（下轮重试）')
      return
    }
    console.log(`[记忆摘要] 会话 ${conv.id} 摘要完成：原文 ${content.length} 字 → 摘要 ${newSummary.length} 字，水位线 → ${newUptoId}${skippedOld > 0 ? `（跳过 ${skippedOld} 条更早历史）` : ''}`)
  } catch (err) {
    console.warn('[记忆摘要] 失败（静默，不影响主流程）：', err instanceof Error ? err.message : err)
  }
}
