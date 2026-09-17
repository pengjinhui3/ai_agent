<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { Settings, SlidersHorizontal, BookMarked, Boxes, LayoutGrid, Plug, GraduationCap, BookOpen } from 'lucide-vue-next'
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-mono/400.css'

/** 侧栏导航图标映射（lucide；store 的 TABS.icon 字符串 → 组件） */
const NAV_ICONS = {
  settings: Settings,        // 系统设置：齿轮
  sliders: SlidersHorizontal, // 动态参数：滑杆调节
  bookmarked: BookMarked,     // 字典配置：带书签的手册
  boxes: Boxes,               // 厂商与模型：模型集合
  layoutGrid: LayoutGrid,     // 应用：应用网格入口
  plug: Plug,                 // MCP：服务接入插头
  graduationCap: GraduationCap, // Skill：技能学帽
  bookOpen: BookOpen,           // 知识库：翻开的书
}
import './setting/settings.css'
import { useSettingStore, TABS } from '../stores/setting'
import SystemPanel from './setting/SystemPanel.vue'
import DynamicParamsPanel from './setting/DynamicParamsPanel.vue'
import ProviderPanel from './setting/ProviderPanel.vue'
import AppPanel from './setting/AppPanel.vue'
import McpPanel from './setting/McpPanel.vue'
import DictPanel from './setting/DictPanel.vue'
import SkillPanel from './setting/SkillPanel.vue'
import KnowledgePanel from './setting/KnowledgePanel.vue'
import SettingsModal from './setting/SettingsModal.vue'
import McpTestModal from './setting/McpTestModal.vue'

/**
 * 设置页（/settings）壳 —— 明暗工作台风格（蓝本：Taskora Dashboard Preview 规格）。
 *
 * 拆分说明（原 1100 行单文件 → setting/ 组件 + stores/setting Pinia store）：
 * - stores/setting.js  Pinia store：面板级懒加载（ensure/PANEL_DEPS）+ UI 共享态
 * - SystemPanel      系统设置（基础模型等通用配置，第 1 位）
 * - ProviderPanel    厂商与模型（厂商行展开模型子表）
 * - AppPanel         应用（模型/MCP/技能绑定）
 * - McpPanel         MCP（注册 + 测试启用流程）
 * - DictPanel        字典配置（类型/值两级 CRUD，第 5 位）
 * - SkillPanel       技能（markdown 工作指导文档）
 * - SettingsModal    通用表单弹窗（字段模板，ok 回调由面板注入）
 * - McpTestModal     MCP 连接测试弹窗（工具列表预览 + 确认启用）
 * 壳只管：布局 / 侧栏导航 / 顶栏 / toast / 面板挂载。
 * 数据按面板懒加载：进入哪个面板拉哪个（各面板 onMounted ensure），壳不再全量 loadAll。
 */
const router = useRouter()
const store = useSettingStore()
const { providers, models, apps, message } = storeToRefs(store)

const activeTab = ref('system')
const activeMeta = computed(() => TABS.find(t => t.key === activeTab.value))
const PANELS = {
  system: SystemPanel, dynParam: DynamicParamsPanel, provider: ProviderPanel, app: AppPanel,
  mcp: McpPanel, dict: DictPanel, skill: SkillPanel, kb: KnowledgePanel,
}
/** 侧栏分组视图（平台 | 模型与应用） */
const groupedTabs = computed(() => {
  const groups = []
  for (const t of TABS) {
    let g = groups.find(x => x.name === t.group)
    if (!g) {
      g = { name: t.group, tabs: [] }
      groups.push(g)
    }
    g.tabs.push(t)
  }
  return groups
})
</script>

<template>
  <div class="st-page">
    <!-- 顶栏 -->
    <header class="st-header">
      <div class="st-header-left">
        <button class="st-back" @click="router.push('/')" title="返回对话">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="st-crumb">设置</span>
        <span class="st-crumb-sep">/</span>
        <span class="st-crumb-current">{{ activeMeta?.label }}</span>
      </div>
      <div class="st-header-right">
        <span class="st-chip">{{ providers.length || 0 }} 厂商 · {{ models.length || 0 }} 模型 · {{ apps.length || 0 }} 应用</span>
      </div>
    </header>

    <!-- toast -->
    <transition name="toast">
      <div v-if="message" class="st-toast" :class="{ ok: message.ok }">{{ message.ok ? '✓ ' : '! ' }}{{ message.text }}</div>
    </transition>

    <div class="st-body">
      <!-- 侧栏导航（分组：平台 | 模型与应用） -->
      <nav class="st-rail">
        <template v-for="(g, gi) in groupedTabs" :key="g.name">
          <div v-if="gi > 0" class="st-rail-divider"></div>
          <div class="st-rail-group">{{ g.name }}</div>
          <button v-for="t in g.tabs" :key="t.key" class="st-rail-item" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
            <span class="st-rail-icon">
              <component :is="NAV_ICONS[t.icon] || NAV_ICONS.settings" :size="15" />
            </span>
            <span class="st-rail-text">
              <span class="st-rail-label">{{ t.label }}</span>
              <span class="st-rail-desc">{{ t.desc }}</span>
            </span>
          </button>
        </template>
      </nav>

      <!-- 主区：按 tab 挂载面板（切换即重挂载，面板内展开态自然重置） -->
      <main class="st-main">
        <component :is="PANELS[activeTab]" />
      </main>
    </div>

    <!-- 通用表单弹窗 + MCP 连接测试弹窗 -->
    <SettingsModal />
    <McpTestModal />
  </div>
</template>
