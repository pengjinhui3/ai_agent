// ============================================================
// MCP 工具注册表（批次 3）
// 从 DB 读取启用的 AiMcpServer，逐个建立 MCP 连接并拉取工具列表，
// 统一转成 ToolCallback 缓存复用。支持三种传输类型：
//   - streamable：url + headers（StreamableHTTPClientTransport）
//   - stdio：command + args + env（StdioClientTransport，spawn 子进程）
//   - sse：url + headers（SSEClientTransport）
// MCP 服务增删改后由外部调用 evictMcp() 驱逐缓存，下次拉取时重建。
// 另提供临时连接测试：建立连接(initialize) → listTools → 关闭。
// ============================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { AiMcpServer } from '@prisma/client'
import pLimit from 'p-limit'
import { prisma } from '../../db/client.js'
import type { ToolCallback } from '../builtin/index.js'

/** MCP 工具全名的分段分隔符：mcp_{serverCode}__{toolName} */
export const MCP_SEGMENT_SEPARATOR = '__'

/** 全部服务连接失败后的重试冷却时间（毫秒），避免每个请求都反复重连挂掉的服务 */
const ALL_FAILED_COOLDOWN_MS = 30_000

/** 单服务器连接/工具拉取的默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000

/** 连接握手时对外声明的客户端信息 */
const CLIENT_INFO = { name: 'ai-app-node', version: '0.1.0' }

/** 生成 MCP 工具全名：mcp_{serverCode}__{toolName} */
export function mcpToolName(serverCode: string, toolName: string): string {
  return `mcp_${serverCode}${MCP_SEGMENT_SEPARATOR}${toolName}`
}

// ---------- 配置类型与解析 ----------

/** MCP 服务配置（测试连通时可由外部直接传入，字段与 AiMcpServer 表对应） */
export interface McpServerConfig {
  serverCode: string
  name?: string
  /** 传输类型：streamable | stdio | sse */
  type: string
  url?: string | null
  /** JSON 对象字符串或普通对象 */
  headers?: string | Record<string, string> | null
  command?: string | null
  /** JSON 数组字符串或字符串数组 */
  args?: string | string[] | null
  /** JSON 对象字符串或普通对象（仅 stdio） */
  env?: string | Record<string, string> | null
}

/** 连通性测试结果 */
export interface McpTestResult {
  ok: boolean
  serverCode: string
  /** 成功时返回的工具列表 */
  tools: { name: string; description: string }[]
  error?: string
  elapsedMs: number
  /** 握手信息（管理界面"测试并启用"弹窗展示） */
  serverName?: string
  serverVersion?: string
  protocolVersion?: string
}

/** AiMcpServer 表记录 → 通用配置对象 */
function toConfig(row: AiMcpServer): McpServerConfig {
  return {
    serverCode: row.serverCode,
    name: row.name,
    type: row.type,
    url: row.url,
    headers: row.headers,
    command: row.command,
    args: row.args,
    env: row.env,
  }
}

/** 解析 headers：兼容 JSON 对象字符串 / 双层 JSON（历史存储 bug 遗留）/ 普通对象 / 空值 */
function parseHeaders(headers: McpServerConfig['headers']): Record<string, string> {
  if (!headers) return {}
  if (typeof headers === 'object') return { ...headers }
  let parsed: unknown
  try { parsed = JSON.parse(headers) } catch { return {} }
  // 双层 JSON 解包：历史 POST 路由对字符串又 stringify 了一层（JSON.parse 后还是字符串）
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return {} }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {}
}

/** 解析 args：兼容 JSON 数组字符串 / 数组 / 空白分隔字符串 / 空值 */
function parseArgs(args: McpServerConfig['args']): string[] {
  if (!args) return []
  if (Array.isArray(args)) return args.map(String)
  try {
    const parsed = JSON.parse(args)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // 非 JSON，按空白分隔兜底（如 "src/index.mjs --port 3000"）
    const parts = String(args).trim().split(/\s+/).filter(Boolean)
    if (parts.length > 0) return parts
  }
  return []
}

/** 解析 env：兼容 JSON 对象字符串 / 普通对象 / 空值 */
function parseEnv(env: McpServerConfig['env']): Record<string, string> {
  if (!env) return {}
  if (typeof env === 'object') return { ...env }
  try {
    const parsed = JSON.parse(env)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 取当前进程环境变量（值全为 string，供 stdio 子进程继承） */
function currentEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** 按传输类型创建 MCP Transport（配置缺失/类型未知时抛错） */
function createTransport(config: McpServerConfig): Transport {
  const type = (config.type || '').trim().toLowerCase()
  if (type === 'stdio') {
    if (!config.command) throw new Error('stdio 类型 MCP 服务缺少 command')
    return new StdioClientTransport({
      command: config.command,
      args: parseArgs(config.args),
      env: { ...currentEnv(), ...parseEnv(config.env) },
    })
  }
  if (type === 'streamable' || type === 'sse') {
    if (!config.url) throw new Error(`${type} 类型 MCP 服务缺少 url`)
    const headers = parseHeaders(config.headers)
    const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {}
    return type === 'streamable'
      ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit })
      : new SSEClientTransport(new URL(config.url), { requestInit })
  }
  throw new Error(`不支持的 MCP 传输类型：${config.type}（支持 streamable / stdio / sse）`)
}

// ---------- 通用工具函数 ----------

/** 给 Promise 加超时（超时定时器不阻塞进程退出） */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** 把 MCP callTool 结果序列化为字符串（text 块拼接，其余 JSON 化） */
function stringifyCallResult(result: unknown): string {
  const r = result as { content?: unknown[]; isError?: boolean; structuredContent?: unknown }
  const parts: string[] = []
  if (Array.isArray(r?.content)) {
    for (const block of r.content) {
      const b = block as { type?: string; text?: unknown }
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else parts.push(JSON.stringify(b))
    }
  } else if (r?.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent))
  } else if (result !== undefined) {
    parts.push(JSON.stringify(result))
  }
  const text = parts.join('\n') || '(无返回内容)'
  return r?.isError ? `MCP 工具返回错误：${text}` : text
}

// ---------- 连通性测试 ----------

/**
 * 测试连通：建立临时连接（POST initialize 握手 / stdio spawn）→ listTools → 返回工具列表 → 关闭。
 * 全程不写缓存、不影响现有连接，适合管理界面"测试连接"按钮直接调用。
 */
export async function testMcpServerConnection(
  config: McpServerConfig,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpTestResult> {
  const started = Date.now()
  const client = new Client(CLIENT_INFO, { capabilities: {} })
  try {
    const transport = createTransport(config)
    await withTimeout(client.connect(transport), timeoutMs, `建立连接超时（>${timeoutMs}ms）`)
    const res = await withTimeout(client.listTools(), timeoutMs, `listTools 超时（>${timeoutMs}ms）`)
    // 握手信息（MCP Client.initialize 后可用；getServerVersion 部分版本缺省则留空）
    const sv: { name?: string; version?: string } = (client as any).getServerVersion?.() ?? {}
    return {
      ok: true,
      serverCode: config.serverCode,
      tools: (res.tools ?? []).map(t => ({ name: t.name ?? '', description: t.description ?? '' })),
      elapsedMs: Date.now() - started,
      serverName: sv.name ?? '',
      serverVersion: sv.version ?? '',
      protocolVersion: '2025-03-26',
    }
  } catch (err) {
    return {
      ok: false,
      serverCode: config.serverCode,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    }
  } finally {
    try {
      await client.close()
    } catch {
      // 忽略临时连接关闭时的错误
    }
  }
}

/** 按 serverCode 从 DB 读配置并测试连通（管理界面便捷入口） */
export async function testMcpServerByCode(serverCode: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<McpTestResult> {
  let row: AiMcpServer | null
  try {
    row = await prisma.aiMcpServer.findFirst({ where: { serverCode, delFlag: '0' } })
  } catch (err) {
    return {
      ok: false,
      serverCode,
      tools: [],
      error: `读取 DB 失败：${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: 0,
    }
  }
  if (!row) {
    return { ok: false, serverCode, tools: [], error: `MCP 服务不存在或已删除：${serverCode}`, elapsedMs: 0 }
  }
  return testMcpServerConnection(toConfig(row), timeoutMs)
}

// ---------- 工具缓存与注册表 ----------

/** 单个 MCP 服务的缓存条目：连接客户端 + 转换后的工具回调 */
interface McpCacheEntry {
  serverCode: string
  client: Client
  tools: ToolCallback[]
  connectedAt: number
}

const cache = new Map<string, McpCacheEntry>()
let loading: Promise<ToolCallback[]> | null = null
let failedUntil = 0

// ============================================================
// per-server 信号量（19_0 序 2，源自 19_1 §五约束② + 20 号研判共识）
// 同一 MCP 服务同一时刻只允许一个在途工具调用：
//   - stdio 子进程是单管道单线程处理，并发 JSON-RPC 会消息交错/打挂
//   - 有状态服务（如 DBX 的 session）并发调用会串台
// 信号量与 cache entry 同生命周期：evictMcp() 清缓存时联动清理（防泄漏），
// 服务连接重建时信号量一并重建。
// ============================================================
const serverLimits = new Map<string, ReturnType<typeof pLimit>>()

function getServerLimit(serverCode: string): ReturnType<typeof pLimit> {
  let limit = serverLimits.get(serverCode)
  if (!limit) {
    limit = pLimit(1)
    serverLimits.set(serverCode, limit)
  }
  return limit
}

/** 把 MCP 原生工具定义包装成统一 ToolCallback（execute 闭包持有该服务的连接） */
function toToolCallback(serverCode: string, client: Client, tool: McpTool): ToolCallback {
  const fullName = mcpToolName(serverCode, tool.name)
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: 'object' as const, properties: {} }
  return {
    name: fullName,
    // 显示名 = MCP 原始工具名（用户友好；全名编码用于白名单匹配与去重）
    displayName: tool.name,
    description: tool.description?.trim() || `MCP 工具 ${tool.name}（来自服务 ${serverCode}）`,
    parameters: schema,
    async execute(args) {
      // per-server 信号量：同一服务的并发调用在此排队（串行化，防消息交错/串台）
      const limit = getServerLimit(serverCode)
      return limit(async () => {
        try {
          const result = await client.callTool({ name: tool.name, arguments: args })
          return stringifyCallResult(result)
        } catch (err) {
          return `错误：MCP 工具 ${fullName} 调用失败 - ${err instanceof Error ? err.message : String(err)}（若服务已变更，可刷新工具缓存后重试）`
        }
      })
    },
  }
}

/** 连接单个 MCP 服务并缓存其工具（失败仅告警，不影响其他服务） */
async function connectServer(config: McpServerConfig): Promise<void> {
  const client = new Client(CLIENT_INFO, { capabilities: {} })
  try {
    const transport = createTransport(config)
    await withTimeout(client.connect(transport), DEFAULT_TIMEOUT_MS, `建立连接超时（>${DEFAULT_TIMEOUT_MS}ms）`)
    const res = await withTimeout(client.listTools(), DEFAULT_TIMEOUT_MS, `listTools 超时（>${DEFAULT_TIMEOUT_MS}ms）`)
    const tools = (res.tools ?? []).map(t => toToolCallback(config.serverCode, client, t))
    cache.set(config.serverCode, { serverCode: config.serverCode, client, tools, connectedAt: Date.now() })
    console.log(`[tools/mcp] 已连接 MCP 服务 ${config.serverCode}，获取 ${tools.length} 个工具`)
  } catch (err) {
    try {
      await client.close()
    } catch {
      // 忽略半开连接的关闭错误
    }
    console.warn(
      `[tools/mcp] 连接 MCP 服务 ${config.serverCode}（${config.type}）失败：`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** 读 DB 中启用的服务并全量加载（并发连接，单服务失败不中断） */
async function loadAll(): Promise<ToolCallback[]> {
  let servers: AiMcpServer[]
  try {
    servers = await prisma.aiMcpServer.findMany({
      where: { enabled: true, delFlag: '0' },
      orderBy: { id: 'asc' },
    })
  } catch (err) {
    console.warn('[tools/mcp] 读取 AiMcpServer 表失败：', err instanceof Error ? err.message : err)
    failedUntil = Date.now() + ALL_FAILED_COOLDOWN_MS // DB 不可用时同样进入冷却，避免每请求重复撞库
    return []
  }
  if (servers.length === 0) return []
  await Promise.allSettled(servers.map(s => connectServer(toConfig(s))))
  if (cache.size === 0) {
    // 全军覆没：进入冷却期，避免每个请求都反复重连挂掉的服务
    failedUntil = Date.now() + ALL_FAILED_COOLDOWN_MS
    console.warn(`[tools/mcp] 所有 MCP 服务连接失败，${ALL_FAILED_COOLDOWN_MS / 1000}s 后才会重试`)
  }
  return cachedMcpTools()
}

/** 当前缓存中的全部 MCP 工具 */
export function cachedMcpTools(): ToolCallback[] {
  return [...cache.values()].flatMap(e => e.tools)
}

/**
 * 获取 MCP 工具列表（缓存优先）：
 * - 缓存非空直接返回（外部在 MCP 服务增删改后调用 evictMcp 驱逐）
 * - 缓存为空则读 DB 全量加载一次；并发调用共享同一次加载
 * - 全部失败后进入短暂冷却期，期间直接返回空数组
 */
export async function getMcpTools(): Promise<ToolCallback[]> {
  if (cache.size > 0) return cachedMcpTools()
  if (Date.now() < failedUntil) return []
  if (!loading) {
    loading = loadAll().finally(() => {
      loading = null
    })
  }
  return loading
}

/** 当前缓存的服务编码列表（观测用） */
export function cachedServerCodes(): string[] {
  return [...cache.keys()]
}

/**
 * 驱逐 MCP 缓存：关闭全部连接并清空缓存（MCP 服务增删改后由外部调用），
 * 下次 getMcpTools() 将按 DB 最新状态重建连接。
 */
export async function evictMcp(): Promise<void> {
  const entries = [...cache.values()]
  cache.clear()
  serverLimits.clear() // 信号量与缓存同生命周期：一并清理，防泄漏
  failedUntil = 0
  await Promise.allSettled(entries.map(e => e.client.close()))
}
