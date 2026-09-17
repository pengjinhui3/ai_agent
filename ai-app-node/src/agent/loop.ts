/**
 * 编排内核薄壳（07_2 序 0 拆分后）。
 *
 * chat() 只做编排：assembleContext（context.ts）→ streamText
 * → runStreamEvents（loop-control.ts）→ persistRound（persistence.ts）。
 * 各阶段实现见对应模块；SSE 事件协议与拆分前零变化（行为等价重构）。
 */
import { streamText } from 'ai'
import { getProvider } from '../llm/provider'
import { assembleContext, ContextError } from './context'
import { buildStopWhen, readMaxSteps, runStreamEvents, newRunState } from './loop-control'
import { persistRound, persistFailedRound } from './persistence'
import { evMessage, evDone, evError, type ChatEvent } from './events'

// ---------- SSE 流式对话入口 ----------

export interface ChatRequest {
  query: string
  conversationId?: string
  attachments?: { mime: string; name: string; data: string }[]
  /** 嵌出来源标记（16 方案）：embed 链路传入 app-key，会话创建时落 reserve2 做来源溯源与隔离 */
  embedKey?: string
  /** @ 触发标记（15 方案）：ai_at_command.trigger_code（mode=系统指令 / skill=应用绑定技能点名），缺省=普通对话 */
  trigger?: string
}

export async function* chat(appCode: string, request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const messageId = crypto.randomUUID()

  // ①-⑨ 上下文装配（应用/模型/厂商/会话/记忆/附件/技能/工具/思考档位/messages）
  let ctx
  try {
    ctx = await assembleContext(appCode, request, messageId)
  } catch (e) {
    yield evError(e instanceof ContextError ? e.message : `上下文装配失败：${e instanceof Error ? e.message : e}`)
    return
  }
  const convId = ctx.conv.conversationId

  // 首帧：messageId + conversationId
  yield evMessage('', messageId, convId)

  // ⑩-⑪ streamText 执行 + 事件流归一化（媒体劫持/ack 拦截/计时/聚合）
  const state = newRunState()
  try {
    const modelFactory = await getProvider(ctx.provider.providerCode)
    const languageModel = modelFactory(ctx.model.modelCode || '')
    console.log(`[编排] provider=${ctx.provider.providerCode} model=${ctx.model.modelCode} tools=${ctx.tools.length} → streamText 启动`)

    const maxSteps = await readMaxSteps()
    const result = streamText({
      model: languageModel,
      messages: ctx.messages,
      abortSignal: signal,
      system: ctx.systemPrompt,
      ...(ctx.tools.length > 0 && {
        tools: Object.fromEntries(
          ctx.tools.map((t: any) => [t.name, {
            description: t.description,
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              ...t.parameters,
            },
            execute: t.execute,
          }])
        ),
        stopWhen: buildStopWhen(ctx.ackEnabled, maxSteps),
      }),
      // TODO: thinking/budget 适配（GLM 网关 anthropic 端点返回空流，需进一步排查）
      // Anthropic 协议：默认 max_tokens（动态配置 anthropic_max_tokens，缺省回退 8192）
      ...(ctx.provider.protocol === 'anthropic' && {
        maxOutputTokens: await readAnthropicMaxTokens(),
      }),
    })

    yield* runStreamEvents(result.fullStream, {
      appCode, convPk: ctx.conv.id, messageId, tools: ctx.tools,
    }, state)

    yield evDone(messageId, convId)

    // 落库（content_blocks + media_json + ack 摘要覆盖）+ 异步摘要触发
    await persistRound({
      convPk: ctx.conv.id,
      messageId,
      request,
      state,
      attachmentsJson: ctx.attachmentsJson,
    })
  } catch (e: any) {
    // 用户中断（AbortError）：以已聚合的半截内容正常落库 + 标注中断（模型当步可能仍在服务商侧
    // 生成——本地工具循环已停止，后续步不再发起）
    if (e?.name === 'AbortError' || signal?.aborted) {
      console.log(`[编排] 用户中断 ${messageId}（半截落库）`)
      try {
        await persistRound({
          convPk: ctx.conv.id,
          messageId,
          request,
          state,
          attachmentsJson: ctx.attachmentsJson,
        })
      } catch (pe) {
        console.warn('[编排] 中断落库失败：', pe)
      }
      return
    }
    yield evError(e?.message || '流式调用失败')
    yield evDone(messageId, convId)
    // 半截落库（空 blocks）
    await persistFailedRound({
      convPk: ctx.conv.id,
      messageId,
      request,
      attachmentsJson: ctx.attachmentsJson,
      errorMessage: e?.message || '流式调用失败',
    })
  }
}

/** 读取 Anthropic 协议默认 max_tokens（AiSysConfig.anthropic_max_tokens；缺省/非法/DB 异常回退 8192） */
async function readAnthropicMaxTokens(): Promise<number> {
  try {
    const { prisma } = await import('../db/client')
    const row = await prisma.aiSysConfig.findFirst({ where: { configKey: 'anthropic_max_tokens', delFlag: '0' } })
    const n = Number(row?.configValue)
    return Number.isInteger(n) && n > 0 ? n : 8192
  } catch {
    return 8192
  }
}
