/**
 * 全量 CRUD 路由（批次 2）：厂商/模型/应用/会话/消息/Skill/MCP/字典/系统配置/内置工具。
 * 接口契约与 Java 版一一对应（前端零适配）。
 */
import { Hono } from 'hono'
import { prisma } from '../db/client'

export const serverRoutes = new Hono()

// ---------- 生产环境平台配置锁定（辉哥 2026-09-17 需求）----------
// NODE_ENV=production 时，系统设置中的「动态参数（system-config）」与「字典（dicts）」
// 的写操作全部拒绝（403）——防止试用人员改动平台级配置；dev 环境零影响。
// 用户侧行为（对话/会话管理/技能沉淀/KB 上传）不受限。
const IS_PROD = process.env.NODE_ENV === 'production'
const PROD_LOCKED_PREFIXES = ['/system-config', '/dicts']

serverRoutes.use(async (c, next) => {
  if (IS_PROD) {
    const method = c.req.method
    const path = c.req.path
    const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE'
    if (isWrite && PROD_LOCKED_PREFIXES.some(p => path.includes(p))) {
      return c.json({ error: '生产环境已锁定平台配置（动态参数与字典只读）——修改请联系管理员' }, 403)
    }
  }
  await next()
})

// ---------- 工具函数 ----------

const ok = (data: Record<string, unknown>) => data
const err = (msg: string, status = 400): never => {
  throw new HTTPError(msg, status)
}

class HTTPError extends Error {
  constructor(msg: string, public status: number) { super(msg) }
}

serverRoutes.onError((e, c) => {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status as any)
  console.error('[API]', e)
  return c.json({ error: e?.message || '服务内部错误' }, 500)
})

const maskKey = (key: string) => key.length <= 6 ? '***' : key.substring(0, 6) + '***'

// ---------- 厂商 ----------

serverRoutes.get('/providers', async (c) => {
  const list = await prisma.aiProvider.findMany({ where: { delFlag: '0' } })
  return c.json({ providers: list.map(p => ({
    id: p.id, providerCode: p.providerCode, name: p.name, protocol: p.protocol,
    baseUrl: p.baseUrl, apiKeyMasked: maskKey(p.apiKey), maxTokens: p.maxTokens,
    enabled: p.enabled, modelCount: null as number | null,
  })) })
})

serverRoutes.post('/providers', async (c) => {
  const b = await c.req.json()
  if (!b.providerCode?.trim()) err('厂商编码 provider-code 必填')
  if (!b.baseUrl?.trim()) err('厂商缺少 base-url')
  if (!b.apiKey?.trim()) err('厂商缺少 api-key')
  const exist = await prisma.aiProvider.findFirst({ where: { providerCode: b.providerCode, delFlag: '0' } })
  if (exist) err(`厂商编码 [${b.providerCode}] 已存在`)
  const p = await prisma.aiProvider.create({
    data: { providerCode: b.providerCode, name: b.name || b.providerCode, protocol: b.protocol || 'openai',
      baseUrl: b.baseUrl, apiKey: b.apiKey, maxTokens: b.maxTokens ?? null, enabled: b.enabled ?? true,
      createTime: new Date(), updateTime: new Date() },
  })
  return c.json({ id: p.id, providerCode: p.providerCode })
})

serverRoutes.put('/providers/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiProvider.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`厂商不存在 id=${id}`)
  await prisma.aiProvider.update({
    where: { id },
    data: {
      name: b.name ?? exist.name, baseUrl: b.baseUrl ?? exist.baseUrl,
      apiKey: b.apiKey?.trim() && !b.apiKey.includes('***') ? b.apiKey : exist.apiKey,
      maxTokens: b.maxTokens ?? exist.maxTokens, updateTime: new Date(),
    },
  })
  return c.json({ id })
})

serverRoutes.delete('/providers/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiProvider.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`厂商不存在 id=${id}`)
  const count = await prisma.aiModel.count({ where: { providerCode: exist.providerCode, delFlag: '0' } })
  if (count > 0) err(`厂商 [${exist.providerCode}] 仍有 ${count} 个模型引用（如 ${count}），请先删除模型`, 409)
  await prisma.aiProvider.update({ where: { id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

serverRoutes.post('/providers/:id/enabled', async (c) => {
  const id = Number(c.req.param('id'))
  const value = c.req.query('value') !== 'false'
  const exist = await prisma.aiProvider.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`厂商不存在 id=${id}`)
  if (value) {
    const cnt = await prisma.aiModel.count({ where: { providerCode: exist.providerCode, enabled: true, delFlag: '0' } })
    if (cnt === 0) err(`厂商 [${exist.name}] 下没有测试通过的模型——请先在模型列表点「测试并启用」`)
  }
  await prisma.aiProvider.update({ where: { id }, data: { enabled: value, updateTime: new Date() } })
  return c.json({ providerCode: exist.providerCode, enabled: value })
})

// ---------- 模型 ----------

serverRoutes.get('/models', async (c) => {
  const providerCode = c.req.query('providerCode')
  const list = await prisma.aiModel.findMany({
    where: { delFlag: '0', ...(providerCode && { providerCode }) },
  })
  return c.json({ models: list })
})

serverRoutes.post('/models', async (c) => {
  const b = await c.req.json()
  if (!b.modelCode?.trim()) err('模型编码 model-code 必填')
  if (!b.providerCode?.trim()) err(`模型 [${b.modelCode}] 缺少所属厂商 provider-code`)
  const p = await prisma.aiProvider.findFirst({ where: { providerCode: b.providerCode, delFlag: '0' } })
  if (!p) err(`模型引用的厂商 [${b.providerCode}] 不存在`)
  const dup = await prisma.aiModel.findFirst({ where: { providerCode: b.providerCode, modelCode: b.modelCode, delFlag: '0' } })
  if (dup) err(`厂商 [${b.providerCode}] 下模型编码 [${b.modelCode}] 已存在`)
  const m = await prisma.aiModel.create({
    data: { modelCode: b.modelCode, name: b.name || b.modelCode, providerCode: b.providerCode,
      thinkingEffort: b.thinkingEffort || null, enabled: false,
      createTime: new Date(), updateTime: new Date() },
  })
  return c.json(m)
})

serverRoutes.put('/models/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiModel.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`模型不存在 id=${id}`)
  // 启停规则：false→true 拒绝（走测试）；true→false 校验应用引用
  if (b.enabled === true && !exist.enabled) err(`模型 [${exist.modelCode}] 处于停用状态：请通过「测试并启用」验证连通后启用`)
  if (b.enabled === false && exist.enabled) {
    const refs = await prisma.aiApp.findMany({ where: { modelId: id, delFlag: '0' } })
    if (refs.length) err(`模型 [${exist.modelCode}] 仍被 ${refs.length} 个应用引用（如 ${refs[0].name}-${refs[0].appCode}），请先删除或改绑应用`, 409)
    const base = await prisma.aiSysConfig.findFirst({ where: { configKey: 'base_model_id', delFlag: '0' } })
    if (base?.configValue === String(id)) err(`模型 [${exist.modelCode}] 已被系统基础设置引用为基础模型，请先更换基础模型`, 409)
  }
  await prisma.aiModel.update({
    where: { id },
    data: { name: b.name ?? exist.name, thinkingEffort: b.thinkingEffort ?? null,
      enabled: b.enabled ?? exist.enabled, updateTime: new Date() },
  })
  return c.json({ id })
})

serverRoutes.delete('/models/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiModel.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`模型不存在 id=${id}`)
  const refs = await prisma.aiApp.findMany({ where: { modelId: id, delFlag: '0' } })
  if (refs.length) err(`模型 [${exist.modelCode}] 仍被 ${refs.length} 个应用引用（如 ${refs[0].name}-${refs[0].appCode}），请先删除或改绑应用`, 409)
  const base = await prisma.aiSysConfig.findFirst({ where: { configKey: 'base_model_id', delFlag: '0' } })
  if (base?.configValue === String(id)) err(`模型 [${exist.modelCode}] 已被系统基础设置引用为基础模型`, 409)
  await prisma.aiModel.update({ where: { id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

// ---------- 应用 ----------

serverRoutes.get('/apps', async (c) => {
  const apps = await prisma.aiApp.findMany({ where: { delFlag: '0' } })
  const result = []
  for (const a of apps) {
    const m = await prisma.aiModel.findFirst({ where: { id: a.modelId, delFlag: '0' } })
    const p = m ? await prisma.aiProvider.findFirst({ where: { providerCode: m.providerCode, delFlag: '0' } }) : null
    result.push({
      id: a.id, appCode: a.appCode, name: a.name, modelId: a.modelId,
      provider: p?.providerCode, protocol: p?.protocol, model: m?.modelCode,
      toolsEnabled: !!(a.mcpTools && a.mcpTools !== '[]'),
      skillsEnabled: !!(a.skills && a.skills !== '[]'),
      enabled: a.enabled,
    })
  }
  return c.json({ apps: result })
})

serverRoutes.get('/apps/:appCode', async (c) => {
  const a = await prisma.aiApp.findFirst({ where: { appCode: c.req.param('appCode'), delFlag: '0' } })
  if (!a) err(`应用不存在 [${c.req.param('appCode')}]`)
  return c.json(a)
})

serverRoutes.post('/apps', async (c) => {
  const b = await c.req.json()
  if (!b.appCode?.trim()) err('应用编码 app-code 必填')
  const dup = await prisma.aiApp.findFirst({ where: { appCode: b.appCode, delFlag: '0' } })
  if (dup) err(`应用编码 [${b.appCode}] 已存在`)
  const a = await prisma.aiApp.create({
    data: { appCode: b.appCode, name: b.name || b.appCode, modelId: b.modelId,
      systemPrompt: b.systemPrompt || null, mcpTools: b.mcpTools || null,
      skills: b.skills || null,
      enabled: b.enabled ?? true, createTime: new Date(), updateTime: new Date() },
  })
  return c.json({ id: a.id, appCode: a.appCode })
})

serverRoutes.put('/apps/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiApp.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`应用不存在 id=${id}`)
  await prisma.aiApp.update({
    where: { id },
    data: { name: b.name ?? exist.name, modelId: b.modelId ?? exist.modelId,
      systemPrompt: b.systemPrompt ?? exist.systemPrompt, mcpTools: b.mcpTools ?? exist.mcpTools,
      skills: b.skills ?? exist.skills,
      enabled: b.enabled ?? exist.enabled, updateTime: new Date() },
  })
  return c.json({ id })
})

// 应用启停（Node 版补齐：Java 版端点迁移遗漏，前端 toggleApp 一直调用的 POST /apps/:id/enabled?value=）
serverRoutes.post('/apps/:id/enabled', async (c) => {
  const id = Number(c.req.param('id'))
  const value = c.req.query('value') !== 'false'
  const exist = await prisma.aiApp.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`应用不存在 id=${id}`, 404)
  await prisma.aiApp.update({ where: { id }, data: { enabled: value, updateTime: new Date() } })
  return c.json({ appCode: exist.appCode, enabled: value })
})

serverRoutes.delete('/apps/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiApp.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`应用不存在 id=${id}`)
  await prisma.aiApp.update({ where: { id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

// ---------- 会话与消息 ----------

serverRoutes.get('/apps/:appCode/conversations', async (c) => {
  const appCode = c.req.param('appCode')
  const app = await prisma.aiApp.findFirst({ where: { appCode, delFlag: '0', enabled: true } })
  if (!app) err(`未配置或已停用的应用 [${appCode}]`, 404)
  const list = await prisma.aiConversation.findMany({
    where: { appCode, delFlag: '0' }, orderBy: { id: 'desc' },
  })
  return c.json({ conversations: list.map(x => ({
    conversationId: x.conversationId, title: x.title, createTime: x.createTime, updateTime: x.updateTime,
  })) })
})

// ---------- 历史回放截取（辉哥 2026-09-17 需求）----------
// 网页检索等工具回放内容太大（tool_result 可达数万字）→ 会话加载慢。
// 仅在【消息列表 API 读侧】截取展示：DB 原值不动、实时 SSE 不动、
// 上下文重建（context.ts 直读 DB）不受影响——三路天然隔离。
const HISTORY_TRUNCATE_CHARS = 200

function truncStr(s: string): string {
  return s.length > HISTORY_TRUNCATE_CHARS
    ? s.slice(0, HISTORY_TRUNCATE_CHARS) + `…（回放已截取，全文 ${s.length} 字）`
    : s
}

/** toolCallsJson 截取：每条调用的 args / result（技能全文加载的 query 结果同样被覆盖） */
function truncateToolCalls(json: string | null): string | null {
  if (!json) return null
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return json
    for (const tc of arr) {
      if (tc?.args && typeof tc.args === 'object') {
        const s = JSON.stringify(tc.args)
        if (s.length > HISTORY_TRUNCATE_CHARS) tc.args = truncStr(s)
      } else if (typeof tc?.args === 'string') {
        tc.args = truncStr(tc.args)
      }
      if (typeof tc?.result === 'string') tc.result = truncStr(tc.result)
    }
    return JSON.stringify(arr)
  } catch { return json }
}

/** contentBlocks 截取：tool_use 块的 args / tool_result 块的 content（thinking/text 不动——正文与思考完整保留） */
function truncateBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks
  for (const b of blocks as Array<Record<string, unknown>>) {
    if (b?.type === 'tool_use' && b?.content && typeof b.content === 'object') {
      const c = b.content as Record<string, unknown>
      if (c.args && typeof c.args === 'object') {
        const s = JSON.stringify(c.args)
        if (s.length > HISTORY_TRUNCATE_CHARS) c.args = truncStr(s)
      } else if (typeof c.args === 'string') {
        c.args = truncStr(c.args)
      }
    }
    if (b?.type === 'tool_result' && typeof b?.content === 'string') {
      b.content = truncStr(b.content)
    }
  }
  return blocks
}

serverRoutes.get('/conversations/:conversationId/messages', async (c) => {
  const conv = await prisma.aiConversation.findFirst({
    where: { conversationId: c.req.param('conversationId'), delFlag: '0' },
  })
  if (!conv) err(`会话不存在 [${c.req.param('conversationId')}]`, 404)
  const msgs = await prisma.aiMessage.findMany({
    where: { conversationId: conv.id }, orderBy: { id: 'asc' },
  })
  return c.json({ messages: msgs.map(m => ({
    messageId: m.messageId, question: m.question,
    contentBlocks: m.contentBlocks ? truncateBlocks(JSON.parse(m.contentBlocks)) : null,
    answerPure: m.answerPure, toolCallsJson: truncateToolCalls(m.toolCallsJson),
    mediaJson: m.mediaJson, attachments: m.attachments,
    success: m.success, errorMessage: m.errorMessage, createTime: m.createTime,
  })) })
})

serverRoutes.put('/conversations/:conversationId/title', async (c) => {
  const b = await c.req.json()
  const title = b?.title?.trim()
  if (!title) err('会话名称不能为空')
  if (title.length > 40) err(`会话名称过长（最多 40 字）`)
  const conv = await prisma.aiConversation.findFirst({
    where: { conversationId: c.req.param('conversationId'), delFlag: '0' },
  })
  if (!conv) err(`会话不存在 [${c.req.param('conversationId')}]`, 404)
  await prisma.aiConversation.update({ where: { id: conv.id }, data: { title, updateTime: new Date() } })
  return c.json({ ok: true, title })
})

serverRoutes.delete('/conversations/:conversationId', async (c) => {
  const convId = c.req.param('conversationId')
  const conv = await prisma.aiConversation.findFirst({ where: { conversationId: convId, delFlag: '0' } })
  if (!conv) err(`会话不存在 [${convId}]`, 404)
  await prisma.aiMessage.deleteMany({ where: { conversationId: conv.id } })
  await prisma.aiConversation.update({ where: { id: conv.id }, data: { delFlag: '1' } })
  const { cleanupConversation } = await import('../memory/attachment')
  cleanupConversation(convId)
  return c.json({ deleted: true })
})

// ---------- Skill ----------

serverRoutes.get('/skills', async (c) => {
  const list = await prisma.aiSkill.findMany({ where: { delFlag: '0' } })
  return c.json({ skills: list })
})

// ---------- @ 可唤起对象（15 号：@ 弹层数据源——系统指令组 + 当前应用绑定的技能组） ----------

serverRoutes.get('/at-commands', async (c) => {
  // 系统指令组：ai_at_command（mode 型行，展示元数据；执行配方在代码 MODE_REGISTRY）
  const commands = await prisma.aiAtCommand.findMany({
    where: { enabled: true, delFlag: '0', targetType: 'mode' },
    orderBy: { sort: 'asc' },
    select: { triggerCode: true, label: true, description: true, targetCode: true },
  })
  // 技能组：当前应用绑定的技能（授权=绑定即可见；不预注册 @ 表——绑定关系即真源）
  const appCode = c.req.query('appCode') || ''
  let skills: { code: string; name: string }[] = []
  if (appCode) {
    const app = await prisma.aiApp.findFirst({ where: { appCode, delFlag: '0' } })
    if (app?.skills) {
      let binds: Array<{ code?: string }> = []
      try { binds = JSON.parse(app.skills) } catch { binds = [] }
      const codes = binds.filter(b => typeof b?.code === 'string').map(b => b.code as string)
      if (codes.length) {
        const rows = await prisma.aiSkill.findMany({
          where: { skillCode: { in: codes }, delFlag: '0', enabled: true },
          select: { skillCode: true, name: true },
        })
        skills = rows.map(r => ({ code: r.skillCode, name: r.name || r.skillCode }))
      }
    }
  }
  return c.json({ commands, skills })
})

serverRoutes.post('/skills', async (c) => {
  const b = await c.req.json()
  if (!b.skillCode?.trim()) err('技能编码必填')
  if (!b.content?.trim()) err('技能正文必填')
  const dup = await prisma.aiSkill.findFirst({ where: { skillCode: b.skillCode, delFlag: '0' } })
  if (dup) err(`技能编码 [${b.skillCode}] 已存在`)
  const s = await prisma.aiSkill.create({
    data: { skillCode: b.skillCode, name: b.name || b.skillCode, content: b.content,
      enabled: true, description: b.description || null,
      createTime: new Date(), updateTime: new Date() },
  })
  return c.json(s)
})

serverRoutes.put('/skills/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiSkill.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`技能不存在 id=${id}`)
  // 内置技能保护（辉哥 2026-09-15）：平台预定义的稳定资产，不允许修改、不允许停用
  // （剧本体系的依赖面收敛原则——meta-skill 等系统级技能是剧本刚需，被改坏 = 流程死）
  if (exist.skillType === 'builtin') err(`内置技能 [${exist.skillCode}] 为平台预定义资产，不允许修改或停用`)
  await prisma.aiSkill.update({
    where: { id },
    data: { name: b.name ?? exist.name, content: b.content ?? exist.content,
      description: b.description ?? exist.description,
      ...(b.enabled !== undefined && { enabled: b.enabled }),
      updateTime: new Date() },
  })
  return c.json({ id })
})

serverRoutes.delete('/skills/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiSkill.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`技能不存在 id=${id}`)
  if (exist.skillType === 'builtin') err(`内置技能 [${exist.skillCode}] 不可删除`)
  const apps = await prisma.aiApp.findMany({ where: { delFlag: '0' } })
  for (const a of apps) {
    if (a.skills?.includes(exist.skillCode)) err(`技能 [${exist.skillCode}] 仍被应用 [${a.name}-${a.appCode}] 绑定`, 409)
  }
  await prisma.aiSkill.update({ where: { id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

// 技能启停（Java 版遗留接口缺口——辉哥 2026-09-17 实测 404 发现：前端 skills.js setEnabled 调此路由但 Node 版未实现）
serverRoutes.post('/skills/:id/enabled', async (c) => {
  const id = Number(c.req.param('id'))
  const value = c.req.query('value') !== 'false'
  const exist = await prisma.aiSkill.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`技能不存在 id=${id}`)
  await prisma.aiSkill.update({ where: { id }, data: { enabled: value, updateTime: new Date() } })
  return c.json({ skillCode: exist.skillCode, enabled: value })
})

// ---------- MCP ----------

/**
 * headers 纯文本解析（辉哥 2026-09-17 定调：唯一输入形态，一行一个 key: value；不兼容 JSON 直填）。
 * 存储统一为 JSON 对象字符串（一层）；格式错误报 400（行号 + 原文提示）。
 */
function parseHeaderText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const text = String(v).trim()
  if (!text) return null
  if (text.startsWith('{')) err(`headers 请用纯文本格式（一行一个 key: value），不要填 JSON——示例：\nx-api-key: 5f4efc…`)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const obj: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx <= 0) err(`headers 第 ${i + 1} 行格式错误（应为 key: value）：${lines[i]}`)
    const key = lines[i].slice(0, idx).trim()
    if (!key) err(`headers 第 ${i + 1} 行 key 为空`)
    obj[key] = lines[i].slice(idx + 1).trim()
  }
  return Object.keys(obj).length ? JSON.stringify(obj) : null
}

/** args/env 存储归一：字符串原样（JSON 文本），对象才 stringify */
const asJsonText = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null
  if (v && typeof v === 'object') return JSON.stringify(v)
  return null
}

serverRoutes.get('/mcp-servers', async (c) => {
  const list = await prisma.aiMcpServer.findMany({ where: { delFlag: '0' } })
  return c.json({ servers: list })
})

serverRoutes.post('/mcp-servers', async (c) => {
  const b = await c.req.json()
  if (!b.serverCode?.trim()) err('服务编码必填')
  const dup = await prisma.aiMcpServer.findFirst({ where: { serverCode: b.serverCode, delFlag: '0' } })
  if (dup) err(`服务编码 [${b.serverCode}] 已存在`)
  const s = await prisma.aiMcpServer.create({
    data: { serverCode: b.serverCode, name: b.name || b.serverCode,
      type: b.type || 'sse', url: b.url || null, headers: parseHeaderText(b.headers),
      command: b.command || null, args: asJsonText(b.args),
      env: asJsonText(b.env),
      enabled: false, createTime: new Date(), updateTime: new Date() },
  })
  // 服务集变更：驱逐进程内工具缓存（下次对话装配时按 DB 重建——registry 注释声明的联动在此接线）
  const { evictMcp } = await import('../tools/mcp/registry')
  await evictMcp()
  return c.json(s)
})

/** 连通性测试（管理界面"测试并启用"）：不写库、不影响现有连接；契约与前端 McpTestModal 对齐 */
serverRoutes.post('/mcp-servers/test', async (c) => {
  const b: any = await c.req.json().catch((): null => null)
  if (!b?.type) err('type 必填（streamable / stdio）')
  const { testMcpServerConnection } = await import('../tools/mcp/registry')
  const r = await testMcpServerConnection({
    serverCode: 'test', type: b.type, url: b.url ?? null,
    headers: b.headers ?? null, command: b.command ?? null,
    args: b.args ?? null, env: b.env ?? null,
  })
  return c.json({
    success: r.ok,
    serverName: r.serverName ?? '',
    serverVersion: r.serverVersion ?? '',
    protocolVersion: r.protocolVersion ?? '',
    tools: r.tools,
    ...(r.error && { error: r.error }),
  })
})

serverRoutes.put('/mcp-servers/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiMcpServer.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`服务不存在 id=${id}`)
  await prisma.aiMcpServer.update({
    where: { id },
    data: { name: b.name ?? exist.name, type: b.type ?? exist.type,
      url: b.url ?? exist.url, headers: b.headers !== undefined ? parseHeaderText(b.headers) : exist.headers,
      command: b.command ?? exist.command, args: b.args !== undefined ? asJsonText(b.args) : exist.args,
      env: b.env !== undefined ? asJsonText(b.env) : exist.env, updateTime: new Date() },
  })
  // 配置变更（url/headers/args 等）：驱逐缓存重建连接
  const { evictMcp } = await import('../tools/mcp/registry')
  await evictMcp()
  return c.json({ id })
})

serverRoutes.delete('/mcp-servers/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiMcpServer.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`服务不存在 id=${id}`)
  await prisma.aiMcpServer.update({ where: { id }, data: { delFlag: '1' } })
  // 删除服务：驱逐缓存，其工具从下次装配中消失
  const { evictMcp } = await import('../tools/mcp/registry')
  await evictMcp()
  return c.json({ deleted: true })
})

serverRoutes.post('/mcp-servers/:id/enabled', async (c) => {
  const id = Number(c.req.param('id'))
  const value = c.req.query('value') !== 'false'
  const exist = await prisma.aiMcpServer.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`服务不存在 id=${id}`)
  await prisma.aiMcpServer.update({ where: { id }, data: { enabled: value, updateTime: new Date() } })
  // 启停切换：驱逐缓存（停用的服务下次装配不再连接；启用的服务重建时纳入）
  const { evictMcp } = await import('../tools/mcp/registry')
  await evictMcp()
  return c.json({ serverCode: exist.serverCode, enabled: value })
})

// ---------- 字典 ----------

serverRoutes.get('/dicts/types', async (c) => {
  const list = await prisma.aiDictType.findMany({ where: { delFlag: '0' } })
  return c.json({ types: list })
})

serverRoutes.post('/dicts/types', async (c) => {
  const b = await c.req.json()
  if (!b.dictType?.trim()) err('字典类型必填')
  const dup = await prisma.aiDictType.findFirst({ where: { dictType: b.dictType, delFlag: '0' } })
  if (dup) err(`字典类型 [${b.dictType}] 已存在`)
  const t = await prisma.aiDictType.create({
    data: { dictType: b.dictType, dictName: b.dictName || b.dictType,
      remark: b.remark || null, createTime: new Date(), updateTime: new Date() },
  })
  return c.json(t)
})

serverRoutes.put('/dicts/types/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiDictType.findFirst({ where: { dictId: id, delFlag: '0' } })
  if (!exist) err(`字典类型不存在 id=${id}`)
  await prisma.aiDictType.update({
    where: { dictId: id }, data: { dictName: b.dictName ?? exist.dictName, remark: b.remark ?? exist.remark, updateTime: new Date() },
  })
  return c.json({ id })
})

serverRoutes.delete('/dicts/types/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiDictType.findFirst({ where: { dictId: id, delFlag: '0' } })
  if (!exist) err(`字典类型不存在 id=${id}`)
  const cnt = await prisma.aiDictData.count({ where: { dictType: exist.dictType, delFlag: '0' } })
  if (cnt > 0) err(`字典类型 [${exist.dictType}] 下仍有 ${cnt} 条数据，请先清空`, 409)
  await prisma.aiDictType.update({ where: { dictId: id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

serverRoutes.get('/dicts/data', async (c) => {
  const dictType = c.req.query('dictType')
  const list = await prisma.aiDictData.findMany({
    where: { delFlag: '0', ...(dictType && { dictType }) },
    orderBy: { dictCode: 'asc' },
  })
  return c.json({ data: list })
})

serverRoutes.post('/dicts/data', async (c) => {
  const b = await c.req.json()
  if (!b.dictType?.trim()) err('字典类型必填')
  if (!b.dictLabel?.trim()) err('字典标签必填')
  const d = await prisma.aiDictData.create({
    data: { dictType: b.dictType, dictLabel: b.dictLabel, dictValue: b.dictValue || null,
      isDefault: b.isDefault || 'N', sort: b.sort ?? 0,
      createTime: new Date(), updateTime: new Date() },
  })
  return c.json(d)
})

serverRoutes.put('/dicts/data/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiDictData.findFirst({ where: { dictCode: id, delFlag: '0' } })
  if (!exist) err(`字典值不存在 id=${id}`)
  // 默认档互斥
  if (b.isDefault === 'Y') {
    await prisma.aiDictData.updateMany({
      where: { dictType: exist.dictType, isDefault: 'Y', delFlag: '0', dictCode: { not: id } },
      data: { isDefault: 'N' },
    })
  }
  await prisma.aiDictData.update({
    where: { dictCode: id },
    data: { dictLabel: b.dictLabel ?? exist.dictLabel, dictValue: b.dictValue ?? exist.dictValue,
      isDefault: b.isDefault ?? exist.isDefault, sort: b.sort ?? exist.sort, updateTime: new Date() },
  })
  return c.json({ id })
})

serverRoutes.delete('/dicts/data/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiDictData.findFirst({ where: { dictCode: id, delFlag: '0' } })
  if (!exist) err(`字典值不存在 id=${id}`)
  await prisma.aiDictData.update({ where: { dictCode: id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

// ---------- 系统配置 ----------

serverRoutes.get('/system-config', async (c) => {
  // id = configId 别名（前端动态参数面板按 id 定位编辑/删除目标）
  const configs = await prisma.aiSysConfig.findMany({ where: { delFlag: '0' } })
    .then(rows => rows.map(r => ({ ...r, id: r.configId })))
  const base = configs.find(c => c.configKey === 'base_model_id')
  let baseModel = null
  if (base?.configValue) {
    const m = await prisma.aiModel.findFirst({ where: { id: Number(base.configValue), delFlag: '0', enabled: true } })
    if (m) baseModel = { id: m.id, modelCode: m.modelCode, name: m.name, providerCode: m.providerCode }
  }
  return c.json({ configs, baseModel: baseModel || {} })
})

serverRoutes.put('/system-config/base-model', async (c) => {
  const b = await c.req.json()
  const modelId = b?.modelId ?? null
  if (modelId) {
    const m = await prisma.aiModel.findFirst({ where: { id: modelId, delFlag: '0' } })
    if (!m) err(`基础模型不存在 id=${modelId}`)
    if (!m.enabled) err(`基础模型 [${m.modelCode}] 已停用，请选择启用的模型`)
  }
  await upsertConfig('base_model_id', '系统基础模型', modelId ? String(modelId) : null)
  return c.json({ baseModelId: modelId || 0 })
})

serverRoutes.put('/system-config/runtime-params', async (c) => {
  const b = await c.req.json()
  const map: Record<string, [string, string]> = {
    toolResultMaxChars: ['tool_result_max_chars', '工具结果轨迹截断长度'],
    mcpRequestTimeoutSeconds: ['mcp_request_timeout_seconds', 'MCP 请求超时（秒）'],
    mcpInitTimeoutSeconds: ['mcp_init_timeout_seconds', 'MCP 初始化超时（秒）'],
    textInjectMaxChars: ['text_inject_max_chars', '文本附件注入上限（字符）'],
    agentMaxSteps: ['agent_max_steps', 'Agent 工具循环步数上限'],
    anthropicMaxTokens: ['anthropic_max_tokens', 'Anthropic 默认 max_tokens'],
    memorySummaryTriggerChars: ['memory_summary_trigger_chars', '记忆摘要触发水位线'],
    taskResultMaxChars: ['task_result_max_chars', '任务结果截断长度'],
    kbEmbedTimeoutSeconds: ['kb_embed_timeout_seconds', '知识库 embedding 超时秒数'],
    kbTopK: ['kb_top_k', '知识库检索返回条数'],
    kbMinSimilarity: ['kb_min_similarity', '知识库相似度阈值（0-1）'],
  }
  for (const [field, [key, name]] of Object.entries(map)) {
    const v = b[field]
    if (v !== undefined) {
      if (typeof v !== 'number' || v <= 0) err(`${name} 必须为正整数，收到：${v}`)
      await upsertConfig(key, name, String(v))
    }
  }
  return c.json({ saved: true })
})

serverRoutes.post('/system-config', async (c) => {
  const b = await c.req.json()
  if (!b.configKey?.trim()) err('参数键 config-key 必填')
  const key = b.configKey.trim()
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) err(`参数键格式：小写字母开头，仅小写字母/数字/下划线（2~64 位），收到：${key}`)
  if (!b.configName?.trim()) err('参数名称必填')
  const dup = await prisma.aiSysConfig.findFirst({ where: { configKey: key, delFlag: '0' } })
  if (dup) err(`参数键 [${key}] 已存在`)
  const created = await prisma.aiSysConfig.create({
    data: { configName: b.configName.trim(), configKey: key, configValue: b.configValue || null,
      isBuiltin: false, createTime: new Date(), updateTime: new Date() },
  })
  return c.json(created)
})

serverRoutes.put('/system-config/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  const exist = await prisma.aiSysConfig.findFirst({ where: { configId: id, delFlag: '0' } })
  if (!exist) err(`配置不存在 id=${id}`)
  await prisma.aiSysConfig.update({
    where: { configId: id },
    data: { configValue: b.configValue ?? exist.configValue,
      ...(!exist.isBuiltin && { configName: b.configName?.trim() || exist.configName }),
      updateTime: new Date() },
  })
  return c.json({ configId: id })
})

serverRoutes.delete('/system-config/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiSysConfig.findFirst({ where: { configId: id, delFlag: '0' } })
  if (!exist) err(`配置不存在 id=${id}`)
  if (exist.isBuiltin) err(`内置配置 [${exist.configKey}] 不可删除`)
  await prisma.aiSysConfig.update({ where: { configId: id }, data: { delFlag: '1' } })
  return c.json({ deleted: true })
})

// ---------- 内置工具 ----------

serverRoutes.get('/builtin-tools', async (c) => {
  const list = await prisma.aiBuiltinTool.findMany({ where: { delFlag: '0' }, orderBy: { id: 'asc' } })
  return c.json({ tools: list })
})

// ---------- 应用密钥（16 方案：应用嵌出 app-key 管理） ----------

/** 生成嵌入密钥：sk_emb_ + 24 位随机（crypto 随机，URL 安全） */
function genEmbedKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `sk_emb_${hex}`
}

serverRoutes.get('/app-keys', async (c) => {
  const list = await prisma.aiAppKey.findMany({ where: { delFlag: '0' }, orderBy: { id: 'desc' } })
  return c.json({ keys: list.map(k => ({
    id: k.id, appKey: k.appKey, appCode: k.appCode, name: k.name,
    domains: k.domains, dailyQuota: k.dailyQuota, expireTime: k.expireTime,
    enabled: k.enabled, createTime: k.createTime,
  })) })
})

serverRoutes.post('/app-keys', async (c) => {
  const b = await c.req.json().catch((): null => null)
  const appCode = String(b?.appCode || '').trim()
  const name = String(b?.name || '').trim()
  if (!appCode) err('appCode 不能为空')
  if (!name) err('名称不能为空')
  const app = await prisma.aiApp.findFirst({ where: { appCode, delFlag: '0' }, select: { appCode: true } })
  if (!app) err(`应用不存在：${appCode}`, 404)
  const dailyQuota = b?.dailyQuota != null ? Number(b.dailyQuota) : null
  if (dailyQuota !== null && (!Number.isInteger(dailyQuota) || dailyQuota < 0)) err('dailyQuota 必须为非负整数')
  let domains: string | null = null
  if (Array.isArray(b?.domains)) {
    domains = JSON.stringify(b.domains.map((d: unknown) => String(d).trim()).filter(Boolean))
  } else if (typeof b?.domains === 'string' && b.domains.trim()) {
    domains = JSON.stringify((b.domains as string).split(/[,，\s]+/).map((s: string) => s.trim()).filter(Boolean))
  }
  const expireTime = b?.expireTime ? new Date(b.expireTime) : null
  if (expireTime && isNaN(expireTime.getTime())) err('expireTime 不是合法时间')
  const appKey = genEmbedKey()
  const rec = await prisma.aiAppKey.create({
    data: { appKey, appCode, name, domains, dailyQuota, expireTime,
      enabled: true, createTime: new Date(), updateTime: new Date() },
  })
  return c.json({ id: rec.id, appKey, appCode, name, domains, dailyQuota, expireTime, enabled: true })  // 完整 key 仅创建时返回一次
})

serverRoutes.put('/app-keys/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiAppKey.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`密钥不存在 id=${id}`, 404)
  const b = await c.req.json().catch((): null => null)
  const data: Record<string, unknown> = { updateTime: new Date() }
  if (b?.name !== undefined) {
    const name = String(b.name).trim()
    if (!name) err('名称不能为空')
    data.name = name
  }
  if (b?.enabled !== undefined) data.enabled = !!b.enabled
  if (b?.dailyQuota !== undefined) {
    const q = b.dailyQuota == null ? null : Number(b.dailyQuota)
    if (q !== null && (!Number.isInteger(q) || q < 0)) err('dailyQuota 必须为非负整数或空')
    data.dailyQuota = q
  }
  if (b?.domains !== undefined) {
    if (b.domains == null || (Array.isArray(b.domains) && b.domains.length === 0)) {
      data.domains = null
    } else if (Array.isArray(b.domains)) {
      data.domains = JSON.stringify(b.domains.map((d: unknown) => String(d).trim()).filter(Boolean))
    } else if (typeof b.domains === 'string') {
      data.domains = (b.domains as string).trim()
        ? JSON.stringify((b.domains as string).split(/[,，\s]+/).map((s: string) => s.trim()).filter(Boolean))
        : null
    }
  }
  if (b?.expireTime !== undefined) {
    const t = b.expireTime ? new Date(b.expireTime) : null
    if (t && isNaN(t.getTime())) err('expireTime 不是合法时间')
    data.expireTime = t
  }
  await prisma.aiAppKey.update({ where: { id }, data: data as any })
  return c.json({ ok: true })
})

serverRoutes.delete('/app-keys/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const exist = await prisma.aiAppKey.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`密钥不存在 id=${id}`, 404)
  await prisma.aiAppKey.update({ where: { id }, data: { delFlag: '1', enabled: false, updateTime: new Date() } })
  return c.json({ deleted: true })
})

serverRoutes.post('/builtin-tools/:id/enabled', async (c) => {
  const id = Number(c.req.param('id'))
  const value = c.req.query('value') !== 'false'
  const exist = await prisma.aiBuiltinTool.findFirst({ where: { id, delFlag: '0' } })
  if (!exist) err(`内置工具不存在 id=${id}`)
  if (exist.required && !value) err(`系统必需工具 [${exist.toolCode}] 不可停用`)
  await prisma.aiBuiltinTool.update({ where: { id }, data: { enabled: value, updateTime: new Date() } })
  return c.json({ toolCode: exist.toolCode, enabled: value })
})

// ---------- 辅助 ----------

async function upsertConfig(key: string, name: string, value: string | null) {
  const exist = await prisma.aiSysConfig.findFirst({ where: { configKey: key, delFlag: '0' } })
  if (exist) {
    await prisma.aiSysConfig.update({ where: { configId: exist.configId }, data: { configValue: value, updateTime: new Date() } })
  } else {
    await prisma.aiSysConfig.create({
      data: { configName: name, configKey: key, configValue: value, isBuiltin: true,
        createTime: new Date(), updateTime: new Date() },
    })
  }
}
