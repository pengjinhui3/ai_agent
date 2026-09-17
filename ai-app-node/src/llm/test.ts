/**
 * 模块职责：模型连通性测试。
 *
 * 按 id 读取 ai_model 及其厂商配置，构建 provider 后用 Vercel AI SDK 的
 * streamText 发送 "你好" 验证连通；测试通过自动把 ai_model.enabled 置为 true，
 * 失败抛出 Error（消息透传给前端展示）。
 */
import { streamText } from 'ai'
import { prisma } from '../db/client'
import { getProvider } from './provider'

/**
 * 测试指定模型是否可用。
 * 成功：返回 { reply }（模型回复全文），并自动启用该模型（enabled=true）。
 * 失败：抛 Error，message 为可透传前端展示的原因。
 */
export async function testModel(modelId: number): Promise<{ reply: string }> {
  const model = await prisma.aiModel.findUnique({ where: { id: modelId } })
  if (!model || model.delFlag === '1') {
    throw new Error(`模型不存在：id=${modelId}`)
  }

  const provider = await getProvider(model.providerCode)

  let reply: string
  try {
    const result = streamText({
      model: provider(model.modelCode),
      prompt: '你好',
    })
    // await result.text 会消费完整个流；流中报错（401/超时/超限等）在此 reject
    reply = (await result.text).trim()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }

  if (!reply) {
    throw new Error(`模型 ${model.modelCode} 返回内容为空`)
  }

  // 测试通过自动启用（updateTime 由本侧维护，schema 未用 @updatedAt）
  await prisma.aiModel.update({
    where: { id: modelId },
    data: { enabled: true, updateTime: new Date() },
  })

  return { reply }
}
