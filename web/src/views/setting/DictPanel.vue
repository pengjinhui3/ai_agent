<script setup>
import { computed, ref, onMounted } from 'vue'
import { dictApi } from '../../api/dict'
import { useSettingStore } from '../../stores/setting'

/**
 * 字典配置面板（第 5 位，10 方案）：类型列表 → 选中类型的值表格 CRUD。
 * 字典数据不入 store——组件本地状态 + 实时拉取（进入面板加载，CRUD 后刷新本地面）。
 * thinking_effort 档位被运行时消费（思考档位换算），thinking_effort 相关下拉走全局
 * getDictData(type)（stores/setting.js 导出，实时查询不缓存）。
 */
const store = useSettingStore()

// ---- 字典本地状态（实时拉取，非 store） ----
const dictTypes = ref([])
const dictData = ref([])
const localLoading = ref(false)

async function loadDicts() {
  localLoading.value = true
  try {
    const [t, d] = await Promise.all([dictApi.listTypes(), dictApi.listData()])
    dictTypes.value = t.types || []
    dictData.value = d.data || []
  } catch (e) {
    store._toast('字典加载失败：' + e.message)
  } finally {
    localLoading.value = false
  }
}
onMounted(loadDicts)

/** 字典 CRUD 后刷新本地数据（不走 store.withSaving 的 refreshLoaded） */
async function withDictSaving(fn) {
  store.saving = true
  try {
    await fn()
    store.modal = null
    await loadDicts()
    store._toast('已保存', true)
  } catch (e) {
    store._toast(e.message)
  } finally {
    store.saving = false
  }
}

const selectedType = ref(null)

const stats = computed(() => [
  { label: '字典类型', value: dictTypes.value.length },
  { label: '字典值', value: dictData.value.length },
  { label: '默认档', value: dictData.value.filter(d => d.isDefault === 'Y').length },
])

/** 选中类型的值列表（sort 升序） */
const currentValues = computed(() => {
  if (!selectedType.value) return []
  return dictData.value
    .filter(d => d.dictType === selectedType.value.dictType)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
})

/** 每类型值数量角标 */
function countOf(dictType) {
  return dictData.value.filter(d => d.dictType === dictType).length
}

function newType() {
  store.openModal({
    title: '新增字典类型', type: 'dictType', isNew: true,
    data: { dictName: '', dictType: '', remark: '' },
    ok: saveType
  })
}
function editType(t) {
  store.openModal({
    title: '编辑字典类型', sub: t.dictType, type: 'dictType', isNew: false, id: t.dictId,
    data: { dictName: t.dictName, dictType: t.dictType, remark: t.remark || '' },
    ok: saveType
  })
}
async function saveType(m) {
  await withDictSaving(async () => {
    const body = { dictName: m.data.dictName, remark: m.data.remark }
    if (m.isNew) body.dictType = m.data.dictType
    if (m.isNew) await dictApi.createType(body)
    else await dictApi.updateType(m.id, body)
  })
}
async function removeType(t) {
  const n = countOf(t.dictType)
  if (!confirm(`确认删除字典类型「${t.dictName}」？${n ? `（含 ${n} 个值，将被拒绝）` : ''}`)) return
  await withDictSaving(() => dictApi.removeType(t.dictId))
}

function newValue() {
  if (!selectedType.value) return
  store.openModal({
    title: `新增字典值 · ${selectedType.value.dictName}`, type: 'dictData', isNew: true,
    data: { dictLabel: '', dictValue: '', isDefault: 'N', sort: 0, remark: '' },
    ok: saveValue
  })
}
function editValue(d) {
  store.openModal({
    title: `编辑字典值 · ${d.dictType}`, type: 'dictData', isNew: false, id: d.dictCode,
    data: { dictLabel: d.dictLabel, dictValue: d.dictValue, isDefault: d.isDefault, sort: d.sort, remark: d.remark || '' },
    ok: saveValue
  })
}
async function saveValue(m) {
  await withDictSaving(async () => {
    const body = {
      dictType: selectedType.value ? selectedType.value.dictType : m.data.dictType,
      dictLabel: m.data.dictLabel, dictValue: m.data.dictValue,
      isDefault: m.data.isDefault === 'Y' ? 'Y' : 'N',
      sort: Number(m.data.sort) || 0, remark: m.data.remark
    }
    if (m.isNew) await dictApi.createData(body)
    else await dictApi.updateData(m.id, body)
  })
}
async function removeValue(d) {
  if (!confirm(`确认删除字典值「${d.dictLabel}」？`)) return
  await withDictSaving(() => dictApi.removeData(d.dictCode))
}
</script>

<template>
  <div style="display:flex;flex-direction:column;flex:1;min-height:0;">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">字典配置</h1>
          <p class="st-panel-desc">枚举值集中管理（改动即时生效）</p>
        </div>
        <button class="st-btn st-btn-primary" @click="newType">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          新增类型
        </button>
      </div>

      <div v-if="stats.length" class="st-stats">
        <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
          <span class="st-stat-value">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <div class="st-list-scroll" style="flex:1;min-height:0;overflow-y:auto;padding-right:4px;">
      <!-- 类型卡片列表 -->
      <div v-for="t in dictTypes" :key="t.dictId"
           class="st-card st-app-row" style="cursor:pointer;"
           :class="{ '': true }"
           :style="selectedType && selectedType.dictId === t.dictId ? 'border-color:var(--text);box-shadow:0 1px 3px rgba(24,24,27,0.1);' : ''"
           @click="selectedType = t">
        <div class="st-app-main">
          <div class="st-app-name">{{ t.dictName }}<span class="mono st-app-code">{{ t.dictType }}</span>
            <span class="st-dot tools">{{ countOf(t.dictType) }} 值</span>
          </div>
          <div class="st-app-sub" v-if="t.remark">
            <span style="color:var(--text-3)">{{ t.remark.slice(0, 90) }}</span>
          </div>
        </div>
        <div class="st-row-actions" @click.stop>
          <button class="st-btn st-btn-ghost" @click="editType(t)">编辑</button>
          <button class="st-btn st-btn-ghost st-danger" @click="removeType(t)">删除</button>
        </div>
      </div>
      <div v-if="!dictTypes.length && !localLoading" class="st-empty">
        <p>还没有字典类型</p>
        <p class="st-empty-sub">思考档位（thinking_effort）由系统启动时自动播种</p>
      </div>

      <!-- 选中类型的值表格 -->
      <template v-if="selectedType">
        <div class="st-builtin-head" style="margin-top:14px;">
          {{ selectedType.dictName }} · 字典值
          <span class="st-form-hint-inline">label = 前端展示 / OpenAI 传参值；value = Anthropic 换算值（如 budget_tokens）</span>
        </div>
        <div class="st-card" style="overflow:hidden;">
          <div class="st-model-head" style="grid-template-columns:1.1fr 1fr 70px 60px auto;">
            <span>标签 label</span><span>值 value</span><span>默认</span><span>排序</span><span class="ta-r">操作</span>
          </div>
          <div v-if="!currentValues.length" class="st-empty-inline" style="padding-left:16px;">该类型暂无值</div>
          <div v-for="d in currentValues" :key="d.dictCode" class="st-model-row" style="grid-template-columns:1.1fr 1fr 70px 60px auto;">
            <span class="mono" style="font-size:12.5px;">{{ d.dictLabel }}</span>
            <span class="mono" style="font-size:12.5px;color:var(--text-2);">{{ d.dictValue === '' ? '（空）' : d.dictValue }}</span>
            <span class="st-dot" :class="d.isDefault === 'Y' ? 'tools' : 'off'">{{ d.isDefault === 'Y' ? '默认' : '—' }}</span>
            <span style="font-size:12px;color:var(--text-3);">{{ d.sort }}</span>
            <div class="st-row-actions ta-r">
              <button class="st-btn st-btn-ghost" @click="editValue(d)">编辑</button>
              <button class="st-btn st-btn-ghost st-danger" @click="removeValue(d)">删除</button>
            </div>
          </div>
        </div>
        <button class="st-btn st-btn-primary" style="margin-top:10px;" @click="newValue">+ 新增值</button>
      </template>
    </div>
  </div>
</template>
