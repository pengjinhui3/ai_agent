<script setup>
import { computed, ref, onMounted } from 'vue'
import { providersApi } from '../../api/providers'
import { modelsApi } from '../../api/models'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'

/**
 * 厂商与模型面板：厂商行展开模型子表，模型独立启停。
 */
const store = useSettingStore()
// 面板级懒加载：进入面板拉取声明依赖的数据（幂等）
onMounted(() => store.ensure('provider'))
const { providers, models, loading } = storeToRefs(store)

const expandedProvider = ref(null)

const stats = computed(() => [
  { label: '厂商', value: providers.value.length },
  { label: '模型', value: models.value.length },
  { label: '停用厂商', value: providers.value.filter(p => p.enabled === false).length },
])

function modelsOf(providerCode) {
  return models.value.filter(m => m.providerCode === providerCode)
}

// ---------- 厂商 ----------
function newProvider() {
  store.openModal({
    title: '新建厂商', type: 'provider', isNew: true,
    data: { providerCode: '', name: '', protocol: 'openai', baseUrl: '', apiKey: '', maxTokens: null },
    ok: saveProvider
  })
}
function editProvider(p) {
  store.openModal({
    title: '编辑厂商', sub: p.providerCode, type: 'provider', isNew: false, id: p.id,
    data: { providerCode: p.providerCode, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: '', maxTokens: p.maxTokens },
    ok: saveProvider
  })
}
async function saveProvider(m) {
  await store.withSaving(async () => {
    const body = { ...m.data, apiKey: m.data.apiKey && !m.data.apiKey.includes('***') ? m.data.apiKey : undefined }
    if (m.isNew) await providersApi.create(body)
    else await providersApi.update(m.id, body)
  })
}
async function toggleProvider(p) {
  await store.withSaving(() => providersApi.setEnabled(p.id, !(p.enabled !== false)))
}
async function removeProvider(p) {
  if (!confirm(`确认删除厂商「${p.providerCode}」？（有模型引用时将被拒绝）`)) return
  await store.withSaving(() => providersApi.remove(p.id))
}

// ---------- 模型 ----------
function newModel(providerCode) {
  store.openModal({
    title: '新建模型', sub: '厂商 ' + providerCode, type: 'model', isNew: true,
    data: { modelCode: '', name: '', providerCode, thinkingEffort: null },
    ok: saveModel
  })
}
function editModel(mm) {
  store.openModal({
    title: '编辑模型', sub: mm.modelCode, type: 'model', isNew: false, id: mm.id,
    data: {
      modelCode: mm.modelCode, name: mm.name, providerCode: mm.providerCode,
      thinkingEffort: mm.thinkingEffort || null
    },
    ok: saveModel
  })
}
async function saveModel(m) {
  await store.withSaving(async () => {
    const body = { ...m.data, thinkingEffort: m.data.thinkingEffort || null }
    if (m.isNew) await modelsApi.create(body)
    else await modelsApi.update(m.id, body)
  })
}

// 模型启停规则（模型测试功能）：
// - 新建默认停用；启用唯一途径 = 「测试并启用」（"你好"连通验证，通过后自动 enabled）
// - 停用手动允许（后端做应用/基础模型引用校验，被引用时 409）
// - 停用后再启用 → 重新走测试
const testingId = ref(null)

/** 测试并启用：成功 toast 提示（含模型回复摘要）；失败 400 文案直接透出 */
async function testModel(mm) {
  if (testingId.value) return
  testingId.value = mm.id
  try {
    const r = await modelsApi.test(mm.id)
    store._toast(`「${mm.modelCode}」连通 OK，已启用`, true)
    if (r.reply) console.log('[模型测试] 回复：', String(r.reply).slice(0, 120))
    await store.refreshLoaded()
  } catch (e) {
    store._toast(`「${mm.modelCode}」测试失败：${e.message}`)
  } finally {
    testingId.value = null
  }
}

/** 停用模型（后端引用校验：被应用绑定/设为基础模型时 409 提示） */
async function disableModel(mm) {
  await store.withSaving(() => modelsApi.update(mm.id, { id: mm.id, name: mm.name, enabled: false }))
}
async function removeModel(mm) {
  if (!confirm(`确认删除模型「${mm.modelCode}」？（有应用引用时将被拒绝）`)) return
  await store.withSaving(() => modelsApi.remove(mm.id))
}
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">厂商与模型</h1>
          <p class="st-panel-desc">模型厂商接入与模型清单</p>
        </div>
        <button class="st-btn st-btn-primary" @click="newProvider">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          新建厂商
        </button>
      </div>

      <div v-if="stats.length" class="st-stats">
        <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
          <span class="st-stat-value">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <div v-for="(p, pi) in providers" :key="p.id" class="st-card st-provider" :style="{ animationDelay: (pi * 50 + 120) + 'ms' }">
      <div class="st-provider-row" :class="{ off: p.enabled === false }" @click="expandedProvider = expandedProvider === p.providerCode ? null : p.providerCode">
        <svg class="st-chevron" :class="{ open: expandedProvider === p.providerCode }" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div class="st-provider-main">
          <div class="st-provider-name mono">{{ p.providerCode }}</div>
          <div class="st-provider-sub">{{ p.name }} · {{ p.baseUrl }}</div>
        </div>
        <span class="st-dot" :class="p.protocol">{{ p.protocol }}</span>
        <span class="st-status" :class="p.enabled === false ? 'off' : 'on'">{{ p.enabled === false ? '停用' : '启用' }}</span>
        <div class="st-row-actions" @click.stop>
          <button v-if="p.enabled !== false" class="st-btn st-btn-ghost" @click="toggleProvider(p)">停用</button>
          <button v-else class="st-btn st-btn-ghost" @click="toggleProvider(p)">启用</button>
          <button class="st-btn st-btn-ghost" @click="editProvider(p)">编辑</button>
          <button class="st-btn st-btn-ghost" @click="newModel(p.providerCode)">+ 模型</button>
          <button class="st-btn st-btn-ghost st-danger" @click="removeProvider(p)">删除</button>
        </div>
      </div>

      <!-- 模型子表 -->
      <div v-if="expandedProvider === p.providerCode" class="st-model-table">
        <div class="st-model-head">
          <span>模型</span><span>显示名</span><span>状态</span><span class="ta-r">操作</span>
        </div>
        <div v-if="!modelsOf(p.providerCode).length" class="st-empty-inline">该厂商暂无模型 · 点上方「+ 模型」添加</div>
        <div v-for="mm in modelsOf(p.providerCode)" :key="mm.id" class="st-model-row" :class="{ off: mm.enabled === false }">
          <span class="mono st-model-code">{{ mm.modelCode }}</span>
          <span class="st-model-name">{{ mm.name }}</span>
          <span class="st-status" :class="mm.enabled === false ? 'off' : 'on'">{{ mm.enabled === false ? '停用' : '启用' }}</span>
          <div class="st-row-actions ta-r">
            <!-- 模型测试功能：停用态 → 测试并启用（"你好"连通验证，通过自动启用）；
                 启用态 → 停用（后端应用引用校验） -->
            <button v-if="mm.enabled !== false" class="st-btn st-btn-ghost" title="停用（被应用引用或设为基础模型时将拒绝）" @click="disableModel(mm)">停用</button>
            <button v-else class="st-btn st-btn-ghost" :disabled="testingId !== null"
                    :title="testingId === mm.id ? '测试中（发送「你好」验证连通）…' : '发送「你好」验证连通，通过后自动启用'"
                    @click="testModel(mm)">
              {{ testingId === mm.id ? '测试中…' : '测试并启用' }}
            </button>
            <button class="st-btn st-btn-ghost" @click="editModel(mm)">编辑</button>
            <button class="st-btn st-btn-ghost st-danger" @click="removeModel(mm)">删除</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="loading" class="st-empty">加载中…</div>
    <div v-else-if="!providers.length" class="st-empty">
      <p>还没有厂商</p>
      <p class="st-empty-sub">接入你的第一个模型厂商（OpenAI / Anthropic 兼容端点即可）</p>
    </div>
  </div>
</template>
