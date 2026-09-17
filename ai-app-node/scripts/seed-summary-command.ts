// 一次性：追加 session-summary 系统指令入口行（会话总结）
import { prisma } from '../src/db/client.js'

async function main() {
  const exist = await prisma.aiAtCommand.findFirst({ where: { triggerCode: 'session-summary' } })
  if (exist) {
    await prisma.aiAtCommand.update({
      where: { id: exist.id },
      data: { label: '会话总结', description: '总结当前会话并导出 markdown 文件（将使用记忆回查与文件导出工具）', enabled: true, updateTime: new Date() },
    })
    console.log('✓ 更新 session-summary')
  } else {
    await prisma.aiAtCommand.create({
      data: {
        triggerCode: 'session-summary', label: '会话总结',
        description: '总结当前会话并导出 markdown 文件（将使用记忆回查与文件导出工具）',
        targetType: 'mode', targetCode: 'session-summary', sort: 2, enabled: true, delFlag: '0',
        createTime: new Date(), updateTime: new Date(),
      },
    })
    console.log('✓ 新增 session-summary')
  }
  const all = await prisma.aiAtCommand.findMany({ where: { delFlag: '0' }, select: { triggerCode: true, label: true, enabled: true } })
  console.log('指令表现状:', JSON.stringify(all))
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
