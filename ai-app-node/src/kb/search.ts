// ============================================================
// 向量检索（18 号方案 MVP：纯向量 top-k + 阈值过滤）
// ============================================================

import { getPool, readKbConfig } from './store.js'

export interface KbHit {
  docId: number
  title: string
  seq: number
  content: string
  score: number
}

/**
 * 检索：query 向量 → 余弦距离 top-k → 阈值过滤。
 * 只查 status=ready 的文档。抛错由调用方（工具层）降级。
 */
export async function searchChunks(queryEmbedding: Float32Array): Promise<KbHit[]> {
  const cfg = await readKbConfig()
  const lit = vectorLiteral(queryEmbedding)
  interface Row { doc_id: number; title: string; seq: number; content: string; score: string }
  const { rows } = await getPool().query<Row>(
    `SELECT c.doc_id, d.title, c.seq, c.content, 1 - (c.embedding <=> $1::vector) AS score
     FROM ai_kb_chunk c
     JOIN ai_kb_doc d ON d.id = c.doc_id
     WHERE d.status = 'ready' AND 1 - (c.embedding <=> $1::vector) > $2
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [lit, cfg.minSimilarity, cfg.topK]
  )
  return rows.map((r: Row) => ({ docId: r.doc_id, title: r.title, seq: r.seq, content: r.content, score: Number(r.score) }))
}

function vectorLiteral(v: Float32Array): string {
  const parts = new Array(v.length)
  for (let i = 0; i < v.length; i++) parts[i] = v[i].toFixed(6)
  return `[${parts.join(',')}]`
}
