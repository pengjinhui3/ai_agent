/**
 * 应用嵌出 embed 端点组（16 方案：app-key 授权 + widget 嵌入）。
 *
 * 鉴权模型（防君子，见 16 方案 §六）：
 *   - appKey 存在 / enabled / 未过期 / 未软删
 *   - 域名白名单只在 config 端点校验（widget.js 请求 Origin=宿主页）；
 *     iframe 内 API 与平台同源不校验——嵌入页由 CSP frame-ancestors 白名单保护（main 挂载时按需）
 *   - 每日配额：内存计数（单进程；appKey+日期），超限 429
 *
 * 端点：
 *   GET  /embed/config?key=xxx                    widget init 校验 + 应用信息
 *   POST /embed/chat                              对话 SSE（复用 chat() 编排，会话落 reserve2=appKey）
 *   GET  /embed/conversations?key=xxx             嵌入会话列表（reserve2=appKey 隔离）
 *   GET  /embed/conversations/:id/messages?key=    消息回放（校验会话归属）
 *   （ack 续跑复用原 /apps/:appCode/chat/:messageId/ack：taskId 匹配保护足够，嵌入页从 config 拿 appCode）
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { prisma } from '../db/client'
import { chat, type ChatRequest } from '../agent/loop'

export const embedRoutes = new Hono()

// config 校验由 widget.js 在宿主页（跨域：第三方站点 / file://）发起 fetch，
// 必须开放 CORS 才能渲染悬浮球（生产环境 Hono 直接 serve 时；dev 下 Vite 默认已开放）。
// 对话/会话等其余端点由 iframe 内同域嵌入页调用，无需 CORS。
embedRoutes.use('/config', cors({ origin: '*' }))

// ---------- 鉴权与配额 ----------

/** 内存配额计数：appKey+日期 → 已用次数（单进程；重启清零可接受——嵌入级粗限流） */
const quotaCounter = new Map<string, number>()

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

interface AppKeyRecord {
  id: number
  appKey: string
  appCode: string
  name: string
  domains: string | null
  dailyQuota: number | null
}

/** 校验 appKey 合法性（存在/启用/未过期/未删）→ 记录或 null */
async function loadKey(appKey: string): Promise<AppKeyRecord | null> {
  if (!appKey || !appKey.startsWith('sk_emb_')) return null
  const rec = await prisma.aiAppKey.findFirst({
    where: { appKey, enabled: true, delFlag: '0' },
    select: { id: true, appKey: true, appCode: true, name: true, domains: true, dailyQuota: true, expireTime: true },
  })
  if (!rec) return null
  if (rec.expireTime && rec.expireTime.getTime() < Date.now()) return null
  return rec as AppKeyRecord
}

/** 域名白名单校验（Origin/Referer 命中即通过；白名单空=不限） */
function checkDomains(rec: AppKeyRecord, origin: string | null, referer: string | null): boolean {
  if (!rec.domains) return true
  try {
    const list: string[] = JSON.parse(rec.domains)
    if (!Array.isArray(list) || list.length === 0) return true
    const source = origin || (referer ? new URL(referer).origin : '')
    if (!source) return false   // 有白名单但请求无来源信息 → 拒绝
    return list.includes(source)
  } catch { return true }   // 白名单脏数据不拦截
}

/** 每日配额：超限返回 false */
function checkQuota(rec: AppKeyRecord): boolean {
  if (!rec.dailyQuota || rec.dailyQuota <= 0) return true
  const k = `${rec.appKey}:${todayKey()}`
  return (quotaCounter.get(k) || 0) < rec.dailyQuota
}

function incrQuota(rec: AppKeyRecord): void {
  const k = `${rec.appKey}:${todayKey()}`
  quotaCounter.set(k, (quotaCounter.get(k) || 0) + 1)
}

// ---------- widget init：key 校验 + 应用信息 ----------

embedRoutes.get('/config', async (c) => {
  const appKey = c.req.query('key') || ''
  const rec = await loadKey(appKey)
  if (!rec) return c.json({ legal: false, reason: 'invalid' })
  const origin = c.req.header('origin')
  const referer = c.req.header('referer')
  if (!checkDomains(rec, origin, referer)) return c.json({ legal: false, reason: 'domain' })
  if (!checkQuota(rec)) return c.json({ legal: false, reason: 'quota' })
  const app = await prisma.aiApp.findFirst({
    where: { appCode: rec.appCode, delFlag: '0' },
    select: { appCode: true, name: true, model: { select: { modelCode: true, name: true } } },
  })
  if (!app) return c.json({ legal: false, reason: 'app' })
  return c.json({
    legal: true,
    appCode: app.appCode,
    appName: app.name,
    modelLabel: app.model?.name || app.model?.modelCode || '',
  })
})

// ---------- 对话（SSE，复用 chat() 编排） ----------

embedRoutes.post('/chat', async (c) => {
  const body: any = await c.req.json().catch((): null => null)
  const appKey = String(body?.appKey || '')
  const rec = await loadKey(appKey)
  if (!rec) return c.json({ error: 'app-key 无效或已吊销' }, 401)
  if (!checkQuota(rec)) return c.json({ error: '今日调用配额已用完' }, 429)
  if (!String(body?.query || '').trim() && !Array.isArray(body?.attachments) ) {
    return c.json({ error: 'query 与附件不能同时为空' }, 400)
  }

  // 会话归属校验：续传的 conversationId 必须属于该 app-key（reserve2）
  // ——防跨密钥越权续聊（A 拿到 B 的会话 ID 也无法在其上继续对话）
  let conversationId: string | undefined
  if (body.conversationId) {
    const conv = await prisma.aiConversation.findFirst({
      where: { conversationId: String(body.conversationId), reserve2: appKey, delFlag: '0' },
      select: { id: true },
    })
    if (!conv) return c.json({ error: '会话不存在或不属于该 app-key' }, 403)
    conversationId = String(body.conversationId)
  }

  incrQuota(rec)
  const req: ChatRequest = {
    query: String(body.query || ''),
    conversationId,
    attachments: body.attachments || undefined,
    embedKey: appKey,   // 会话落 reserve2=appKey（来源溯源 + 嵌入会话隔离）
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const evt of chat(rec.appCode, req, c.req.raw.signal)) {
        await stream.writeSSE({ data: JSON.stringify(evt) })
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ERROR', content: e?.message || '流式异常' }) }) } catch { /* 连接已断 */ }
      }
    }
  })
})

// ---------- 嵌入会话列表（reserve2=appKey 隔离，最近在前） ----------

embedRoutes.get('/conversations', async (c) => {
  const appKey = c.req.query('key') || ''
  const rec = await loadKey(appKey)
  if (!rec) return c.json({ error: 'app-key 无效或已吊销' }, 401)
  const list = await prisma.aiConversation.findMany({
    where: { appCode: rec.appCode, reserve2: appKey, delFlag: '0' },
    orderBy: { updateTime: 'desc' },
    select: { conversationId: true, title: true, updateTime: true },
    take: 50,
  })
  return c.json({ conversations: list })
})

// ---------- 消息回放（校验会话归属该 appKey） ----------

embedRoutes.get('/conversations/:conversationId/messages', async (c) => {
  const appKey = c.req.query('key') || ''
  const rec = await loadKey(appKey)
  if (!rec) return c.json({ error: 'app-key 无效或已吊销' }, 401)
  const conv = await prisma.aiConversation.findFirst({
    where: { conversationId: c.req.param('conversationId'), reserve2: appKey, delFlag: '0' },
  })
  if (!conv) return c.json({ error: '会话不存在或不属于该 app-key' }, 404)
  const msgs = await prisma.aiMessage.findMany({
    where: { conversationId: conv.id }, orderBy: { id: 'asc' },
  })
  return c.json({ messages: msgs.map(m => ({
    messageId: m.messageId, question: m.question,
    contentBlocks: m.contentBlocks ? JSON.parse(m.contentBlocks) : null,
    answerPure: m.answerPure, toolCallsJson: m.toolCallsJson,
    mediaJson: m.mediaJson, attachments: m.attachments,
    success: m.success, errorMessage: m.errorMessage, createTime: m.createTime,
  })) })
})
