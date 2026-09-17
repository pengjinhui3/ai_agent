// 一次性探针：走 registry 完整链路（DB 读→parseHeaders→connect→callTool）
// 定位：SDK 直连同（probe-mcp-headers ✓），应用链路是否 headers 丢失
// 用法：npx tsx scripts/probe-registry.ts
import { getMcpTools, evictMcp } from '../src/tools/mcp/registry.js'

async function main() {
  evictMcp()   // 清缓存强制全量重建（模拟重启后的首次装配）
  console.log('① evict 完成，走 registry 全流程加载工具...')
  const tools = await getMcpTools()
  console.log(`② 共 ${tools.length} 个 MCP 工具`)
  const scrape = tools.find(t => /web_page|scrape/i.test(t.name))
  if (!scrape) {
    console.log('② 没找到 scrapingant 工具（服务未启用或连接失败）')
    return
  }
  console.log(`③ 调用 ${scrape.name}（registry 链路真实调用）...`)
  const r = await scrape.execute({ url: 'https://example.com' })
  const text = typeof r === 'string' ? r : JSON.stringify(r)
  console.log(`④ 结果（前 150 字）: ${text.slice(0, 150)}`)
  console.log(text.includes('Missing API Key') ? '⑤ ❌ 仍缺 key——registry 层复现！' : '⑤ ✓ 鉴权通过——registry 层正常')
}

main().catch(e => { console.error('探针失败:', e); process.exit(1) })
