// ============================================================
// 知识库管理路由（18 号方案 + 2026-09-17 v2 单键配置改造）
// - 配置：kb_config 单键 JSON（参数 + enabled + lastTest）——状态=配置字段，不做运行时探测
// - 测试：POST /kb/test 带【页面表单数据】探测（格式校验→3s POST 探测）；
//         成功 → 表单数据+enabled=true 整存配置；失败 → 只报错不写库
// - 保存：PUT /kb/config 只存参数（enabled/lastTest 保留现值；URL 清空 = enabled false 下架）
// - 守卫：上传在 enabled=false 时 403；列表响应附 kbEnabled
// ============================================================

import { Hono } from 'hono'
import { listDocs, deleteDoc, getPool } from '../kb/store.js'
import { ingestDocument, KB_ACCEPT_TYPES } from '../kb/ingest.js'
import {
  readKbConfig, writeKbConfig, probeEmbedding, validateEmbeddingUrl,
  type KbConfig,
} from '../kb/availability.js'

export const kbRoutes = new Hono()

/** 状态三态：'' 正常 / not_configured URL 空 / disabled 有 URL 未启用（测试失败/未测） */
function reasonOf(cfg: KbConfig): '' | 'not_configured' | 'disabled' {
  if (!cfg.embeddingUrl) return 'not_configured'
  return cfg.enabled ? '' : 'disabled'
}

/**
 * POST /kb/test：测试并保存（辉哥 2026-09-17 终版——测试与保存统一）
 * - body 带页面表单数据；**无论结果如何表单参数全量落库**（用户参数问题不兜底，所见即所存）
 * - enabled/lastTest 跟随探测结果：成功 true；格式错/不可达/URL 空 → false
 * - URL 清空 = 下架（enabled=false, lastTest=null）
 */
kbRoutes.post('/kb/test', async (c) => {
  try {
    const b = await c.req.json()
    const url = String(b?.embeddingUrl ?? '').trim()
    const cur = await readKbConfig()
    const numOr = (v: unknown, curV: number, fb: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : (v === undefined ? curV : fb)
    }
    /** 从 body 组装全量表单值（参数如实——错的也存） */
    const form: KbConfig = {
      embeddingUrl: url,
      embeddingModel: String(b?.embeddingModel ?? cur.embeddingModel).trim() || 'bge-m3:latest',
      embeddingApiKey: String(b?.embeddingApiKey ?? cur.embeddingApiKey).trim(),
      embedTimeoutSeconds: numOr(b?.embedTimeoutSeconds, cur.embedTimeoutSeconds, 15),
      topK: numOr(b?.topK, cur.topK, 6),
      minSimilarity: numOr(b?.minSimilarity, cur.minSimilarity, 0.35),
      enabled: false,
      lastTest: null,
    }
    // ① URL 空 → 下架（参数全存，状态清零）
    if (!url) {
      await writeKbConfig(form)
      return c.json({ ok: false, reason: 'not_configured', detail: 'embedding 地址为空——知识库下架' }, 200)
    }
    // ② 格式错 → 参数照存 + 状态如实（不可启用）
    const invalid = validateEmbeddingUrl(url)
    if (invalid) {
      await writeKbConfig({ ...form, lastTest: { ok: false, detail: `地址格式错误：${invalid}`, at: new Date().toISOString() } })
      return c.json({ ok: false, reason: 'invalid_url', detail: `地址格式错误：${invalid}` }, 200)
    }
    // ③ 端到端探测（带 key + model 真实请求）→ 成功启用 / 失败下架（参数都已全存）
    const probe = await probeEmbedding(url, form.embeddingApiKey, form.embeddingModel)
    await writeKbConfig({
      ...form,
      enabled: probe.ok,
      lastTest: { ok: probe.ok, detail: probe.detail, at: new Date().toISOString() },
    })
    return probe.ok
      ? c.json({ ok: true, detail: probe.detail })
      : c.json({ ok: false, reason: 'unreachable', detail: probe.detail }, 200)
  } catch (e) {
    return c.json({ ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) }, 200)
  }
})

/** GET /kb/status：面板禁用态数据源（读配置字段，零探测） */
kbRoutes.get('/kb/status', async (c) => {
  const cfg = await readKbConfig()
  return c.json({ enabled: cfg.enabled, reason: reasonOf(cfg), lastTest: cfg.lastTest })
})

kbRoutes.get('/kb/documents', async (c) => {
  try {
    const docs = await listDocs()
    const cfg = await readKbConfig()   // 列表响应附可用状态（前端一鱼两吃）
    return c.json({ documents: docs, kbEnabled: cfg.enabled, kbReason: reasonOf(cfg) })
  } catch (e) {
    return c.json({ error: `知识库不可用：${e instanceof Error ? e.message : e}` }, 503)
  }
})

kbRoutes.post('/kb/documents', async (c) => {
  try {
    const cfg = await readKbConfig()   // 上传守卫：未启用 → 拒绝
    const why = reasonOf(cfg)
    if (why) {
      const tip = why === 'not_configured' ? '向量模型未配置，请到系统设置配置并测试启用' : '知识库未启用（未通过测试），请在系统设置点「测试并启用」'
      return c.json({ error: tip }, 403)
    }
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ error: '文件超过 10MB 上限' }, 400)
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (!KB_ACCEPT_TYPES.includes(ext as (typeof KB_ACCEPT_TYPES)[number])) {
      return c.json({ error: `不支持的类型 .${ext}（支持：${KB_ACCEPT_TYPES.join(' / ')}）` }, 400)
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    const docId = await ingestDocument({ originalName: file.name, buffer })
    return c.json({ id: docId, status: 'pending' })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
  }
})

kbRoutes.get('/kb/documents/:id/chunks', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '非法 id' }, 400)
  try {
    const { rows } = await getPool().query<{ seq: number; content: string }>(
      'SELECT seq, content FROM ai_kb_chunk WHERE doc_id = $1 ORDER BY seq', [id]
    )
    return c.json({ chunks: rows })
  } catch (e) {
    return c.json({ error: `知识库不可用：${e instanceof Error ? e.message : e}` }, 503)
  }
})

kbRoutes.delete('/kb/documents/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '非法 id' }, 400)
  try {
    const ok = await deleteDoc(id)
    if (!ok) return c.json({ error: '文档不存在' }, 404)
    return c.json({ deleted: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
