<script setup>
import { ref, computed, onMounted } from 'vue'
import { KeyRound, Plus, Trash2, Copy, Ban, X } from 'lucide-vue-next'
import { appKeyApi } from '../../api/appKeys'

/**
 * 应用嵌出弹窗（16 方案调整版：从应用页"嵌出"操作打开，按应用维度管理密钥）。
 *
 * - 密钥列表：只显示当前应用的（appKey 过滤）
 * - 生成：备注名 + 域名白名单 + 每日配额 → 完整 key 仅一次展示
 * - 管理：吊销/启用、复制接入代码、删除
 */
const props = defineProps({
  app: { type: Object, required: true },   // { appCode, name }
})
const emit = defineEmits(['close'])

const keys = ref([])
const loading = ref(false)
const showForm = ref(false)
const created = ref(null)
const form = ref({ name: '', domains: '', dailyQuota: '' })

async function load() {
  loading.value = true
  try {
    const all = await appKeyApi.list()
    keys.value = all.filter(k => k.appCode === props.app.appCode)
  } catch { /* 列表失败不阻塞 */ } finally {
    loading.value = false
  }
}

async function createKey() {
  if (!form.value.name.trim()) return
  try {
    const rec = await appKeyApi.create({
      appCode: props.app.appCode,
      name: form.value.name.trim(),
      domains: form.value.domains.trim() || null,
      dailyQuota: form.value.dailyQuota ? Number(form.value.dailyQuota) : null,
    })
    created.value = rec
    showForm.value = false
    form.value = { name: '', domains: '', dailyQuota: '' }
    await load()
  } catch (e) {
    alert('生成失败：' + e.message)
  }
}

async function toggleEnabled(k) {
  try { await appKeyApi.update(k.id, { enabled: !k.enabled }); k.enabled = !k.enabled } catch (e) { alert(e.message) }
}

async function removeKey(k) {
  if (!confirm(`确认删除密钥「${k.name}」？删除后嵌入方立即失效。`)) return
  try { await appKeyApi.remove(k.id); await load() } catch (e) { alert(e.message) }
}

function widgetSnippet(key) {
  const origin = window.location.origin
  return `<script src="${origin}/embed/widget.js" data-app-key="${key}" defer><\/script>`
}

async function copyText(text, tip) {
  try { await navigator.clipboard.writeText(text); alert(tip || '已复制') } catch { alert('复制失败（浏览器限制）') }
}

/** 接入示例（最简通用形态）：优先取第一个启用中的真实密钥（复制即用），没有则占位 */
const embedExample = computed(() => {
  const key = keys.value.find(k => k.enabled)?.appKey || '你的app-key'
  const origin = window.location.origin
  return `<!-- 在你的网页底部加入这一行，右下角即出现对话悬浮球 -->\n<script src="${origin}/embed/widget.js" data-app-key="${key}" defer><\/script>`
})

onMounted(load)
</script>

<template>
  <div class="aem-mask" @click.self="emit('close')">
    <div class="aem-card">
      <div class="aem-head">
        <div class="aem-title">
          <KeyRound :size="15" />
          <span>应用嵌出 · {{ app.name }}</span>
        </div>
        <button class="aem-x" @click="emit('close')"><X :size="15" /></button>
      </div>
      <p class="aem-desc">为「{{ app.name }}」生成嵌入密钥：第三方页面一行 script 引入即可挂出对话挂件（对话能力完整，不可切换应用）。密钥绑定本应用，支持域名白名单 / 每日配额 / 吊销。</p>

      <!-- 接入示例（最简通用：一行 script；有启用密钥时为真实可用代码） -->
      <div class="aem-example">
        <div class="aem-example-head">
          <span>接入示例</span>
          <button class="st-btn st-btn-ghost" @click="copyText(embedExample, '接入示例已复制')"><Copy :size="11" /> 复制</button>
        </div>
        <pre class="aem-example-code">{{ embedExample }}</pre>
        <p class="aem-example-note">任意网页均可接入：加入后页面右下角出现悬浮球，点击弹出对话窗口（桌面浮层 / 移动端全屏）。</p>
      </div>

      <!-- 生成入口 -->
      <div class="aem-toolbar">
        <button class="st-btn st-btn-primary" @click="showForm = !showForm"><Plus :size="12" /> 生成密钥</button>
        <span class="aem-count" v-if="keys.length">{{ keys.length }} 个密钥</span>
      </div>

      <!-- 生成表单 -->
      <div v-if="showForm" class="aem-form">
        <div class="aem-row"><label>备注名</label><input v-model="form.name" placeholder="如：合作方A官网" /></div>
        <div class="aem-row"><label>域名白名单</label><input v-model="form.domains" placeholder="https://a.com, https://b.com（留空不限）" /></div>
        <div class="aem-row"><label>每日配额</label><input v-model="form.dailyQuota" type="number" min="0" placeholder="每日对话上限（留空不限）" /></div>
        <div class="aem-form-actions">
          <button class="st-btn st-btn-primary" @click="createKey">生成</button>
          <button class="st-btn st-btn-ghost" @click="showForm = false">取消</button>
        </div>
      </div>

      <!-- 新建成功：完整 key 一次性展示 -->
      <div v-if="created" class="aem-created">
        <div class="aem-created-line">密钥已生成（仅此一次完整展示，请立即复制）：</div>
        <div class="aem-created-key-row">
          <code class="aem-key">{{ created.appKey }}</code>
          <button class="st-btn st-btn-ghost" @click="copyText(created.appKey, '密钥已复制')">复制密钥</button>
          <button class="st-btn st-btn-ghost" @click="copyText(widgetSnippet(created.appKey), '接入代码已复制')">复制接入代码</button>
          <button class="st-btn st-btn-ghost" @click="created = null">关闭</button>
        </div>
      </div>

      <!-- 密钥列表 -->
      <div class="aem-list">
        <div v-for="k in keys" :key="k.id" class="aem-item" :class="{ off: !k.enabled }">
          <div class="aem-item-main">
            <div class="aem-item-title">
              <span>{{ k.name }}</span>
              <code class="aem-key masked">{{ k.appKey.slice(0, 11) }}…</code>
              <span class="st-status" :class="k.enabled ? 'on' : 'off'">{{ k.enabled ? '启用' : '已吊销' }}</span>
            </div>
            <div class="aem-item-meta">
              <span>白名单：{{ k.domains ? k.domains : '不限' }}</span>
              <span>配额：{{ k.dailyQuota ? k.dailyQuota + ' 次/日' : '不限' }}</span>
              <span>过期：{{ k.expireTime ? String(k.expireTime).slice(0, 10) : '永不' }}</span>
            </div>
          </div>
          <div class="aem-item-actions">
            <button class="st-btn st-btn-ghost" @click="toggleEnabled(k)"><Ban :size="11" /> {{ k.enabled ? '吊销' : '启用' }}</button>
            <button class="st-btn st-btn-ghost" title="复制接入代码" @click="copyText(widgetSnippet(k.appKey), '接入代码已复制')"><Copy :size="11" /></button>
            <button class="st-btn st-btn-ghost danger" title="删除" @click="removeKey(k)"><Trash2 :size="11" /></button>
          </div>
        </div>
        <div v-if="!keys.length && !loading" class="aem-empty">还没有密钥——生成一个，把「{{ app.name }}」挂到任意第三方页面。</div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./settings.css"></style>
<style scoped>
.aem-mask { position: fixed; inset: 0; background: rgba(24,24,27,.32); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.aem-card { width: 620px; max-width: calc(100vw - 40px); max-height: 84vh; overflow-y: auto; background: var(--surface, #fff); border-radius: 14px; padding: 18px 20px; box-shadow: 0 20px 60px rgba(24,24,27,.2); }
.aem-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.aem-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
.aem-x { border: none; background: none; cursor: pointer; color: var(--text-3, #A1A1AA); padding: 4px; border-radius: 6px; }
.aem-x:hover { background: #F4F4F5; color: #18181B; }
.aem-desc { font-size: 12px; color: var(--text-3, #A1A1AA); line-height: 1.6; margin: 0 0 12px; }
/* 接入示例区块 */
.aem-example { border: 1px solid var(--border, #E9EAEC); border-radius: 10px; margin-bottom: 12px; background: #FCFCFD; }
.aem-example-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 0; font-size: 12px; font-weight: 600; color: var(--text-2, #52525B); }
.aem-example-code { margin: 8px 12px; padding: 10px 12px; background: #18181B; color: #E4E4E7; border-radius: 8px; font-family: 'Geist Mono', monospace; font-size: 11.5px; line-height: 1.7; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.aem-example-note { margin: 0 12px 10px; font-size: 11.5px; color: var(--text-3, #A1A1AA); line-height: 1.6; }
.aem-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.aem-count { font-size: 11.5px; color: var(--text-3, #A1A1AA); }
.aem-form { border: 1px solid var(--border, #E9EAEC); border-radius: 10px; padding: 12px; margin-bottom: 12px; display: grid; gap: 8px; }
.aem-row { display: grid; grid-template-columns: 76px 1fr; gap: 10px; align-items: center; }
.aem-row label { font-size: 12px; color: var(--text-2, #52525B); }
.aem-row input { border: 1px solid var(--border, #E9EAEC); border-radius: 7px; padding: 6px 10px; font-size: 12.5px; background: var(--surface, #fff); color: var(--text, #18181B); width: 100%; box-sizing: border-box; }
.aem-form-actions { display: flex; gap: 8px; justify-content: flex-end; }
.aem-created { border: 1px solid #A7F3D0; background: #ECFDF5; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.aem-created-line { font-size: 12.5px; color: #065F46; margin-bottom: 8px; }
.aem-created-key-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.aem-key { font-family: 'Geist Mono', monospace; font-size: 11.5px; background: rgba(0,0,0,.06); padding: 3px 8px; border-radius: 5px; word-break: break-all; }
.aem-list { display: grid; gap: 8px; }
.aem-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--border, #E9EAEC); border-radius: 10px; padding: 10px 12px; }
.aem-item.off { opacity: .6; }
.aem-item-title { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 13px; flex-wrap: wrap; }
.aem-item-meta { display: flex; gap: 12px; margin-top: 4px; font-size: 11px; color: var(--text-3, #A1A1AA); flex-wrap: wrap; }
.aem-item-actions { display: flex; gap: 5px; flex-shrink: 0; }
.aem-item-actions .danger:hover { color: var(--red, #EF4444); }
.aem-empty { text-align: center; color: var(--text-3, #A1A1AA); font-size: 12.5px; padding: 22px 0; }
</style>
