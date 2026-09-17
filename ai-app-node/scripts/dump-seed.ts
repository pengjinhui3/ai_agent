// 一次性：导出服务器部署用基础数据（11 张配置表 → INSERT SQL）
// v2 修正：用原生 SQL 查询（$queryRawUnsafe）——返回 DB 真实列名（下划线），
//          v1 用 Prisma findMany 导出驼峰字段名导致导入报 Unknown column
// 用法：npx tsx scripts/dump-seed.ts > seed.sql
import { prisma } from '../src/db/client.js'

const TABLES = [
  'ai_provider', 'ai_model', 'ai_sys_config', 'ai_dict_type', 'ai_dict_data',
  'ai_builtin_tool', 'ai_skill', 'ai_at_command', 'ai_mcp_server', 'ai_app', 'ai_app_key',
]

type Row = Record<string, unknown>

function esc(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'boolean' ? (v ? '1' : '0') : String(v)
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
}

async function main() {
  console.log('SET NAMES utf8mb4;')
  console.log('SET FOREIGN_KEY_CHECKS = 0;')
  for (const t of TABLES) {
    const rows = (await prisma.$queryRawUnsafe(`SELECT * FROM ${t} ORDER BY 1`)) as Row[]
    if (!rows.length) { console.log(`-- ${t}: 0 行，跳过`); continue }
    for (const r of rows) {
      const cols = Object.keys(r)
      const vals = cols.map(c => esc(r[c]))
      console.log(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${vals.join(', ')});`)
    }
    console.log(`-- ${t}: ${rows.length} 行`)
  }
  console.log('SET FOREIGN_KEY_CHECKS = 1;')
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
