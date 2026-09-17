<script setup>
import { computed, ref, onMounted } from 'vue'
import { mcpApi } from '../../api/mcp'
import { builtinToolsApi } from '../../api/builtin'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'
import { Plus, Lock } from 'lucide-vue-next'

/**
 * MCP 面板：双子 tab 分流（内置工具 / MCP 服务），列表区独立滚动。
 * 服务注册（streamable / stdio；SSE 已废弃存量兼容），启用须先连接测试确认工具列表。
 */
const store = useSettingStore()
// 面板级懒加载：进入面板拉取声明依赖的数据（幂等）
onMounted(() => store.ensure('mcp'))
const { mcpServers, builtinTools, loading, mcpTest } = storeToRefs(store)

const subTab = ref('mcp') // 'mcp' 服务（主场景） | 'builtin' 内置工具

const stats = computed(() => subTab.value === 'builtin'
  ? [
      { label: '内置工具', value: builtinTools.value.length },
      { label: '启用中', value: builtinTools.value.filter(t => t.enabled !== false).length },
      { label: '系统必需', value: builtinTools.value.filter(t => t.required).length },
    ]
  : [
      { label: '服务', value: mcpServers.value.length },
      { label: 'Streamable', value: mcpServers.value.filter(s => (s.type || 'sse') === 'streamable').length },
      { label: 'STDIO', value: mcpServers.value.filter(s => (s.type || 'sse') === 'stdio').length },
    ]
)

/** 内置工具启停（required 系统必需不可停，后端拒绝） */
async function toggleBuiltinTool(t) {
  if (t.required) return
  await store.withSaving(() => builtinToolsApi.setEnabled(t.id, t.enabled === false))
}

/** args JSON 数组 ↔ 多行文本（一行一个参数）互转 */
function argsToText(argsJson) {
  if (!argsJson) return ''
  try {
    const arr = JSON.parse(argsJson)
    return Array.isArray(arr) ? arr.join('\n') : String(argsJson)
  } catch { return String(argsJson) }
}
function textToArgs(text) {
  if (!text || !text.trim()) return null
  return JSON.stringify(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
}

function newMcp() {
  store.openModal({
    title: '新建 MCP 服务', type: 'mcp', isNew: true,
    data: { serverCode: '', name: '', type: 'streamable', url: '', headers: '', command: '', argsText: '', env: '', enabled: false },
    ok: saveMcp
  })
}
function editMcp(s) {
  // enabled 不进编辑表单：启停走列表上的"测试并启用 / 停用"（启用须经连接测试确认）
  store.openModal({
    title: '编辑 MCP 服务', sub: s.serverCode, type: 'mcp', isNew: false, id: s.id,
    data: {
      serverCode: s.serverCode, name: s.name, type: s.type || 'sse', url: s.url || '',
      headers: headersToLines(s.headers),
      command: s.command || '', argsText: argsToText(s.args), env: s.env || ''
    },
    ok: saveMcp
  })
}
/** headers 回填转换：DB 存的 JSON 对象字符串 → key: value 行文本（与输入格式一致）；非法 JSON 原样返回 */
function headersToLines(raw) {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n')
    }
  } catch { /* 非 JSON 原样 */ }
  return String(raw)
}
async function saveMcp(m) {
  await store.withSaving(async () => {
    const stdio = m.data.type === 'stdio'
    const body = stdio
      ? {
          name: m.data.name, type: 'stdio',
          url: null, headers: null,
          command: m.data.command.trim(),
          args: textToArgs(m.data.argsText),
          env: m.data.env && m.data.env.trim() ? m.data.env.trim() : null
        }
      : {
          name: m.data.name, type: m.data.type,
          url: m.data.url.trim(),
          headers: m.data.headers && m.data.headers.trim() ? m.data.headers.trim() : null,
          command: null, args: null, env: null
        }
    if (m.isNew) await mcpApi.create({ ...body, serverCode: m.data.serverCode })
    else await mcpApi.update(m.id, body)
  })
}
async function removeMcp(s) {
  if (!confirm(`确认删除 MCP 服务「${s.serverCode}」？引用它的应用将自动失去该工具`)) return
  await store.withSaving(() => mcpApi.remove(s.id))
}
/** 测试并启用：initialize + 拉取工具列表 → 弹窗展示 → 用户确认后才启用 */
async function testAndEnableMcp(s) {
  mcpTest.value = { server: s, loading: true, result: null, error: '' }
  try {
    const r = await mcpApi.test(
      (s.type || 'sse') === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: s.type || 'sse', url: s.url, headers: s.headers || null }
    )
    mcpTest.value.result = r
  } catch (e) {
    mcpTest.value.error = (e && e.message) || '请求失败'
  } finally {
    mcpTest.value.loading = false
  }
}
async function disableMcp(s) {
  await store.withSaving(() => mcpApi.setEnabled(s.id, false))
}
/** 卡片副标题：stdio 显示 command + 参数数，http 显示 url */
function endpointDesc(s) {
  if ((s.type || 'sse') === 'stdio') {
    let argsCount = 0
    try { argsCount = (JSON.parse(s.args || '[]')).length } catch { /* 忽略 */ }
    return s.command + (argsCount ? ` （${argsCount} 个参数）` : '')
  }
  return s.url
}
</script>

<template>
  <div style="display:flex;flex-direction:column;flex:1;min-height:0;">
    <div class="st-panel-head">
      <div>
        <h1 class="st-h1">工具</h1>
        <p class="st-panel-desc">内置工具与 MCP 服务 · 在本页停用后，即使应用已绑定也无法使用</p>
      </div>
      <button class="st-btn st-btn-primary" @click="newMcp">
        <Plus :size="13" />
        新建服务
      </button>
    </div>

    <!-- 子 tab 分流：固定，不随列表滚动 -->
    <div class="st-subtabs">
      <button class="st-subtab" :class="{ active: subTab === 'mcp' }" @click="subTab = 'mcp'">
        MCP 服务<span class="cnt">{{ mcpServers.length }}</span>
      </button>
      <button class="st-subtab" :class="{ active: subTab === 'builtin' }" @click="subTab = 'builtin'">
        内置工具<span class="cnt">{{ builtinTools.length }}</span>
      </button>
    </div>

    <div v-if="stats.length" class="st-stats">
      <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
        <span class="st-stat-value">{{ s.value }}</span>
        <span class="st-stat-label">{{ s.label }}</span>
      </div>
    </div>

    <!-- 列表区：独立滚动 -->
    <div class="st-list-scroll" style="flex:1;min-height:0;overflow-y:auto;padding-right:4px;">

      <!-- ===== MCP 服务 tab ===== -->
      <template v-if="subTab === 'mcp'">
        <div v-for="(s, si) in mcpServers" :key="s.id" class="st-card st-app-row" :style="{ animationDelay: (si * 50 + 120) + 'ms' }">
          <div class="st-app-main">
            <div class="st-app-name">{{ s.name || s.serverCode }}<span class="mono st-app-code">{{ s.serverCode }}</span></div>
            <div class="st-app-sub">
              <span class="st-dot" :class="(s.type || 'sse') === 'streamable' ? 'anthropic' : ''">{{ s.type || 'sse' }}</span>
              <span class="st-dot" :class="s.enabled ? 'tools' : 'off'">{{ s.enabled ? '已启用' : '已停用' }}</span>
              <span class="mono">{{ endpointDesc(s) }}</span>
              <span v-if="s.headers" class="st-dot tools">Headers</span>
            </div>
          </div>
          <div class="st-row-actions">
            <button v-if="!s.enabled" class="st-btn st-btn-primary" @click="testAndEnableMcp(s)">测试并启用</button>
            <button v-else class="st-btn st-btn-ghost" @click="disableMcp(s)">停用</button>
            <button class="st-btn st-btn-ghost" @click="editMcp(s)">编辑</button>
            <button class="st-btn st-btn-ghost st-danger" @click="removeMcp(s)">删除</button>
          </div>
        </div>
        <div v-if="!mcpServers.length && !loading" class="st-empty">
          <p>还没有 MCP 服务</p>
          <p class="st-empty-sub">注册 Streamable 端点，为应用装配工具</p>
        </div>
      </template>

      <!-- ===== 内置工具 tab ===== -->
      <template v-else>
        <div v-if="builtinTools.length" class="st-builtin-head" style="margin:0 0 8px;">
          平台自带 · 代码播种随版本演进 · 应用白名单绑定启用 · 仅可启停
        </div>
        <div v-for="t in builtinTools" :key="t.id" class="st-card st-app-row">
          <div class="st-app-main">
            <div class="st-app-name">{{ t.name || t.toolCode }}<span class="mono st-app-code">{{ t.toolCode }}</span><span class="st-dot tools">内置</span></div>
            <div class="st-app-sub">
              <span class="st-dot" :class="t.enabled === false ? 'off' : ''">{{ t.enabled === false ? '已停用' : '已启用' }}</span>
              <span v-if="t.required" class="st-dot anthropic">系统必需</span>
              <span style="color:var(--text-3)">{{ (t.description || '').slice(0, 100) }}</span>
            </div>
          </div>
          <div class="st-row-actions">
            <button v-if="!t.required" class="st-btn st-btn-ghost"  @click="toggleBuiltinTool(t)">{{ t.enabled === false ? '启用' : '停用' }}</button>
            <span v-else class="st-dot lock-tag" title="系统必需工具：平台核心流程依赖，禁止停用"><Lock :size="10" /> 受保护</span>
          </div>
        </div>
        <div v-if="!builtinTools.length && !loading" class="st-empty">
          <p>暂无内置工具</p>
          <p class="st-empty-sub">平台能力随版本发布自动注册</p>
        </div>
      </template>
    </div>
  </div>
</template>
