<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { BookOpen, Plus, Trash2, FileText, Loader2, CircleCheck, CircleAlert, Hourglass } from 'lucide-vue-next'
import { kbApi } from '../../api/kb.js'

/**
 * 知识库面板（18 号方案 MVP：仅文档管理 + 上传 + 删除）。
 * - 上传后异步管道处理（pending → vectorizing → ready/failed），有非终态时轮询刷新
 * - 检索测试/块预览/配置区为将来增强（方案 §八），MVP 不做
 */
const docs = ref([])
const loading = ref(false)
const uploading = ref(false)
const fileEl = ref(null)
const msg = ref('')
let pollTimer = null

const stats = computed(() => {
  const ready = docs.value.filter(d => d.status === 'ready').length
  const failed = docs.value.filter(d => d.status === 'failed').length
  const chunks = docs.value.reduce((s, d) => s + (d.status === 'ready' ? d.chunk_count : 0), 0)
  return [
    { label: '文档', value: docs.value.length },
    { label: '已就绪', value: ready },
    { label: '内容块', value: chunks },
    { label: '失败', value: failed },
  ]
})

const hasProcessing = computed(() => docs.value.some(d => d.status === 'pending' || d.status === 'vectorizing'))

/** KB 可用性（读配置字段：未配置/未测试启用/正常）：load 时并行拉取 */
const kbEnabled = ref(true)
const kbReason = ref('')
const kbDisabledTip = computed(() => kbReason.value === 'not_configured'
  ? '向量模型未配置——上传与检索均不可用。'
  : kbReason.value === 'disabled'
    ? '知识库未通过测试启用（地址已配但未启用）。'
    : '知识库不可用——请到系统设置检查配置。')

async function load() {
  loading.value = true
  try {
    const [list, st] = await Promise.all([
      kbApi.list().catch(() => []),
      kbApi.status().catch(() => null),
    ])
    docs.value = list
    if (st) { kbEnabled.value = st.enabled; kbReason.value = st.reason }
  } catch (e) {
    msg.value = '加载失败：' + (e?.response?.data?.error || e.message)
  } finally {
    loading.value = false
  }
}

function schedulePoll() {
  stopPoll()
  pollTimer = setInterval(() => {
    if (hasProcessing.value) load()
    else stopPoll()
  }, 3000)
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  uploading.value = true
  msg.value = ''
  for (const f of files) {
    try {
      await kbApi.upload(f)
    } catch (err) {
      msg.value = `「${f.name}」上传失败：` + (err?.response?.data?.error || err.message)
    }
  }
  uploading.value = false
  await load()
  schedulePoll()
}

async function removeDoc(d) {
  if (!confirm(`确认删除「${d.title}」？其内容块将一并删除。`)) return
  try {
    await kbApi.remove(d.id)
    if (expandedId.value === d.id) expandedId.value = null
    await load()
  } catch (e) {
    msg.value = '删除失败：' + (e?.response?.data?.error || e.message)
  }
}

// ---------- 块预览（点击文档行展开：seq + 内容，懒加载缓存） ----------
const expandedId = ref(null)
const chunksByDoc = ref({})
const chunksLoading = ref(false)

async function toggleChunks(d) {
  if (expandedId.value === d.id) { expandedId.value = null; return }
  expandedId.value = d.id
  if (!chunksByDoc.value[d.id]) {
    chunksLoading.value = true
    try {
      chunksByDoc.value[d.id] = await kbApi.chunks(d.id)
    } catch (e) {
      msg.value = '分块加载失败：' + (e?.response?.data?.error || e.message)
      expandedId.value = null
    } finally {
      chunksLoading.value = false
    }
  }
}

function statusMeta(s) {
  return {
    pending: { label: '排队中', icon: Hourglass, cls: 'wait' },
    vectorizing: { label: '向量化中', icon: Loader2, cls: 'run' },
    ready: { label: '已就绪', icon: CircleCheck, cls: 'ok' },
    failed: { label: '失败', icon: CircleAlert, cls: 'fail' },
  }[s] || { label: s, icon: Hourglass, cls: 'wait' }
}

onMounted(() => { load() })
onBeforeUnmount(stopPoll)
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">知识库</h1>
          <p class="st-panel-desc">上传文档向量化入库，对话中模型自动检索引用（MD / TXT / CSV）</p>
        </div>
        <input ref="fileEl" type="file" accept=".md,.txt,.csv" multiple class="kb-file-input" @change="onFileChange" />
        <button class="st-btn st-btn-primary" :disabled="uploading || !kbEnabled" :title="kbEnabled ? '' : kbDisabledTip" @click="fileEl?.click()">
          <Loader2 v-if="uploading" :size="13" class="kb-spin" />
          <Plus v-else :size="13" />
          上传文档
        </button>
      </div>

      <!-- KB 不可用横幅：未配置 / 未测试启用 → 功能禁用（辉哥 2026-09-17 定调） -->
      <div v-if="!kbEnabled && !loading" class="st-card kb-disabled-banner">
        <strong>知识库未启用</strong>
        <span>{{ kbDisabledTip }}</span>
        <span style="font-size:11px;color:var(--text-3);">到「系统设置 → 知识库配置」填写地址后点「测试并启用」。</span>
      </div>

      <div v-if="stats.length" class="st-stats">
        <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
          <span class="st-stat-value">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>

      <p v-if="msg" class="kb-msg">{{ msg }}</p>
    </div>

    <div v-for="d in docs" :key="d.id" class="kb-doc-wrap">
      <div class="st-card kb-doc-row" :class="{ expanded: expandedId === d.id }">
        <div class="kb-doc-main kb-doc-click" :title="expandedId === d.id ? '收起分块' : '点击查看分块'" @click="d.status === 'ready' && toggleChunks(d)">
          <div class="kb-doc-title">
            <FileText :size="14" class="kb-doc-icon" />
            <span>{{ d.title }}</span>
            <span class="kb-type-badge">{{ (d.source_type || '').toUpperCase() }}</span>
          </div>
          <div class="kb-doc-meta">
            <span class="kb-status" :class="statusMeta(d.status).cls">
              <component :is="statusMeta(d.status).icon" :size="11" :class="{ 'kb-spin': d.status === 'vectorizing' }" />
              {{ statusMeta(d.status).label }}
            </span>
            <span>{{ d.chunk_count }} 块</span>
            <span>{{ new Date(d.create_time).toLocaleString('zh-CN', { hour12: false }) }}</span>
            <span v-if="d.status === 'failed' && d.error_message" class="kb-err" :title="d.error_message">{{ d.error_message.slice(0, 80) }}</span>
          </div>
        </div>
        <div class="st-row-actions" v-if="expandedId !== d.id">
          <button v-if="d.status === 'ready'" class="st-btn st-btn-ghost" @click="toggleChunks(d)">分块</button>
          <button class="st-btn st-btn-ghost st-danger" @click="removeDoc(d)"><Trash2 :size="11" /> 删除</button>
        </div>
        <div class="st-row-actions" v-else>
          <button class="st-btn st-btn-ghost" @click="toggleChunks(d)">收起</button>
          <button class="st-btn st-btn-ghost st-danger" @click="removeDoc(d)"><Trash2 :size="11" /> 删除</button>
        </div>
      </div>
      <!-- 分块明细（懒加载，展开显示） -->
      <div v-if="expandedId === d.id" class="st-card kb-chunks-card">
        <div v-if="chunksLoading" class="kb-chunks-hint">加载分块中…</div>
        <template v-else>
          <div class="kb-chunks-head">共 {{ (chunksByDoc[d.id] || []).length }} 块（检索时的最小单元）</div>
          <div class="kb-chunks-list">
            <div v-for="ch in chunksByDoc[d.id]" :key="ch.seq" class="kb-chunk">
              <span class="kb-chunk-seq">{{ ch.seq }}</span>
              <pre class="kb-chunk-content">{{ ch.content }}</pre>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div v-if="!docs.length && !loading" class="st-empty">
      <BookOpen :size="30" class="kb-empty-icon" />
      <p>还没有文档</p>
      <p class="st-empty-sub">上传 MD / TXT / CSV 文档，向量化后对话即可检索引用</p>
    </div>
  </div>
</template>

<style scoped src="./settings.css"></style>
<style scoped>
.kb-file-input { display: none; }
.kb-disabled-banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; margin: 0 0 10px; font-size: 12.5px; color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A; }
.kb-disabled-banner strong { font-size: 13px; }
.kb-spin { animation: kb-spin 1s linear infinite; }
@keyframes kb-spin { to { transform: rotate(360deg) } }
.kb-msg { font-size: 12px; color: #DC2626; margin: 0 0 8px; }
.kb-doc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; margin-bottom: 0; }
.kb-doc-main { flex: 1; min-width: 0; }
.kb-doc-wrap { margin-bottom: 10px; }
.kb-doc-wrap .kb-doc-row { margin-bottom: 0; }
.kb-doc-wrap .kb-doc-row.expanded { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.kb-doc-click { cursor: pointer; border-radius: inherit; }
.kb-doc-click:hover .kb-doc-title span:first-of-type { color: #2563EB; }
/* 分块明细 */
.kb-chunks-card { border-top: none; border-top-left-radius: 0; border-top-right-radius: 0; padding: 12px 16px; }
.kb-chunks-head { font-size: 11.5px; color: var(--text-3, #A1A1AA); margin-bottom: 8px; }
.kb-chunks-hint { font-size: 12px; color: var(--text-3, #A1A1AA); padding: 8px 0; }
.kb-chunks-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.kb-chunk { display: flex; gap: 9px; align-items: flex-start; }
.kb-chunk-seq { flex-shrink: 0; min-width: 20px; height: 20px; border-radius: 5px; background: #EEF2FF; color: #4338CA; font-size: 10.5px; font-weight: 600; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
.kb-chunk-content { flex: 1; margin: 0; font-family: 'Geist Mono', monospace; font-size: 11px; line-height: 1.65; color: var(--text-2, #52525B); white-space: pre-wrap; word-break: break-word; background: #F8F9FA; border-radius: 7px; padding: 8px 10px; max-height: 170px; overflow-y: auto; }
.kb-doc-title { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 500; }
.kb-doc-icon { color: var(--text-3, #A1A1AA); flex-shrink: 0; }
.kb-type-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: #EEF2FF; color: #4338CA; font-weight: 600; }
.kb-doc-meta { display: flex; align-items: center; gap: 12px; margin-top: 5px; font-size: 11.5px; color: var(--text-3, #A1A1AA); flex-wrap: wrap; }
.kb-status { display: inline-flex; align-items: center; gap: 4px; }
.kb-status.ok { color: #059669; }
.kb-status.run { color: #B45309; }
.kb-status.fail { color: #DC2626; }
.kb-status.wait { color: var(--text-3, #A1A1AA); }
.kb-err { color: #DC2626; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-empty-icon { color: var(--text-3, #A1A1AA); margin-bottom: 8px; }
</style>
