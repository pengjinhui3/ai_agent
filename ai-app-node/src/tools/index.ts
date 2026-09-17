// ============================================================
// 工具模块汇总出口（批次 3）
// 统一导出：
//   - builtin：ToolCallback 回调格式 + 内置工具（builtin_current_time /
//     builtin_datetime_calc）+ AiBuiltinTool 表 enabled 过滤
//   - mcp：MCP 工具注册表（streamable / stdio / sse 三种传输、缓存与驱逐、连通测试）
//   - skill：Skill 装配（注入式全文 / 目录式 load_skill 工具）
//   - registry：统一注册表 getTools(whitelist) / evict()
// 上层服务（如 chat 流程）一般只需 import { getTools, assembleSkills, evict }
// ============================================================

export * from './builtin/index.js'
export * from './mcp/registry.js'
export * from './skill/loader.js'
export * from './registry.js'
