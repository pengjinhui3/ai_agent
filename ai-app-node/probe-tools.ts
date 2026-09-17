/**
 * 诊断探针：记录 fullStream 全部事件类型，定位工具后正文缺失。
 */
import 'dotenv/config'
import { streamText } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { prisma } from './src/db/client'

async function main() {
  const provider = await prisma.aiProvider.findUnique({ where: { providerCode: 'hz-glm-openai' } })
  if (!provider) { console.error('厂商不存在'); process.exit(1) }
  const baseURL = provider.baseUrl.replace(/\/+$/, '') + '/v1'
  const deepseek = createDeepSeek({ apiKey: provider.apiKey, baseURL })
  const model = deepseek.chat('deepseek-v4-pro')

  const result = streamText({
    model,
    messages: [{ role: 'user', content: '现在几点了？简短回答' }],
    tools: {
      builtin_current_time: {
        description: '获取当前日期时间',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { timezone: { type: 'string' } },
          required: [],
        },
        execute: async () => {
          const now = new Date()
          return `当前时间：${now.toLocaleString('zh-CN')}`
        },
      },
    },
    maxSteps: 8,
  })

  for await (const part of result.fullStream) {
    const ts = new Date().toISOString().substring(11, 23)
    switch (part.type) {
      case 'text-delta':
        console.log(`[${ts}] TEXT-DELTA: "${part.text}"`)
        break
      case 'reasoning-delta':
        console.log(`[${ts}] REASONING: "${(part.text || '').substring(0, 30)}"`)
        break
      case 'tool-call':
        console.log(`[${ts}] TOOL-CALL: ${part.toolName} input=${JSON.stringify(part.input)}`)
        break
      case 'tool-result': {
        const out = (part as any).output ?? (part as any).result
        console.log(`[${ts}] TOOL-RESULT: ${String(out).substring(0, 60)}`)
        break
      }
      case 'step-start':
        console.log(`[${ts}] STEP-START`)
        break
      case 'step-finish':
        console.log(`[${ts}] STEP-FINISH finishReason=${(part as any).finishReason} text="${String((part as any).text || '').substring(0, 50)}"`)
        break
      case 'finish':
        console.log(`[${ts}] FINISH finishReason=${(part as any).finishReason} totalSteps=${(part as any).totalSteps}`)
        break
      case 'error':
        console.log(`[${ts}] ERROR: ${JSON.stringify(part.error).substring(0, 100)}`)
        break
      default:
        console.log(`[${ts}] ${part.type.toUpperCase()}`)
    }
  }
  console.log('--- stream ended ---')
  console.log('result.text:', JSON.stringify(await result.text).substring(0, 100))

  await prisma.$disconnect()
}

main()
