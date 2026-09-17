import { defineStore } from 'pinia'
import { appsApi } from '../api/apps'
import { providersApi } from '../api/providers'
import { modelsApi } from '../api/models'
import { mcpApi } from '../api/mcp'
import { skillsApi } from '../api/skills'
import { builtinToolsApi } from '../api/builtin'
import { dictApi } from '../api/dict'

/**
 * 全局字典方法（不入 store，实时拉取）：按类型取字典值列表（sort 升序）。
 * 使用方按需调用（如模型编辑表单的思考档位下拉）——字典数据轻量、变更低频，
 * 但为保证「改完即生效」，不做缓存、每次实时拉取。
 */
export async function getDictData(dictType) {
  const r = await dictApi.listData(dictType)
  return (r.data || []).sort((a, b) => (a.sort || 0) - (b.sort || 0))
}

/**
 * 设置页 store（Pinia）：
 * <ul>
 *   <li><b>面板级懒加载</b>：进入哪个面板拉哪个的数据（ensure + loadedKeys），
 *       替代原首屏 loadAll 全量接口的打法；</li>
 *   <li><b>保存后定向刷新</b>：withSaving 成功只重拉已加载的 key（refreshLoaded），
 *       不触碰未访问面板的数据；</li>
 *   <li>字典不入 store：DictPanel 走组件本地状态 + 实时拉取；下拉类场景用全局
 *       {@link getDictData}（type 实时查询）；</li>
 *   <li>UI 共享态（modal 弹窗 / saving / toast / mcpTest）一并入 store。</li>
 * </ul>
 */

export const TABS = [
  { key: 'system', label: '系统设置', desc: '基础模型与运行参数', icon: 'settings', group: '平台' },
  { key: 'dynParam', label: '动态参数', desc: '普通 kv 配置增删改查', icon: 'sliders', group: '平台' },
  { key: 'dict', label: '字典配置', desc: '枚举值集中管理', icon: 'bookmarked', group: '平台' },
  { key: 'provider', label: '厂商与模型', desc: '模型厂商接入与模型清单', icon: 'boxes', group: '模型与应用' },
  { key: 'app', label: '应用', desc: '对话入口与绑定配置', icon: 'layoutGrid', group: '模型与应用' },
  { key: 'mcp', label: '工具', desc: '内置工具与 MCP 服务', icon: 'plug', group: '模型与应用' },
  { key: 'skill', label: '技能', desc: '工作技能指导文档', icon: 'graduationCap', group: '模型与应用' },
  { key: 'kb', label: '知识库', desc: '文档向量化与检索', icon: 'bookOpen', group: '模型与应用' },
]

/** 各面板声明的数据依赖（懒加载单元 → 面板） */
export const PANEL_DEPS = {
  system: ['providers', 'models', 'systemConfig'],
  dynParam: ['systemConfig'],
  provider: ['providers', 'models'],
  app: ['apps', 'providers', 'models', 'mcpServers', 'skills', 'builtinTools'],
  mcp: ['mcpServers', 'builtinTools'],
  dict: [],   // 字典实时拉取（不入 store）
  skill: ['skills', 'apps'],
  kb: [],     // 知识库走组件本地状态（18 号 MVP：文档列表实时拉取 + 轮询）
}

export const useSettingStore = defineStore('setting', {
  state: () => ({
    // ---- 业务数据（按 key 懒加载） ----
    providers: [],
    models: [],
    apps: [],
    mcpServers: [],
    skills: [],
    builtinTools: [],
    systemBaseModel: null,
    /** 系统动态配置全量（运行参数卡回显用） */
    systemConfigs: [],
    /** 已加载完成的数据 key（ensure 幂等依据） */
    loadedKeys: [],

    // ---- UI 共享态 ----
    loading: false,
    message: '',
    saving: false,
    /** 通用表单弹窗：{ title, sub, type, isNew, id, data, ok(modal) } */
    modal: null,
    /** MCP 连接测试弹窗：{ server, loading, result, error } */
    mcpTest: null,
  }),

  actions: {
    /** 单 key 数据加载器（每 key 一个接口组） */
    async _load(key) {
      switch (key) {
        case 'providers': this.providers = (await providersApi.list()).providers || []; break
        case 'models': this.models = (await modelsApi.list()).models || []; break
        case 'apps': this.apps = (await appsApi.list()).apps || []; break
        case 'mcpServers': this.mcpServers = (await mcpApi.list()).servers || []; break
        case 'skills': this.skills = (await skillsApi.list()).skills || []; break
        case 'builtinTools': this.builtinTools = (await builtinToolsApi.list()).tools || []; break
        case 'systemConfig': {
          const sc = await systemConfigApiGet()
          this.systemBaseModel = sc.baseModel && sc.baseModel.id ? sc.baseModel : null
          this.systemConfigs = sc.configs || []
          break
        }
      }
    },

    /**
     * 面板数据懒加载（幂等）：拉取尚未加载的 key。
     * 面板组件 onMounted 时按面板 key 调用（PANEL_DEPS 声明依赖）。
     */
    async ensure(panelKey) {
      const deps = PANEL_DEPS[panelKey] || []
      const pending = deps.filter(k => !this.loadedKeys.includes(k))
      if (!pending.length) return
      this.loading = true
      try {
        await Promise.all(pending.map(k => this._load(k)))
        this.loadedKeys.push(...pending)
      } catch (e) {
        this._toast('数据加载失败：' + e.message)
      } finally {
        this.loading = false
      }
    },

    /** 保存后定向刷新：只重拉已加载的 key（未访问面板的数据不动） */
    async refreshLoaded() {
      const keys = [...this.loadedKeys]
      if (!keys.length) return
      try {
        await Promise.all(keys.map(k => this._load(k)))
      } catch (e) {
        this._toast('数据刷新失败：' + e.message)
      }
    },

    _toast(text, ok = false) {
      this.message = { text, ok }
      setTimeout(() => { this.message = '' }, 3000)
    },

    openModal(config) {
      this.modal = config
    },

    /** 保存动作包装：异常 toast、成功后关闭弹窗 + 定向刷新已加载数据 */
    async withSaving(fn) {
      this.saving = true
      try {
        await fn()
        this.modal = null
        await this.refreshLoaded()
        this._toast('已保存', true)
      } catch (e) {
        this._toast(e.message)
      } finally {
        this.saving = false
      }
    },
  },
})

/** systemConfig 接口（延迟引入避免 store 顶部依赖混乱，与 getDictData 同文件的系统配置 API） */
async function systemConfigApiGet() {
  const { systemConfigApi } = await import('../api/dict')
  return systemConfigApi.get()
}
