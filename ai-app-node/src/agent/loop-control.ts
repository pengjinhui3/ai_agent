/**
 * 循环执行控制（07_2 序 0：从 loop.ts 拆出）。
 *
 * 职责：stopWhen 组合构造 + streamText 事件流归一化（媒体劫持状态机 / ack 拦截
 * 建 task / 工具计时配对 / 聚合器驱动）。执行期状态集中在 RunState，
 * loop.ts 在流结束后交给 persistence 落库。
 */
import { stepCountIs } from 'ai'
import { createTask, transitionTask, TASK_EVENT } from './tasks'
import { ACK_TOOL_NAME, validateAckArgs, ackSummary } from '../tools/builtin/ack'
import { BlockAggregator, type ContentBlock } from './blocks'
import {
  evMessage, evThinking, evToolStart, evToolResult,
  evMediaStart, evMediaEnd, evError,
  type ChatEvent,
} from './events'

// ---------- 动态配置读取 ----------

/** 读取 Agent 工具循环步数上限（AiSysConfig.agent_max_steps；缺省/非法/DB 异常回退 20） */
export async function readMaxSteps(): Promise<number> {
  try {
    const { prisma } = await import('../db/client')
    const row = await prisma.aiSysConfig.findFirst({ where: { configKey: 'agent_max_steps', delFlag: '0' } })
    const n = Number(row?.configValue)
    return Number.isInteger(n) && n > 0 ? n : 20
  } catch {
    return 20
  }
}

// ---------- stopWhen 构造 ----------

/**
 * stopWhen 组合（v7 替代 v4 maxSteps；探针实证不传时工具后第二轮不启动）：
 * - stepCountIs(maxSteps)：步数上限（动态配置 agent_max_steps）
 * - ackStop：模型调 ack_user 且载荷合法时停止本轮流（07_1；载荷非法不停，
 *   execute 错误文本回传驱动模型下一轮自纠重调）
 */
export function buildStopWhen(ackEnabled: boolean, maxSteps: number) {
  if (!ackEnabled) return stepCountIs(maxSteps)
  const ackStop = (opts: { steps: any[] }): boolean => {
    const last = opts.steps[opts.steps.length - 1]
    const content = last?.content
    if (!Array.isArray(content)) return false
    for (const c of content) {
      if (c?.type !== 'tool-call' || c.toolName !== ACK_TOOL_NAME) continue
      const a = (c as any).input ?? (c as any).args ?? {}
      return validateAckArgs((typeof a === 'object' && a) || {}) === null
    }
    return false
  }
  return [stepCountIs(maxSteps), ackStop]
}

// ---------- 执行期状态 ----------

/** 单轮执行状态（事件流消费中累积；流结束交 persistence 落库） */
export interface RunState {
  aggregator: BlockAggregator
  toolCalls: any[]
  mediaBlocks: { type: string; index: number; title: string | null; data: unknown }[]
  ackTriggered: { taskId: string; args: Record<string, unknown> } | null
  errorMessage: string | null
}

export function newRunState(): RunState {
  return {
    aggregator: new BlockAggregator(),
    toolCalls: [],
    mediaBlocks: [],
    ackTriggered: null,
    errorMessage: null,
  }
}

// ---------- 工具来源推断 ----------

/** 按工具命名约定推断来源：builtin_{code} → builtin；mcp_{server}__{tool} → mcp:{server}；其余 → skill */
function toolSourceOf(toolName: string): string {
  if (toolName.startsWith('builtin_')) return 'builtin'
  if (toolName.startsWith('mcp_')) {
    const rest = toolName.slice(4)
    const sep = rest.indexOf('__')
    return sep > 0 ? `mcp:${rest.slice(0, sep)}` : 'skill'
  }
  return 'skill'
}

// ---------- 媒体劫持状态机（09 方案 §5.1，适配 content_blocks；多媒体类型扩展） ----------

const MEDIA_MARKERS: { marker: string; type: string }[] = [
  { marker: '```echarts', type: 'media_chart' },
  { marker: '```mermaid', type: 'media_mermaid' },
  { marker: '```plan', type: 'plan' },   // 07_2 序 1：计划块（走 aggregator.handlePlan，不进 mediaBlocks）
]
const MAX_MARKER_LEN = Math.max(...MEDIA_MARKERS.map(m => m.marker.length))

/** 在文本中找最早出现的媒体起始标记（多种标记取位置最前者） */
function findMarker(text: string): { pos: number; type: string; marker: string } | null {
  let best: { pos: number; type: string; marker: string } | null = null
  for (const m of MEDIA_MARKERS) {
    const pos = text.indexOf(m.marker)
    if (pos >= 0 && (!best || pos < best.pos)) best = { pos, type: m.type, marker: m.marker }
  }
  return best
}

/**
 * 媒体劫持器：普通模式逐 delta 检测媒体起始标记（```echarts / ```mermaid）
 * → MEDIA 模式（token 不进正文）→ 闭合后按类型解析（chart=JSON / mermaid=纯文本）
 * → media 块 + MEDIA 事件；解析失败降级内联回正文。
 * 半截（断流）由 finish() 降级。
 */
class MediaHijacker {
  private mode = false
  private type = 'media_chart'
  private buf = ''
  private tail = ''
  private idx = 0

  constructor(
    private readonly aggregator: BlockAggregator,
    private readonly mediaBlocks: RunState['mediaBlocks'],
    private readonly emit: (ev: ChatEvent) => void,
  ) {}

  /** 处理一段文本 delta：返回需进正文的残余（媒体闭合后的 after 部分内部已处理） */
  feed(chunk: string): void {
    if (!this.mode) {
      this.tail += chunk
      const hit = findMarker(this.tail)
      if (hit) {
        const before = this.tail.slice(0, hit.pos)
        if (before) {
          this.aggregator.handleTextDelta(before)
          this.emit(evMessage(before))
        }
        this.mode = true
        this.type = hit.type
        this.buf = this.tail.slice(hit.pos + hit.marker.length)
        this.tail = ''
        this.emit(evMediaStart(this.idx, this.type))
      } else {
        // 安全 flush：保留最后 (最长标记-1) 字符防标记跨 delta 切断
        const keep = MAX_MARKER_LEN - 1
        if (this.tail.length > keep) {
          const flush = this.tail.slice(0, this.tail.length - keep)
          this.aggregator.handleTextDelta(flush)
          this.emit(evMessage(flush))
          this.tail = this.tail.slice(-keep)
        }
      }
      return
    }
    // MEDIA 模式：缓冲找闭合 ```
    this.buf += chunk
    const close = this.buf.indexOf('```')
    if (close >= 0) {
      const rawContent = this.buf.slice(0, close).trim()
      const after = this.buf.slice(close + 3)
      this.buf = ''
      this.mode = false
      this.closeBlock(rawContent)
      if (after) {
        this.aggregator.handleTextDelta(after)
        this.emit(evMessage(after))
      }
    }
  }

  private closeBlock(rawContent: string): void {
    // plan 块（07_2 序 1）：JSON 数组 [{index,desc,tool}]，劫持后走 aggregator.handlePlan（不进 mediaBlocks）
    if (this.type === 'plan') {
      let steps: { index: number; desc: string; tool?: string }[] | null = null
      try {
        const parsed = JSON.parse(rawContent)
        if (Array.isArray(parsed) && parsed.every(s => s?.desc)) {
          steps = parsed.map((s, i) => ({ index: Number(s.index ?? i + 1), desc: String(s.desc), ...(s.tool ? { tool: String(s.tool) } : {}) }))
        }
      } catch { steps = null }
      if (steps && steps.length) {
        this.aggregator.handlePlan(steps)
        this.emit(evMediaEnd(this.idx, 'plan', `共 ${steps.length} 步`, steps as unknown))
        this.idx++
      } else {
        const raw = '```plan\n' + rawContent + '\n```'
        this.aggregator.handleTextDelta(raw)
        this.emit(evMessage(raw))
      }
      return
    }
    if (this.type === 'media_mermaid') {
      const mTitle = rawContent.match(/^\s*(?:%%\s*(.+)|title\s+(.+))$/m)
      const title = mTitle?.[1]?.trim() || mTitle?.[2]?.trim() || null
      if (rawContent) {
        this.mediaBlocks.push({ type: 'media_mermaid', index: this.idx, title, data: rawContent })
        this.aggregator.handleMedia(this.idx, title)
        this.emit(evMediaEnd(this.idx, 'media_mermaid', title, rawContent))
        this.idx++
      } else {
        const raw = '```mermaid\n```'
        this.aggregator.handleTextDelta(raw)
        this.emit(evMessage(raw))
      }
      return
    }
    // echarts：JSON.parse
    let parsed: any = null
    try { parsed = JSON.parse(rawContent) } catch { parsed = null }
    const title = parsed?.title?.text ?? (typeof parsed?.title === 'string' ? parsed.title : null) ?? null
    if (parsed) {
      this.mediaBlocks.push({ type: 'media_chart', index: this.idx, title, data: parsed })
      this.aggregator.handleMedia(this.idx, title)
      this.emit(evMediaEnd(this.idx, 'media_chart', title, parsed))
      this.idx++
    } else {
      // 脏数据降级：整块作为普通代码块内联回正文（09 方案 §5.1）
      const raw = '```echarts\n' + rawContent + '\n```'
      this.aggregator.handleTextDelta(raw)
      this.emit(evMessage(raw))
    }
  }

  /** 流结束收尾：半截降级（09 方案 §5.3）+ 尾部缓冲 flush */
  finish(): void {
    if (this.mode && this.buf.trim()) {
      const fence = this.type === 'media_mermaid' ? '```mermaid' : this.type === 'plan' ? '```plan' : '```echarts'
      const raw = fence + '\n' + this.buf.trim() + '\n```'
      this.aggregator.handleTextDelta(raw)
      this.emit(evMessage(raw))
      this.emit(evMediaEnd(this.idx, this.type, null, null))
      this.mode = false
    }
    this.flushPending()
  }

  /**
   * 冲刷尾部缓冲（text 段结束的标志——模型切换到工具调用/流结束时调用）：
   * 防切断保留的最后几字符此刻归位，消除"text 段跨工具调用被截断"的延迟显示。
   */
  flushPending(): void {
    if (this.tail) {
      this.aggregator.handleTextDelta(this.tail)
      this.emit(evMessage(this.tail))
      this.tail = ''
    }
  }
}

// ---------- 事件流归一化 ----------

/** 事件流消费依赖（loop.ts 注入） */
export interface StreamDeps {
  appCode: string
  convPk: number
  messageId: string
  tools: any[]
}

/**
 * 消费 streamText 的 fullStream，归一化为 ChatEvent 流（AsyncGenerator）。
 * 事件协议不变（MESSAGE/THINKING/TOOL/MEDIA）；聚合/媒体/ack 状态写入 RunState。
 * ack 拦截（07_1 阶段 B）：模型请求用户决策 → 建 task 挂起（buildStopWhen 合法载荷才停流）。
 */
export async function* runStreamEvents(
  fullStream: AsyncIterable<any>,
  deps: StreamDeps,
  state: RunState,
): AsyncGenerator<ChatEvent> {
  const { aggregator, toolCalls, mediaBlocks } = state
  const emitBuffer: ChatEvent[] = []   // MediaHijacker 的 emit 直通本 generator 的 yield
  const hijacker = new MediaHijacker(aggregator, mediaBlocks, ev => emitBuffer.push(ev))
  const pendingToolBlocks: { blockIdx: number; callIdx: number; callId: string }[] = []
  const toolTimers = new Map<string, number>()

  for await (const part of fullStream) {
    // 冲刷 hijacker 缓冲事件（feed 中产生的 MESSAGE/MEDIA）
    const flush = function* (): Generator<ChatEvent> {
      while (emitBuffer.length) yield emitBuffer.shift()!
    }

    switch (part.type) {
      case 'text-delta': {
        if (part.text) hijacker.feed(part.text)
        yield* flush()
        break
      }

      case 'reasoning-delta':
        if (part.text) {
          aggregator.handleReasoningDelta(part.text)
          yield evThinking(part.text)
        }
        break

      case 'tool-call': {
        // 模型切换到工具调用：当前 text 段必然已结束——冲掉防切断缓冲（修复跨工具调用的 text 截断）
        hijacker.flushPending()
        while (emitBuffer.length) yield emitBuffer.shift()!
        const toolInput = (part as any).input ?? (part as any).args ?? {}
        const callId = (part as any).toolCallId || part.toolName
        const toolDef = deps.tools.find(t => t.name === part.toolName)
        const displayName = toolDef?.displayName || part.toolName
        yield evToolStart(part.toolName, toolInput, displayName)
        const blockIdx = aggregator.handleToolCall(part.toolName, toolInput, toolSourceOf(part.toolName), displayName)
        pendingToolBlocks.push({ blockIdx, callIdx: toolCalls.length, callId })
        toolTimers.set(callId, Date.now())
        toolCalls.push({ tool: part.toolName, displayName, args: toolInput })

        // ack 拦截（07_1 + 07_2 原子化：args.plan 携带步骤计划时同轮落 plan 块——计划与确认原子绑定）
        if (part.toolName === ACK_TOOL_NAME) {
          const args = (typeof toolInput === 'object' && toolInput) || {}
          if (validateAckArgs(args) === null) {
            // plan 字段（原子化设计）：步骤计划随 ack 一起落库（content_blocks 的 plan 块 + 回放兼容）
            if (Array.isArray(args.plan) && args.plan.length) {
              const steps = (args.plan as any[])
                .filter((s: any) => s?.desc)
                .map((s: any, i: number) => ({ index: Number(s.index ?? i + 1), desc: String(s.desc), ...(s.tool ? { tool: String(s.tool) } : {}) }))
              if (steps.length) aggregator.handlePlan(steps)
            }
            try {
              const task = await createTask({ appCode: deps.appCode, goal: String(args.question || '').slice(0, 500), conversationPk: deps.convPk, messageId: deps.messageId })
              await transitionTask(task.taskId, TASK_EVENT.START)
              await transitionTask(task.taskId, TASK_EVENT.ASK, { ackPayload: args })
              state.ackTriggered = { taskId: task.taskId, args }
              console.log(`[ack] 任务 ${task.taskId} 挂起（${args.type}${args.plan ? '+plan' : ''}）：${String(args.question).slice(0, 60)}`)
            } catch (e) {
              console.warn('[ack] task 创建失败（降级为普通工具调用）：', e)
            }
          }
        }
        break
      }

      case 'tool-result': {
        const output = (part as any).output ?? (part as any).result ?? ''
        const resultText = typeof output === 'string' ? output : JSON.stringify(output)
        const resultCallId = (part as any).toolCallId
        const startedAt = toolTimers.get(resultCallId)
        toolTimers.delete(resultCallId)
        const costMs = startedAt ? Date.now() - startedAt : 0
        // 错误检测：工具包装层把异常转字符串返回（保模型自纠错），按文本模式识别为展示层错误
        const toolError = /^(错误|MCP 工具返回错误|Error\b)/.test(resultText.trim()) ? resultText.trim() : undefined
        const pending = pendingToolBlocks.shift()
        if (pending) {
          aggregator.handleToolResult(pending.blockIdx, resultText, costMs, toolError)
          if (toolCalls[pending.callIdx]) {
            toolCalls[pending.callIdx].result = resultText
            toolCalls[pending.callIdx].costMs = costMs
            if (toolError) toolCalls[pending.callIdx].success = false
          }
        }
        // ack 占位不发 SSE（07_1 前端交互态依赖 result==null 判定"等待用户"；
        // 占位文本会让卡片误转只读。观测轨迹照记，真实结果由 ack-route 响应时覆盖）
        if (part.toolName === ACK_TOOL_NAME) break
        yield evToolResult(part.toolName, resultText, costMs, toolError)
        break
      }

      case 'error': {
        const errText = typeof part.error === 'object' && part.error !== null
          ? String((part.error as Error).message || '未知错误')
          : String(part.error || '未知错误')
        state.errorMessage = errText
        yield evError(errText)
        break
      }
    }
  }

  hijacker.finish()
  while (emitBuffer.length) yield emitBuffer.shift()!
}

/** ack 轮 answerPure 摘要（07_1 §4.3：续跑/记忆才能"记得"问过什么） */
export function ackSummaryText(state: RunState): string | null {
  return state.ackTriggered ? ackSummary(state.ackTriggered.args) : null
}
