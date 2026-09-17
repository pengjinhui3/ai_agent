/**
 * 模块职责：LLM 厂商 provider 工厂（含进程内缓存）。
 *
 * 从 DB（ai_provider 表）读取厂商配置（protocol / base_url / api_key），
 * 按 protocol 字段构建对应的 Vercel AI SDK provider 实例：
 * - "openai"            → Chat Completions API（/chat/completions），兼容性最好
 * - "openai.responses"  → Responses API（/responses），OpenAI 新一代 API
 * - "anthropic"         → Anthropic Messages API（/v1/messages）
 *
 * 厂商配置变更时由外部调用 evict(providerCode) 驱逐缓存，下次 getProvider 重建。
 *
 * baseUrl 约定（与 Java 版对齐）：
 * - 以 `#` 结尾：原样使用——去掉 `#` 后直接作为 baseURL，不追加任何路径；
 * - 其余情况：追加 /v1（三种协议统一处理）。
 */
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createAnthropic } from '@ai-sdk/anthropic'
import { prisma } from '../db/client'

/** 用 modelCode 换取 LanguageModel 实例的工厂函数（由 getProvider 返回） */
export type ModelFactory = (modelCode: string) => LanguageModel

/** provider 实例缓存：providerCode -> ModelFactory */
const cache = new Map<string, ModelFactory>()

/**
 * baseUrl 归一化：
 * - `#` 尾缀 → 去掉 # 直接用（不追加任何路径）
 * - 其余 → 追加 /v1（openai 和 anthropic 协议统一；Ollama 走 openai 协议无需单独处理）
 */
export function normalizeBaseUrl(baseUrl: string, protocol: string): string {
  if (baseUrl.endsWith('#')) {
    return baseUrl.slice(0, -1)
  }
  const raw = baseUrl.replace(/\/+$/, '')
  // AI SDK v7：openai 和 anthropic 都不自动追加 /v1（v4 的 anthropic 会自动加，v4.0.x 不会）
  if (!raw.endsWith('/v1')) {
    return `${raw}/v1`
  }
  return raw
}

/**
 * 按 providerCode 读取 DB 配置并构建 AI SDK provider（带缓存）。
 * 缓存命中直接返回；未命中查 ai_provider 表构建后写入缓存。
 * 查不到配置 / 已软删 / 协议不支持时抛 Error。
 */
export async function getProvider(providerCode: string): Promise<ModelFactory> {
  const hit = cache.get(providerCode)
  if (hit) return hit

  const row = await prisma.aiProvider.findUnique({ where: { providerCode } })
  if (!row || row.delFlag === '1') {
    throw new Error(`AI 厂商未配置或已删除：${providerCode}`)
  }

  const protocol = row.protocol.toLowerCase()
  // 归一化后为空则不传，走 SDK 默认官方端点
  const baseURL = normalizeBaseUrl(row.baseUrl, protocol) || undefined

  let factory: ModelFactory
  if (protocol === 'openai') {
    // Chat Completions API（/chat/completions）+ reasoning_content 捕获。
    // 用 @ai-sdk/deepseek 替代 createOpenAI().chat()：底层同为 Chat Completions，
    // 但能捕获 DeepSeek 系网关（hz 等）返回的 reasoning_content 非标准字段并转为 reasoning 事件；
    // 对不返回该字段的端点（GLM 官方/Ollama）零影响。
    const deepseek = createDeepSeek({ apiKey: row.apiKey, baseURL })
    factory = (modelCode) => deepseek.chat(modelCode)
  } else if (protocol === 'openai.responses') {
    // Responses API（/responses）：OpenAI 新一代 API，仅适用于支持该端点的网关
    const openai = createOpenAI({ apiKey: row.apiKey, baseURL })
    factory = (modelCode) => openai(modelCode)
  } else if (protocol === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: row.apiKey, baseURL })
    factory = (modelCode) => anthropic(modelCode)
  } else {
    throw new Error(`不支持的 AI 协议：${row.protocol}（厂商 ${providerCode}，支持 openai / openai.responses / anthropic）`)
  }

  cache.set(providerCode, factory)
  return factory
}

/** 驱逐指定厂商的 provider 缓存（配置变更后由外部调用，下次 getProvider 重建） */
export function evict(providerCode: string): void {
  cache.delete(providerCode)
}
