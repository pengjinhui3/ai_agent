/**
 * 探针：用项目同款 @modelcontextprotocol/sdk 的 StreamableHTTPClientTransport
 * 连接 mcpmarket 天气服务，复现面板 404 并定位（对照手动 curl 是通的）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const URL_ = 'https://mcpmarket.cn/mcp/5232a8fc1eace0794b49dd03'

async function main() {
  const client = new Client({ name: 'ai-app-probe', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { 'x-api-key': '' } },
  })
  try {
    await client.connect(transport)
    console.log('✅ connect OK')
    const tools = await client.listTools()
    console.log('✅ tools:', tools.tools.map(t => t.name).join(', '))
  } catch (e: any) {
    console.error('❌ failed:', e?.message)
    console.error('cause:', e?.cause?.message || e?.cause)
    console.error('body:', typeof e?.body === 'object' ? JSON.stringify(e?.body).substring(0, 300) : e?.body)
  } finally {
    await client.close().catch(() => {})
  }
}

main()
