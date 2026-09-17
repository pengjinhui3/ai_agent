/**
 * 探针：验证 maxOutputTokens 在两种协议下是否真的进入请求体。
 * openai 协议（@ai-sdk/deepseek）→ 请求体应含 max_tokens；
 * 不写死结论，拦截 fetch 看原始 body。
 */
import 'dotenv/config'
import { streamText } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { prisma } from './src/db/client'

async function main() {
  const provider = await prisma.aiProvider.findUnique({ where: { providerCode: 'hz-glm-openai' } })
  if (!provider) { console.error('厂商不存在'); process.exit(1) }
  const baseURL = provider.baseUrl.replace(/\/+$/, '') + '/v1'

  let capturedBody: any = null
  const deepseek = createDeepSeek({
    apiKey: provider.apiKey, baseURL,
    fetch: async (url: any, init?: any) => {
      try { capturedBody = JSON.parse(init?.body) } catch { capturedBody = null }
      console.log('>> URL:', String(url))
      console.log('>> BODY keys:', capturedBody ? Object.keys(capturedBody).join(', ') : '(parse fail)')
      console.log('>> max_tokens in body:', capturedBody?.max_tokens ?? '(absent)')
      return fetch(url, init)
    },
  })

  const result = streamText({
    model: deepseek.chat('deepseek-v4-pro'),
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 1234,
  })
  for await (const _ of result.fullStream) { /* drain */ }
  console.log('---')
  console.log('结论：maxOutputTokens=1234 →', capturedBody?.max_tokens === 1234
    ? '✅ 正确映射为请求体 max_tokens'
    : `❌ 未映射（body.max_tokens=${capturedBody?.max_tokens}）`)

  await prisma.$disconnect()
}

main()
