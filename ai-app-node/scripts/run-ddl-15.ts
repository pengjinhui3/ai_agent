// 一次性：执行 15 号 DDL（ai_at_command 表 + ai_conversation.mode + 初始数据）
// Prisma $executeRawUnsafe 逐条执行（项目惯例：DDL 真源在 SQL 文件，Prisma 只做运行时类型映射）
import { prisma } from '../src/db/client.js'
import fs from 'node:fs'

async function main() {
  const raw = fs.readFileSync(new URL('./ddl-15-at-command.sql', import.meta.url), 'utf8')
  // 去注释行后按分号拆条（COMMENT 字符串里不含分号，安全）
  const stmts = raw.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(s => s.length > 0)
  for (const s of stmts) {
    await prisma.$executeRawUnsafe(s)
    console.log('✓', s.slice(0, 60).replace(/\n/g, ' '), '...')
  }
  // 验证
  const tables = await prisma.$queryRawUnsafe("SHOW TABLES LIKE 'ai_at_command'")
  const cols = await prisma.$queryRawUnsafe("SHOW COLUMNS FROM ai_conversation LIKE 'mode'")
  const rows = await prisma.$queryRawUnsafe("SELECT trigger_code, target_type, enabled FROM ai_at_command")
  const meta = await prisma.$queryRawUnsafe("SELECT skill_code, skill_type, CHAR_LENGTH(content) AS len FROM ai_skill WHERE skill_code = 'meta-skill'")
  console.log('表存在:', tables.length === 1, '| mode 列:', cols.length === 1)
  console.log('指令行:', JSON.stringify(rows), '| meta-skill:', JSON.stringify(meta))
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
