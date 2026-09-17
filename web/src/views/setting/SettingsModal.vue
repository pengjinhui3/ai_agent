<script setup>
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSettingStore, getDictData } from '../../stores/setting'

/**
 * 通用表单弹窗：按 modal.type 渲染厂商/模型/应用/MCP/技能/字典字段模板。
 * 保存逻辑（ok 回调）由各面板在 openModal 时注入——弹窗只管渲染与调用。
 */
const store = useSettingStore()
const { providers, models, mcpServers, skills, builtinTools, modal, saving } = storeToRefs(store)

/** 思考档位下拉源：全局字典方法实时拉取（type=thinking_effort，打开模型表单时加载） */
const effortOptions = ref([])
watch(() => modal.value?.type, async t => {
  if (t === 'model') {
    try { effortOptions.value = await getDictData('thinking_effort') } catch { effortOptions.value = [] }
  }
}, { immediate: true })

/** 应用表单：启用厂商 → 启用模型的树形选择数据 */
const modelTree = computed(() =>
  providers.value
    .filter(p => p.enabled !== false)
    .map(p => ({
      providerCode: p.providerCode,
      protocol: p.protocol,
      models: models.value.filter(m => m.providerCode === p.providerCode && m.enabled !== false)
    }))
    .filter(node => node.models.length)
)
const treeExpanded = ref({})
function toggleTreeNode(code) { treeExpanded.value[code] = !treeExpanded.value[code] }

/** 应用表单：技能可选列表——未启用的隐藏，内置技能（builtin）不受过滤（平台核心能力始终可选） */
const availableSkills = computed(() =>
  skills.value.filter(s => s.enabled !== false || s.skillType === 'builtin')
)

/**
 * 技能绑定模式切换（三态：未绑定 → 注入式 / 目录式 → 未绑定）：
 * - 点击已激活的模式 → 解除绑定
 * - 点击另一模式 → 切换（互斥：同一技能仅一种绑定）
 */
function toggleSkillMode(skillCode, mode) {
  const d = modal.value?.data
  if (!d) return
  const injectArr = d.skillsInject || []
  const catalogArr = d.skillsCatalog || []
  if (mode === 'inject') {
    if (injectArr.includes(skillCode)) {
      d.skillsInject = injectArr.filter(c => c !== skillCode)
    } else {
      d.skillsInject = [...injectArr, skillCode]
      d.skillsCatalog = catalogArr.filter(c => c !== skillCode)
    }
  } else {
    if (catalogArr.includes(skillCode)) {
      d.skillsCatalog = catalogArr.filter(c => c !== skillCode)
    } else {
      d.skillsCatalog = [...catalogArr, skillCode]
      d.skillsInject = injectArr.filter(c => c !== skillCode)
    }
  }
}

/** 必选内置工具编码集（后端必挂，前端展示为锁定选中态） */
const requiredToolCodes = computed(() =>
  builtinTools.value.filter(t => t.required && t.enabled !== false).map(t => t.toolCode)
)
</script>

<template>
  <transition name="modal">
    <div v-if="modal" class="st-modal-mask" @click.self="modal = null">
      <div class="st-modal">
        <div class="st-modal-head">
          <div>
            <div class="st-modal-title">{{ modal.title }}</div>
            <div v-if="modal.sub" class="st-modal-sub mono">{{ modal.sub }}</div>
          </div>
          <button class="st-modal-close" @click="modal = null">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>

        <div class="st-modal-body">
          <!-- 厂商 -->
          <template v-if="modal.type === 'provider'">
            <div class="st-form-grid">
              <label class="st-field"><span>编码（字母/数字/-/_）</span><input class="mono" v-model="modal.data.providerCode" :disabled="!modal.isNew" placeholder="my-gateway" /></label>
              <label class="st-field"><span>显示名</span><input v-model="modal.data.name" placeholder="我的网关" /></label>
              <label class="st-field"><span>协议</span>
                <select v-model="modal.data.protocol">
                  <option value="openai">openai · Chat Completions</option>
                  <option value="openai.responses">openai.responses · Responses API</option>
                  <option value="anthropic">anthropic · Messages</option>
                </select>
              </label>
              <label class="st-field"><span>端点</span><input class="mono" v-model="modal.data.baseUrl" placeholder="https://api.example.com" /></label>
              <label class="st-field"><span>API Key</span><input class="mono" v-model="modal.data.apiKey" :placeholder="modal.isNew ? 'sk-…' : '留空保持原值'" /></label>
              <label v-if="modal.data.protocol === 'anthropic'" class="st-field"><span>max_tokens</span><input class="mono" v-model.number="modal.data.maxTokens" type="number" placeholder="8192" /></label>
            </div>
            <p class="st-form-hint">端点为根地址（自动拼接 /v1）。版本段非 /v1（如智谱 /api/paas/v4）时，填到版本段并在末尾加 <b>#</b>，跳过自动拼接、版本号自定义。openai.responses 仅适用于支持 Responses API 的端点（如 OpenAI 官方、hz 网关）。</p>
          </template>

          <!-- 模型 -->
          <template v-else-if="modal.type === 'model'">
            <div class="st-form-grid">
              <label class="st-field"><span>模型编码（字母/数字/-/_）</span><input class="mono" v-model="modal.data.modelCode" :disabled="!modal.isNew" placeholder="deepseek-v4-pro" /></label>
              <label class="st-field"><span>显示名</span><input v-model="modal.data.name" placeholder="DeepSeek V4 Pro" /></label>
            </div>
            <div class="st-form-row-line">
              <span>归属厂商</span><b class="mono">{{ modal.data.providerCode }}</b>
              <span class="st-form-hint-inline">（归属不可改，如需迁移请新建）</span>
            </div>
            <label class="st-field st-field-full"><span>思考档位
              <span class="st-form-hint-inline">字典 thinking_effort · 空 = 默认档</span></span>
              <select v-model="modal.data.thinkingEffort">
                <option :value="null">— 默认档（字典 is_default）—</option>
                <option v-for="d in effortOptions" :key="d.dictCode" :value="d.dictLabel">
                  {{ d.dictLabel }} - {{ d.dictValue ? '（budget ' + d.dictValue + '）' : '（不思考）' }}
                </option>
              </select>
            </label>
            <!-- 启停不走编辑表单（模型测试功能）：新建默认停用，启用唯一途径是「测试并启用」 -->
          </template>

          <!-- 动态参数（普通 kv CRUD） -->
          <template v-else-if="modal.type === 'config'">
            <div class="st-form-grid">
              <label class="st-field"><span>参数键
                <span class="st-form-hint-inline">小写字母/数字/下划线</span></span>
                <input class="mono" v-model="modal.data.configKey" :disabled="!modal.isNew" placeholder="my_param_key" /></label>
              <label class="st-field"><span>参数名称</span>
                <input v-model="modal.data.configName" :disabled="modal.builtin" :placeholder="modal.builtin ? '（内置参数名称锁定）' : '我的参数'" /></label>
            </div>
            <label class="st-field st-field-full"><span>参数值</span>
              <textarea class="mono" v-model="modal.data.configValue" rows="3" placeholder="值（字符串，消费方自行解析类型）"></textarea>
            </label>
            <p class="st-form-hint">内置参数（运行参数/基础模型）仅可改值；自定义参数删除后由业务消费方按默认值兜底。</p>
          </template>

          <!-- 字典类型 -->
          <template v-else-if="modal.type === 'dictType'">
            <div class="st-form-grid">
              <label class="st-field"><span>类型键（字母/数字/-/_）</span><input class="mono" v-model="modal.data.dictType" :disabled="!modal.isNew" placeholder="thinking_effort" /></label>
              <label class="st-field"><span>名称</span><input v-model="modal.data.dictName" placeholder="思考档位" /></label>
            </div>
            <label class="st-field st-field-full"><span>备注</span><input v-model="modal.data.remark" placeholder="用途说明" /></label>
            <p class="st-form-hint">类型键是代码引用标识，创建后不可改。</p>
          </template>

          <!-- 字典值 -->
          <template v-else-if="modal.type === 'dictData'">
            <div class="st-form-grid">
              <label class="st-field"><span>标签 label</span><input class="mono" v-model="modal.data.dictLabel" placeholder="low" /></label>
              <label class="st-field"><span>值 value</span><input class="mono" v-model="modal.data.dictValue" placeholder="2000（可空）" /></label>
              <label class="st-field"><span>排序</span><input class="mono" v-model.number="modal.data.sort" type="number" /></label>
            </div>
            <label class="st-check"><input type="checkbox" :true-value="'Y'" :false-value="'N'" v-model="modal.data.isDefault" /><span>设为默认（类型内唯一）</span></label>
            <label class="st-field st-field-full"><span>备注</span><input v-model="modal.data.remark" /></label>
            <p class="st-form-hint">thinking_effort 档位：label = OpenAI reasoning_effort 传参值；value = Anthropic budget_tokens（none 档留空）。</p>
          </template>

          <!-- 应用 -->
          <template v-else-if="modal.type === 'app'">
            <div class="st-form-grid">
              <label class="st-field"><span>编码（字母/数字/-/_）</span><input class="mono" v-model="modal.data.appCode" :disabled="!modal.isNew" placeholder="my-assistant" /></label>
              <label class="st-field"><span>名称</span><input v-model="modal.data.name" placeholder="我的助手" /></label>
            </div>

            <div class="st-field-group">
              <div class="st-field-label">绑定模型 <span class="st-form-hint-inline">厂商 → 模型</span></div>
              <div class="st-tree">
                <div v-for="node in modelTree" :key="node.providerCode" class="st-tree-node">
                  <div class="st-tree-provider" @click="toggleTreeNode(node.providerCode)">
                    <svg class="st-chevron" :class="{ open: treeExpanded[node.providerCode] }" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span class="mono">{{ node.providerCode }}</span>
                    <span class="st-tree-count">{{ node.models.length }}</span>
                  </div>
                  <div v-show="treeExpanded[node.providerCode]" class="st-tree-models">
                    <label v-for="m in node.models" :key="m.id" class="st-tree-model" :class="{ selected: modal.data.modelId === m.id }">
                      <input type="radio" :value="m.id" v-model="modal.data.modelId" />
                      <span class="mono">{{ m.modelCode }}</span>
                      <span v-if="m.name && m.name !== m.modelCode" class="st-tree-alias">{{ m.name }}</span>
                    </label>
                  </div>
                </div>
                <div v-if="!modelTree.length" class="st-empty-inline">暂无可用模型 · 请先在「厂商与模型」添加</div>
              </div>
            </div>

            <label class="st-field st-field-full"><span>系统提示词{{ modal.isNew ? '' : '（已回填，可修改）' }}</span><textarea v-model="modal.data.systemPrompt" rows="3" placeholder="你是一个通用AI助手" /></label>

            <div class="st-field-group">
              <div class="st-field-label">
                工具白名单
                <span class="st-form-hint-inline">内置工具 + MCP 服务</span>
                <span v-if="modal.data._loadingDetail" class="st-form-hint-inline">（正在加载已绑定服务…）</span>
                <span v-else-if="modal.data.mcpTools.length" class="st-form-hint-inline">已绑定 {{ modal.data.mcpTools.length }} 个</span>
              </div>
              <div class="st-checks">
                <!-- 内置必选在前（锁定态无选中 icon）；非必选在后 -->
                <label v-for="t in builtinTools.filter(t => t.required)" :key="t.toolCode" class="st-check st-check-chip builtin" :class="{ checked: true, required: true }" :title="`系统必选：${t.description || t.toolCode}`">
                  <input type="checkbox" :value="t.toolCode" v-model="modal.data.mcpTools" disabled />
                  <span>🔒 {{ t.name || t.toolCode }}</span>
                </label>
                <label v-for="t in builtinTools.filter(t => t.enabled !== false && !t.required)" :key="t.toolCode" class="st-check st-check-chip builtin" :class="{ checked: modal.data.mcpTools.includes(t.toolCode) }" :title="t.description || t.toolCode">
                  <input type="checkbox" :value="t.toolCode" v-model="modal.data.mcpTools" />
                  <span>⚡ {{ t.name || t.toolCode }}</span>
                </label>
                <label v-for="s in mcpServers.filter(s => s.enabled !== false)" :key="s.id" class="st-check st-check-chip" :class="{ checked: modal.data.mcpTools.includes(s.serverCode) }" :title="s.serverCode">
                  <input type="checkbox" :value="s.serverCode" v-model="modal.data.mcpTools" />
                  <span>{{ s.name || s.serverCode }}</span>
                </label>
                <span v-if="!mcpServers.filter(s => s.enabled !== false).length && !builtinTools.filter(t => t.required || t.enabled !== false).length" class="st-form-hint-inline">暂无工具，先到 MCP 面板注册或启用内置工具</span>
              </div>
            </div>

            <div class="st-field-group">
              <div class="st-field-label">
                技能绑定
                <span class="st-form-hint-inline">每个技能仅一种模式：注入式（全文进提示词，每轮生效）或目录式（目录常驻，模型按需经 load_skill 拉全文）</span>
                <span v-if="!modal.data._loadingDetail && (modal.data.skillsInject.length + modal.data.skillsCatalog.length)" class="st-form-hint-inline">已绑定 {{ modal.data.skillsInject.length + modal.data.skillsCatalog.length }} 个</span>
              </div>
              <div class="st-skill-list">
                <div v-for="s in availableSkills" :key="s.id" class="st-skill-row" :class="{ off: s.enabled === false }">
                  <span class="st-skill-name" :title="s.description || s.skillCode">{{ s.name || s.skillCode }}</span>
                  <div class="st-skill-modes">
                    <button type="button" class="st-mode-btn inject" :class="{ active: modal.data.skillsInject.includes(s.skillCode) }" :disabled="s.enabled === false" @click="toggleSkillMode(s.skillCode, 'inject')" title="全文注入系统提示词">注入</button>
                    <button type="button" class="st-mode-btn catalog" :class="{ active: modal.data.skillsCatalog.includes(s.skillCode) }" :disabled="s.enabled === false" @click="toggleSkillMode(s.skillCode, 'catalog')" title="目录常驻，按需加载">目录</button>
                  </div>
                </div>
                <span v-if="!availableSkills.length" class="st-form-hint-inline">暂无技能，先到 Skill 面板创建</span>
              </div>
            </div>
            <label class="st-check"><input type="checkbox" v-model="modal.data.enabled" /><span>启用应用</span></label>
          </template>

          <!-- MCP -->
          <template v-else-if="modal.type === 'mcp'">
            <div class="st-form-grid">
              <label class="st-field"><span>编码（字母/数字/-/_）</span><input class="mono" v-model="modal.data.serverCode" :disabled="!modal.isNew" placeholder="howtocook" /></label>
              <label class="st-field"><span>显示名</span><input v-model="modal.data.name" /></label>
              <label class="st-field"><span>传输类型</span>
                <select v-model="modal.data.type">
                  <option value="streamable">Streamable HTTP</option>
                  <option value="stdio">stdio（本地进程）</option>
                  <option value="sse" disabled>SSE（已废弃）</option>
                </select>
              </label>
            </div>

            <!-- http 传输：url + headers -->
            <template v-if="modal.data.type !== 'stdio'">
              <label class="st-field st-field-full"><span>端点</span><input class="mono" v-model="modal.data.url" placeholder="https://mcp.example.com/mcp" /></label>
              <label class="st-field st-field-full"><span>自定义请求头 <span class="st-form-hint-inline">一行一个 key: value · 可空</span></span><textarea class="mono" v-model="modal.data.headers" rows="2" placeholder="x-api-key: 5f4efc3d…&#10;Authorization: Bearer sk-…" /></label>
            </template>

            <!-- stdio 传输：command + args + env -->
            <template v-else>
              <label class="st-field st-field-full"><span>命令 <span class="st-form-hint-inline">可执行命令，须存在于后端所在机器</span></span><input class="mono" v-model="modal.data.command" placeholder="uvx 或 D:\…\node.exe" /></label>
              <label class="st-field st-field-full"><span>参数 <span class="st-form-hint-inline">一行一个参数（自动转 JSON 数组）</span></span><textarea class="mono" v-model="modal.data.argsText" rows="3" placeholder="mcp-server-fetch&#10;或 D:\…\dbx-mcp-server.js" /></label>
              <label class="st-field st-field-full"><span>环境变量 <span class="st-form-hint-inline">JSON 对象 · 可空</span></span><textarea class="mono" v-model="modal.data.env" rows="2" placeholder='{"KEY":"val"}' /></label>
            </template>

            <p class="st-form-hint">保存后默认停用；在列表上点「测试并启用」验证连通并确认工具列表后生效。stdio 首次运行可能需要安装依赖（uvx 等较慢）。</p>
          </template>

          <!-- Skill -->
          <template v-else-if="modal.type === 'skill'">
            <div class="st-form-grid">
              <label class="st-field"><span>编码（字母/数字/-/_）</span><input class="mono" v-model="modal.data.skillCode" :disabled="!modal.isNew" placeholder="weekly-report" /></label>
              <label class="st-field"><span>显示名</span><input v-model="modal.data.name" placeholder="周报写作规范" /></label>
            </div>
            <label class="st-field st-field-full"><span>描述 <span class="st-form-hint-inline">做什么 + 何时用（绑定选择的依据）</span></span><input v-model="modal.data.description" placeholder="生成周报时使用：三段式结构、量化表达" /></label>
            <label class="st-field st-field-full">
              <span>技能正文（markdown）<span class="st-form-hint-inline">{{ (modal.data.content || '').length }} 字 · 建议 3000~8000 字</span></span>
              <textarea class="mono st-skill-editor" v-model="modal.data.content" rows="12" placeholder="## 适用场景&#10;用户要求…&#10;&#10;## 输出格式&#10;1. …&#10;&#10;## 注意事项&#10;- …" />
            </label>
            <p class="st-form-hint">技能 = 工作指导文档，应用绑定后全文注入系统提示词（绑定即生效）；单技能建议 &lt;5k token。</p>
          </template>
        </div>

        <div class="st-modal-foot">
          <button class="st-btn st-btn-primary" :disabled="saving" @click="modal.ok(modal)">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="st-btn st-btn-ghost" @click="modal = null">取消</button>
        </div>
      </div>
    </div>
  </transition>
</template>
