<script setup>
import { computed, ref, onMounted } from 'vue'
import { skillsApi } from '../../api/skills'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'
import { Plus, Lock } from 'lucide-vue-next'

/**
 * 技能面板：双子 tab 分流（用户技能 / 内置技能，对齐工具页模式）；
 * 内置技能 = 平台预定义资产（不允许修改/停用/删除，剧本体系稳定依赖面）；
 * 用户技能可全生命周期管理；应用绑定后编排时注入 system prompt。
 */
const store = useSettingStore()
// 面板级懒加载：进入面板拉取声明依赖的数据（幂等）
onMounted(() => store.ensure('skill'))
const { skills, apps, loading } = storeToRefs(store)

/** 子 tab：user 用户技能（主场景）| builtin 内置技能 */
const subTab = ref('user')

/** 当前 tab 的技能列表 */
const filteredSkills = computed(() => skills.value.filter(s =>
  subTab.value === 'builtin' ? s.skillType === 'builtin' : s.skillType !== 'builtin'
))

const stats = computed(() => {
  const builtin = skills.value.filter(s => s.skillType === 'builtin')
  const user = skills.value.filter(s => s.skillType !== 'builtin')
  const userOn = user.filter(s => s.enabled !== false).length
  const totalChars = skills.value.reduce((n, s) => n + (s.content ? s.content.length : 0), 0)
  return [
    { label: '技能总数', value: skills.value.length },
    { label: '用户/内置', value: `${user.length}/${builtin.length}` },
    { label: '用户启用', value: `${userOn}/${user.length}` },
    { label: '总字数', value: totalChars },
  ]
})

function newSkill() {
  store.openModal({
    title: '新建技能', type: 'skill', isNew: true,
    data: { skillCode: '', name: '', description: '', content: '', enabled: true },
    ok: saveSkill
  })
}
function editSkill(s) {
  store.openModal({
    title: '编辑技能', sub: s.skillCode, type: 'skill', isNew: false, id: s.id,
    data: { skillCode: s.skillCode, name: s.name, description: s.description || '', content: s.content || '' },
    ok: saveSkill
  })
}
async function saveSkill(m) {
  await store.withSaving(async () => {
    const body = { ...m.data }
    if (m.isNew) await skillsApi.create(body)
    else await skillsApi.update(m.id, body)
  })
}
async function removeSkill(s) {
  if (!confirm(`确认删除技能「${s.skillCode}」？被应用绑定时将被拒绝`)) return
  await store.withSaving(() => skillsApi.remove(s.id))
}
async function toggleSkill(s) {
  await store.withSaving(() => skillsApi.setEnabled(s.id, s.enabled === false))
}
/** 应用绑定技能的显示辅助 */
function skillBoundCount(code) {
  return apps.value.filter(a => {
    try { return (a.skills ? JSON.parse(a.skills) : []).includes(code) } catch { return false }
  }).length
}
</script>

<template>
  <div class="st-panel-scroll">
    <div class="st-panel-fixed">
      <div class="st-panel-head">
        <div>
          <h1 class="st-h1">技能</h1>
          <p class="st-panel-desc">工作技能指导文档 · 在本页停用后，即使应用已绑定也无法使用</p>
        </div>
        <button v-if="subTab === 'user'" class="st-btn st-btn-primary" @click="newSkill">
          <Plus :size="13" />
          新建技能
        </button>
      </div>

      <!-- 子 tab 分流：固定，不随列表滚动 -->
      <div class="st-subtabs">
        <button class="st-subtab" :class="{ active: subTab === 'user' }" @click="subTab = 'user'">
          用户技能<span class="cnt">{{ skills.filter(s => s.skillType !== 'builtin').length }}</span>
        </button>
        <button class="st-subtab" :class="{ active: subTab === 'builtin' }" @click="subTab = 'builtin'">
          内置技能<span class="cnt">{{ skills.filter(s => s.skillType === 'builtin').length }}</span>
        </button>
      </div>

      <div v-if="stats.length" class="st-stats">
        <div v-for="(s, i) in stats" :key="s.label" class="st-stat" :style="{ animationDelay: (i * 40) + 'ms' }">
          <span class="st-stat-value">{{ s.value }}</span>
          <span class="st-stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <div v-if="filteredSkills.length" class="st-builtin-head" style="margin:0 0 8px;">
      <template v-if="subTab === 'builtin'">平台预定义 · 随版本演进 · 剧本体系的稳定依赖面 · 不允许修改/停用/删除</template>
      <template v-else>用户沉淀的工作指导 · 可编辑启停删除 · 应用绑定后注入</template>
    </div>
    <div v-for="(s, si) in filteredSkills" :key="s.id" class="st-card st-app-row" :style="{ animationDelay: (si * 50 + 120) + 'ms' }">
      <div class="st-app-main">
        <div class="st-app-name">{{ s.name || s.skillCode }}<span class="mono st-app-code">{{ s.skillCode }}</span><span v-if="s.skillType === 'builtin'" class="st-dot tools">内置</span></div>
        <div class="st-app-sub">
          <span class="st-dot" :class="s.enabled === false ? 'off' : ''">{{ s.enabled === false ? '已停用' : '已启用' }}</span>
          <span class="st-dot tools" v-if="skillBoundCount(s.skillCode)">被 {{ skillBoundCount(s.skillCode) }} 个应用绑定</span>
          <span class="mono">{{ (s.content || '').length }} 字</span>
        </div>
        <div class="st-app-sub" style="margin-top:4px">
          <span style="color:var(--text-3)">{{ (s.description || '').slice(0, 120) }}</span>
        </div>
      </div>
      <div class="st-row-actions">
        <button v-if="s.skillType !== 'builtin'" class="st-btn st-btn-ghost" @click="toggleSkill(s)">{{ s.enabled === false ? '启用' : '停用' }}</button>
        <span v-else class="st-dot lock-tag" title="平台预定义资产：不允许修改、停用、删除（剧本体系的稳定依赖面）"><Lock :size="10" /> 受保护</span>
        <template v-if="s.skillType !== 'builtin'">
          <button class="st-btn st-btn-ghost" @click="editSkill(s)">编辑</button>
          <button class="st-btn st-btn-ghost st-danger" @click="removeSkill(s)">删除</button>
        </template>
      </div>
    </div>
    <div v-if="!filteredSkills.length && !loading" class="st-empty">
      <p>{{ subTab === 'builtin' ? '暂无内置技能' : '还没有用户技能' }}</p>
      <p class="st-empty-sub">{{ subTab === 'builtin' ? '平台能力随版本发布自动注册' : '技能 = 纯 markdown 工作指导文档，应用绑定后注入系统提示词' }}</p>
    </div>
  </div>
</template>
