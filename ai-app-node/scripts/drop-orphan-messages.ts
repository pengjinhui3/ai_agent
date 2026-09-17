// 一次性：清除孤儿消息（父会话已软删、消息残留的记录——删除 API 只软删会话壳）
import { prisma } from '../src/db/client.js'

async function main() {
  const raw = await prisma.$queryRawUnsafe<Array<{ id: bigint; conversation_id: number; q: string }>>(
    `SELECT m.id, m.conversation_id, LEFT(m.question, 40) AS q FROM ai_message m
     WHERE NOT EXISTS (SELECT 1 FROM ai_conversation c WHERE c.id = m.conversation_id AND c.del_flag = '0')`
  )
  const list = raw.map(r => ({ id: Number(r.id), conv: r.conversation_id, q: r.q }))
  console.log('孤儿消息:', JSON.stringify(list))
  if (list.length) {
    await prisma.aiMessage.deleteMany({ where: { id: { in: list.map(x => x.id) } } })
    console.log('✓ 已删除', list.length, '条孤儿消息:', JSON.stringify(list.map(x => x.id)))
  }
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
