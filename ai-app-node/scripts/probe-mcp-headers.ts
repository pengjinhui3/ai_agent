// 一次性探针：验证 StreamableHTTPClientTransport 的 requestInit.headers 是否真进请求
// 用法：npx tsx scripts/probe-mcp-headers.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const URL_ = 'https://api.scrapingant.com/mcp'
const KEY = '5f4efc3d98164d9ab64e61bc1c530f84'

async function main() {
  const headers = { 'x-api-key': KEY }
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers },
  })
  const client = new Client({ name: 'probe-headers', version: '1.0.0' })

  console.log('① 连接中（带 x-api-key requestInit）...')
  await client.connect(transport)
  console.log('② 连接成功，拉工具列表...')
  const tools = await client.listTools()
  console.log(`③ 工具 ${tools.tools.length} 个:`, tools.tools.map(t => t.name).slice(0, 10).join(', '))

  // 找一个轻量工具调用（带 url 参数的那个）
  const scrape = tools.tools.find(t => /scrape|fetch|crawl|get/i.test(t.name))
  if (scrape) {
    console.log(`④ 调用 ${scrape.name}（真实请求验证鉴权）...`)
    try {
      const r = await client.callTool({ name: scrape.name, arguments: { url: 'https://example.com' } })
      const text = (r.content as Array<{ type: string; text?: string }>)?.map(b => b.text || '').join('').slice(0, 200)
      console.log('⑤ 调用成功（鉴权通过）:', text?.slice(0, 120) || '(空内容)')
    } catch (e) {
      console.log('⑤ 调用失败:', e instanceof Error ? e.message : e)
    }
  }
  await client.close()
}

main().catch(e => { console.error('探针失败:', e); process.exit(1) })
