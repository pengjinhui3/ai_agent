// 一次性：删除 ai_builtin_tool 表的 create_skill / ack_user 行（剧本附属工具退表，与 load_skill 同款内部资产）
// - create_skill：skill-craft 剧本专用 sink——工厂构造进 extraTools 直通挂载，不依赖表行
// - ack_user：07_1 平台确认能力——context.ts ⑦ 每轮 extraTools 显式传入，表行冗余
// 退表后：checkModeDeps 对无行工具按"默认启用"放行（与 getBuiltinToolSelection 同语义），校验只对表管工具生效
import { prisma } from '../src/db/client.js'

async function main() {
  const r = await prisma.aiBuiltinTool.deleteMany({ where: { toolCode: { in: ['create_skill', 'ack_user'] } } })
  console.log('✓ 删除附属工具表行 count=' + r.count)
  const rest = await prisma.aiBuiltinTool.findMany({ where: { delFlag: '0' }, select: { toolCode: true, required: true } })
  console.log('剩余内置工具（全部为常规平台能力）:', JSON.stringify(rest))
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
