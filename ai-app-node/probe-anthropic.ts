/**
 * Anthropic 最小探针：隔离 GLM 网关 anthropic 端点的 streamText 行为。
 */
import 'dotenv/config'
import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { prisma } from './src/db/client'

async function main() {
  const provider = await prisma.aiProvider.findUnique({ where: { providerCode: 'my-gateway' } })
  if (!provider) { console.error('厂商不存在'); process.exit(1) }

  console.log('baseUrl:', provider.baseUrl, '| apiKey:', provider.apiKey.substring(0, 10) + '...')

  // 方案 A：标准 createAnthropic
  // const anthropic = createAnthropic({ apiKey: provider.apiKey, baseURL: provider.baseUrl })

  // 方案 B：显式 headers + fetch 拦截看请求
  const baseURL = provider.baseUrl.endsWith('#')
    ? provider.baseUrl.slice(0, -1)
    : provider.baseUrl.replace(/\/+$/, '') + '/v1'
  console.log('normalized baseURL:', baseURL)

  const anthropic = createAnthropic({
    apiKey: provider.apiKey,
    baseURL,
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    fetch: async (url: any, init?: any) => {
      console.log('>> REQUEST:', init?.method, String(url))
      const safeHeaders = Object.fromEntries(
        Object.entries(init?.headers || {}).filter(([k]: [string]) => !k.toLowerCase().includes('key'))
      )
      console.log('>> HEADERS:', JSON.stringify(safeHeaders))
      console.log('>> BODY:', String(init?.body || '').substring(0, 200))
      const resp = await fetch(url, init)
      console.log('<< STATUS:', resp.status, resp.headers.get('content-type'))
      return resp
    },
  })
  const model = anthropic('GLM-5.3', { maxTokens: 2048 })

  console.log('model:', JSON.stringify({ provider: (model as any).provider, modelId: (model as any).modelId }))

  try {
    const result = streamText({
      model,
      messages: [{ role: 'user', content: '1+1=? just the number' }],
      maxTokens: 2048,
    })

    let text = ''
    let reasoning = ''
    let hasFinish = false
    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        console.error('  ERROR part:', JSON.stringify(part, null, 2))
      } else {
        console.log('  part:', part.type)
      }
      if (part.type === 'text-delta') text += part.text
      if (part.type === 'reasoning-delta') reasoning += (part as any).delta || (part as any).text || ''
      if (part.type === 'finish') hasFinish = true
    }
    console.log(`✅ text="${text}" reasoning=${reasoning.length}字 hasFinish=${hasFinish}`)
  } catch (e: any) {
    console.error('❌ failed:', e?.message)
    console.error('cause:', e?.cause?.message || e?.cause)
  }

  await prisma.$disconnect()
}

main()
