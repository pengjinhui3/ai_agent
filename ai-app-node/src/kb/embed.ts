// ============================================================
// Embedding 服务（18 号方案 MVP）
// - config 直配模式：读 kb_embedding_url / kb_embedding_model（不经 provider/AiModel 体系）
// - OpenAI 兼容协议（Ollama /v1/embeddings 实测 200，1024 维）
// - 超时硬闸 kb_embed_timeout_seconds（主流程降级保证之一）
// - 任何失败向上抛（调用方决定降级文案），批量单次调用（bge-m3 多输入）
// ============================================================

import { readKbConfig } from './store.js'

/** 维度探测结果缓存（会话级：首次调用后记住，避免每次查表） */
let cachedDim: number | null = null

export function cachedEmbeddingDim(): number | null {
  return cachedDim
}

/**
 * 批量 embedding：texts → 向量数组（与输入同序）。
 * 抛错场景：url 未配 / 网络超时 / 响应格式异常。
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return []
  const cfg = await readKbConfig()
  if (!cfg.embeddingUrl) throw new Error('kb_embedding_url 未配置')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.embedTimeoutSeconds * 1000)
  try {
    const res = await fetch(cfg.embeddingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 三方平台鉴权（OpenAI 兼容 Bearer；本地 Ollama 留空则不发送）
        ...(cfg.embeddingApiKey ? { Authorization: `Bearer ${cfg.embeddingApiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.embeddingModel, input: texts }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`embedding HTTP ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`)
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
    const data = json?.data
    if (!Array.isArray(data) || data.length !== texts.length || !data[0]?.embedding?.length) {
      throw new Error('embedding 响应格式异常')
    }
    const out = data.map(d => Float32Array.from(d.embedding))
    cachedDim = out[0].length
    return out
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`embedding 调用超时（>${cfg.embedTimeoutSeconds}s）`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 单条 embedding（检索查询用） */
export async function embedOne(text: string): Promise<Float32Array> {
  return (await embedBatch([text]))[0]
}
