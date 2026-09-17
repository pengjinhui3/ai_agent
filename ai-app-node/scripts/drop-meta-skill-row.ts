// 一次性：删除 ai_skill 表的 meta-skill 行（剧本附属技能改为代码常量，不入表——与 load_skill 同款内部资产）
import { prisma } from '../src/db/client.js'

async function main() {
  const r = await prisma.aiSkill.deleteMany({ where: { skillCode: 'meta-skill' } })
  console.log('✓ 已删除 meta-skill 表行（count=' + r.count + '）——附属技能现为代码常量（modes.ts inlineSkills）')
  const rest = await prisma.aiSkill.findMany({ where: { delFlag: '0' }, select: { skillCode: true, skillType: true } })
  console.log('剩余技能:', JSON.stringify(rest))
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
