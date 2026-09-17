/**
 * 探针：验证 hz 网关 Chat Completions 是否返回 reasoning_content，
 * 以及 AI SDK openai.chat() 是否捕获它。
 */
import 'dotenv/config'
import { streamText } from 'ai'
import { getProvider } from './src/llm/provider'
import { prisma } from './src/db/client'

async function main() {
  // 1. 原始 fetch 检查 hz 网关是否返回 reasoning_content
  const provider = await prisma.aiProvider.findUnique({ where: { providerCode: 'hz-glm-openai' } })
  if (!provider) { console.error('厂商不存在'); process.exit(1) }

  const baseUrl = provider.baseUrl.replace(/\/+$/, '') + '/v1'
  console.log('=== 1. 原始 fetch（看网关是否返回 reasoning_content）===')
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '1+1=? think briefly' }],
      stream: true,
      reasoning_effort: 'low',
    }),
  })
  console.log('HTTP status:', resp.status)
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let reasoningChunks = 0
  let contentChunks = 0
  let firstReasoning = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      try {
        const json = JSON.parse(line.slice(6))
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) {
          reasoningChunks++
          if (!firstReasoning) firstReasoning = delta.reasoning_content
        }
        if (delta?.content) contentChunks++
      } catch {}
    }
  }
  console.log(`reasoning_content chunks: ${reasoningChunks}`)
  console.log(`content chunks: ${contentChunks}`)
  console.log(`first reasoning: "${firstReasoning?.substring(0, 50)}"`)

  // 2. @ai-sdk/deepseek 的 createDeepSeek（看能否捕获 reasoning_content）
  console.log('\n=== 2. @ai-sdk/deepseek createDeepSeek() ===')
  const { createDeepSeek } = await import('@ai-sdk/deepseek')
  const deepseek = createDeepSeek({ apiKey: provider.apiKey, baseURL: baseUrl })
  const dsModel = deepseek.chat('deepseek-v4-pro')
  const dsResult = streamText({
    model: dsModel,
    messages: [{ role: 'user', content: '1+1=? think briefly' }],
  })
  let dsReasoningParts = 0
  let dsTextParts = 0
  let dsReasoningText = ''
  let dsText = ''
  for await (const part of dsResult.fullStream) {
    if (part.type === 'reasoning-delta') {
      dsReasoningParts++
      dsReasoningText += part.text || ''
    } else if (part.type === 'text-delta') {
      dsTextParts++
      dsText += part.text || ''
    }
  }
  console.log(`reasoning-delta parts: ${dsReasoningParts}`)
  console.log(`text-delta parts: ${dsTextParts}`)
  console.log(`reasoning: "${dsReasoningText?.substring(0, 60)}"`)
  console.log(`text: "${dsText}"`)

  await prisma.$disconnect()
}

main()
