// ============================================================
// knowledge_search 内置工具（18 号方案 MVP）
// - 唯一接口边界（插拔式）：背后实现可换（PG 自建 / 外部 RAG 服务），模型侧无感
// - 降级保证（决策 #4）：任何异常一律返回降级文本，绝不冒泡成对话 ERROR
// - 未配 kb_embedding_url → 工具不进入注册列表（builtin/index.ts 过滤）
// ============================================================

import type { ToolCallback } from '../index.js'
import { embedOne } from '../../kb/embed.js'
import { searchChunks } from '../../kb/search.js'

export const knowledgeSearch: ToolCallback = {
  name: 'builtin_knowledge_search',
  displayName: '知识库检索',
  description:
    '检索本地知识库（用户上传的私有文档/资料），返回最相关的原文片段。' +
    '当用户的问题涉及已导入的私有知识、内部文档、项目资料时，先用本工具检索再回答；' +
    '常识性问题、闲聊、以及本会话中已确认的事实不需要检索（会话内记忆另有回查工具）。' +
    '检索不到相关内容时会明确说明，此时基于已有知识回答即可。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索问题（用完整自然语言描述要查的内容，中英文均可）',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args) {
    try {
      const query = String(args.query || '').trim()
      if (!query) return '错误：query 参数不能为空'
      const vec = await embedOne(query)
      const hits = await searchChunks(vec)
      if (!hits.length) {
        return '知识库中未检索到相关内容。请基于已有知识回答，或建议用户先在设置页知识库面板上传相关文档。'
      }
      const parts = hits.map((h, i) =>
        `【片段 ${i + 1}】来源：${h.title}（第 ${h.seq} 块）｜相似度：${(h.score * 100).toFixed(1)}%\n${h.content}`
      )
      return `从知识库检索到 ${hits.length} 个相关片段：\n\n${parts.join('\n\n')}`
    } catch (e) {
      // 主流程降级保证：检索链路任何故障 → 降级文本（模型继续正常对话），绝不阻断
      const msg = e instanceof Error ? e.message : String(e)
      return `知识库检索暂不可用（${msg}），请基于已有知识回答，不要臆造知识库内容。`
    }
  },
}
