/**
 * 会话/消息服务（对应 Java 侧 ConversationService + MessageService）。
 */
import { prisma } from '../db/client'

/** 标题取首问前 10 字 */
function buildTitle(firstQuestion: string | null): string {
  if (!firstQuestion || !firstQuestion.trim()) return '新会话'
  const t = firstQuestion.trim()
  return t.length <= 10 ? t : t.substring(0, 10)
}

/** 按业务会话 ID 查会话（软删过滤） */
export async function findByConversationId(conversationId: string) {
  return prisma.aiConversation.findFirst({
    where: { conversationId, delFlag: '0' },
  })
}

/** 定位或创建会话（embedKey：嵌出链路的 app-key，新会话落 reserve2 做来源溯源与隔离） */
export async function locateOrCreate(appCode: string, query: string | null, conversationId: string | null, embedKey?: string) {
  if (conversationId) {
    const exist = await findByConversationId(conversationId)
    if (exist) return exist
  }
  return prisma.aiConversation.create({
    data: {
      appCode,
      conversationId: crypto.randomUUID(),
      title: buildTitle(query),
      ...(embedKey ? { reserve2: embedKey } : {}),
      createTime: new Date(),
      updateTime: new Date(),
    },
  })
}

/** 按应用编码查会话列表（最近在前，软删过滤） */
export async function listByAppCode(appCode: string) {
  return prisma.aiConversation.findMany({
    where: { appCode, delFlag: '0' },
    orderBy: { id: 'desc' },
  })
}

/** 按业务会话 ID 查全部消息（id 升序） */
export async function listMessages(businessConversationId: string) {
  const conv = await findByConversationId(businessConversationId)
  if (!conv) return []
  return prisma.aiMessage.findMany({
    where: { conversationId: conv.id },
    orderBy: { id: 'asc' },
  })
}

/** 落库消息 */
export async function saveMessage(params: {
  conversationPk: number
  messageId: string
  question: string
  contentBlocks: string
  answerPure: string
  toolCallsJson: string | null
  mediaJson: string | null
  attachments: string | null
  success: boolean
  errorMessage: string | null
}) {
  return prisma.aiMessage.create({
    data: {
      conversationId: params.conversationPk,
      messageId: params.messageId,
      question: params.question,
      contentBlocks: params.contentBlocks,
      answerPure: params.answerPure,
      toolCallsJson: params.toolCallsJson,
      mediaJson: params.mediaJson,
      attachments: params.attachments,
      success: params.success,
      errorMessage: params.errorMessage,
      createTime: new Date(),
    },
  })
}

/** 重命名会话 */
export async function rename(conversationId: string, title: string) {
  const t = title.trim()
  if (!t) throw new Error('会话名称不能为空')
  if (t.length > 40) throw new Error('会话名称过长（最多 40 字）')
  const conv = await findByConversationId(conversationId)
  if (!conv) throw new Error(`会话不存在 [${conversationId}]`)
  await prisma.aiConversation.update({
    where: { id: conv.id },
    data: { title: t, updateTime: new Date() },
  })
}

/** 删除会话（消息物理删 + 会话软删 + 附件清理） */
export async function deleteConversation(conversationId: string) {
  const conv = await findByConversationId(conversationId)
  if (!conv) throw new Error(`会话不存在 [${conversationId}]`)
  await prisma.aiMessage.deleteMany({ where: { conversationId: conv.id } })
  await prisma.aiConversation.update({
    where: { id: conv.id },
    data: { delFlag: '1' },
  })
  const { cleanupConversation } = await import('./attachment')
  cleanupConversation(conversationId)
}
