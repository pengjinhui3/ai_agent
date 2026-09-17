<script setup>
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkdownIt from 'markdown-it'
import { Brain, Wrench, BookOpen, CircleHelp, ListChecks, MessageCircleQuestion, CheckCircle2, ListOrdered, Square, PenLine } from 'lucide-vue-next'
import { NDropdown, NModal, NInput, useDialog, useMessage } from 'naive-ui'
import MediaChart from '../components/MediaChart.vue'
import MediaMermaid from '../components/MediaMermaid.vue'
import { appsApi } from '../api/apps'
import { chatApi } from '../api/chat'

const router = useRouter()

/**
 * AI 应用会话页（Taskora 工作台风格，与设置页同一设计系统）
 *
 * 接口契约见 docs/design.md §6：
 * - GET  /api/v1/apps                                  应用列表
 * - GET  /api/v1/apps/{appCode}/conversations          会话列表
 * - GET  /api/v1/conversations/{conversationId}/messages  消息历史（含工具轨迹）
 * - POST /api/v1/apps/{appCode}/chat                   SSE 流式对话，body {query, conversationId?}
 *
 * SSE 事件协议（data: {...} 行）：
 * - MESSAGE     {content, messageId, conversationId}  首帧可能 content 为空串仅带 ID
 * - THINKING    {content}                              推理过程（空 content = 思考阶段信号）
 * - TOOL_START  {tool, args}                           工具调用开始
 * - TOOL_RESULT {tool, result, costMs}                 工具调用结果
 * - DONE        {messageId, conversationId}            本轮流结束
 * - ERROR       {content}                              错误信息
 *
 * 消息渲染模型（segments 分段序列）：
 * assistant 消息按流式时序拆成 text / think / tool / media 段交替——工具块嵌在消息流的对应位置
 * （实时流按 SSE 事件到达顺序构建；历史回放按 contentBlocks 结构化块还原时序（13 方案），
 *   缺失时回退 answerPure 纯文本——旧占位符格式已废弃，消息表已清理）。
 */

// ---------- Markdown 渲染（assistant 正文，前身项目同款 markdown-it） ----------
// html:false：模型输出中的原始 HTML 一律转义（外部数据不进 v-html，安全）
// linkify:true：裸链接自动转可点击；breaks:true：单换行转 <br>（聊天场景友好）
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * Markdown 规范化预处理——DeepSeek 等模型的输出常不标准（实测三类问题）：
 * ① 标题 # 后无空格（"##宫保鸡丁"）→ 补空格成 "## 宫保鸡丁"
 * ② 行首列表 - 后无空格（"-手枪腿"）→ 补空格成 "- 手枪腿"
 * ④ 连行标题：正文后紧跟 "#标题" → 拆行
 *
 * 已删除原规则③（连行列表启发式拆分：行中"-中文/字母"前强制换行）——
 * 误伤一切行中连字符（技能码 chart-generation / code span 内 / 普通连词），
 * 2026-09-15 辉哥实测"手动插 - 即换行"锤死：模型省换行的收益 << 连字符误伤面
 * （表格碎裂/code 断行伪列表的真正根因）。省换行场景由现代模型输出质量自然消除。
 */
function mdNormalize(text) {
  let t = text || ''
  // ① ATX 标题：# 后紧跟非空白字符 → 补一个空格
  t = t.replace(/(^|\n)(#{1,6})(?=[^\s#])/g, '$1$2 ')
  // ④ 连行标题：正文后紧跟 "#标题"（"宫保鸡丁###食材"，模型省了换行）→ 拆行
  t = t.replace(/([^\s\n#])(#{1,6})(?=[^\s#])/g, '$1\n$2 ')
  // ② 行首无序列表：- 后紧跟非空白字符 → 补一个空格（仅行首，不碰行中连字符）
  t = t.replace(/(^|\n)-(?=[^\s\-])/g, '$1- ')
  // ⑤ 裸路径链接化（窄域：仅 /uploads/ 开头的站内文件路径，空白/行首边界起——
  //    导出工具返回的下载路径以纯文本出现时不可点（2026-09-17 辉哥线上实测）；
  //    已有 markdown 链接 [](/uploads/…) 不受影响（前导是 ( 非空白）
  t = t.replace(/(^|[\s（])(\/uploads\/[^\s)）"'）]+)/g, '$1[$2]($2)')
  return t
}

function mdRender(text) {
  return md.render(mdNormalize(text))
}

// ---------- 应用列表 ----------
const apps = ref([])                    // [{appCode, name, provider, model}]
const selectedAppCode = ref('')         // 当前选中应用
const appsLoadError = ref('')           // 应用列表加载失败提示

// ---------- 会话列表（左侧栏） ----------
const conversations = ref([])           // [{conversationId, title, updateTime}]
const convListLoading = ref(false)      // 会话列表加载中
const activeConversationId = ref(null)  // 当前会话（高亮 + 续传）

// ---------- 会话状态 ----------
const messages = ref([])                // 消息列表（user / assistant）
const userInput = ref('')               // 输入框内容
const conversationId = ref(null)        // 会话业务 ID（UUID），首轮由后端首帧返回，之后续传
const streaming = ref(false)            // 是否正在流式接收
const streamAbort = ref(null)          // 当前流的中断控制器（停止按钮）
const listEl = ref(null)                // 消息列表容器（用于自动滚底）

// ---------- Emotion Ball 表情引擎（NX_emotion-ball，AI 伙伴席） ----------
// 双实例方案（辉哥 2026-09-11 决策）：
//   输入框球 emotionBall —— 常驻 DOM，v-show 显隐，SSE 事件驱动表情 + 思考冒泡
//   迎宾球   welcomeBall —— 随空态 v-if 重建（销毁即释放），每次新对话随机表情

const ballEl = ref(null)        // 输入框球容器（常驻）
const emptyBallEl = ref(null)   // 空态球容器（v-if 随空态重建）
const ballTip = ref('')         // 思考冒泡文案（事件驱动）
let emotionBall = null
let welcomeBall = null

/** 同事件防抖窗口（ms）：窗口内重复触发的同一事件不重播表情/冒泡
 *  （场景：短时间连续调用多个工具导致表情与冒泡一直闪刷） */
const BALL_EVT_DEBOUNCE_MS = 3000
let lastBallEvt = { type: '', at: 0 }

/** 从情绪反应组随机抽一个表情 id */
function randomEmotionId() {
  const pool = window.EmotionBall.config.list('emotion')
  return pool.length ? pool[Math.floor(Math.random() * pool.length)].id : '02'
}

/** SSE 事件 → 表情 + 思考冒泡（30-49 代理状态组）
 *  TOOL_RESULT 不映射状态：连续工具调用时（TOOL_START→TOOL_RESULT→TOOL_START…）
 *  中间的 TOOL_RESULT 不记录防抖锚点，后续 TOOL_START 仍与上一次同窗口去重 */
function ballReact(evtType) {
  if (!emotionBall) return
  if (evtType === lastBallEvt.type && Date.now() - lastBallEvt.at < BALL_EVT_DEBOUNCE_MS) return
  switch (evtType) {
    case 'THINKING':   emotionBall.setEmotion('30'); ballTip.value = '思考中…'; break    // 思考环带
    case 'TOOL_START': emotionBall.setEmotion('31'); ballTip.value = '使用工具…'; break  // 检索扫动
    case 'MESSAGE':    emotionBall.setEmotion('39'); ballTip.value = '正在回复…'; break  // 输出回复
    case 'ERROR':      emotionBall.setEmotion('32'); ballTip.value = '出错了…'; break    // 出错
    case 'DONE':       emotionBall.setEmotion('33'); emotionBall.bounce(); ballTip.value = ''; break  // 完成 + 弹跳撒花
    case 'IDLE':       emotionBall.setEmotion('02'); ballTip.value = ''; break          // 待机呼吸
    default: return  // 其他事件（TOOL_RESULT 等）不改变球状态、不记录防抖锚点
  }
  lastBallEvt = { type: evtType, at: Date.now() }
}

// ---------- 空态迎宾文案（每日新闻 → 本地文案池回退） ----------

const welcomeLine = ref('')

/** 本地文案池：每日新闻拉取失败时的欢迎词 / 垃圾话回退 */
const WELCOME_FALLBACKS = [
  '今天想从哪个问题开始？',
  '灵感这东西，聊着聊着就有了。',
  '盯着我看 10 秒，灵感会提前到达（大概）。',
  '把问题写下来，就解决了一半。',
  '球已就位，就差你的问题了。',
  '换个问法，答案可能就在拐角。',
]

/** 当日新闻缓存（模块级）：同一天多次进空态只拉一次，切空态随机换条 */
let dailyNewsCache = null

/** 当前文案源：新闻池（带"你知道吗："前缀）或兜底池；点球换条从这里随机取 */
let welcomeSource = null
let lastWelcomeIdx = -1

/** 从当前文案源随机取一条（避免与上一条重复） */
function pickWelcomeLine() {
  const list = welcomeSource?.list
  if (!list || !list.length) return ''
  let idx = Math.floor(Math.random() * list.length)
  if (list.length > 1 && idx === lastWelcomeIdx) idx = (idx + 1) % list.length
  lastWelcomeIdx = idx
  return (welcomeSource.prefix || '') + list[idx]
}

/** 点击迎宾球：戳一下弹跳反馈 + 换一条文案 */
function cycleWelcomeLine() {
  welcomeBall?.bounce?.()
  const next = pickWelcomeLine()
  if (next) welcomeLine.value = next
}

/** 拉每日资讯（60s API：每天 60 秒读懂世界，免费无 key、CORS 全开）；
 *  成功 → 新闻池（你知道吗：…）；接口异常/超时 → 兜底欢迎词池 */
async function loadDailyLine() {
  const today = new Date().toISOString().slice(0, 10)
  try {
    if (!dailyNewsCache || dailyNewsCache.date !== today) {
      const res = await fetch('https://60s.viki.moe/v2/60s', { signal: AbortSignal.timeout(6000) })
      const body = await res.json()
      const items = body?.data?.news
      if (!Array.isArray(items) || !items.length) throw new Error('news 为空')
      dailyNewsCache = { date: today, items }
    }
    welcomeSource = { list: dailyNewsCache.items, prefix: '你知道吗：' }
  } catch {
    // 接口异常：落到兜底欢迎词（下次进空态会重新尝试拉新闻）
    welcomeSource = { list: WELCOME_FALLBACKS, prefix: '' }
  }
  return pickWelcomeLine()
}

onMounted(() => {
  // 输入框球（window.EmotionBall 由 index.html 静态脚本提供；
  // 不用 lite 模式——思考环带/撒花等状态特效是事件反馈的视觉主体）
  if (window.EmotionBall && ballEl.value) {
    emotionBall = window.EmotionBall.create(ballEl.value, {
      emotion: '02', idle: true, eyeScale: 1.3,
    })
    // 全页鼠标注视（归一化 [-1,1]，两球同步）
    window.addEventListener('pointermove', e => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1
      const ny = (e.clientY / window.innerHeight) * 2 - 1
      emotionBall?.setGaze(nx, ny)
      welcomeBall?.setGaze(nx, ny)
    })
  }
})

// 迎宾球：空态容器随 v-if 重建 → ref 变化时销毁旧球、在新容器上建球（随机表情 + 迎宾文案）
watch(emptyBallEl, el => {
  if (welcomeBall) { welcomeBall.destroy(); welcomeBall = null }
  if (el && window.EmotionBall) {
    welcomeBall = window.EmotionBall.create(el, {
      emotion: randomEmotionId(), eyeScale: 1.15,
    })
    loadDailyLine().then(line => { welcomeLine.value = line })
  }
}, { immediate: true })

onBeforeUnmount(() => {
  emotionBall?.destroy?.()
  emotionBall = null
  welcomeBall?.destroy?.()
  welcomeBall = null
})

// ---------- 设置中心（独立页面，路由跳转） ----------

/** 加载应用列表（启动时加载；从设置页返回时组件重新挂载自动加载） */
async function loadApps() {
  try {
    const data = await appsApi.list()
    const list = Array.isArray(data) ? data : (data.apps || data.data || [])
    apps.value = list
      .map(a => ({
        appCode: a.appCode ?? a.code,
        name: a.name || a.appCode || a.code,
        provider: a.provider,
        model: a.model,
        enabled: a.enabled !== false
      }))
      .filter(a => a.appCode)
    if (!apps.value.some(a => a.appCode === selectedAppCode.value)) {
      selectedAppCode.value = apps.value[0]?.appCode || ''
    }
  } catch (e) {
    appsLoadError.value = '应用列表加载失败（后端可能未启动）：' + e.message
  }
}

// 启动时加载应用列表
onMounted(async () => {
  await loadApps()
  if (!apps.value.length && !appsLoadError.value) {
    appsLoadError.value = '后端未返回可用应用'
  }
})

// 切换应用：清空当前会话并重新加载该应用的会话列表
watch(selectedAppCode, () => {
  if (streaming.value) return
  resetConversation()
  loadConversations()
  // 15 号：切换应用 → @ 弹层技能组随绑定变化，缓存重置
  atState.loaded = false
})

// ---------- 会话列表 ----------

/** 拉取当前应用的会话列表 */
async function loadConversations() {
  if (!selectedAppCode.value) return
  convListLoading.value = true
  try {
    const data = await appsApi.conversations(selectedAppCode.value)
    // 兼容数组 / {conversations:[...]} / {data:[...]} 形态
    const list = Array.isArray(data) ? data : (data.conversations || data.data || [])
    conversations.value = list
      .map(c => ({
        conversationId: c.conversationId ?? c.id,
        title: c.title || '（未命名会话）',
        updateTime: c.updateTime || c.update_time || ''
      }))
      .filter(c => c.conversationId)
  } catch (e) {
    console.warn('会话列表加载失败：', e.message)
    conversations.value = []
  } finally {
    convListLoading.value = false
  }
}

/** 打开历史会话：加载消息历史并渲染，后续可续传继续对话 */
/** 会话历史加载态：区分「切换会话加载中」与「新会话空态」（避免加载期间闪现空白态再跳出消息） */
const loadingConv = ref(false)

async function openConversation(conv) {
  if (streaming.value) return
  if (activeConversationId.value === conv.conversationId) return
  activeConversationId.value = conv.conversationId
  conversationId.value = conv.conversationId
  messages.value = []
  loadingConv.value = true
  try {
    const data = await appsApi.messages(conv.conversationId)
    const list = Array.isArray(data) ? data : (data.messages || data.data || [])
    for (const m of list) {
      // user 气泡 = question + 附件（11 方案：图片缩略 / 文件 chip 回放）
      const userAttachments = parseAttachments(m.attachments)
      if (m.question || userAttachments.length) {
        messages.value.push({ role: 'user', content: m.question || '', attachments: userAttachments })
      }
      // assistant 气泡：contentBlocks 优先 / answer 占位标记降级 → segments 模型（13 方案）
      messages.value.push(reactive(buildHistoryAssistant(m)))
    }
  } catch (e) {
    messages.value.push(reactive({
      role: 'assistant', segments: [], thinking: '',
      error: '历史消息加载失败：' + e.message, messageId: null, done: true
    }))
  } finally {
    loadingConv.value = false
  }
  scrollBottom()
}

/**
 * 历史消息 → assistant 消息模型（13 方案：content_blocks 回放）。
 * contentBlocks 结构化块数组 → 直接按时序映射 segments；
 * 缺失时回退 answerPure 纯文本（旧占位符格式已废弃，消息表已清理）。
 */
function buildHistoryAssistant(m) {
  // contentBlocks 存在且非空 → 直接映射为 segments
  // （后端可能传已解析的对象数组，也可能传 JSON 字符串，parseJsonArray 统一归一化）
  const blocks = parseJsonArray(m.contentBlocks)
  if (blocks.length) {
    return buildFromContentBlocks(m, blocks)
  }
  // 兜底：answerPure 纯文本（保留列）
  const text = (m.answerPure || '').trim()
  return {
    role: 'assistant',
    segments: text ? [{ type: 'text', content: text }] : [],
    error: m.success === false && m.errorMessage ? '[' + m.errorMessage + ']' : '',
    messageId: m.messageId,
    done: true,
  }
}

/**
 * contentBlocks 结构化块 → segments（13 方案新回放通道）。
 * 块类型映射：
 * - thinking / text  → think / text 段（多轮思考天然按时序原位还原）
 * - tool_use         → tool 段（name/args/costMs/status 取自块自身）
 * - tool_result      → 回填最近一个尚无结果的 tool 段（时序配对）
 * - media            → media 段（block 只带 mediaIndex + title，明细 data 仍取自 mediaJson）
 */
function buildFromContentBlocks(m, blocks) {
  const mediaArr = parseJsonArray(m.mediaJson)

  const segments = []
  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        if (block.content?.trim()) {
          segments.push({ type: 'think', content: block.content })
        }
        break
      case 'text':
        if (block.content?.trim()) {
          segments.push({ type: 'text', content: block.content })
        }
        break
      case 'tool_use':
        segments.push({
          type: 'tool',
          tool: block.content?.name || '未知工具',
          displayName: block.displayName || null,
          args: block.content?.args,
          result: null,
          costMs: block.costMs,
          success: block.status !== 'error',
          errorMessage: block.toolError,
        })
        break
      case 'tool_result': {
        // 回填最近一个尚无结果的 tool_use segment（时序配对，同一工具多次调用亦成立）
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].type === 'tool' && segments[i].result == null) {
            segments[i].result = block.content
            break
          }
        }
        break
      }
      case 'media': {
        const media = mediaArr.find(b => b && b.index === block.content?.mediaIndex) || {}
        segments.push({
          type: 'media',
          mediaType: media.type || 'media_chart',
          index: block.content?.mediaIndex ?? 0,
          title: block.content?.title || media.title || null,
          data: media.data || null,
          pending: false,
        })
        break
      }
      case 'plan': {
        // 07_2 序 1：plan 块（```plan 劫持）→ 步骤计划卡片段
        segments.push({
          type: 'media',
          mediaType: 'plan',
          index: block.index,
          title: block.content?.steps ? `共 ${block.content.steps.length} 步` : null,
          data: block.content?.steps || null,
          pending: false,
        })
        break
      }
    }
  }

  return {
    role: 'assistant',
    segments,
    error: m.success === false && m.errorMessage ? '[' + m.errorMessage + ']' : '',
    messageId: m.messageId,
    done: true,
  }
}

/** JSON 字符串（或已是数组）→ 数组；脏数据/空值一律返回 []（contentBlocks 归一化与明细解析共用） */
function parseJsonArray(json) {
  if (!json) return []
  if (Array.isArray(json)) return json // 后端 JSON 字段可能已解析为数组直传
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

/** 重置为全新会话（不动会话列表） */
function resetConversation() {
  conversationId.value = null
  activeConversationId.value = null
  messages.value = []
}

// ---------- 发送与 SSE 解析 ----------

// ---------- @ 唤起（15 号：@ 系统指令 / @ 应用绑定技能） ----------
// 交互契约（辉哥 2026-09-15 定稿）：
//   ① 仅输入框【第一个字符是 @】才弹层；后续 @ 不处理
//   ② 一次只允许一个指令/技能（@词存在于开头即占用）
//   ③ 选中后 @词以蓝色特殊字体显示在输入框内（镜像层渲染，input 本体透明）
//   ④ 文本即状态：@词被删除 → 触发自然失效（无独立 tag/chip）
const atState = reactive({
  show: false,
  word: '',
  commands: [],
  skills: [],
  loaded: false,
})
const atComposing = ref(false)   // IME 拼音过程（composition 期间切回 input 自身渲染——preedit 文本在 input 层显示）

/** 当前生效的 @ 触发（文本派生：输入以 @词+空格 开头，词精确匹配条目 label；文本改动自动同步） */
const activeAt = computed(() => {
  const m = userInput.value.match(/^@(\S+)\s/)
  if (!m) return null
  const label = m[1]
  const pool = [
    ...atState.commands.map(c => ({ kind: 'mode', code: c.triggerCode, label: c.label })),
    ...atState.skills.map(s => ({ kind: 'skill', code: s.code, label: s.name })),
  ]
  return pool.find(i => i.label === label) || null
})

/** 发送时的 trigger 值（无触发 = undefined 走普通对话） */
const activeTrigger = computed(() => {
  const a = activeAt.value
  return a ? `${a.kind}:${a.code}` : undefined
})

/** 镜像层文本：@词与余文分段（@词蓝色渲染） */
const mirrorText = computed(() => {
  const m = userInput.value.match(/^@(\S+)(\s[\s\S]*)?$/)
  if (!m) return { at: '', rest: userInput.value }
  return { at: '@' + m[1], rest: m[2] || '' }
})

/** 拉取 @ 弹层数据（按当前应用；切换应用后重置缓存） */
async function loadAtCommands() {
  if (!selectedAppCode.value) return
  try {
    const data = await chatApi.atCommands(selectedAppCode.value)
    atState.commands = data.commands || []
    atState.skills = data.skills || []
    atState.loaded = true
  } catch { atState.loaded = false }
}

/** 统一联想条目（kind: mode=系统指令 / skill=技能） */
const atFiltered = computed(() => {
  const w = atState.word.toLowerCase()
  const all = [
    ...atState.commands.map(c => ({ kind: 'mode', code: c.triggerCode, label: c.label, desc: c.description || '' })),
    ...atState.skills.map(s => ({ kind: 'skill', code: s.code, label: s.name, desc: '应用绑定技能 · 点名注入' })),
  ]
  if (!w) return all
  return all.filter(i =>
    i.label.toLowerCase().includes(w) || i.code.toLowerCase().includes(w))
})

/** 输入事件：仅首字符 @ 且尚无生效触发时弹层（composition 保护） */
function onAtInput(e) {
  if (atComposing.value) return
  const text = e.target?.value ?? userInput.value
  const isOpen = text.startsWith('@') && !activeAt.value
  if (!isOpen) { atState.show = false; return }
  atState.word = (text.match(/^@([^\s]*)/) || [, ''])[1]
  if (!atState.loaded) loadAtCommands()
  atState.show = true
}

/** 选中条目：回填 @label + 空格（文本即状态——@词蓝色渲染由此生效） */
function pickAt(item) {
  const rest = userInput.value.replace(/^@\S*\s?/, '')
  userInput.value = `@${item.label} ${rest}`
  atState.show = false
  atState.word = ''
}

/** 关闭弹层（Esc / 失焦 / 发送后） */
function closeAtMenu() { atState.show = false }


async function sendMessage() {
  const query = userInput.value.trim()
  const hasAttachments = attachments.value.length > 0
  const trigger = activeTrigger.value
  if ((!query && !hasAttachments && !trigger) || streaming.value) return
  if (!selectedAppCode.value) {
    appsLoadError.value = '请先选择应用'
    return
  }

  // 附件转 base64（失败即中止本轮，附件保留可重试）
  let attachmentPayload = []
  if (hasAttachments) {
    try {
      attachmentPayload = await Promise.all(attachments.value.map(async a => ({
        mime: a.mime, name: a.name, data: await fileToBase64(a.file)
      })))
    } catch (e) {
      message.error('附件读取失败：' + e.message)
      return
    }
  }

  userInput.value = ''
  closeAtMenu()
  // 用户气泡（含附件预览：图片缩略 / 文件 chip）
  const sentAttachments = attachments.value.map(a => ({
    kind: a.mime.startsWith('image/') ? 'image' : 'file',
    mime: a.mime, name: a.name, size: a.size, previewUrl: a.previewUrl
  }))
  // 附件已随消息渲染，本地待发栏清空（objectURL 由气泡持有，此处不 revoke）
  attachments.value = []
  messages.value.push({ role: 'user', content: query, attachments: sentAttachments })

  // 本轮 assistant 气泡（segments 模型：按事件时序构建，工具块嵌在对应位置）
  const assistantMsg = reactive({
    role: 'assistant',
    segments: [],       // [{type:'text',content} | {type:'tool',tool,args,result,costMs,success}]
    thinking: '',       // THINKING 增量追加的思考过程
    thinkingStarted: false, // Anthropic 协议：思考阶段信号（空 THINKING 事件），全文流末到达
    error: '',          // ERROR 红字
    messageId: null,
    done: false
  })
  messages.value.push(assistantMsg)
  streaming.value = true
  scrollBottom()

  // 用户中断（停止按钮）：AbortController → fetch 断开 → 后端半截落库
  streamAbort.value = new AbortController()
  try {
    await chatApi.stream(
      selectedAppCode.value,
      {
        query,
        // 首轮不带 conversationId（后端新建会话并返回），后续轮续传实现多轮
        conversationId: conversationId.value || undefined,
        // 11 方案：附件 base64 直传（图片多模态 / 文本类后端注入 prompt）
        attachments: attachmentPayload.length ? attachmentPayload : undefined,
        // 15 号：@ 触发标记（mode=系统指令 / skill=应用绑定技能点名）
        trigger: trigger || undefined
      },
      evt => handleEvent(evt, assistantMsg),
      streamAbort.value.signal
    )
  } catch (e) {
    if (e?.name !== 'AbortError') {
      assistantMsg.error = (assistantMsg.error ? assistantMsg.error + '\n' : '') + '请求失败：' + e.message
    }
  } finally {
    streaming.value = false
    streamAbort.value = null
    assistantMsg.done = true
    scrollBottom()
    // 对话结束后刷新会话列表（新会话/新消息入列）
    loadConversations()
  }
}

/** 中断当前流（停止按钮）：半截内容保留在消息中（后端同轮落库） */
function stopStreaming() {
  streamAbort.value?.abort()
}

/** SSE 解析（readSseStream/dispatchSseLine）已沉淀到 api/chat.js 统一管理 */

/** 按事件类型分发到当前 assistant 气泡（segments 时序构建）+ Emotion Ball 联动 */
function handleEvent(evt, msg) {
  ballReact(evt.type)
  switch (evt.type) {
    case 'MESSAGE':
      // 首帧 content 可能为空串，仅携带 messageId / conversationId（存住续传）
      if (evt.messageId && !msg.messageId) msg.messageId = evt.messageId
      if (evt.conversationId) {
        conversationId.value = evt.conversationId
        activeConversationId.value = evt.conversationId
      }
      if (evt.content) {
        // 追加到尾部 text 段（若尾部不是 text 段则新建）
        const lastSeg = msg.segments[msg.segments.length - 1]
        if (lastSeg && lastSeg.type === 'text') {
          lastSeg.content += evt.content
        } else {
          msg.segments.push({ type: 'text', content: evt.content })
        }
      }
      break
    case 'THINKING':
      // 多轮思考分段（修复版）：think 段进 segments 时序流——正文/工具之后的新思考
      // 在正确位置渲染。restart 标记 = 新段首帧（工具循环第二轮思考）；
      // 空 content = 思考阶段信号（Anthropic 占位脉冲）
      if (evt.content) {
        const lastSeg = msg.segments[msg.segments.length - 1]
        if (!evt.thinkingRestart && lastSeg && lastSeg.type === 'think') {
          lastSeg.content += evt.content
        } else {
          msg.segments.push({ type: 'think', content: evt.content })
        }
        msg.thinkingStarted = true
      } else {
        msg.thinkingStarted = true // 显示"思考中"占位
      }
      break
    case 'TOOL_START':
      // 工具块插入消息流当前位置（后端落库 answer 时在相同位置嵌 [[TOOL:n]] 占位）
      msg.segments.push({
        type: 'tool', tool: evt.tool, displayName: evt.displayName || null, args: evt.args,
        result: null, costMs: null, success: null, errorMessage: null
      })
      break
    case 'TOOL_RESULT':
      // 回填最近一个同名且尚无结果的工具段（同一工具可能被多次调用）；
      // 失败语义：result=null + toolError 携带错误信息（前端渲染失败徽章）
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        const s = msg.segments[i]
        if (s.type === 'tool' && s.tool === evt.tool && s.result == null && s.success == null) {
          s.result = evt.result || null
          s.costMs = evt.costMs
          s.success = evt.toolError ? false : true
          if (evt.toolError) s.errorMessage = evt.toolError
          break
        }
      }
      break
    case 'MEDIA_START':
      // 富媒体块开始（09：```echarts 块被后端劫持）——占位段（脉冲动画）
      msg.segments.push({
        type: 'media', mediaType: evt.mediaType || 'media_chart',
        index: evt.mediaIndex, title: null, data: null, pending: true
      })
      break
    case 'MEDIA_END': {
      // 媒体块完成——回填最近的同 index pending 段（正常时序下必命中）
      let target = null
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        const s = msg.segments[i]
        if (s.type === 'media' && s.index === evt.mediaIndex && s.pending) {
          target = s
          break
        }
      }
      if (target) {
        target.title = evt.content || null
        target.data = evt.mediaData || null
        target.pending = false
      } else {
        msg.segments.push({
          type: 'media', mediaType: evt.mediaType || 'media_chart',
          index: evt.mediaIndex, title: evt.content || null,
          data: evt.mediaData || null, pending: false
        })
      }
      break
    }
    case 'DONE':
      if (evt.conversationId) {
        conversationId.value = evt.conversationId
        activeConversationId.value = evt.conversationId
      }
      msg.done = true
      break
    case 'ERROR':
      msg.error = (msg.error ? msg.error + '\n' : '') + (evt.content || '未知错误')
      break
    default:
      console.warn('未知 SSE 事件类型：', evt.type)
  }
  scrollBottom()
}

// ---------- 会话管理 ----------

/** 新会话：清空会话 ID 与消息列表 */
function newConversation() {
  if (streaming.value) return // 流式进行中不允许新建
  resetConversation()
}

// ---------- 会话操作（⋯ 菜单：重命名 / 删除；Naive UI） ----------

const dialog = useDialog()
const message = useMessage()

// ---------- 附件（11 方案：图片走多模态 / 文本类注入 prompt） ----------

const attachments = ref([])   // 待发送附件 [{mime, name, size, previewUrl, file}]
const fileInputEl = ref(null)
const dragOver = ref(false)   // 拖拽悬停高亮

const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
/** 扩展名 → 白名单 MIME（.log/.md/.csv 的浏览器 type 不稳，按扩展名优先） */
const EXT_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain'
}

/** 解析文件 MIME：扩展名优先，退回浏览器 type；白名单外返回 null */
function resolveMime(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase()
  if (EXT_MIMES[ext]) return EXT_MIMES[ext]
  const t = (file.type || '').toLowerCase()
  return Object.values(EXT_MIMES).includes(t) ? t : null
}

/** 批量添加附件（选择/粘贴/拖拽统一入口）：数量/类型/大小校验，图片生成预览 */
function addFiles(fileList) {
  if (streaming.value) return
  for (const f of Array.from(fileList || [])) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      message.warning(`最多同时 ${MAX_ATTACHMENTS} 个附件`)
      break
    }
    const mime = resolveMime(f)
    if (!mime) {
      message.warning(`不支持的文件类型：${f.name}`)
      continue
    }
    if (f.size > MAX_ATTACHMENT_BYTES) {
      message.warning(`附件超过 5MB：${f.name}`)
      continue
    }
    attachments.value.push({
      mime, name: f.name, size: f.size, file: f,
      // 统一生成 objectURL：图片用于缩略预览，文本类用于弹窗预览（fetch blob: 合法）
      previewUrl: URL.createObjectURL(f)
    })
  }
}

function removeAttachment(idx) {
  const [a] = attachments.value.splice(idx, 1)
  if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl)
}

function onPaste(e) {
  const files = e.clipboardData?.files
  if (files?.length) {
    e.preventDefault()
    addFiles(files)
  }
}

function onDrop(e) {
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length) addFiles(files)
}

/** dragleave 仅在真正离开主区时收起遮罩（relatedTarget 已不在区内）；
 *  拖拽经过子元素时 leave/over 成对高频触发，直连赋值会导致遮罩反复闪烁 */
function onDragLeave(e) {
  if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
    dragOver.value = false
  }
}

/** File → 纯 base64（去 data: 前缀） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

/** 历史消息 attachments JSON → 渲染模型（path 相对 → /uploads 绝对 URL） */
function parseAttachments(json) {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.map(a => ({
      kind: a.kind, mime: a.mime, name: a.name, size: a.size,
      previewUrl: a.path ? ('/' + a.path) : null
    }))
  } catch { return [] }
}

/** 人类可读大小 */
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

// 文本附件弹窗预览：fetch + TextDecoder('utf-8') 明确解码（根治浏览器直开的编码乱码）
const previewFile = ref(null)   // { name, url, content, loading, error, tooLarge }

async function openFilePreview(a) {
  if (!a.previewUrl) return
  previewFile.value = { name: a.name, url: a.previewUrl, content: '', loading: true, error: '', tooLarge: false }
  try {
    const res = await fetch(a.previewUrl)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 512 * 1024) {
      previewFile.value = { name: a.name, url: a.previewUrl, content: '', loading: false, error: '', tooLarge: true }
      return
    }
    previewFile.value = {
      name: a.name, url: a.previewUrl,
      content: new TextDecoder('utf-8').decode(buf),
      loading: false, error: '', tooLarge: false
    }
  } catch (e) {
    previewFile.value = { name: a.name, url: a.previewUrl, content: '', loading: false, error: '加载失败：' + e.message, tooLarge: false }
  }
}

/** md/markdown 后缀 → markdown-it 渲染（复用消息正文的渲染管线与规范化） */
function isMarkdownFile(p) {
  return p && /\.(md|markdown)$/i.test(p.name || '')
}

/** ⋯ 菜单项（删除项红字，与破坏性语义一致） */
function convMenuOptions() {
  return [
    { label: '重命名', key: 'rename' },
    { label: '删除', key: 'delete', props: { style: 'color: #DC2626' } }
  ]
}

function onConvMenuSelect(key, conv) {
  if (key === 'rename') openRename(conv)
  else if (key === 'delete') confirmDelete(conv)
}

// 重命名弹窗（NModal preset=dialog：取消/保存按钮由 preset 渲染）
const renameOpen = ref(false)
const renameForm = ref({ conversationId: '', title: '', saving: false })

function openRename(conv) {
  renameForm.value = { conversationId: conv.conversationId, title: conv.title, saving: false }
  renameOpen.value = true
}

/** 提交重命名：成功后本地更新列表项标题；返回 false 阻止 NModal 关闭（Naive 协议） */
async function submitRename() {
  const m = renameForm.value
  const title = (m.title || '').trim()
  if (!title || m.saving) return false
  m.saving = true
  try {
    await appsApi.renameConversation(m.conversationId, title)
    const c = conversations.value.find(x => x.conversationId === m.conversationId)
    if (c) c.title = title
    renameOpen.value = false
  } catch (e) {
    message.error('重命名失败：' + e.message)
    m.saving = false
    return false
  }
}

/** 删除确认（useDialog 服务式：onPositiveClick 返回 Promise 时确认按钮自动 loading） */
function confirmDelete(conv) {
  dialog.warning({
    title: '删除会话',
    content: `「${conv.title}」及其全部消息将被删除，不可恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await appsApi.removeConversation(conv.conversationId)
        conversations.value = conversations.value.filter(x => x.conversationId !== conv.conversationId)
        if (conv.conversationId === activeConversationId.value) {
          resetConversation()
        }
        message.success('会话已删除')
      } catch (e) {
        message.error('删除失败：' + e.message)
      }
    }
  })
}

// ---------- 视图辅助 ----------

/** 消息列表自动滚到底部 */
async function scrollBottom() {
  await nextTick()
  if (listEl.value) {
    listEl.value.scrollTop = listEl.value.scrollHeight
  }
}

/** 会话条目副标题：更新时间（截短到分钟） */
function convTime(t) {
  if (!t) return ''
  return String(t).replace('T', ' ').slice(0, 16)
}

/** 工具短名：优先取 `__` 双下划线分段（mcp_dbx__execute_query → execute_query）；无 `__` 时取 `_` 末段兜底 */
function shortToolName(name) {
  if (!name) return '工具'
  const s = String(name)
  const dd = s.split('__')
  if (dd.length > 1) return dd[dd.length - 1] || s
  const parts = s.split('_')
  return parts[parts.length - 1] || s
}

// ---------- ack 人机协同（07_1 阶段 B） ----------

/** ack 卡片图标：approval=问号圆 / choice=勾选清单 / clarify=对话问号 */
function ackIconOf(args) {
  const t = args?.type
  if (t === 'approval') return CircleHelp
  if (t === 'choice') return ListChecks
  return MessageCircleQuestion
}

/** ack 选项列表（args.options 归一化；非法项过滤） */
function ackOptionsOf(args) {
  return Array.isArray(args?.options) ? args.options.filter(o => o && o.id && o.label) : []
}

/** ack 携带的计划步骤（07_2 原子化：args.plan 归一化） */
function ackPlanOf(args) {
  return Array.isArray(args?.plan) ? args.plan.filter(s => s && s.desc) : []
}

/** 选项 id → label（"模型建议"提示用；"我的想法"虚拟项返回 null 不参与） */
function ackLabelOf(args, id) {
  const hit = ackOptionsOf(args).find(o => o.id === id)
  return hit ? hit.label : id
}

/** "我的想法"虚拟选项 id（choice 卡片前端自动追加，不入后端 options） */
const ACK_CUSTOM_ID = '_custom'

const ackResponding = ref(false)

/**
 * ack 用户响应：选项/输入提交（或取消）→ POST ack → 消费续跑轮 SSE（新 assistant 消息）。
 * 响应后本卡片转只读（result = 本地预填文本，回放时由后端轨迹覆盖）。
 * 「我的想法」分支（辉哥 2026-09-11）：choice 卡片用户不选方案而输入自定义意见
 * （典型：认同 B 方案但要求局部调整）→ 走 input 协议，内容带 [我的想法] 前缀
 * 让模型明确这是对方案的修正意见而非自由闲聊。
 */
async function respondAck(seg, msg, reject = false) {
  if (ackResponding.value || streaming.value) return
  const isCustom = seg._picked === ACK_CUSTOM_ID
  const customText = (seg._input || '').trim()
  const body = reject ? { reject: true } : (
    isCustom ? { input: `[我的想法] ${customText}` } :
    seg._picked ? { choice: seg._picked } : { input: (seg._input || '').trim() }
  )
  // 防护：「我的想法」必须非空；普通模式选项与输入至少其一
  if (!reject && ((isCustom && !customText) || (!isCustom && !seg._picked && !body.input))) return
  ackResponding.value = true
  // 本地预填 result（只读态即时反馈；真实轨迹由后端补录）
  const pickedLabel = (!isCustom && seg._picked) ? ackLabelOf(seg.args, seg._picked) : ''
  seg.result = reject ? '用户已取消该操作'
    : (isCustom ? `用户想法：${customText}`
    : (pickedLabel ? `用户选择：${seg._picked} · ${pickedLabel}` : `用户回复：${body.input}`))
  seg.success = true
  if (reject) {
    // 拒绝不走续跑流
    try { await chatApi.ackRespond(selectedAppCode.value, msg.messageId, body, () => {}) }
    catch (e) { message.error('取消失败：' + e.message) }
    finally { ackResponding.value = false }
    return
  }
  // 续跑轮：新 assistant 消息消费 SSE（复用 handleEvent，工具/媒体/思考全部生效）
  const resumeMsg = reactive({
    role: 'assistant', segments: [], thinking: '', thinkingStarted: false,
    error: '', messageId: null, done: false,
  })
  messages.value.push(resumeMsg)
  streaming.value = true
  scrollBottom()
  streamAbort.value = new AbortController()
  try {
    await chatApi.ackRespond(selectedAppCode.value, msg.messageId, body, evt => handleEvent(evt, resumeMsg), streamAbort.value.signal)
  } catch (e) {
    if (e?.name !== 'AbortError') resumeMsg.error = '续跑失败：' + e.message
  } finally {
    streaming.value = false
    ackResponding.value = false
    resumeMsg.done = true
    scrollBottom()
    loadConversations()
  }
}

/** 当前应用（顶栏信息用） */
function currentApp() {
  return apps.value.find(a => a.appCode === selectedAppCode.value)
}

/**
 * 工具结果适配解析（前端展示专用）。
 * HowToCook 轨迹的 result 是双层 JSON：[{text:"{菜谱JSON}"}]，逐层剥开后按结构识别：
 * - error          → 错误提示（红字）
 * - name+ingredients/steps → 菜谱卡片
 * - 普通对象       → 键值摘要
 * - 解析失败       → 原文（限高滚动）
 */
function parseToolResult(seg) {
  if (seg.result == null && seg.errorMessage == null) return { type: 'pending' }
  if (seg.errorMessage) return { type: 'error', message: seg.errorMessage }
  let obj = null
  const raw = String(seg.result)
  try {
    obj = JSON.parse(raw)
  } catch {
    return { type: 'raw', text: raw }
  }
  // HowToCook 双层包裹：[{text:"{...}"}]
  if (Array.isArray(obj) && obj.length && typeof obj[0]?.text === 'string') {
    try {
      obj = JSON.parse(obj[0].text)
    } catch {
      return { type: 'raw', text: obj[0].text }
    }
  }
  if (Array.isArray(obj)) obj = obj[0]
  if (obj && typeof obj === 'object') {
    if (obj.error) {
      return { type: 'error', message: obj.error + (obj.suggestion ? `（${obj.suggestion}）` : '') }
    }
    if (obj.name && (obj.ingredients || obj.steps)) {
      return { type: 'recipe', data: obj }
    }
    return { type: 'kv', data: obj }
  }
  return { type: 'raw', text: String(obj) }
}

/** 菜谱食材 chips：取 name 去重，限 12 个 */
function recipeIngredients(recipe) {
  const names = (recipe.ingredients || [])
    .map(i => i.name || i.text_quantity)
    .filter(n => n && n.length < 30)
  return [...new Set(names)].slice(0, 12)
}

/** kv 摘要：取前 6 个键值对 */
function kvEntries(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, 6)
}
</script>

<template>
  <div class="chat-root">
    <!-- 顶栏（60px sticky，同设置页 st-header） -->
    <header class="ch-header">
      <div class="ch-header-left">
        <span class="ch-crumb">对话</span>
        <span class="ch-crumb-sep">/</span>
        <span class="ch-crumb-current">{{ currentApp()?.name || '未选择应用' }}</span>
      </div>
      <div class="ch-header-right">
        <span v-if="currentApp()" class="ch-chip mono">{{ currentApp().provider }} · {{ currentApp().model }}</span>
        <button class="ch-icon-btn" @click="router.push('/settings')" title="设置">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      </div>
    </header>

    <div class="ch-body">
      <!-- 左侧：会话栏（218px rail，同设置页 st-rail） -->
      <aside class="ch-rail">
        <div class="ch-rail-top">
          <button class="ch-btn ch-btn-primary ch-btn-new" @click="newConversation" :disabled="streaming">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <span>新会话</span>
          </button>
        </div>

        <!-- 应用选择 -->
        <div class="ch-rail-app">
          <select v-model="selectedAppCode" class="ch-select" :disabled="streaming">
            <option v-for="a in apps" :key="a.appCode" :value="a.appCode">
              {{ a.name }}
            </option>
            <option v-if="!apps.length" value="" disabled>暂无可用应用</option>
          </select>
        </div>

        <!-- 会话列表 -->
        <div class="ch-conv-list">
          <div v-if="convListLoading" class="ch-conv-tip">加载中…</div>
          <div v-else-if="!conversations.length" class="ch-conv-tip">暂无历史会话</div>
          <div
            v-for="c in conversations"
            :key="c.conversationId"
            class="ch-conv-item"
            :class="{ active: c.conversationId === activeConversationId }"
            @click="openConversation(c)"
          >
            <div class="ch-conv-title">{{ c.title }}</div>
            <div class="ch-conv-time">{{ convTime(c.updateTime) }}</div>
            <!-- ⋯ 操作入口：hover/激活时浮现，流式进行中隐藏；NDropdown trigger -->
            <NDropdown
              v-if="!streaming"
              trigger="click"
              placement="right-start"
              :options="convMenuOptions()"
              @select="key => onConvMenuSelect(key, c)"
            >
              <button class="ch-conv-more" title="会话操作" @click.stop>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.8" cy="8" r="1.4"/></svg>
              </button>
            </NDropdown>
          </div>
        </div>

        <!-- 左下角：设置入口 + 版权 -->
        <div class="ch-rail-foot">
          <button class="ch-rail-settings" @click="router.push('/settings')">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <span class="ch-rail-settings-text">设置</span>
          </button>
          <div class="ch-rail-copyright">© 2026 彭某某 · 17752802756@163.com</div>
        </div>
      </aside>

      <!-- 右侧：对话主区（11 方案：拖拽附件入口——dragover 高亮 / drop 接收） -->
      <main class="ch-main" @dragover.prevent="!streaming && (dragOver = true)" @dragleave="onDragLeave" @drop.prevent="onDrop">
        <!-- 拖拽悬停遮罩 -->
        <div v-if="dragOver" class="ch-drop-mask">
          <div class="ch-drop-card">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none"><path d="M8 11V2.5M5 5l3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11v2.5h11V11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <p>松开添加附件</p>
          </div>
        </div>

        <!-- 应用列表加载提示 -->
        <div v-if="appsLoadError" class="ch-banner-error">{{ appsLoadError }}</div>

        <!-- 消息流（居中列） -->
        <div ref="listEl" class="ch-thread">
          <!-- 切换会话加载中（与空态区分：不闪"开始新对话"再跳出消息） -->
          <div v-if="loadingConv" class="ch-empty ch-conv-loading">
            <span class="ch-loading-dots"><span></span><span></span><span></span></span>
            <p class="ch-conv-loading-text">正在加载会话…</p>
          </div>
          <div v-else-if="!messages.length" class="ch-empty">
            <!-- 迎宾词气泡：绑在空态宽容器上（文档流居中、宽度自适应），尾巴指向下方球 -->
            <transition name="ch-tip-pop">
              <div v-if="welcomeLine" class="ch-empty-tip">{{ welcomeLine }}</div>
            </transition>
            <!-- 新对话迎宾球：随 v-if 重建（随机表情）；点击戳一下 → 弹跳 + 换一条文案 -->
            <div class="ch-empty-mark">
              <div ref="emptyBallEl" class="ch-empty-ball" title="戳我换一条" @click="cycleWelcomeLine"></div>
            </div>
            <p class="ch-empty-title">开始一段新对话</p>
            <p class="ch-empty-sub">选择应用后输入问题；左侧可查看历史会话，多轮上下文自动续传</p>
          </div>

          <div v-for="(m, idx) in messages" :key="idx" class="ch-msg" :class="m.role">
            <!-- user：右对齐深色气泡（11 方案：图片缩略在气泡内，文件引用在气泡下方） -->
            <div v-if="m.role === 'user'" class="ch-bubble-user">
              <div class="ch-bubble-user-body">
                <!-- 图片附件：缩略网格（点击新标签页看原图） -->
                <div v-if="m.attachments?.some(a => a.kind === 'image')" class="ch-attach-grid">
                  <a v-for="(a, ai) in m.attachments.filter(a => a.kind === 'image')" :key="ai"
                     :href="a.previewUrl" target="_blank" class="ch-attach-img" :title="a.name">
                    <img :src="a.previewUrl" :alt="a.name" />
                  </a>
                </div>
                <div v-if="m.content" class="ch-bubble-user-text">{{ m.content }}</div>
              </div>
              <!-- 文件附件：气泡下方引用条（引用色 + 文件名，点击弹窗预览） -->
              <div v-if="m.attachments?.some(a => a.kind !== 'image')" class="ch-attach-refs">
                <a v-for="(a, ai) in m.attachments.filter(a => a.kind !== 'image')" :key="ai"
                   href="javascript:void(0)" class="ch-file-ref" :title="'预览 ' + a.name"
                   @click.prevent="openFilePreview(a)">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 1.8h6l2.5 2.5V14.2H4V1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 1.8v2.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                  <span class="ch-file-ref-name">{{ a.name }}</span>
                  <span class="ch-file-ref-size">{{ fmtSize(a.size) }}</span>
                </a>
              </div>
            </div>

            <!-- assistant：白卡片 -->
            <div v-else class="ch-bubble-ai">
              <!-- Anthropic 思考阶段占位（流中布尔标记；思考文本在流末到达） -->
              <div v-if="m.thinkingStarted && !m.segments.some(s => s.type === 'think')" class="ch-thinking-pending">
                <span class="ch-pulse-dot"></span>思考中…
              </div>

              <!-- 分段序列渲染（text/think/tool/media 按时序交替，工具与新思考嵌在对应位置） -->
              <template v-for="(seg, si) in m.segments" :key="si">
                <!-- 文本段（Markdown 渲染，仅 assistant；user 输入永不走 v-html） -->
                <div v-if="seg.type === 'text' && seg.content" class="ch-text md-body" v-html="mdRender(seg.content)"></div>

                <!-- 思考段（多轮思考修复：内联位置折叠块，工具循环第二轮的新思考显示在正文/工具之后） -->
                <details v-else-if="seg.type === 'think'" class="ch-thinking">
                  <summary>
                    <Brain class="ch-thinking-icon" :size="12" />
                    思考过程
                  </summary>
                  <pre class="ch-pre">{{ seg.content }}</pre>
                </details>

                <!-- 媒体段（09：media_chart / media_mermaid / plan；pending 占位 → 渲染 → 容错降级） -->
                <div v-else-if="seg.type === 'media'" class="ch-media">
                  <div v-if="seg.pending" class="ch-media-pending">
                    <span class="ch-pulse-dot"></span>{{ seg.mediaType === 'media_mermaid' ? '流程图生成中…' : seg.mediaType === 'plan' ? '计划生成中…' : '图表生成中…' }}
                  </div>
                  <!-- plan 步骤计划卡片（07_2 序 1：```plan 劫持） -->
                  <template v-else-if="seg.mediaType === 'plan'">
                    <div class="ch-plan">
                      <div class="ch-plan-head">
                        <ListOrdered class="ch-plan-icon" :size="14" />
                        <span class="ch-plan-title">执行计划{{ seg.title ? ` · ${seg.title}` : '' }}</span>
                      </div>
                      <div v-if="Array.isArray(seg.data)" class="ch-plan-steps">
                        <div v-for="s in seg.data" :key="s.index" class="ch-plan-step">
                          <span class="ch-plan-idx">{{ s.index }}</span>
                          <span class="ch-plan-desc">{{ s.desc }}</span>
                          <span v-if="s.tool" class="ch-plan-tool mono">{{ s.tool }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                  <template v-else-if="seg.mediaType === 'media_chart'">
                    <div v-if="seg.title" class="ch-media-title">{{ seg.title }}</div>
                    <MediaChart v-if="seg.data && typeof seg.data === 'object'" :option="seg.data" />
                    <div v-else class="ch-media-fallback">⚠️ 图表数据异常
                      <details><summary>查看原始数据</summary><pre class="ch-pre">{{ JSON.stringify(seg.data, null, 2) }}</pre></details>
                    </div>
                  </template>
                  <template v-else-if="seg.mediaType === 'media_mermaid'">
                    <div v-if="seg.title" class="ch-media-title">{{ seg.title }}</div>
                    <MediaMermaid v-if="seg.data && typeof seg.data === 'string'" :code="seg.data" />
                    <div v-else class="ch-media-fallback">⚠️ 流程图数据异常
                      <details><summary>查看原始数据</summary><pre class="ch-pre">{{ String(seg.data) }}</pre></details>
                    </div>
                  </template>
                  <div v-else class="ch-media-unknown">
                    媒体类型暂不支持：{{ seg.mediaType }}{{ seg.title ? ' · ' + seg.title : '' }}
                  </div>
                </div>

                <!-- ack 段（07_1：用户决策卡片——等待响应交互态 / 已响应只读态） -->
                <div v-else-if="seg.type === 'tool' && seg.tool === 'ack_user'" class="ch-ack" :class="{ done: seg.result != null }">
                  <div class="ch-ack-head">
                    <component :is="ackIconOf(seg.args)" class="ch-ack-icon" :size="14" />
                    <span class="ch-ack-title">{{ seg.args?.question || '等待用户确认' }}</span>
                  </div>
                  <div v-if="seg.args?.risk" class="ch-ack-risk">⚠️ {{ seg.args.risk }}</div>
                  <!-- 原子化 plan 步骤区（07_2 修正：计划随 ack 携带，同卡片展示步骤+确认） -->
                  <div v-if="ackPlanOf(seg.args).length" class="ch-ack-plan">
                    <div v-for="s in ackPlanOf(seg.args)" :key="s.index" class="ch-plan-step">
                      <span class="ch-plan-idx">{{ s.index }}</span>
                      <span class="ch-plan-desc">{{ s.desc }}</span>
                      <span v-if="s.tool" class="ch-plan-tool mono">{{ s.tool }}</span>
                    </div>
                  </div>
                  <!-- 交互态：等待用户响应 -->
                  <template v-if="seg.result == null">
                    <!-- 选项列表常驻（两条互斥分支：点普通选项仅选中；点"我的想法"展开输入框，列表不隐藏可切回） -->
                    <div v-if="ackOptionsOf(seg.args).length" class="ch-ack-options">
                      <button v-for="o in ackOptionsOf(seg.args)" :key="o.id" type="button"
                              class="ch-ack-option" :class="{ picked: seg._picked === o.id, recommended: o.recommended }"
                              @click="seg._picked = o.id">
                        <span class="ch-ack-opt-label">{{ o.id }} · {{ o.label }}<span v-if="o.recommended" class="ch-ack-rec">推荐</span></span>
                        <span v-if="o.detail" class="ch-ack-opt-detail">{{ o.detail }}</span>
                      </button>
                      <!-- 我的想法（辉哥 2026-09-11）：choice 型自动追加——认同方案但要调整时自由输入意见 -->
                      <button v-if="seg.args?.type === 'choice'" type="button"
                              class="ch-ack-option ch-ack-custom" :class="{ picked: seg._picked === ACK_CUSTOM_ID }"
                              @click="seg._picked = ACK_CUSTOM_ID">
                        <span class="ch-ack-opt-label"><PenLine :size="12" class="ch-ack-custom-icon" /> 我的想法<span class="ch-ack-custom-hint">不选方案，直接说你的意见</span></span>
                      </button>
                    </div>
                    <!-- 输入框：clarify / 无选项 / 选中"我的想法"时展开（选项列表不隐藏） -->
                    <div v-if="seg.args?.type === 'clarify' || !ackOptionsOf(seg.args).length || seg._picked === ACK_CUSTOM_ID" class="ch-ack-input-row">
                      <input v-model="seg._input" class="ch-ack-input"
                             :placeholder="seg._picked === ACK_CUSTOM_ID ? '如：我觉得 B 方案不错，但这些地方需要调整…' : '输入你的回复…'"
                             @keydown.enter="respondAck(seg, m)" />
                    </div>
                    <div class="ch-ack-actions">
                      <span v-if="seg.args?.default && ackOptionsOf(seg.args).length" class="ch-ack-hint">💡 模型建议：{{ ackLabelOf(seg.args, seg.args.default) }}</span>
                      <button type="button" class="st-btn st-btn-primary ch-ack-btn"
                              :disabled="ackResponding || (seg._picked === ACK_CUSTOM_ID ? !(seg._input || '').trim() : (!seg._picked && !seg._input))"
                              @click="respondAck(seg, m)">{{ seg.args?.type === 'approval' ? '确认执行' : '提交' }}</button>
                      <button type="button" class="st-btn st-btn-ghost ch-ack-btn"
                              :disabled="ackResponding" @click="respondAck(seg, m, true)">取消</button>
                    </div>
                  </template>
                  <!-- 只读态：已响应 -->
                  <div v-else class="ch-ack-resolved">
                    <CheckCircle2 class="ch-ack-done-icon" :size="13" />
                    <span>{{ seg.result }}</span>
                  </div>
                </div>

                <!-- 工具段：卡片化展示（skill 加载=书本图标；其他工具=扳手图标；lucide 图标库） -->
                <details v-else-if="seg.type === 'tool'" class="ch-tool" :class="{ pending: seg.result == null && seg.success == null }">
                  <summary>
                    <component :is="seg.tool === 'load_skill' ? BookOpen : Wrench" class="ch-tool-icon" :size="12" />
                    <span class="mono ch-tool-name">{{ seg.displayName || shortToolName(seg.tool) }}</span>
                    <span v-if="seg.result != null || seg.success != null || seg.errorMessage" class="ch-tool-badge" :class="seg.success === false ? 'fail' : 'ok'">
                      {{ seg.success === false ? '失败' : '完成' }} · {{ seg.costMs }}ms
                    </span>
                    <span v-else class="ch-tool-badge run">
                      <span class="ch-pulse-dot"></span>调用中
                    </span>
                    <svg class="ch-tool-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </summary>
                  <div class="ch-tool-body">
                    <div class="ch-tool-args">
                      <span class="ch-tool-label">入参</span>
                      <code class="mono">{{ typeof seg.args === 'string' ? seg.args : JSON.stringify(seg.args) }}</code>
                    </div>

                    <!-- 工具结果适配渲染 -->
                    <template v-if="seg.result != null || seg.errorMessage">
                      <!-- 错误 -->
                      <div v-if="parseToolResult(seg).type === 'error'" class="ch-tool-error">
                        ⚠️ {{ parseToolResult(seg).message }}
                      </div>
                      <!-- 菜谱卡片 -->
                      <div v-else-if="parseToolResult(seg).type === 'recipe'" class="ch-recipe">
                        <div class="ch-recipe-name">{{ parseToolResult(seg).data.name }}</div>
                        <div class="ch-recipe-meta">
                          <span v-if="parseToolResult(seg).data.difficulty" class="ch-chip-tag">难度 {{ parseToolResult(seg).data.difficulty }}/5</span>
                          <span v-if="parseToolResult(seg).data.category" class="ch-chip-tag">{{ parseToolResult(seg).data.category }}</span>
                          <span v-if="parseToolResult(seg).data.servings" class="ch-chip-tag">{{ parseToolResult(seg).data.servings }} 人份</span>
                        </div>
                        <div v-if="recipeIngredients(parseToolResult(seg).data).length" class="ch-recipe-ings">
                          <span v-for="ing in recipeIngredients(parseToolResult(seg).data)" :key="ing" class="ch-ing-chip">{{ ing }}</span>
                        </div>
                        <details v-if="parseToolResult(seg).data.description" class="ch-recipe-desc">
                          <summary>查看做法详情</summary>
                          <pre class="ch-pre">{{ parseToolResult(seg).data.description }}</pre>
                        </details>
                      </div>
                      <!-- 通用键值摘要 -->
                      <div v-else-if="parseToolResult(seg).type === 'kv'" class="ch-kv">
                        <div v-for="[k, v] in kvEntries(parseToolResult(seg).data)" :key="k" class="ch-kv-row">
                          <span class="ch-kv-key">{{ k }}</span>
                          <span class="ch-kv-val">{{ String(v).slice(0, 60) }}</span>
                        </div>
                      </div>
                      <!-- 原文兜底（限高） -->
                      <pre v-else class="ch-pre">{{ parseToolResult(seg).text }}</pre>
                    </template>
                  </div>
                </details>
              </template>

              <!-- 生成中光标（无任何输出时） -->
              <span v-if="!m.done && !m.segments.length && !m.error" class="ch-typing">▋</span>

              <!-- 错误 -->
              <div v-if="m.error" class="ch-error">{{ m.error }}</div>
            </div>
          </div>
        </div>

        <!-- 底部输入区（悬浮卡片；11 方案：附件栏 + 粘贴/选择输入） -->
        <footer class="ch-composer">
          <div class="ch-composer-card" :class="{ streaming }">
            <!-- 附件预览栏（有附件时显示） -->
            <div v-if="attachments.length" class="ch-composer-attach">
              <div v-for="(a, i) in attachments" :key="i" class="ch-attach-chip">
                <img v-if="a.mime.startsWith('image/')" :src="a.previewUrl" class="ch-attach-chip-img" :alt="a.name" />
                <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 1.8h6l2.5 2.5V14.2H4V1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 1.8v2.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                <span class="ch-attach-chip-name">{{ a.name }}</span>
                <button class="ch-attach-chip-x" title="移除" @click="removeAttachment(i)">×</button>
              </div>
            </div>
            <div class="ch-composer-row">
              <!-- 📎 附件入口（隐藏 file input，白名单过滤） -->
              <input
                ref="fileInputEl"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json,.log"
                class="ch-file-input"
                @change="e => { addFiles(e.target.files); e.target.value = '' }"
              />
              <!-- @ 唤起弹层（15 号：系统指令 / 应用绑定技能；输入框上方悬浮） -->
              <div v-if="atState.show && atFiltered.length" class="ch-at-menu">
                <div class="ch-at-group">系统指令</div>
                <template v-for="it in atFiltered" :key="it.kind + it.code">
                  <button v-if="it.kind === 'mode'" class="ch-at-item" @mousedown.prevent="pickAt(it)">
                    <span class="ch-at-item-label">{{ it.label }}</span>
                    <span class="ch-at-item-desc">{{ it.desc }}</span>
                  </button>
                </template>
                <div v-if="atFiltered.some(i => i.kind === 'skill')" class="ch-at-group">技能（本应用绑定）</div>
                <template v-for="it in atFiltered" :key="'s' + it.code">
                  <button v-if="it.kind === 'skill'" class="ch-at-item" @mousedown.prevent="pickAt(it)">
                    <span class="ch-at-item-label">{{ it.label }}</span>
                    <span class="ch-at-item-desc">{{ it.desc }}</span>
                  </button>
                </template>
              </div>
              <!-- Emotion Ball 输入框球（NX_emotion-ball：常驻 DOM，空会话时随消息数显隐；SSE 事件驱动表情 + 思考冒泡） -->
              <div class="ch-emotion-ball-wrap">
                <transition name="ch-tip">
                  <div v-if="ballTip" class="ch-ball-tip">{{ ballTip }}</div>
                </transition>
                <div v-show="!!messages.length" ref="ballEl" class="ch-emotion-ball"></div>
              </div>
              <!-- 输入框镜像层（15 号：@词蓝色特殊字体渲染——input 本体透明，镜像同步全文；
                   pointer-events 穿透，输入/光标仍在 input 上） -->
              <div class="ch-input-wrap" :class="{ composing: atComposing }">
                <div class="ch-input-mirror" aria-hidden="true"><span v-if="mirrorText.at" class="ch-at-word">{{ mirrorText.at }}</span>{{ mirrorText.rest }}</div>
                <input
                  v-model="userInput"
                  class="ch-composer-input ch-input-transparent"
                  type="text"
                  placeholder="输入问题，回车发送…（可粘贴图片；首个字符 @ 唤起指令/技能）"
                  :disabled="streaming"
                  @keydown.enter.exact.prevent="sendMessage"
                  @keydown.esc="closeAtMenu"
                  @blur="closeAtMenu"
                  @input="onAtInput"
                  @compositionstart="atComposing = true"
                  @compositionend="atComposing = false"
                  @paste="onPaste"
                />
              </div>
              <!-- 📎 附件按钮（右移：发送前置动作，相邻顺手） -->
              <button class="ch-attach-btn" title="支持：图片 png / jpg / jpeg / webp / gif；文本 txt / md / csv / json / log（单个 ≤5MB，最多 4 个）" :disabled="streaming" @click="fileInputEl?.click()">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8.5 12.5l-4.2-4.2a2.6 2.6 0 013.7-3.7l4.6 4.6a4.2 4.2 0 01-5.9 5.9L2.3 10.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <!-- 流式进行中=停止按钮（用户中断）；否则=发送 -->
              <button v-if="streaming" class="ch-btn ch-send ch-stop" @click="stopStreaming" title="停止生成（已生成内容保留）">
                <Square :size="12" />
                停止
              </button>
              <button v-else class="ch-btn ch-btn-primary ch-send" @click="sendMessage" :disabled="!userInput.trim() && !attachments.length">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 8l11-5.5L10 8l3.5 5.5-11-5.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                发送
              </button>
            </div>
          </div>
          <p class="ch-composer-hint">{{ streaming ? '模型输出中，请稍候…' : '回车发送 · 多轮上下文自动续传 · 支持图片/文件附件' }}</p>
        </footer>
      </main>
    </div>

    <!-- 文本附件预览弹窗：md 后缀走 markdown-it 渲染，其余等宽原文；utf-8 明确解码 -->
    <NModal :show="!!previewFile" preset="card" :title="previewFile?.name || '文件预览'"
            :teleport="false"
            :style="{ width: '680px', maxWidth: 'calc(100vw - 48px)' }"
            @update:show="o => !o && (previewFile = null)">
      <div v-if="previewFile?.loading" class="ch-file-preview-tip">加载中…</div>
      <div v-else-if="previewFile?.error" class="ch-file-preview-tip ch-file-preview-err">{{ previewFile.error }}</div>
      <div v-else-if="previewFile?.tooLarge" class="ch-file-preview-tip">
        文件较大（超过 512KB），请下载后查看：
        <a :href="previewFile.url" :download="previewFile.name" class="ch-file-preview-dl">点击下载</a>
      </div>
      <div v-else-if="isMarkdownFile(previewFile)" class="ch-file-preview-block md-body" v-html="mdRender(previewFile.content)"></div>
      <pre v-else class="ch-file-preview">{{ previewFile?.content }}</pre>
    </NModal>

    <!-- 会话重命名弹窗（Naive preset=dialog：标题/取消/保存开箱即用，保存 loading 由 preset 接管） -->
    <NModal
      v-model:show="renameOpen"
      preset="dialog"
      title="重命名会话"
      negative-text="取消"
      positive-text="保存"
      :loading="renameForm.saving"
      :on-positive-click="submitRename"
    >
      <NInput
        v-model:value="renameForm.title"
        maxlength="40"
        placeholder="输入会话名称（最多 40 字）"
        @keyup.enter="submitRename"
      />
    </NModal>
  </div>
</template>

<style scoped>
/* ============ 对话页设计系统（与设置页同一套 token，蓝本：Taskora Dashboard） ============ */
.chat-root {
  --bg: #F9F9FA;
  --surface: #FFFFFF;
  --surface-2: #F4F4F5;
  --border: #E9EAEC;
  --text: #18181B;
  --text-2: #52525B;
  --text-3: #A1A1AA;
  --green: #10B981;
  --red: #EF4444;
  --ring: rgba(99, 102, 241, 0.35);

  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: 'Geist Sans', 'Segoe UI', sans-serif;
  font-size: 14px;
}
.mono { font-family: 'Geist Mono', Consolas, monospace; }

/* ---------- 顶栏（同设置页 st-header） ---------- */
.ch-header {
  height: 60px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  flex-shrink: 0;
}
.ch-header-left { display: flex; align-items: center; gap: 10px; }
.ch-crumb { color: var(--text-3); font-size: 13.5px; }
.ch-crumb-sep { color: var(--text-3); font-size: 12px; }
.ch-crumb-current { color: var(--text); font-size: 13.5px; font-weight: 500; }
.ch-header-right { display: flex; align-items: center; gap: 10px; }
.ch-chip {
  font-size: 12px; color: var(--text-2);
  background: var(--surface-2); border-radius: 999px; padding: 5px 12px;
}
.ch-icon-btn {
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
}
.ch-icon-btn:hover { border-color: var(--text-3); color: var(--text); }

/* ---------- 布局 ---------- */
.ch-body { display: flex; flex: 1; min-height: 0; }
.ch-rail {
  width: 218px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  padding: 16px 12px 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.ch-rail-top { padding: 0 2px; }
.ch-rail-app { padding: 0 2px; }

/* 按钮（同设置页 st-btn 家族） */
.ch-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 13px;
  border-radius: 8px; font-size: 13px; font-weight: 500;
  cursor: pointer; transition: all 0.15s ease;
  font-family: inherit; white-space: nowrap;
}
.ch-btn:active { transform: scale(0.97); }
.ch-btn-primary {
  background: var(--text); color: #FAFAFA; border: 1px solid var(--text);
}
.ch-btn-primary:hover { opacity: 0.88; }
.ch-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-btn-new { width: 100%; justify-content: center; }

/* 应用选择（同设置页表单控件） */
.ch-select {
  width: 100%; height: 36px;
  border: 1px solid var(--border); border-radius: 8px;
  padding: 0 11px; font-size: 13px; outline: none;
  background: var(--surface); color: var(--text);
  font-family: inherit; box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ch-select:focus { border-color: #6366F1; box-shadow: 0 0 0 3px var(--ring); }

/* 会话列表 */
.ch-conv-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.ch-conv-tip { text-align: center; color: var(--text-3); font-size: 12.5px; margin-top: 28px; }
.ch-conv-item {
  padding: 9px 12px; border-radius: 10px; cursor: pointer;
  position: relative; transition: background 0.15s ease;
  animation: fadeUp 0.4s ease-out both;
}
.ch-conv-item:hover { background: var(--surface); }
.ch-conv-item.active { background: var(--surface); box-shadow: 0 1px 3px rgba(24,24,27,0.06); }
.ch-conv-item.active::before {
  content: ''; position: absolute; left: 0; top: 9px; bottom: 9px;
  width: 2px; border-radius: 2px; background: var(--text);
}
.ch-conv-title {
  font-size: 13px; font-weight: 500; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ch-conv-item.active .ch-conv-title { color: var(--text); }
.ch-conv-time { font-size: 11px; color: var(--text-3); margin-top: 2px; }

/* ⋯ 操作按钮：hover / 激活时浮现（浮层菜单由 Naive NDropdown 渲染） */
.ch-conv-more {
  position: absolute; right: 6px; top: 7px;
  width: 24px; height: 24px; border-radius: 7px; border: none;
  display: flex; align-items: center; justify-content: center;
  background: none; color: var(--text-3); cursor: pointer;
  opacity: 0; transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.ch-conv-item:hover .ch-conv-more, .ch-conv-item.active .ch-conv-more { opacity: 1; }
.ch-conv-more:hover { background: var(--border); color: var(--text); }

/* 侧栏底部设置入口 */
.ch-rail-foot { border-top: 1px solid var(--border); padding-top: 10px; }
.ch-rail-copyright { padding: 6px 12px 2px; font-size: 10.5px; color: var(--text-3); user-select: none; }
.ch-rail-settings {
  display: flex; align-items: center; gap: 9px;
  width: 100%; padding: 8px 12px; border-radius: 10px;
  border: none; background: none; color: var(--text-2);
  font-size: 13px; font-family: inherit; cursor: pointer;
  transition: background 0.15s ease;
}
.ch-rail-settings:hover { background: var(--surface); color: var(--text); }

/* ---------- 主区 ---------- */
.ch-main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.ch-banner-error {
  margin: 14px 24px 0; padding: 10px 14px;
  background: #FEF2F2; border: 1px solid #FECACA; border-radius: 10px;
  color: #B91C1C; font-size: 12.5px;
}

/* 消息流：居中列 */
.ch-thread { flex: 1; overflow-y: auto; padding: 28px 24px 8px; }
.ch-msg { max-width: 760px; margin: 0 auto 16px; animation: fadeUp 0.4s ease-out both; }

/* 空态（同设置页 st-empty） */
.ch-empty { text-align: center; padding: 96px 20px; }
/* 切换会话加载态（与空态区分）：三点脉冲 + 文案，居中 */
.ch-conv-loading { padding: 120px 20px; }
.ch-loading-dots { display: inline-flex; gap: 6px; align-items: center; }
.ch-loading-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); animation: ch-dot-pulse 1.2s infinite ease-in-out; }
.ch-loading-dots span:nth-child(2) { animation-delay: .18s; }
.ch-loading-dots span:nth-child(3) { animation-delay: .36s; }
@keyframes ch-dot-pulse { 0%, 100% { opacity: .25; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
.ch-conv-loading-text { margin: 12px 0 0; font-size: 12.5px; color: var(--text-3); }
.ch-empty-mark { color: var(--text-3); margin-bottom: 14px; }
.ch-empty-title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.ch-empty-sub { color: var(--text-3); font-size: 13px; margin-top: 6px; }

/* user 气泡：右对齐深色（Taskora 深色 CTA 语言） */
.ch-bubble-user { display: flex; justify-content: flex-end; }
.ch-bubble-user-text {
  background: var(--text); color: #FAFAFA;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 14px;
  font-size: 13.5px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
}

/* assistant 气泡：白卡片 */
.ch-bubble-ai {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
}

/* 思考块 */
.ch-thinking {
  background: var(--surface-2);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.ch-thinking summary {
  cursor: pointer; font-size: 12.5px; color: var(--text-2); font-weight: 500;
  display: flex; align-items: center; gap: 6px;
  list-style: none; user-select: none;
}
.ch-thinking summary::-webkit-details-marker { display: none; }
.ch-thinking[open] summary { margin-bottom: 8px; }
.ch-pre {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12px; line-height: 1.7; color: var(--text-2);
  white-space: pre-wrap; word-break: break-word;
  margin: 0; max-height: 320px; overflow-y: auto;
}
.ch-thinking-pending {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--text-3);
  padding: 4px 2px 12px;
}
.ch-pulse-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green);
  animation: pulse 1.2s ease-in-out infinite;
}

/* 工具卡 */
.ch-tool {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #FCFCFD;
  margin: 10px 0;
}
.ch-tool.pending { border-color: #DDE3FE; background: #F8F9FF; }
.ch-tool summary {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: pointer; user-select: none;
  font-size: 12.5px; list-style: none;
}
.ch-tool summary::-webkit-details-marker { display: none; }
.ch-tool-icon { color: var(--text-3); flex-shrink: 0; }

/* ---------- ack 人机协同卡片（07_1） ---------- */

/* ---------- plan 步骤计划卡片（07_2 序 1） ---------- */
.ch-plan {
  border: 1px solid #C7D2FE; border-radius: 10px; background: #F8F9FF;
  padding: 12px 14px; margin: 6px 0; font-size: 13px;
}
.ch-plan-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ch-plan-icon { color: #4F46E5; flex-shrink: 0; }
.ch-plan-title { font-weight: 600; color: var(--text); }
.ch-plan-steps { display: flex; flex-direction: column; gap: 6px; }
.ch-plan-step { display: flex; align-items: baseline; gap: 9px; }
.ch-plan-idx {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 999px;
  background: #4F46E5; color: #fff; font-size: 11.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
  align-self: flex-start; margin-top: 1px;
}
.ch-plan-desc { color: var(--text); line-height: 1.5; }
.ch-plan-tool {
  font-size: 11px; color: #4F46E5; background: #EEF2FF;
  border-radius: 5px; padding: 1px 6px; white-space: nowrap;
}
.ch-ack {
  border: 1px solid #FDE68A; border-radius: 10px; background: #FFFBEB;
  padding: 12px 14px; margin: 6px 0; font-size: 13px;
}
.ch-ack.done { border-color: var(--border); background: var(--bg); }
.ch-ack-head { display: flex; align-items: center; gap: 8px; }
.ch-ack-icon { color: #D97706; flex-shrink: 0; }
.ch-ack-title { font-weight: 600; color: var(--text); line-height: 1.5; }
.ch-ack-risk {
  margin-top: 8px; font-size: 12.5px; color: #B91C1C; background: #FEF2F2;
  border: 1px solid #FECACA; border-radius: 7px; padding: 7px 10px;
}
.ch-ack-plan {
  margin-top: 10px; display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.ch-ack-options { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.ch-ack-option {
  text-align: left; border: 1px solid var(--border); background: var(--surface);
  border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.12s ease;
}
.ch-ack-option:hover { border-color: #D97706; }
.ch-ack-option.picked { border-color: #D97706; background: #FFFBEB; box-shadow: 0 0 0 2px rgba(217,119,6,0.12); }
.ch-ack-opt-label { display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--text); }
.ch-ack-rec { font-size: 10.5px; color: #D97706; background: #FEF3C7; border-radius: 999px; padding: 1px 7px; }
.ch-ack-opt-detail { display: block; margin-top: 2px; font-size: 12px; color: var(--text-3); }
/* 我的想法（辉哥 2026-09-11）：choice 自动追加的自由意见入口——虚线弱化，与实体方案区分 */
.ch-ack-option.ch-ack-custom { border-style: dashed; }
.ch-ack-option.ch-ack-custom.picked { border-style: solid; }
.ch-ack-custom-icon { flex-shrink: 0; color: var(--text-2); }
.ch-ack-custom-hint { margin-left: 4px; font-size: 11px; font-weight: 400; color: var(--text-3); }
.ch-ack-input-row { margin-top: 10px; }
.ch-ack-input {
  width: 100%; box-sizing: border-box; height: 36px; border: 1px solid var(--border);
  border-radius: 8px; padding: 0 12px; font-size: 13px; outline: none;
  background: var(--surface); color: var(--text); font-family: inherit;
}
.ch-ack-input:focus { border-color: #D97706; }
.ch-ack-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.ch-ack-hint { font-size: 12px; color: var(--text-3); margin-right: auto; }
.ch-ack-btn { height: 30px; padding: 0 14px; font-size: 12.5px; border-radius: 8px; border: none; cursor: pointer; }
.ch-ack-btn.st-btn-primary { background: #D97706; color: #fff; }
.ch-ack-btn.st-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-ack-btn.st-btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text-2); }
.ch-ack-resolved { display: flex; align-items: center; gap: 7px; margin-top: 8px; color: var(--text-2); font-size: 12.5px; }
.ch-ack-done-icon { color: #059669; flex-shrink: 0; }
.ch-thinking-icon { color: var(--text-3); flex-shrink: 0; }
.ch-tool-name { font-size: 12px; font-weight: 500; color: var(--text); }
.ch-tool-badge {
  font-size: 11px; padding: 1px 8px; border-radius: 999px; flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 5px;
}
.ch-tool-badge.ok { background: #ECFDF5; color: #047857; }
.ch-tool-badge.fail { background: #FEF2F2; color: #B91C1C; }
.ch-tool-badge.run { background: #FFFBEB; color: #B45309; }
.ch-tool-chevron { color: var(--text-3); margin-left: auto; transition: transform 0.2s ease; }
.ch-tool[open] .ch-tool-chevron { transform: rotate(90deg); }
.ch-tool-body { padding: 0 12px 10px; }
.ch-tool-args { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.ch-tool-label {
  font-size: 11px; color: var(--text-3); flex-shrink: 0;
  background: var(--surface-2); border-radius: 5px; padding: 2px 6px; margin-top: 2px;
}
.ch-tool-args code {
  font-size: 11.5px; color: var(--text-2); line-height: 1.6;
  word-break: break-all;
}
.ch-tool-error {
  background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px;
  padding: 8px 12px; font-size: 12.5px; color: #B91C1C;
}

/* 媒体段（09 图表：占位 → 渲染 → 降级） */
.ch-media {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #FCFCFD;
  margin: 10px 0;
  padding: 12px;
}
.ch-media-pending {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--text-3); padding: 16px 2px;
}
.ch-media-title {
  font-size: 13.5px; font-weight: 600; margin-bottom: 8px;
}
.ch-media-fallback {
  font-size: 12.5px; color: #B91C1C;
}
.ch-media-fallback details { margin-top: 6px; color: var(--text-2); }
.ch-media-fallback summary { cursor: pointer; font-size: 12px; color: var(--text-3); list-style: none; }
.ch-media-fallback summary::-webkit-details-marker { display: none; }
.ch-media-unknown {
  font-size: 12.5px; color: var(--text-3);
  padding: 14px 2px; text-align: center;
}

/* 菜谱卡片 */
.ch-recipe { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); }
.ch-recipe-name { font-size: 14px; font-weight: 600; }
.ch-recipe-meta { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.ch-chip-tag {
  font-size: 11px; padding: 1px 8px; border-radius: 999px;
  background: #FFFBEB; color: #B45309;
}
.ch-recipe-ings { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ch-ing-chip {
  font-size: 11.5px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-2);
}
.ch-recipe-desc { margin-top: 10px; }
.ch-recipe-desc summary {
  cursor: pointer; font-size: 12px; color: var(--text-3); user-select: none; list-style: none;
}
.ch-recipe-desc summary::-webkit-details-marker { display: none; }
.ch-recipe-desc[open] summary { margin-bottom: 8px; }

/* kv 摘要 */
.ch-kv { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ch-kv-row {
  display: flex; gap: 12px; padding: 7px 12px;
  border-bottom: 1px solid var(--border); font-size: 12px;
}
.ch-kv-row:last-child { border-bottom: none; }
.ch-kv-key { color: var(--text-2); font-weight: 500; flex-shrink: 0; }
.ch-kv-val { color: var(--text-3); word-break: break-all; }

/* 正文 markdown 渲染 */
.ch-text { font-size: 14px; line-height: 1.75; color: var(--text); word-break: break-word; }
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3), .md-body :deep(h4) {
  font-weight: 600; letter-spacing: -0.01em; margin: 18px 0 8px; line-height: 1.4;
}
.md-body :deep(h1) { font-size: 18px; }
.md-body :deep(h2) { font-size: 16px; }
.md-body :deep(h3) { font-size: 14.5px; }
.md-body :deep(h4) { font-size: 14px; }
.md-body :deep(h1:first-child), .md-body :deep(h2:first-child), .md-body :deep(p:first-child) { margin-top: 0; }
.md-body :deep(p) { margin: 8px 0; }
.md-body :deep(ul), .md-body :deep(ol) { margin: 8px 0; padding-left: 22px; }
.md-body :deep(li) { margin: 4px 0; }
.md-body :deep(strong) { font-weight: 600; }
.md-body :deep(a) { color: #4F46E5; text-decoration: none; border-bottom: 1px solid rgba(79, 70, 229, 0.3); }
.md-body :deep(code) {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12.5px; background: var(--surface-2);
  border-radius: 5px; padding: 1px 6px; color: var(--text);
}
/* 表格单元格内行内码不断行：长编码（如技能码）在 auto 布局下被压窄断行，视觉碎裂成伪列表 */
.md-body :deep(td code), .md-body :deep(th code) { white-space: nowrap; }
.md-body :deep(pre) {
  background: #FAFAFB; border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; overflow-x: auto; margin: 10px 0;
}
.md-body :deep(pre code) { background: none; padding: 0; font-size: 12.5px; line-height: 1.7; }
.md-body :deep(table) { border-collapse: collapse; margin: 10px 0; width: 100%; font-size: 13px; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--border); padding: 7px 11px; text-align: left; }
.md-body :deep(th) { background: var(--surface-2); font-weight: 500; }
.md-body :deep(blockquote) {
  margin: 10px 0; padding: 6px 14px; color: var(--text-2);
  border-left: 2px solid var(--border);
}
.md-body :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 14px 0; }

/* 生成中光标 */
.ch-typing { display: inline-block; color: var(--text-3); animation: blink 0.9s step-end infinite; }

/* 错误红字 */
.ch-error {
  background: #FEF2F2; border: 1px solid #FECACA; border-radius: 10px;
  padding: 9px 13px; font-size: 12.5px; color: #B91C1C;
  white-space: pre-wrap; word-break: break-word; margin-top: 8px;
}

/* ---------- 输入区（底部悬浮卡片） ---------- */
.ch-composer { padding: 8px 24px 14px; max-width: 808px; margin: 0 auto; width: 100%; box-sizing: border-box; flex-shrink: 0; }
.ch-composer-card {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 8px 8px 8px 8px;
  box-shadow: 0 4px 20px rgba(24, 24, 27, 0.05);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ch-composer-card:focus-within { border-color: #6366F1; box-shadow: 0 0 0 3px var(--ring), 0 4px 20px rgba(24, 24, 27, 0.05); }
.ch-composer-card.streaming { opacity: 0.7; }
.ch-composer-row { display: flex; align-items: center; gap: 10px; padding-left: 10px; position: relative; }

/* ---------- @ 唤起（15 号） ---------- */
/* 输入框 wrap：input 透明文字 + 镜像层渲染（@词蓝色链接字体的实现载体） */
.ch-input-wrap { flex: 1; position: relative; min-width: 0; display: flex; align-items: center; }
/* 高特异性压过 .ch-composer-input 的 color（否则出现双层文本重影） */
.ch-composer-input.ch-input-transparent { color: transparent; caret-color: var(--text); }
/* IME 拼音过程（composition）：v-model 冻结不更新镜像 → 切回 input 自身渲染
   （拼音 preedit 文本在 input 层正常显示，镜像隐藏防旧文本双显） */
.ch-input-wrap.composing .ch-input-mirror { visibility: hidden; }
.ch-input-wrap.composing .ch-composer-input.ch-input-transparent { color: var(--text); }
.ch-input-mirror {
  position: absolute; inset: 0; display: flex; align-items: center;
  font-size: 13.5px; color: var(--text); font-family: inherit;
  white-space: nowrap; overflow: hidden; pointer-events: none;
}
/* @ 词：蓝色链接字体（选中指令/技能后的醒目标记；文本即状态——删除即取消） */
.ch-at-word { color: #2563EB; }
.ch-at-menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30;
  width: 380px; max-height: 300px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(24, 24, 27, 0.14); padding: 4px;
}
.ch-at-group {
  font-size: 10.5px; color: var(--text-3); padding: 6px 10px 3px; font-weight: 600;
  letter-spacing: 0.04em;
}
.ch-at-item {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; background: none; border-radius: 7px;
  cursor: pointer; text-align: left; font-family: inherit;
}
.ch-at-item:hover { background: var(--surface-2); }
.ch-at-item-label { font-size: 13px; color: var(--text); font-weight: 600; flex-shrink: 0; }
.ch-at-item-desc { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-composer-input {
  flex: 1; border: none; outline: none; background: none;
  font-size: 13.5px; color: var(--text); font-family: inherit;
  height: 36px; min-width: 0;
}
.ch-composer-input::placeholder { color: var(--text-3); }
.ch-composer-input:disabled { cursor: not-allowed; }
.ch-send { height: 36px; }
.ch-stop {
  background: #B91C1C; color: #fff; border: none; display: inline-flex; align-items: center; gap: 5px;
}
.ch-composer-hint { text-align: center; font-size: 11.5px; color: var(--text-3); margin: 8px 0 0; }

/* ---------- Emotion Ball（NX_emotion-ball：AI 伙伴席） ---------- */
/* 输入框球 + 思考冒泡的包裹层：flex 布局占位与溢出补偿都在这一层 */
.ch-emotion-ball-wrap {
  position: relative; flex-shrink: 0;
  margin: -34px 6px -34px -10px;
}
/* 球：宽 65 高 120（viewBox 259 正方形按 preserveAspectRatio meet 取 65px 直径、
 * 垂直居中，上留白给弹跳腾挪） */
.ch-emotion-ball {
  width: 65px; height: 120px;
  cursor: default; user-select: none;
  pointer-events: none;            /* 不挡输入区交互；gaze 由全局 pointermove 驱动 */
}
/* 思考冒泡：悬在球上方（球顶在 120px 容器内约 27px 处，气泡底锚在球顶上方） */
.ch-ball-tip {
  position: absolute; bottom: 92px; left: 50%;
  transform: translateX(-50%);
  max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--surface); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 5px 11px; font-size: 12px;
  box-shadow: 0 2px 8px rgba(24, 24, 27, 0.08);
  z-index: 6;
}
.ch-ball-tip::after {  /* 小尾巴 */
  content: ''; position: absolute; left: 50%; bottom: -4px;
  transform: translateX(-50%) rotate(45deg);
  width: 7px; height: 7px;
  background: var(--surface); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
/* 冒泡过渡：淡入上浮、淡出 */
.ch-tip-enter-active { transition: opacity .25s ease, transform .25s ease; }
.ch-tip-leave-active { transition: opacity .15s ease; }
.ch-tip-enter-from { opacity: 0; transform: translateX(-50%) translateY(6px); }
.ch-tip-leave-to { opacity: 0; }
/* 空态迎宾球 + 迎宾气泡（绑在空态宽容器 .ch-empty 上）：
 * 气泡走文档流居中（宽度随内容自适应，最宽 640px），尾巴指向下方球，绝不裁切 */
.ch-empty-ball { width: 130px; height: 130px; margin: 0 auto; cursor: pointer; }
.ch-empty-tip {
  width: fit-content;
  max-width: 640px;
  margin: 0 auto 18px;
  background: var(--surface); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 7px 13px; font-size: 12px; line-height: 1.6;
  box-shadow: 0 2px 8px rgba(24, 24, 27, 0.08);
  position: relative;
}
.ch-empty-tip::after {  /* 尾巴：贴气泡底部居中，指向下方迎宾球 */
  content: ''; position: absolute; left: 50%; bottom: -4px;
  transform: translateX(-50%) rotate(45deg);
  width: 7px; height: 7px;
  background: var(--surface); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
/* 空态气泡过渡：淡入下坠感（文本自上而下浮现） */
.ch-tip-pop-enter-active { transition: opacity .25s ease, transform .25s ease; }
.ch-tip-pop-leave-active { transition: opacity .15s ease; }
.ch-tip-pop-enter-from { opacity: 0; transform: translateY(6px); }
.ch-tip-pop-leave-to { opacity: 0; }

/* ---------- 附件（11 方案） ---------- */
.ch-file-input { display: none; }
.ch-attach-btn {
  width: 32px; height: 32px; border-radius: 8px; border: none; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: none; color: var(--text-3); cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ch-attach-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.ch-attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 待发送附件栏（composer 卡内） */
.ch-composer-attach { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 10px 2px; }
.ch-attach-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 4px 6px 4px 6px; max-width: 220px; color: var(--text-2);
}
.ch-attach-chip-img { width: 32px; height: 32px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
.ch-attach-chip-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-attach-chip-x {
  border: none; background: none; color: var(--text-3); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 0 2px; flex-shrink: 0;
}
.ch-attach-chip-x:hover { color: var(--red); }

/* 用户气泡：气泡 + 下方文件引用条（11 方案：引用色，同 markdown blockquote 风格） */
.ch-bubble-user { display: flex; flex-direction: column; align-items: flex-end; }
.ch-bubble-user-body { display: flex; flex-direction: column; align-items: flex-end; max-width: 78%; }
.ch-attach-grid { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-bottom: 6px; }
.ch-attach-refs { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; margin-top: 3px; }
.ch-file-ref {
  display: inline-flex; align-items: center; gap: 6px;
  border-left: 2px solid var(--border); padding: 2px 10px;
  color: var(--text-2); font-size: 12px; text-decoration: none;
  max-width: 78%;
}
.ch-file-ref:hover { color: var(--text); }
.ch-file-ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-file-ref-size { color: var(--text-3); flex-shrink: 0; }

.ch-attach-img img {
  max-width: 180px; max-height: 140px; border-radius: 10px; display: block;
  border: 1px solid rgba(255, 255, 255, 0.25); cursor: zoom-in;
}
.ch-attach-file {
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 8px; padding: 6px 10px; color: #FAFAFA;
  font-size: 12px; text-decoration: none; max-width: 240px;
}
.ch-attach-file:hover { background: rgba(255, 255, 255, 0.2); }
.ch-attach-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-attach-file-size { opacity: 0.6; flex-shrink: 0; }

/* 拖拽悬停遮罩 */
.ch-drop-mask {
  position: absolute; inset: 0; z-index: 30;
  background: rgba(249, 249, 250, 0.85);
  display: flex; align-items: center; justify-content: center;
}
.ch-drop-card {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  color: var(--text-2); font-size: 14px;
  border: 2px dashed var(--text-3); border-radius: 16px;
  padding: 36px 56px; background: var(--surface);
}

/* ---------- 动画 ---------- */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}

/* ---------- 响应式（同设置页断点） ---------- */
@media (max-width: 760px) {
  .ch-rail { width: 56px; padding: 14px 8px 10px; }
  .ch-btn-new { width: 36px; padding: 0; justify-content: center; }
  .ch-btn-new span, .ch-rail-settings-text { display: none; }
  .ch-rail-app { display: none; }
  .ch-conv-title { display: none; }
  .ch-conv-item { padding: 10px 8px; display: flex; justify-content: center; }
  .ch-conv-item.active::before { top: 6px; bottom: 6px; }
  .ch-rail-settings { justify-content: center; padding: 10px 0; }
  .ch-thread { padding: 18px 14px 8px; }
  .ch-composer { padding: 8px 14px 10px; }
}
</style>

<style>
/* ============ 全局（非 scoped）：文本附件预览弹窗 ============
 * NModal 的内容渲染层拿不到 scoped hash 的稳定命中（且取不到 .chat-root
 * 作用域的 CSS 变量），此处类名加 ch- 前缀做命名空间隔离，选择器全局生效。
 * 色值取项目 zinc 色板硬编码（与 scoped 块的 --surface-2/--border 同值）。
 */
.ch-file-preview, .ch-file-preview-block {
  max-height: 60vh; overflow: auto;
  background: #F4F4F5;
  border: 1px solid #E9EAEC;
  border-radius: 8px; padding: 12px 14px;
  box-sizing: border-box;
}
.ch-file-preview {
  margin: 0;
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12.5px; line-height: 1.7; color: #18181B;
  white-space: pre-wrap; word-break: break-word;
}
.ch-file-preview-block { font-size: 13px; line-height: 1.75; color: #18181B; }
.ch-file-preview-tip { padding: 24px 0; text-align: center; color: #A1A1AA; font-size: 13px; }
.ch-file-preview-err { color: #EF4444; }
.ch-file-preview-dl { color: #52525B; margin-left: 6px; text-decoration: underline; }
</style>
