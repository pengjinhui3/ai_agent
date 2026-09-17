// ============================================================
// KB 配置与可用性（2026-09-17 v2：辉哥方案——单配置项 + 显式启用状态）
// - kb_config 单键（sys_config）存 JSON：参数 + enabled + lastTest
// - 状态 = 配置字段（不派生、不缓存、不做运行时探测）——"测试并启用"驱动
// - 旧散键（kb_embedding_url / kb_embedding_model / ...）读取兼容：无单键时拼旧键
// - probeEmbedding() 仅在「测试」动作时调用（探测表单传入的 URL，不落库）
// ============================================================

import { prisma } from '../db/client.js'

export interface KbConfig {
  embeddingUrl: string
  embeddingModel: string
  embeddingApiKey: string
  embedTimeoutSeconds: number
  topK: number
  minSimilarity: number
  /** 显式启用状态：测试通过写入 true；URL 清空保存即整体下架 */
  enabled: boolean
  /** 最近一次测试结果（展示用） */
  lastTest: { ok: boolean; detail: string; at: string } | null
}

const KB_CONFIG_KEY = 'kb_config'
const KB_CONFIG_NAME = '知识库配置（单键 JSON：参数+启用状态）'

/** 默认值（无任何配置时） */
export const KB_DEFAULTS: KbConfig = {
  embeddingUrl: '', embeddingModel: 'bge-m3:latest', embeddingApiKey: '',
  embedTimeoutSeconds: 15, topK: 6, minSimilarity: 0.35,
  enabled: false, lastTest: null,
}

/** 旧散键 → 单键 的兼容映射（存量数据迁移读） */
const LEGACY_KEYS: Array<[keyof KbConfig, string]> = [
  ['embeddingUrl', 'kb_embedding_url'],
  ['embeddingModel', 'kb_embedding_model'],
  ['embeddingApiKey', 'kb_embedding_api_key'],
  ['embedTimeoutSeconds', 'kb_embed_timeout_seconds'],
  ['topK', 'kb_top_k'],
  ['minSimilarity', 'kb_min_similarity'],
]

async function readRow(key: string): Promise<string | null> {
  try {
    const row = await prisma.aiSysConfig.findFirst({ where: { configKey: key, delFlag: '0' } })
    return row?.configValue ?? null
  } catch { return null }
}

/** 读 KB 配置：单键优先，无则旧散键拼装（保存后归一到单键）——readKbConfigAll 别名供 store 转发 */
export const readKbConfigAll = readKbConfig
export async function readKbConfig(): Promise<KbConfig> {
  const single = await readRow(KB_CONFIG_KEY)
  if (single) {
    try {
      const parsed = JSON.parse(single) as Partial<KbConfig>
      return { ...KB_DEFAULTS, ...parsed }
    } catch { /* 单键损坏 → 走旧键拼装 */ }
  }
  // 旧散键兼容（enabled 派生：有 URL 即视为旧逻辑下的启用态）
  const cfg: KbConfig = { ...KB_DEFAULTS, enabled: false, lastTest: null }
  for (const [field, key] of LEGACY_KEYS) {
    const v = await readRow(key)
    if (v === null || v === '') continue
    const target = cfg as unknown as Record<string, unknown>
    if (field === 'embedTimeoutSeconds' || field === 'topK' || field === 'minSimilarity') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) target[field] = n
    } else {
      target[field] = v
    }
  }
  if (cfg.embeddingUrl) cfg.enabled = true   // 旧数据有 URL = 已启用（旧行为语义）
  return cfg
}

/** 保存 KB 配置（单键整存） */
export async function writeKbConfig(cfg: KbConfig): Promise<void> {
  const exist = await prisma.aiSysConfig.findFirst({ where: { configKey: KB_CONFIG_KEY, delFlag: '0' } })
  const value = JSON.stringify(cfg)
  if (exist) {
    await prisma.aiSysConfig.update({ where: { configId: exist.configId }, data: { configValue: value, updateTime: new Date() } })
  } else {
    await prisma.aiSysConfig.create({
      data: { configKey: KB_CONFIG_KEY, configName: KB_CONFIG_NAME, configValue: value, isBuiltin: true, delFlag: '0', createTime: new Date(), updateTime: new Date() },
    })
  }
}

/** URL 格式校验（畸形地址不进探测——"https" 裸串直接报格式错） */
export function validateEmbeddingUrl(url: string): string | null {
  if (!url) return null
  if (!/^https?:\/\/\S+\.\S+/.test(url)) return '必须是 http(s)://host[:port]/path 形式的完整地址'
  return null
}

/**
 * 端到端探测（仅测试动作调用）：带表单的 apiKey + model 真实请求一次 embedding。
 * - 200 = 完全可用；401/403 = 认证失败（key 无效）；其他 4xx = 参数/模型问题；网络异常 = 不可达
 * （辉哥 2026-09-17 实测发现：空 body 探测无法发现 key 错误——401 会被误判"服务活着"）
 */
export async function probeEmbedding(url: string, apiKey: string, model: string): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now()
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 10_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ input: ['ping'], model: model || 'bge-m3:latest' }),
        signal: ac.signal,
      })
      const ms = Date.now() - t0
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}，${ms}ms` }
      // 4xx/5xx：读响应体片段辅助定位（key 错/模型名错/地址错）
      const text = await res.text().catch(() => '')
      const brief = text ? text.slice(0, 120) : ''
      return { ok: false, detail: `HTTP ${res.status}（${ms}ms）${brief}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '超时（10s）' : e.message) : String(e)
    return { ok: false, detail: msg }
  }
}
