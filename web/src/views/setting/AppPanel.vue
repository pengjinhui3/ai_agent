<script setup>
import { computed, ref, onMounted } from 'vue'
import { appsApi } from '../../api/apps'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'
import AppEmbedModal from './AppEmbedModal.vue'

/**
 * 应用面板：应用列表（模型绑定 / MCP / 技能 / 启停），编辑走通用弹窗（详情异步回填）。
 * 嵌出（16 方案调整版）：应用行"嵌出"操作 → AppEmbedModal 按应用维度管理嵌入密钥。
 */
const store = useSettingStore()
// 面板级懒加载：进入面板拉取声明依赖的数据（幂等）
onMounted(() => store.ensure('app'))
const { apps, models, loading, modal } = storeToRefs(store)

/** 当前打开嵌出弹窗的应用（AppEmbedModal） */
const embedApp = ref(null)

const stats = computed(() => {
  const on = apps.value.filter(a => a.enabled).length
  const tools = apps.value.filter(a => a.toolsEnabled).length
  const withSkills = apps.value.filter(a => a.skillsEnabled).length
  return [
    { label: '应用', value: apps.value.length },
    { label: '启用/停用', value: `${on}/${apps.value.length - on}` },
    { label: '带工具', value: tools },
    { label: '带技能', value: withSkills },
  ]
})

function newApp() {
  store.openModal({
    title: '新建应用', type: 'app', isNew: true,
    data: { appCode: '', name: '', modelId: null, systemPrompt: '', mcpTools: requiredBuiltinCodes(), skillsInject: [], skillsCatalog: [], enabled: true },
    ok: saveApp
  })
}
/** 必选内置工具编码（后端必挂；UI 预勾选保证展示与实际一致） */
function requiredBuiltinCodes() {
  return store.builtinTools.filter(t => t.required && t.enabled !== false).map(t => t.toolCode)
}
/** 编辑应用：先开弹窗（基础字段），异步拉详情回填 MCP/提示词/skills（已绑定状态直观可见） */
async function editApp(a) {
  store.openModal({
    title: '编辑应用', sub: a.name, type: 'app', isNew: false, id: a.id,
    data: { appCode: a.appCode, name: a.name, modelId: a.modelId, systemPrompt: '', mcpTools: [], skillsInject: [], skillsCatalog: [], enabled: a.enabled !== false, _loadingDetail: true },
    ok: saveApp
  })
  try {
    const detail = await appsApi.detail(a.appCode)
    const m = modal.value
    if (!m || m.type !== 'app' || m.data.appCode !== a.appCode) return // 弹窗已关/已切换
    m.data.systemPrompt = detail.systemPrompt || ''
    try { m.data.mcpTools = detail.mcpTools ? JSON.parse(detail.mcpTools) : [] } catch { m.data.mcpTools = [] }
    // 必选内置工具强制入列（旧数据可能未含，保证 UI 与后端行为一致）
    m.data.mcpTools = [...new Set([...m.data.mcpTools, ...requiredBuiltinCodes()])]
    // skills 双模式拆分回填（["a"] → inject；[{"code":"b","mode":"catalog"}] → catalog）
    m.data.skillsInject = []
    m.data.skillsCatalog = []
    try {
      const arr = detail.skills ? JSON.parse(detail.skills) : []
      for (const el of arr) {
        if (typeof el === 'string') m.data.skillsInject.push(el)
        else if (el && el.code) (el.mode === 'catalog' ? m.data.skillsCatalog : m.data.skillsInject).push(el.code)
      }
    } catch { /* 脏数据忽略 */ }
    m.data._loadingDetail = false
  } catch (e) {
    store.showMsg('详情加载失败：' + e.message)
    if (modal.value?.data) modal.value.data._loadingDetail = false
  }
}
async function saveApp(m) {
  await store.withSaving(async () => {
    // 双模式合并为绑定数组：字符串=inject（兼容），对象带 mode
    const skills = [
      ...m.data.skillsInject.map(code => ({ code, mode: 'inject' })),
      ...m.data.skillsCatalog.map(code => ({ code, mode: 'catalog' }))
    ]
    const body = {
      name: m.data.name,
      modelId: m.data.modelId,
      systemPrompt: m.data.systemPrompt || '',
      mcpTools: JSON.stringify(m.data.mcpTools || []),
      skills: JSON.stringify(skills),
      enabled: m.data.enabled !== false
    }
    if (m.isNew) {
      body.appCode = m.data.appCode
      await appsApi.create(body)
    } else {
      await appsApi.update(m.id, body)
    }
  })
}
async function toggleApp(a) {
  await store.withSaving(() => appsApi.setEnabled(a.id, !a.enabled))
}
async function removeApp(a) {
  if (!confirm(`确认删除应用「${a.name}」？`)) return
  await store.withSaving(() => appsApi.remove(a.id))
}
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">应用</h1>
          <p class="st-panel-desc">对话入口与绑定配置</p>
        </div>
        <button class="st-btn st-btn-primary" @click="newApp">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          新建应用
        </button>
      </div>

      <div v-if="stats.length" class="st-stats">
        <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
          <span class="st-stat-value">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <div v-for="(a, ai) in apps" :key="a.id" class="st-card st-app-row" :class="{ off: !a.enabled }" :style="{ animationDelay: (ai * 50 + 120) + 'ms' }">
      <div class="st-app-main">
        <div class="st-app-name">{{ a.name }}<span class="mono st-app-code">{{ a.appCode }}</span></div>
        <div class="st-app-sub">
          <span class="st-dot" :class="a.protocol">{{ a.protocol }}</span>
          <span class="mono">{{ a.provider }} / {{ a.model }}</span>
          <span v-if="a.toolsEnabled" class="st-dot tools">MCP</span>
          <span v-if="a.skillsEnabled" class="st-dot anthropic">技能</span>
        </div>
      </div>
      <span class="st-status" :class="a.enabled ? 'on' : 'off'">{{ a.enabled ? '启用' : '停用' }}</span>
      <div class="st-row-actions">
        <button class="st-btn st-btn-ghost" @click="toggleApp(a)">{{ a.enabled ? '停用' : '启用' }}</button>
        <button class="st-btn st-btn-ghost" @click="editApp(a)">编辑</button>
        <button class="st-btn st-btn-ghost" @click="embedApp = a">嵌出</button>
        <button class="st-btn st-btn-ghost st-danger" @click="removeApp(a)">删除</button>
      </div>
    </div>
    <div v-if="!apps.length && !loading" class="st-empty">
      <p>还没有应用</p>
      <p class="st-empty-sub">创建一个应用，绑定模型即可开始对话</p>
    </div>

    <!-- 应用嵌出弹窗（16 方案：按应用维度管理嵌入密钥） -->
    <AppEmbedModal v-if="embedApp" :app="embedApp" @close="embedApp = null" />
  </div>
</template>
