/** 探针：验证 builtin_datetime_calc 停用后 getBuiltinTools 是否过滤 */
import 'dotenv/config'
import { getBuiltinTools } from './src/tools/builtin/index'

const tools = await getBuiltinTools()
console.log('启用的内置工具:', tools.map(t => t.name).join(', '))
console.log('datetime_calc 被过滤:', tools.some(t => t.name === 'builtin_datetime_calc') ? '❌ 仍存在' : '✅ 已过滤')
process.exit(0)
