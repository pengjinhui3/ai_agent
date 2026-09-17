// ============================================================
// export_file 内置工具（15 号 §6.2：报告类指令的 sink——产物落盘）
// - 工厂模式：装配时闭包注入会话上下文（convPk——导出成功后清 mode）
// - 落盘路径：uploads/reports/{安全化文件名}（/uploads 静态服务现成，链接天然可点）
// - MVP 格式：markdown（pdf/word 属转换层，将来）
// ============================================================

import type { ToolCallback } from '../index.js'
import { clearConversationMode } from '../../agent/modes.js'
import fs from 'node:fs'
import path from 'node:path'

export interface ExportToolCtx {
  conversationPk: number | null
}

/** 文件名安全化：去路径分隔符与非法字符，强制 .md 后缀，限长 */
function sanitizeFilename(raw: string): string {
  let name = String(raw || '').trim()
    .replace(/[\\/:*?"<>|]/g, '')      // Windows 非法字符
    .replace(/\s+/g, ' ')               // 连续空白合一
    .replace(/^\.+/, '')                // 前导点
    .slice(0, 80)                        // 限长
  if (!name) name = '导出报告'
  if (!/\.md$/i.test(name)) name += '.md'
  return name
}

/** 导出根目录（与附件 store 同级：uploads/ 由 /uploads/* 静态服务） */
const EXPORT_DIR = path.resolve(process.cwd(), 'uploads', 'reports')

export function buildExportFileTool(ctx: ExportToolCtx): ToolCallback {
  return {
    name: 'export_file',
    displayName: '文件导出',
    description:
      '将内容导出为 markdown 文件并返回下载链接（会话总结/报告类指令的最终步骤）。' +
      '参数：filename（文件名，如 "2026-09-15-会话总结.md"）/ content（完整文件内容）。',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '文件名（.md 后缀可省略自动补；日期前缀便于归档）' },
        content: { type: 'string', description: '文件的完整 markdown 内容' },
      },
      required: ['filename', 'content'],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      try {
        const filename = sanitizeFilename(String(args.filename ?? ''))
        const content = String(args.content || '').trim()
        if (!content) return '错误：content 不能为空'

        fs.mkdirSync(EXPORT_DIR, { recursive: true })
        const full = path.join(EXPORT_DIR, filename)
        fs.writeFileSync(full, content, 'utf8')
        const url = `/uploads/reports/${encodeURIComponent(filename)}`

        // sink 完成：清会话 mode（指令流程结束，回归普通对话）
        if (ctx.conversationPk) await clearConversationMode(ctx.conversationPk)

        return `导出成功：${filename}（${content.length} 字）\n\n📥 [点击下载 ${filename}](${url})\n` +
          `（向用户转述时请原样保留上面的 markdown 下载链接，用户点击即下载；流程结束）`
      } catch (e) {
        return `错误：导出失败 - ${e instanceof Error ? e.message : String(e)}（文件未落盘，可修正文件名后重试）`
      }
    },
  }
}
