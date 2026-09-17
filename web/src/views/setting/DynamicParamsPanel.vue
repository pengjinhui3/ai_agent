<script setup>
import { computed, onMounted, ref } from 'vue'
import { systemConfigApi } from '../../api/dict'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'

/**
 * 动态参数面板：ai_sys_config 普通 kv 参数的增删改查。
 * - 内置参数（运行参数/基础模型，is_builtin=1）：可改值、不可删、名称由代码注册锁定；
 * - 自定义参数：可增删改（key 创建后不可改）。
 * 消费方式由业务代码自行约定（getInt/getValue，无联动校验）。
 */
const store = useSettingStore()
onMounted(() => store.ensure('dynParam'))
const { systemConfigs, loading } = storeToRefs(store)

const stats = computed(() => [
  { label: '参数', value: systemConfigs.value.length },
  { label: '内置', value: systemConfigs.value.filter(c => c.isBuiltin !== false && c.isBuiltin !== 0).length },
  { label: '自定义', value: systemConfigs.value.filter(c => c.isBuiltin === false || c.isBuiltin === 0).length },
])

function isBuiltin(c) {
  return c.isBuiltin !== false && c.isBuiltin !== 0
}

// ---------- CRUD（SettingsModal 'config' 表单类型） ----------
function newParam() {
  store.openModal({
    title: '新增参数', type: 'config', isNew: true,
    data: { configKey: '', configName: '', configValue: '' },
    ok: saveParam
  })
}
function editParam(c) {
  store.openModal({
    title: '编辑参数', sub: c.configKey, type: 'config', isNew: false, id: c.id, builtin: isBuiltin(c),
    data: { configKey: c.configKey, configName: c.configName, configValue: c.configValue || '' },
    ok: saveParam
  })
}
async function saveParam(m) {
  await store.withSaving(async () => {
    if (m.isNew) {
      await systemConfigApi.createParam(m.data)
    } else {
      await systemConfigApi.updateParam(m.id, m.data)
    }
    await store.refreshLoaded()
  })
}
async function removeParam(c) {
  if (!confirm(`确认删除参数「${c.configName}（${c.configKey}）」？`)) return
  await store.withSaving(async () => {
    await systemConfigApi.removeParam(c.id)
    await store.refreshLoaded()
  })
}

const keyword = ref('')
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return systemConfigs.value
  return systemConfigs.value.filter(c =>
    (c.configKey || '').toLowerCase().includes(k) || (c.configName || '').toLowerCase().includes(k))
})
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">动态参数</h1>
          <p class="st-panel-desc">普通 kv 配置：内置参数改值即用，自定义参数可增删</p>
        </div>
        <button class="st-btn st-btn-primary" @click="newParam">新增参数</button>
      </div>

      <!-- 统计 -->
      <div class="st-stats">
        <div v-for="s in stats" :key="s.label" class="st-stat">
          <span class="st-stat-num">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>

      <!-- 搜索 -->
      <input v-model="keyword" class="st-search" placeholder="按名称 / 键搜索…" />
    </div>

    <!-- 参数列表 -->
    <div class="st-card" style="padding:4px;">
      <div class="st-dyparam-head">
        <span>名称</span><span>键</span><span>值</span><span>类型</span><span class="ta-r">操作</span>
      </div>
      <div v-if="!filtered.length && !loading" class="st-empty-inline">暂无参数 · 点上方「新增参数」添加</div>
      <div v-for="c in filtered" :key="c.id" class="st-dyparam-row">
        <span class="st-dyparam-name">
          {{ c.configName }}
          <span v-if="c.remark" class="st-dyparam-remark" :title="c.remark">{{ c.remark }}</span>
        </span>
        <span class="mono st-dyparam-key">{{ c.configKey }}</span>
        <span class="mono st-dyparam-value" :title="c.configValue">{{ c.configValue || '（空）' }}</span>
        <span><span class="st-dot" :class="isBuiltin(c) ? 'tools' : ''">{{ isBuiltin(c) ? '内置' : '自定义' }}</span></span>
        <div class="st-row-actions ta-r">
          <button class="st-btn st-btn-ghost" @click="editParam(c)">编辑</button>
          <button class="st-btn st-btn-ghost st-danger" :disabled="isBuiltin(c)"
                  :title="isBuiltin(c) ? '内置配置不可删除' : ''" @click="removeParam(c)">删除</button>
        </div>
      </div>
    </div>
    <div v-if="loading" class="st-empty">加载中…</div>
  </div>
</template>

<style scoped>
.st-search {
  width: 100%; height: 36px; box-sizing: border-box; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: 9px;
  padding: 0 12px; font-size: 13px; outline: none;
  background: var(--surface); color: var(--text); font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.st-search:focus { border-color: #6366F1; box-shadow: 0 0 0 3px var(--ring); }
.st-dyparam-head, .st-dyparam-row {
  display: grid; grid-template-columns: 1.2fr 1.4fr 1.6fr 64px 132px;
  gap: 8px; align-items: center; padding: 8px 12px;
}
.st-dyparam-head {
  font-size: 11.5px; color: var(--text-3); border-bottom: 1px solid var(--border);
}
.st-dyparam-row { border-bottom: 1px solid var(--border); transition: background 0.12s ease; }
.st-dyparam-row:last-child { border-bottom: none; }
.st-dyparam-row:hover { background: var(--bg); }
.st-dyparam-name { font-size: 13px; font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-dyparam-remark { display: block; font-size: 11px; font-weight: 400; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.st-dyparam-key { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-dyparam-value { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) {
  .st-dyparam-head, .st-dyparam-row { grid-template-columns: 1fr 1fr 80px; }
  .st-dyparam-head span:nth-child(2), .st-dyparam-row .st-dyparam-key,
  .st-dyparam-head span:nth-child(4), .st-dyparam-row span:nth-child(4) { display: none; }
}
</style>
