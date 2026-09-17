// ============================================================
// 知识库存储层（18 号方案 MVP）
// - PG 连接池（pg 驱动直连；主业务仍 Prisma/MySQL，零牵连）
// - kb_* 动态配置读取辅助（缺省/非法/DB 异常一律回退默认值，
//   不让对话主流程因配置问题失败——项目三件套纪律）
// ============================================================

import pg from 'pg'
import { prisma } from '../db/client.js'

/** PG 连接串：env 优先（部署可配），本地开发回退默认（18 号联测环境） */
const PG_URL = process.env.PG_URL || 'postgres://postgres:123456@127.0.0.1:5432/ai_kb'

/** 懒初始化连接池（首次用到才建；PG 未起时调接口才报错，不影响服务启动） */
let pool: pg.Pool | null = null
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: PG_URL, max: 8, idleTimeoutMillis: 30_000 })
  }
  return pool
}

/** kb 配置键默认值（DB 未配/非法时的回退） */
export const KB_DEFAULTS = {
  kb_embedding_url: '',
  kb_embedding_model: 'bge-m3:latest',
  kb_embedding_api_key: '',
  kb_embed_timeout_seconds: 15,
  kb_top_k: 6,
  kb_min_similarity: 0.35,
} as const

export interface KbConfig {
  embeddingUrl: string
  embeddingModel: string
  embeddingApiKey: string
  embedTimeoutSeconds: number
  topK: number
  minSimilarity: number
}

/**
 * 读 kb 配置：转发单键模块（kb_config JSON，含 enabled/lastTest；无单键时旧散键兼容拼装）。
 * - 六字段签名保持不变（embed/search 调用方零改动）
 * - fail-open：任何异常回退默认值（配置问题不阻断知识库之外的流程）
 */
export async function readKbConfig(): Promise<KbConfig> {
  try {
    const { readKbConfigAll } = await import('./availability.js')
    const all = await readKbConfigAll()
    return {
      embeddingUrl: all.embeddingUrl,
      embeddingModel: all.embeddingModel,
      embeddingApiKey: all.embeddingApiKey,
      embedTimeoutSeconds: all.embedTimeoutSeconds,
      topK: all.topK,
      minSimilarity: all.minSimilarity,
    }
  } catch {
    return {
      embeddingUrl: KB_DEFAULTS.kb_embedding_url,
      embeddingModel: KB_DEFAULTS.kb_embedding_model,
      embeddingApiKey: KB_DEFAULTS.kb_embedding_api_key,
      embedTimeoutSeconds: KB_DEFAULTS.kb_embed_timeout_seconds,
      topK: KB_DEFAULTS.kb_top_k,
      minSimilarity: KB_DEFAULTS.kb_min_similarity,
    }
  }
}

// ---------- DAO ----------

export interface KbDocRow {
  id: number
  title: string
  source_type: string
  status: string
  chunk_count: number
  error_message: string | null
  file_path: string | null
  create_time: Date
}

/** 文档列表（最近在前） */
export async function listDocs(): Promise<KbDocRow[]> {
  const { rows } = await getPool().query<KbDocRow>(
    'SELECT id, title, source_type, status, chunk_count, error_message, file_path, create_time FROM ai_kb_doc ORDER BY id DESC'
  )
  return rows
}

/** 建文档行（status=pending）并返回 id */
export async function createDoc(title: string, sourceType: string, rawText: string, filePath: string | null): Promise<number> {
  const { rows } = await getPool().query<{ id: number }>(
    'INSERT INTO ai_kb_doc (title, source_type, status, raw_text, file_path) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [title, sourceType, 'pending', rawText, filePath]
  )
  return rows[0].id
}

/** 更新文档状态（管道推进 / 终态） */
export async function updateDocStatus(id: number, status: string, chunkCount?: number, errorMessage?: string | null): Promise<void> {
  await getPool().query(
    'UPDATE ai_kb_doc SET status = $1, chunk_count = COALESCE($2, chunk_count), error_message = $3 WHERE id = $4',
    [status, chunkCount ?? null, errorMessage ?? null, id]
  )
}

/** 回填原件路径（ingest 落盘后） */
export async function setDocFilePath(id: number, relPath: string): Promise<void> {
  await getPool().query('UPDATE ai_kb_doc SET file_path = $1 WHERE id = $2', [relPath, id])
}

/** 删文档（chunk 级联） */
export async function deleteDoc(id: number): Promise<boolean> {
  const { rowCount } = await getPool().query('DELETE FROM ai_kb_doc WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

/** 批量写 chunk（embedding 为 Float32Array 数组，驱动层转 vector 文本） */
export async function insertChunks(docId: number, contents: string[], embeddings: Float32Array[]): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // 先清旧块（重跑/重处理场景幂等）
    await client.query('DELETE FROM ai_kb_chunk WHERE doc_id = $1', [docId])
    for (let i = 0; i < contents.length; i++) {
      await client.query(
        'INSERT INTO ai_kb_chunk (doc_id, seq, content, embedding) VALUES ($1, $2, $3, $4)',
        [docId, i + 1, contents[i], vectorLiteral(embeddings[i])]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Float32Array → pgvector 字面量 '[0.12, -0.34, ...]'（保留 6 位精度足够） */
function vectorLiteral(v: Float32Array): string {
  const parts = new Array(v.length)
  for (let i = 0; i < v.length; i++) parts[i] = v[i].toFixed(6)
  return `[${parts.join(',')}]`
}
