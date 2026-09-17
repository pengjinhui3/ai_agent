/**
 * 诊断：getTools 全链路——内置/MCP/白名单过滤实际返回了什么。
 */
import 'dotenv/config'
import { getTools } from './src/tools/registry'
import { assembleSkills } from './src/tools/skill/loader'
import { prisma } from './src/db/client'

async function main() {
  const app = await prisma.aiApp.findFirst({ where: { appCode: 'assistant', delFlag: '0' } })
  if (!app) { console.error('应用不存在'); process.exit(1) }

  const whitelist = app.mcpTools ? JSON.parse(app.mcpTools) : []
  console.log('白名单:', whitelist)

  // 1. getTools（当前 loop.ts 的调用方式——不传 extraTools）
  const tools = await getTools(whitelist)
  console.log(`\n=== getTools 结果: ${tools.length} 个 ===`)
  for (const t of tools) {
    console.log(`  - ${t.name}`)
  }

  // 2. Skill 装配（loop.ts 目前没调用）
  const skillResult = await assembleSkills(app)
  console.log(`\n=== assembleSkills ===`)
  console.log(`prompt 注入长度: ${skillResult.prompt.length}`)
  console.log(`load_skill 工具: ${skillResult.tool ? skillResult.tool.name : 'null'}`)

  // 3. 完整装配（正确方式：getTools(whitelist, [load_skill])）
  const extraTools = skillResult.tool ? [skillResult.tool] : []
  const fullTools = await getTools(whitelist, extraTools)
  console.log(`\n=== 完整装配结果: ${fullTools.length} 个 ===`)
  for (const t of fullTools) {
    console.log(`  - ${t.name}`)
  }

  await prisma.$disconnect()
}

main()
