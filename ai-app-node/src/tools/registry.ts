// ============================================================
// 统一工具注册表（批次 3）
// 汇聚三类工具来源：
//   1. MCP 工具：来自启用的 AiMcpServer（命名 mcp_{serverCode}__{toolName}）
//   2. 内置工具：静态定义 + AiBuiltinTool 表 enabled 状态过滤（builtin_ 前缀）
//   3. 附加工具：调用方传入（如 Skill 的 load_skill 工具）
// getTools(whitelist) 按白名单做精确/分段匹配过滤；evict() 清空 MCP 缓存。
// ============================================================

import type { ToolCallback } from './builtin/index.js'
import { getBuiltinToolSelection } from './builtin/index.js'
import { evictMcp, getMcpTools, MCP_SEGMENT_SEPARATOR } from './mcp/registry.js'

/**
 * 白名单匹配（精确 + 分段）：
 * - 精确匹配：白名单项 === 工具全名，如 builtin_current_time、mcp_github__create_issue
 * - 分段匹配（带 mcp_ 前缀容错）：白名单项是 MCP 服务编码（如 weather）时，
 *   命中 mcp_weather 服务器下的全部工具（mcp_weather__get_weather 等）；
 *   白名单项也可以写全前缀（mcp_weather），同样命中。
 */
export function matchWhitelist(whitelistItem: string, toolName: string): boolean {
  const item = whitelistItem.trim()
  if (item === '') return false
  if (item === toolName) return true
  return toolName.startsWith(item + MCP_SEGMENT_SEPARATOR)
    || toolName.startsWith(`mcp_${item}${MCP_SEGMENT_SEPARATOR}`)
}

/**
 * 获取统一工具列表（按白名单过滤）：
 * - whitelist 为空数组 → 返回空列表（不挂载任何工具）
 * - 内置工具中 AiBuiltinTool.required=true 的视为必选，豁免白名单强制包含
 * - extraTools：调用方附加的工具回调（典型为目录式 Skill 的 load_skill），
 *   由调用方按需生成（存在即代表用户配置了目录式技能），视为必选，豁免白名单
 * - 同名工具先到先得：extraTools > 内置 > MCP
 */
export async function getTools(whitelist: string[], extraTools: ToolCallback[] = []): Promise<ToolCallback[]> {
  const [builtinSelection, mcpTools] = await Promise.all([getBuiltinToolSelection(), getMcpTools()])
  const requiredCodes = new Set(builtinSelection.requiredCodes)

  const seen = new Set<string>()
  const result: ToolCallback[] = []

  // extraTools（如 load_skill）直接挂载，不受白名单约束
  for (const tool of extraTools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    result.push(tool)
  }

  const candidates: ToolCallback[] = [...builtinSelection.tools, ...mcpTools]
  for (const tool of candidates) {
    if (seen.has(tool.name)) continue // 同名去重，先到先得
    const isRequired = requiredCodes.has(tool.name)
    const inWhitelist = whitelist.some(w => matchWhitelist(w, tool.name))
    if (isRequired || inWhitelist) {
      seen.add(tool.name)
      result.push(tool)
    }
  }
  return result
}

/** 清空 MCP 工具缓存（MCP 服务增删改后调用；下次 getTools 时按 DB 重建连接） */
export async function evict(): Promise<void> {
  await evictMcp()
}
