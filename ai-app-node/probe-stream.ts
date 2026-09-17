/**
 * 最小 streamText 探针：定位 "Cannot read properties of undefined (reading 'typeName')" 的来源。
 */
import 'dotenv/config'
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { prisma } from './src/db/client'

async function main() {
  // 读真实厂商配置
  const provider = await prisma.aiProvider.findUnique({ where: { providerCode: 'hz-glm-openai' } })
  if (!provider) { console.error('厂商不存在'); process.exit(1) }

  console.log('provider:', provider.providerCode, '| baseUrl:', provider.baseUrl, '| protocol:', provider.protocol)

  const baseURL = provider.baseUrl.endsWith('#')
    ? provider.baseUrl.slice(0, -1)
    : provider.baseUrl.replace(/\/+$/, '') + '/v1'
  console.log('normalized baseURL:', baseURL)

  const openai = createOpenAI({ apiKey: provider.apiKey, baseURL })
  const model = openai('deepseek-v4-pro')

  console.log('model:', JSON.stringify({
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
  }))

  // 最小 streamText（无 tools / 无 providerOptions / 无 system）
  try {
    const result = streamText({
      model,
      messages: [{ role: 'user', content: '1+1=? reply with just the number' }],
    })
    let text = ''
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.textDelta
      if (part.type === 'error') console.error('stream error:', part.error)
    }
    console.log('✅ streamText OK, reply:', text || '(empty)')
  } catch (e) {
    console.error('❌ streamText failed:', e?.message)
    console.error('stack:', e?.stack?.split('\n').slice(0, 5).join('\n'))
  }

  await prisma.$disconnect()
}

main()
