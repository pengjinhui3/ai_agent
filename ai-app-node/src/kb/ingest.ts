// ============================================================
// 入库管道（18 号方案 MVP）
// 解析（MD/TXT/CSV）→ 分块（默认策略）→ 批量 embed → chunk 入库
// - fire-and-forget 异步：上传接口立即返回，状态机 pending → vectorizing → ready/failed
// - 原件落盘 uploads/kb/{docId}/（复用 11 号静态服务）；raw_text 入库（重跑原料）
// - 失败即 failed：重新上传即重试（MVP 不做断点续传）
// ============================================================

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createDoc, updateDocStatus, insertChunks } from './store.js'
import { embedBatch } from './embed.js'

/** 分块常量（改需重刷，非运行时可调——18 号方案 §四） */
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 50
const EMBED_BATCH = 32

/** 支持的文档类型（MVP：纯文本三件） */
export const KB_ACCEPT_TYPES = ['md', 'txt', 'csv'] as const

/** uploads 根（与 11 号附件静态服务同根） */
const KB_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'kb')

/**
 * 上传处理入口（fire-and-forget）：
 * 返回文档 id，管道后台跑；失败落 status=failed + error_message。
 */
export async function ingestDocument(file: { originalName: string; buffer: Buffer }): Promise<number> {
  const ext = file.originalName.split('.').pop()?.toLowerCase() || ''
  if (!KB_ACCEPT_TYPES.includes(ext as (typeof KB_ACCEPT_TYPES)[number])) {
    throw new Error(`不支持的文档类型 .${ext}（支持：${KB_ACCEPT_TYPES.join(' / ')}）`)
  }
  const rawText = file.buffer.toString('utf-8')
  if (!rawText.trim()) throw new Error('文档内容为空')

  // 原件落盘 + 建行（status=pending）
  const docId = await createDoc(file.originalName, ext, rawText, null)
  const docDir = path.join(KB_UPLOAD_DIR, String(docId))
  await fs.mkdir(docDir, { recursive: true })
  const filePath = path.join(docDir, sanitizeFilename(file.originalName))
  await fs.writeFile(filePath, file.buffer)
  const { setDocFilePath } = await import('./store.js')
  await setDocFilePath(docId, `kb/${docId}/${path.basename(filePath)}`)

  // 后台跑管道（不 await）
  void runPipeline(docId, ext, rawText).catch(() => { /* runPipeline 内部已兜底 */ })
  return docId
}

/** 管道主体：分块 → 批量 embed → 入库；任何异常 → failed */
async function runPipeline(docId: number, ext: string, rawText: string): Promise<void> {
  try {
    const chunks = ext === 'md' ? chunkMarkdown(rawText) : chunkSliding(rawText)
    if (!chunks.length) throw new Error('分块结果为空')
    await updateDocStatus(docId, 'vectorizing')

    const embeddings: Float32Array[] = []
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      embeddings.push(...await embedBatch(batch))
    }
    await insertChunks(docId, chunks, embeddings)
    await updateDocStatus(docId, 'ready', chunks.length)
  } catch (e) {
    await updateDocStatus(docId, 'failed', undefined, e instanceof Error ? e.message : String(e)).catch(() => {})
  }
}

/** MD 分块：按标题层级（#/##/### 之上切开），超长段再滑动窗口 */
function chunkMarkdown(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length) {
      sections.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) sections.push(current.join('\n'))

  // 段落过长的再滑动切
  const out: string[] = []
  for (const sec of sections) {
    if (sec.length <= CHUNK_SIZE) {
      if (sec.trim()) out.push(sec.trim())
    } else {
      out.push(...chunkSliding(sec))
    }
  }
  return out
}

/** 滑动窗口分块（TXT/CSV/超长段通用）：512 字，重叠 50 */
function chunkSliding(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length)
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks.filter(c => c.length > 0)
}

/** 文件名净化（防路径穿越） */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'unnamed'
}
