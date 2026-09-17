// 一次性：ai_message.tool_calls_json 扩容 text(64KB) → mediumtext(16MB)
// 背景（15 号联测）：技能工坊流程的工具调用记录（create_skill 的技能全文参数 / 大草稿 ack 选项）
// 超过 64KB 导致 prisma.aiMessage.create() 报 "too long for the column's type"
// 修法选择扩容而非截断：14 号 query_tool_calls 回查依赖原始数据完整性
import { prisma } from '../src/db/client.js'

async function main() {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE ai_message MODIFY COLUMN tool_calls_json MEDIUMTEXT NULL COMMENT '工具调用记录 JSON（名称/参数/结果/耗时）——15 号起技能全文与草稿类参数较大，扩为 mediumtext 防超长'"
  )
  const rows = await prisma.$queryRawUnsafe<Array<{ COLUMN_TYPE: string }>>(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ai_app' AND TABLE_NAME='ai_message' AND COLUMN_NAME='tool_calls_json'"
  )
  console.log('✓ tool_calls_json 现为:', rows[0]?.COLUMN_TYPE)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
