<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { systemConfigApi } from '../../api/dict'
import { kbApi } from '../../api/kb'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'

/**
 * 系统设置面板（第 1 位，10 方案）：系统基础模型 + 知识库配置（18 方案）。
 * 基础模型：平台内部 LLM 调用统一使用，建议选轻量快速模型。
 * 知识库配置：embedding 地址 / 模型 + 检索参数（改值保存即时生效；
 *   embedding 地址留空 = 知识库工具整体下架，插拔式）。
 */
const store = useSettingStore()
// 面板级懒加载：进入面板拉取声明依赖的数据（幂等）
onMounted(() => store.ensure('system'))
const { providers, models, systemBaseModel, systemConfigs, loading } = storeToRefs(store)

const selectedModelId = ref(undefined)

/** 启用厂商 → 启用模型的平铺清单（下拉源，同应用绑定语义） */
const enabledModels = computed(() => {
  const enabledProviders = new Set(providers.value.filter(p => p.enabled !== false).map(p => p.providerCode))
  return models.value
    .filter(m => enabledProviders.has(m.providerCode) && m.enabled !== false)
    .map(m => ({ ...m, display: `${m.providerCode} / ${m.modelCode}${m.name && m.name !== m.modelCode ? '（' + m.name + '）' : ''}` }))
})

// 回显当前配置：懒加载异步到达后回填（undefined = 初始化前，用户一旦选择即不再覆盖）
watch(systemBaseModel, (m) => {
  if (m && selectedModelId.value === undefined) selectedModelId.value = m.id
}, { immediate: true })

async function saveBaseModel() {
  await store.withSaving(async () => {
    await systemConfigApi.saveBaseModel(selectedModelId.value || null)
  })
}

// ---------- 知识库配置（18 方案：embedding 直配 + 检索参数） ----------

/** kb 配置表单：键对应 ai_sys_config.config_key；fallback 为代码默认值 */
const KB_CONFIG = {
  urlKey: 'kb_embedding_url',
  modelKey: 'kb_embedding_model',
  apiKeyKey: 'kb_embedding_api_key',
  numParams: [
    { field: 'embedTimeoutSeconds', key: 'kb_embed_timeout_seconds', label: '调用超时', fallback: 15, unit: '秒', desc: 'embedding 请求超时硬闸（防拖死对话）' },
    { field: 'topK', key: 'kb_top_k', label: '检索条数', fallback: 6, unit: '块', desc: '每次检索返回的最相关片段数' },
    { field: 'minSimilarity', key: 'kb_min_similarity', label: '相似度阈值', fallback: 0.35, unit: '', desc: '低于此分数的块过滤掉（0-1）' },
  ],
}

const kbForm = ref({ embeddingUrl: '', embeddingModel: '', embeddingApiKey: '', embedTimeoutSeconds: 15, topK: 6, minSimilarity: 0.35 })
/** KB 真实启用状态（单键 kb_config.enabled——徽章/回填用） */
const kbEnabled = ref(false)
const kbLastTest = ref(null)

/** configs（ai_sys_config 全量）到达后回填表单：优先解析 kb_config 单键 JSON，无则旧散键拼装 */
watch(systemConfigs, (list) => {
  if (!list || !list.length) return
  const byKey = Object.fromEntries(list.map(c => [c.configKey, c]))
  const single = byKey['kb_config']?.configValue
  if (single) {
    try {
      const cfg = JSON.parse(single)
      kbForm.value = {
        embeddingUrl: cfg.embeddingUrl || '',
        embeddingModel: cfg.embeddingModel || 'bge-m3:latest',
        embeddingApiKey: cfg.embeddingApiKey || '',
        embedTimeoutSeconds: Number(cfg.embedTimeoutSeconds) > 0 ? Number(cfg.embedTimeoutSeconds) : 15,
        topK: Number(cfg.topK) > 0 ? Number(cfg.topK) : 6,
        minSimilarity: Number(cfg.minSimilarity) > 0 ? Number(cfg.minSimilarity) : 0.35,
      }
      kbEnabled.value = !!cfg.enabled
      kbLastTest.value = cfg.lastTest || null
      return
    } catch { /* 单键损坏 → 旧散键拼装 */ }
  }
  const form = { embeddingUrl: '', embeddingModel: '', embeddingApiKey: '' }
  form.embeddingUrl = byKey[KB_CONFIG.urlKey]?.configValue || ''
  form.embeddingModel = byKey[KB_CONFIG.modelKey]?.configValue || ''
  form.embeddingApiKey = byKey[KB_CONFIG.apiKeyKey]?.configValue || ''
  for (const p of KB_CONFIG.numParams) {
    const num = Number(byKey[p.key]?.configValue)
    form[p.field] = Number.isFinite(num) && num > 0 ? num : p.fallback
  }
  kbForm.value = form
  kbEnabled.value = !!form.embeddingUrl   // 旧散键语义：有 URL=已启用
}, { immediate: true })

/** 测试并保存（唯一动作——辉哥终版统一）：带页面表单数据探测；参数无论对错全量落库（用户参数不兜底），enabled/lastTest 跟随探测结果 */
const kbTestResult = ref(null)   // {ok, reason, detail}
const kbTesting = ref(false)
async function testKbConfig() {
  kbTesting.value = true
  kbTestResult.value = null
  try {
    kbTestResult.value = await kbApi.test({ ...kbForm.value })
    // 参数与状态均已落库 → 同步徽章 + 刷新配置回填
    kbEnabled.value = !!kbTestResult.value?.ok
    await store._load('systemConfig')
  } catch (e) {
    kbTestResult.value = { ok: false, reason: 'error', detail: e?.response?.data?.error || e.message }
  } finally {
    kbTesting.value = false
  }
}
const kbTestText = computed(() => {
  if (!kbTestResult.value) return ''
  const r = kbTestResult.value
  if (r.ok) return `连接成功（${r.detail}）——知识库已启用`
  if (r.reason === 'not_configured') return '请先填写 embedding 地址'
  if (r.reason === 'invalid_url') return r.detail
  return `不可达：${r.detail || r.reason}`
})
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">系统设置</h1>
          <p class="st-panel-desc">基础模型与通用配置</p>
        </div>
      </div>
    </div>

    <!-- 系统基础模型 -->
    <div class="st-card" style="padding:16px 18px;">
      <div class="st-app-name" style="margin-bottom:6px;">系统基础模型
        <span v-if="systemBaseModel" class="st-dot tools">已配置</span>
        <span v-else class="st-dot off">未配置</span>
      </div>
      <p style="font-size:12px;color:var(--text-3);margin:0 0 12px;">
        平台内部能力（记忆摘要、技能生成等，相应功能实施后生效）统一使用此模型，与用户对话模型分离。
        建议选择轻量快速的模型（flash 级）；未配置时相应功能降级。
      </p>
      <div style="display:flex;gap:10px;align-items:center;">
        <select v-model="selectedModelId" class="ch-select" style="flex:1;max-width:420px;height:36px;border:1px solid var(--border);border-radius:8px;padding:0 11px;font-size:13px;background:var(--surface);color:var(--text);">
          <option :value="null">— 未配置（功能降级）—</option>
          <option v-for="m in enabledModels" :key="m.id" :value="m.id">{{ m.display }}</option>
        </select>
        <button class="st-btn st-btn-primary" @click="saveBaseModel">保存</button>
      </div>
    </div>

    <!-- 知识库配置（18 方案：embedding 直配 + 检索参数；地址留空 = 工具整体下架） -->
    <div class="st-card" style="padding:16px 18px;">
      <div class="st-app-name" style="margin-bottom:6px;">知识库配置
        <span v-if="kbEnabled" class="st-dot tools" :title="kbLastTest ? `最近测试：${kbLastTest.detail}（${new Date(kbLastTest.at).toLocaleString()}）` : ''">已启用</span>
        <span v-else-if="kbForm.embeddingUrl" class="st-dot off" title="已配置地址但未通过测试启用">未启用（待测试）</span>
        <span v-else class="st-dot off">未配置</span>
      </div>
      <p style="font-size:12px;color:var(--text-3);margin:0 0 12px;">
        插拔式 RAG（18 方案）：配置 embedding 地址后所有对话自动获得知识库检索能力；地址留空即整体下架（模型不可见，零干扰）。
        参数保存即时生效。
      </p>
      <div class="kb-cfg-text">
        <label class="st-runtime-item" style="flex:1;">
          <span class="st-runtime-label">Embedding 地址（OpenAI 兼容完整路径）</span>
          <input v-model="kbForm.embeddingUrl" class="st-runtime-input kb-cfg-url" placeholder="http://host:port/v1/embeddings（留空 = 关闭知识库）" />
        </label>
        <label class="st-runtime-item" style="width:240px;">
          <span class="st-runtime-label">Embedding 模型</span>
          <input v-model="kbForm.embeddingModel" class="st-runtime-input" placeholder="bge-m3:latest" />
        </label>
      </div>
      <div class="kb-cfg-text" style="margin-bottom:14px;">
        <label class="st-runtime-item" style="flex:1;">
          <span class="st-runtime-label">API Key（三方平台鉴权；本地 Ollama 留空）</span>
          <input v-model="kbForm.embeddingApiKey" type="password" autocomplete="off" class="st-runtime-input kb-cfg-url" placeholder="sk-xxx（OpenAI 兼容 Bearer 认证；留空 = 无鉴权）" />
        </label>
      </div>
      <div class="st-runtime-grid">
        <label v-for="p in KB_CONFIG.numParams" :key="p.key" class="st-runtime-item">
          <span class="st-runtime-label">{{ p.label }}</span>
          <span class="st-runtime-input-wrap">
            <input v-model.number="kbForm[p.field]" type="number" :min="p.field === 'minSimilarity' ? 0.01 : 1" :step="p.field === 'minSimilarity' ? 0.05 : 1" class="st-runtime-input" />
            <span class="st-runtime-unit">{{ p.unit }}</span>
          </span>
          <span class="st-runtime-desc">{{ p.desc }}</span>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:4px;">
        <span v-if="kbTestText" :style="{ fontSize: '12px', color: kbTestResult?.ok ? 'var(--ok, #2e7d32)' : 'var(--danger, #c62828)' }">{{ kbTestText }}</span>
        <button class="st-btn st-btn-primary" :disabled="kbTesting" title="保存当前表单并探测——成功即启用；失败如实保存（enabled=false）。URL 清空保存即下架" @click="testKbConfig">{{ kbTesting ? '测试中…' : '测试并保存' }}</button>
      </div>
    </div>

    <!-- 预留区：后续通用配置逐卡追加 -->
    <div class="st-empty" style="padding:28px 20px;">
      <p class="st-empty-sub">后续通用配置（摘要触发阈值等）将在此逐卡追加</p>
    </div>
  </div>
</template>

<style scoped>
.st-runtime-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px; margin-bottom: 12px;
}
.st-runtime-item { display: flex; flex-direction: column; gap: 4px; }
.st-runtime-label { font-size: 12.5px; font-weight: 500; color: var(--text-2); }
.st-runtime-input-wrap { display: flex; align-items: center; gap: 8px; }
.st-runtime-input {
  width: 130px; height: 32px; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: 8px;
  padding: 0 10px; font-size: 13px; outline: none;
  background: var(--bg); color: var(--text); font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.st-runtime-input:focus { border-color: #6366F1; box-shadow: 0 0 0 3px var(--ring); }
.st-runtime-unit { font-size: 12px; color: var(--text-3); }
.st-runtime-desc { font-size: 11.5px; color: var(--text-3); }
/* 知识库配置：文本两列（url 宽 + model 窄） */
.kb-cfg-text { display: flex; gap: 16px; margin-bottom: 14px; align-items: flex-start; }
.kb-cfg-url { width: 100%; height: 32px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px; padding: 0 10px; font-size: 12.5px; outline: none; background: var(--bg); color: var(--text); transition: border-color .15s ease, box-shadow .15s ease; font-family: 'Geist Mono', monospace; }
.kb-cfg-url:focus { border-color: #6366F1; box-shadow: 0 0 0 3px var(--ring); }
@media (max-width: 760px) { .st-runtime-grid { grid-template-columns: 1fr; } .kb-cfg-text { flex-direction: column; } .kb-cfg-text .st-runtime-item { width: 100% !important; } }
</style>
