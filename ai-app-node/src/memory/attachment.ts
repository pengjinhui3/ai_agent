/**
 * 附件落盘服务（对应 Java 侧 AttachmentService）：
 * base64 → 本地文件 + 引用 JSON；会话删除联动清理。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const UPLOAD_ROOT = 'uploads'

export interface DecodedAttachment {
  mime: string
  name: string
  bytes: Buffer
}

export interface StoredAttachment {
  kind: 'image' | 'file'
  mime: string
  name: string
  path: string
  size: number
}

/** MIME 白名单 */
const MIME_WHITELIST = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/x-log',
])

export function validateMime(mime: string): boolean {
  return MIME_WHITELIST.has(mime.toLowerCase().trim())
}

/** 批量落盘 */
export function store(conversationId: string, messageId: string, list: DecodedAttachment[]): StoredAttachment[] {
  const stored: StoredAttachment[] = []
  if (!list || list.length === 0) return stored

  const dir = path.join(UPLOAD_ROOT, conversationId, messageId)
  fs.mkdirSync(dir, { recursive: true })

  for (const a of list) {
    const ext = extensionOf(a.mime, a.name)
    const fileName = crypto.randomUUID().replace(/-/g, '').substring(0, 16) + '.' + ext
    const file = path.join(dir, fileName)
    fs.writeFileSync(file, a.bytes)
    stored.push({
      kind: a.mime.startsWith('image/') ? 'image' : 'file',
      mime: a.mime,
      name: a.name,
      path: file.replace(/\\/g, '/'),
      size: a.bytes.length,
    })
  }
  console.log(`[附件] 落盘 ${stored.length} 个 → ${dir}`)
  return stored
}

/** 会话删除联动清理 */
export function cleanupConversation(conversationId: string): void {
  try {
    const dir = path.join(UPLOAD_ROOT, conversationId)
    if (!fs.existsSync(dir)) return
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`[附件] 会话附件目录已清理：${dir}`)
  } catch (e) {
    console.warn(`[附件] 会话附件目录清理失败（残留孤儿文件无害）：${conversationId}`, e)
  }
}

function extensionOf(mime: string, name: string): string {
  if (name) {
    const dot = name.lastIndexOf('.')
    if (dot >= 0 && dot < name.length - 1) {
      const ext = name.substring(dot + 1).toLowerCase()
      if (/^[a-z0-9]{1,8}$/.test(ext)) return ext
    }
  }
  const byMime: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  }
  return byMime[mime] || 'bin'
}
