<script setup>
import { ref, reactive, nextTick, onMounted, onBeforeUnmount } from 'vue'
import MarkdownIt from 'markdown-it'
import { Brain, Wrench, BookOpen, CircleHelp, ListChecks, MessageCircleQuestion, CheckCircle2, Square, PenLine, Plus, MessageSquare, PanelLeftClose, PanelLeftOpen, Paperclip } from 'lucide-vue-next'
import MediaChart from '../components/MediaChart.vue'
import MediaMermaid from '../components/MediaMermaid.vue'
import { embedApi, embedAppKey } from '../api/embed'

/**
 * 应用嵌出对话页（16 方案 /embed/page?app_key=xxx，iframe 内运行）。
 *
 * 派生自 ChatView 的精简版（辉哥 2026-09-11 拍板）：
 * - 保留：消息气泡/思考折叠/工具卡片/图表与流程图媒体渲染/流式输出/停止按钮/
 *         ack 确认卡片（含"我的想法"）/附件多模态
 * - 移除：侧栏应用切换、设置入口、表情小球、会话重命名删除菜单
 * - 会话列表：展示（reserve2=appKey 隔离，只看嵌入产生的会话）
 */
const appKey = embedAppKey()
const config = ref(null)   // { legal, appCode, appName, modelLabel }
const configError = ref('')

const messages = ref([])
const conversationId = ref(null)
const streaming = ref(false)
const streamAbort = ref(null)
const listEl = ref(null)
const conversations = ref([])
const showConvList = ref(true)

// ---------- markdown ----------
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
function mdRender(text) {
  try { return md.render(text || '') } catch { return '' }
}
function kvEntries(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
}

// ---------- 启动：key 校验 + 会话列表 ----------

onMounted(async () => {
  if (!appKey) { configError.value = '缺少 app_key 参数'; return }
  try {
    const cfg = await embedApi.config(appKey)
    if (!cfg.legal) {
      configError.value = { invalid: 'app-key 无效或已吊销', domain: '当前域名不在白名单', quota: '今日配额已用完', app: '绑定的应用不存在' }[cfg.reason] || '授权无效'
      return
    }
    config.value = cfg
    await loadConversations()
  } catch (e) {
    configError.value = '授权服务不可达：' + e.message
  }
})

async function loadConversations() {
  try {
    conversations.value = await embedApi.conversations(appKey)
  } catch { /* 列表失败不阻塞对话 */ }
}

// ---------- 会话切换与消息回放（13 方案 content_blocks 结构化回放） ----------

function parseJsonArray(json) {
  if (!json) return []
  if (Array.isArray(json)) return json
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : [] } catch { return [] }
}

function buildFromContentBlocks(m, blocks) {
  const mediaArr = parseJsonArray(m.mediaJson)
  const segments = []
  for (const block of blocks) {
    switch (block.type) {
      case 'thinking': if (block.content?.trim()) segments.push({ type: 'think', content: block.content }); break
      case 'text': if (block.content?.trim()) segments.push({ type: 'text', content: block.content }); break
      case 'tool_use':
        segments.push({ type: 'tool', tool: block.content?.name || '未知工具', displayName: block.displayName || null, args: block.content?.args, result: null, costMs: block.costMs, success: block.status !== 'error', errorMessage: block.toolError })
        break
      case 'tool_result':
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].type === 'tool' && segments[i].result == null) { segments[i].result = block.content; break }
        }
        break
      case 'media': {
        const media = mediaArr.find(b => b && b.index === block.content?.mediaIndex) || {}
        segments.push({ type: 'media', mediaType: media.type || 'media_chart', index: block.content?.mediaIndex ?? 0, title: block.content?.title || media.title || null, data: media.data || null, pending: false })
        break
      }
      case 'plan':
        segments.push({ type: 'media', mediaType: 'plan', index: block.index, title: block.content?.steps ? `共 ${block.content.steps.length} 步` : null, data: block.content?.steps || null, pending: false })
        break
    }
  }
  return { role: 'assistant', segments, error: m.success === false && m.errorMessage ? '[' + m.errorMessage + ']' : '', messageId: m.messageId, done: true }
}

/** 历史消息 → assistant 消息模型（contentBlocks 优先，answerPure 纯文本兜底） */
function buildHistoryAssistant(m) {
  const blocks = parseJsonArray(m.contentBlocks)
  if (blocks.length) return buildFromContentBlocks(m, blocks)
  const text = (m.answerPure || '').trim()
  return {
    role: 'assistant',
    segments: text ? [{ type: 'text', content: text }] : [],
    error: m.success === false && m.errorMessage ? '[' + m.errorMessage + ']' : '',
    messageId: m.messageId,
    done: true,
  }
}

/** 会话历史加载态：区分「切换会话加载中」与「新会话空态」（避免加载期间闪现空态再跳出消息） */
const loadingConv = ref(false)

async function openConversation(convId) {
  if (streaming.value || convId === conversationId.value) return
  messages.value = []
  loadingConv.value = true
  try {
    const list = await embedApi.messages(appKey, convId)
    conversationId.value = convId
    // 每条 DB 记录拆两条展示消息（与主站 ChatView 同构）：
    // 有 question/附件 → user 气泡；assistant 部分 → contentBlocks/answerPure 回放
    const out = []
    for (const m of list) {
      const userAtt = parseJsonArray(m.attachments).map(a => ({
        kind: a.kind || (String(a.mime || '').startsWith('image/') ? 'image' : 'file'),
        mime: a.mime, name: a.name, size: a.size,
        // path 已含 uploads/ 前缀（与主站同构：'/' + path）
        previewUrl: a.path ? ('/' + a.path) : null,
      }))
      if ((m.question || '').trim() || userAtt.length) {
        out.push({ role: 'user', content: m.question || '', attachments: userAtt })
      }
      out.push(buildHistoryAssistant(m))
    }
    messages.value = out
    nextTick(() => { listEl.value?.scrollTo({ top: listEl.value.scrollHeight }) })
  } catch (e) {
    messages.value = []
  } finally {
    loadingConv.value = false
  }
}

function newConversation() {
  if (streaming.value) return
  conversationId.value = null
  messages.value = []
}

// ---------- 发送与 SSE ----------

const userInput = ref('')

async function sendMessage() {
  const query = userInput.value.trim()
  const hasAttachments = attachments.value.length > 0
  if ((!query && !hasAttachments) || streaming.value || !config.value) return

  let attachmentPayload = []
  if (hasAttachments) {
    try {
      attachmentPayload = await Promise.all(attachments.value.map(async a => ({ mime: a.mime, name: a.name, data: await fileToBase64(a.file) })))
    } catch { return }
  }

  userInput.value = ''
  const sentAttachments = attachments.value.map(a => ({ kind: a.mime.startsWith('image/') ? 'image' : 'file', mime: a.mime, name: a.name, size: a.size, previewUrl: a.previewUrl }))
  attachments.value = []
  messages.value.push({ role: 'user', content: query, attachments: sentAttachments })

  const assistantMsg = reactive({ role: 'assistant', segments: [], thinking: '', thinkingStarted: false, error: '', messageId: null, done: false })
  messages.value.push(assistantMsg)
  streaming.value = true
  scrollBottom()
  streamAbort.value = new AbortController()
  try {
    await embedApi.stream(appKey, {
      query,
      conversationId: conversationId.value || undefined,
      attachments: attachmentPayload.length ? attachmentPayload : undefined,
    }, evt => handleEvent(evt, assistantMsg), streamAbort.value.signal)
  } catch (e) {
    if (e?.name !== 'AbortError') assistantMsg.error = (assistantMsg.error ? assistantMsg.error + '\n' : '') + '请求失败：' + e.message
  } finally {
    streaming.value = false
    streamAbort.value = null
    assistantMsg.done = true
    scrollBottom()
    loadConversations()
  }
}

function stopStreaming() { streamAbort.value?.abort() }

function handleEvent(evt, msg) {
  switch (evt.type) {
    case 'MESSAGE':
      if (evt.messageId && !msg.messageId) msg.messageId = evt.messageId
      if (evt.conversationId) conversationId.value = evt.conversationId
      if (evt.content) {
        const lastSeg = msg.segments[msg.segments.length - 1]
        if (lastSeg && lastSeg.type === 'text') lastSeg.content += evt.content
        else msg.segments.push({ type: 'text', content: evt.content })
      }
      break
    case 'THINKING':
      if (evt.content) {
        const lastSeg = msg.segments[msg.segments.length - 1]
        if (!evt.thinkingRestart && lastSeg && lastSeg.type === 'think') lastSeg.content += evt.content
        else msg.segments.push({ type: 'think', content: evt.content })
        msg.thinkingStarted = true
      } else msg.thinkingStarted = true
      break
    case 'TOOL_START':
      msg.segments.push({ type: 'tool', tool: evt.tool, displayName: evt.displayName || null, args: evt.args, result: null, costMs: null, success: null, errorMessage: null })
      break
    case 'TOOL_RESULT':
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        const s = msg.segments[i]
        if (s.type === 'tool' && s.tool === evt.tool && s.result == null && s.success == null) {
          s.result = evt.result || null; s.costMs = evt.costMs
          s.success = evt.toolError ? false : true
          if (evt.toolError) s.errorMessage = evt.toolError
          break
        }
      }
      break
    case 'MEDIA_START':
      msg.segments.push({ type: 'media', mediaType: evt.mediaType || 'media_chart', index: evt.mediaIndex, title: null, data: null, pending: true })
      break
    case 'MEDIA_END': {
      let target = null
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        const s = msg.segments[i]
        if (s.type === 'media' && s.index === evt.mediaIndex && s.pending) { target = s; break }
      }
      if (target) { target.title = evt.content || null; target.data = evt.mediaData || null; target.pending = false }
      else msg.segments.push({ type: 'media', mediaType: evt.mediaType || 'media_chart', index: evt.mediaIndex, title: evt.content || null, data: evt.mediaData || null, pending: false })
      break
    }
    case 'DONE':
      if (evt.conversationId) conversationId.value = evt.conversationId
      msg.done = true
      break
    case 'ERROR':
      msg.error = (msg.error ? msg.error + '\n' : '') + (evt.content || '未知错误')
      break
  }
  scrollBottom()
}

function scrollBottom() {
  nextTick(() => { if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight })
}

// ---------- ack 确认卡片（含"我的想法"，从 ChatView 同步精简） ----------

function ackIconOf(args) {
  const t = args?.type
  if (t === 'approval') return CircleHelp
  if (t === 'choice') return ListChecks
  return MessageCircleQuestion
}
function ackOptionsOf(args) {
  return Array.isArray(args?.options) ? args.options.filter(o => o && o.id && o.label) : []
}
function ackPlanOf(args) {
  return Array.isArray(args?.plan) ? args.plan.filter(s => s && s.desc) : []
}
function ackLabelOf(args, id) {
  const hit = ackOptionsOf(args).find(o => o.id === id)
  return hit ? hit.label : id
}
const ACK_CUSTOM_ID = '_custom'
const ackResponding = ref(false)

async function respondAck(seg, msg, reject = false) {
  if (ackResponding.value || streaming.value) return
  const isCustom = seg._picked === ACK_CUSTOM_ID
  const customText = (seg._input || '').trim()
  const body = reject ? { reject: true } : (
    isCustom ? { input: `[我的想法] ${customText}` } :
    seg._picked ? { choice: seg._picked } : { input: (seg._input || '').trim() }
  )
  if (!reject && ((isCustom && !customText) || (!isCustom && !seg._picked && !body.input))) return
  ackResponding.value = true
  const pickedLabel = (!isCustom && seg._picked) ? ackLabelOf(seg.args, seg._picked) : ''
  seg.result = reject ? '用户已取消该操作'
    : (isCustom ? `用户想法：${customText}`
    : (pickedLabel ? `用户选择：${seg._picked} · ${pickedLabel}` : `用户回复：${body.input}`))
  seg.success = true
  if (reject) {
    try { await embedApi.ackRespond(config.value.appCode, msg.messageId, body, () => {}) } catch { /* 拒绝失败静默 */ }
    finally { ackResponding.value = false }
    return
  }
  const resumeMsg = reactive({ role: 'assistant', segments: [], thinking: '', thinkingStarted: false, error: '', messageId: null, done: false })
  messages.value.push(resumeMsg)
  streaming.value = true
  scrollBottom()
  streamAbort.value = new AbortController()
  try {
    await embedApi.ackRespond(config.value.appCode, msg.messageId, body, evt => handleEvent(evt, resumeMsg), streamAbort.value.signal)
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

// ---------- 附件（11 方案同款：图片多模态 / 文本注入） ----------

const attachments = ref([])
const fileInputEl = ref(null)
const dragOver = ref(false)
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const EXT_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain'
}
function resolveMime(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase()
  if (EXT_MIMES[ext]) return EXT_MIMES[ext]
  const t = (file.type || '').toLowerCase()
  return Object.values(EXT_MIMES).includes(t) ? t : null
}
function addFiles(fileList) {
  if (streaming.value) return
  for (const f of Array.from(fileList || [])) {
    if (attachments.value.length >= MAX_ATTACHMENTS) break
    const mime = resolveMime(f)
    if (!mime) continue
    if (f.size > MAX_ATTACHMENT_BYTES) continue
    attachments.value.push({ mime, name: f.name, size: f.size, file: f, previewUrl: URL.createObjectURL(f) })
  }
}
function removeAttachment(idx) {
  const [a] = attachments.value.splice(idx, 1)
  if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl)
}
function onPaste(e) {
  const files = e.clipboardData?.files
  if (files?.length) { e.preventDefault(); addFiles(files) }
}
function onDrop(e) {
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length) addFiles(files)
}
function onDragLeave(e) {
  if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) dragOver.value = false
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

onBeforeUnmount(() => {
  streamAbort.value?.abort()
  attachments.value.forEach(a => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
})
</script>

<template>
  <!-- 授权失败：全屏提示 -->
  <div v-if="configError" class="eb-error-page">
    <div class="eb-error-card">
      <div class="eb-error-icon">🔑</div>
      <h3>无法打开对话</h3>
      <p>{{ configError }}</p>
      <p class="eb-error-sub">请联系提供方检查应用密钥配置</p>
    </div>
  </div>

  <!-- 正常嵌入对话 -->
  <div v-else class="eb-page" @dragover.prevent="!streaming && (dragOver = true)" @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- 拖拽遮罩 -->
    <div v-if="dragOver" class="eb-drop-mask"><p>松开添加附件</p></div>

    <!-- 左：会话列表（嵌入会话，reserve2=appKey 隔离） -->
    <aside v-if="showConvList" class="eb-rail">
      <div class="eb-rail-head">
        <span class="eb-app-name">{{ config?.appName || '…' }}</span>
        <button class="eb-rail-toggle" title="收起会话列表" @click="showConvList = false"><PanelLeftClose :size="13" /></button>
      </div>
      <button class="eb-new-btn" :disabled="streaming" @click="newConversation"><Plus :size="12" /> 新对话</button>
      <div class="eb-conv-list">
        <button v-for="c in conversations" :key="c.conversationId"
                class="eb-conv-item" :class="{ active: c.conversationId === conversationId }"
                @click="openConversation(c.conversationId)">
          <MessageSquare :size="12" class="eb-conv-icon" />
          <span class="eb-conv-title">{{ c.title || '（未命名）' }}</span>
        </button>
        <div v-if="!conversations.length" class="eb-conv-empty">还没有会话</div>
      </div>
      <div class="eb-rail-foot">{{ config?.modelLabel }}</div>
    </aside>

    <!-- 右：消息流 + 输入 -->
    <main class="eb-main">
      <div v-if="!showConvList" class="eb-rail-open">
        <button class="eb-rail-toggle" title="展开会话列表" @click="showConvList = true"><PanelLeftOpen :size="13" /></button>
      </div>

      <div ref="listEl" class="eb-thread">
        <!-- 切换会话加载中（与空态区分） -->
        <div v-if="loadingConv" class="eb-empty eb-conv-loading">
          <span class="eb-loading-dots"><span></span><span></span><span></span></span>
          <p class="eb-conv-loading-text">正在加载会话…</p>
        </div>
        <!-- 空态 -->
        <div v-else-if="!messages.length" class="eb-empty">
          <p class="eb-empty-title">你好，我是 {{ config?.appName || '智能助手' }}</p>
          <p class="eb-empty-sub">输入问题开始对话；支持粘贴图片</p>
        </div>

        <div v-for="(m, idx) in messages" :key="idx" class="eb-msg" :class="m.role">
          <!-- 用户气泡 -->
          <div v-if="m.role === 'user'" class="eb-bubble-user">
            <div v-if="m.attachments?.some(a => a.kind === 'image')" class="eb-attach-grid">
              <a v-for="(a, ai) in m.attachments.filter(a => a.kind === 'image')" :key="ai" :href="a.previewUrl" target="_blank" class="eb-attach-img"><img :src="a.previewUrl" :alt="a.name" /></a>
            </div>
            <div v-if="m.content" class="eb-bubble-user-text">{{ m.content }}</div>
          </div>

          <!-- 助手：segments 时序渲染 -->
          <div v-else class="eb-bubble-ai">
            <template v-for="(seg, si) in m.segments" :key="si">
              <!-- 思考折叠 -->
              <details v-if="seg.type === 'think'" class="eb-think">
                <summary><Brain :size="11" /> 思考过程</summary>
                <div class="eb-think-body">{{ seg.content }}</div>
              </details>
              <!-- 正文 -->
              <div v-else-if="seg.type === 'text' && seg.content" class="eb-text md-body" v-html="mdRender(seg.content)"></div>
              <!-- 媒体 -->
              <div v-else-if="seg.type === 'media'" class="eb-media">
                <div v-if="seg.pending" class="eb-media-pending"><span class="eb-pulse"></span> 生成图表中…</div>
                <template v-else>
                  <div v-if="seg.title" class="eb-media-title">{{ seg.title }}</div>
                  <div v-if="seg.mediaType === 'plan' && Array.isArray(seg.data)" class="eb-plan">
                    <div v-for="s in seg.data" :key="s.index" class="eb-plan-step">
                      <span class="eb-plan-idx">{{ s.index }}</span><span>{{ s.desc }}</span>
                      <span v-if="s.tool" class="mono">{{ s.tool }}</span>
                    </div>
                  </div>
                  <MediaChart v-else-if="seg.data && typeof seg.data === 'object'" :option="seg.data" />
                  <MediaMermaid v-else-if="seg.data && typeof seg.data === 'string'" :code="seg.data" />
                  <div v-else class="eb-media-fallback">⚠️ 图表数据异常</div>
                </template>
              </div>
              <!-- ack 段：用户决策卡片（等待响应交互态 / 已响应只读态） -->
              <div v-else-if="seg.type === 'tool' && seg.tool === 'ack_user'" class="eb-ack" :class="{ done: seg.result != null }">
                <div class="eb-ack-head">
                  <component :is="ackIconOf(seg.args)" :size="14" />
                  <span>{{ seg.args?.question || '等待用户确认' }}</span>
                </div>
                <div v-if="seg.args?.risk" class="eb-ack-risk">⚠️ {{ seg.args.risk }}</div>
                <div v-if="ackPlanOf(seg.args).length" class="eb-ack-plan">
                  <div v-for="s in ackPlanOf(seg.args)" :key="s.index" class="eb-plan-step">
                    <span class="eb-plan-idx">{{ s.index }}</span>
                    <span>{{ s.desc }}</span>
                    <span v-if="s.tool" class="mono">{{ s.tool }}</span>
                  </div>
                </div>
                <template v-if="seg.result == null">
                  <div v-if="ackOptionsOf(seg.args).length" class="eb-ack-options">
                    <button v-for="o in ackOptionsOf(seg.args)" :key="o.id" type="button"
                            class="eb-ack-option" :class="{ picked: seg._picked === o.id }"
                            @click="seg._picked = o.id">
                      <span class="eb-ack-opt-label">{{ o.id }} · {{ o.label }}<span v-if="o.recommended" class="eb-ack-rec">推荐</span></span>
                      <span v-if="o.detail" class="eb-ack-opt-detail">{{ o.detail }}</span>
                    </button>
                    <button v-if="seg.args?.type === 'choice'" type="button"
                            class="eb-ack-option ch-ack-custom" :class="{ picked: seg._picked === ACK_CUSTOM_ID }"
                            @click="seg._picked = ACK_CUSTOM_ID">
                      <span class="eb-ack-opt-label"><PenLine :size="12" /> 我的想法<span class="eb-ack-custom-hint">不选方案，直接说你的意见</span></span>
                    </button>
                  </div>
                  <div v-if="seg.args?.type === 'clarify' || !ackOptionsOf(seg.args).length || seg._picked === ACK_CUSTOM_ID" class="eb-ack-input-row">
                    <input v-model="seg._input" class="eb-ack-input"
                           :placeholder="seg._picked === ACK_CUSTOM_ID ? '如：我觉得 B 方案不错，但这些地方需要调整…' : '输入你的回复…'"
                           @keydown.enter="respondAck(seg, m)" />
                  </div>
                  <div class="eb-ack-actions">
                    <span v-if="seg.args?.default && ackOptionsOf(seg.args).length" class="eb-ack-hint">💡 模型建议：{{ ackLabelOf(seg.args, seg.args.default) }}</span>
                    <button type="button" class="eb-ack-btn"
                            :disabled="ackResponding || (seg._picked === ACK_CUSTOM_ID ? !(seg._input || '').trim() : (!seg._picked && !seg._input))"
                            @click="respondAck(seg, m)">{{ seg.args?.type === 'approval' ? '确认执行' : '提交' }}</button>
                    <button type="button" class="eb-ack-btn ghost"
                            :disabled="ackResponding" @click="respondAck(seg, m, true)">取消</button>
                  </div>
                </template>
                <div v-else class="eb-ack-resolved">
                  <CheckCircle2 :size="13" />
                  <span>{{ seg.result }}</span>
                </div>
              </div>

              <!-- 工具卡片 -->
              <details v-else-if="seg.type === 'tool'" class="eb-tool" :class="{ pending: seg.result == null && seg.success == null }">
                <summary>
                  <component :is="seg.tool === 'load_skill' ? BookOpen : Wrench" :size="12" />
                  <span class="mono eb-tool-name">{{ seg.displayName || seg.tool }}</span>
                  <span v-if="seg.result != null || seg.success != null" class="eb-tool-badge" :class="seg.success === false ? 'fail' : 'ok'">{{ seg.success === false ? '失败' : '完成' }} · {{ seg.costMs }}ms</span>
                  <span v-else class="eb-tool-badge run"><span class="eb-pulse"></span>调用中</span>
                </summary>
                <div class="eb-tool-body">
                  <div v-if="seg.args && Object.keys(seg.args).length" class="eb-tool-args">
                    <div v-for="([k, v]) in kvEntries(seg.args).slice(0, 6)" :key="k" class="eb-kv"><span class="eb-k">{{ k }}</span><span class="eb-v">{{ v }}</span></div>
                  </div>
                  <pre v-if="seg.result != null" class="eb-tool-result" :class="{ fail: seg.success === false }">{{ seg.result }}</pre>
                </div>
              </details>
            </template>
            <!-- 流式思考中占位 -->
            <div v-if="m.thinkingStarted && !m.segments.length" class="eb-thinking-hint"><span class="eb-pulse"></span> 思考中…</div>
            <div v-if="m.error" class="eb-error">{{ m.error }}</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <footer class="eb-composer">
        <input ref="fileInputEl" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json,.log" class="eb-file-input" @change="e => { addFiles(e.target.files); e.target.value = '' }" />
        <div v-if="attachments.length" class="eb-attach-bar">
          <div v-for="(a, ai) in attachments" :key="ai" class="eb-attach-chip">
            <img v-if="a.mime.startsWith('image/')" :src="a.previewUrl" class="eb-attach-thumb" />
            <span class="eb-attach-name">{{ a.name }}</span>
            <button class="eb-attach-x" @click="removeAttachment(ai)">×</button>
          </div>
        </div>
        <div class="eb-input-row">
          <button class="eb-attach-btn" title="支持：图片 png/jpg/jpeg/webp/gif；文本 txt/md/csv/json/log（单个 ≤5MB，最多 4 个）" :disabled="streaming" @click="fileInputEl?.click()"><Paperclip :size="14" /></button>
          <input v-model="userInput" class="eb-input" placeholder="输入问题，回车发送…（可粘贴图片）"
                 :disabled="streaming" @keydown.enter.exact.prevent="sendMessage" @paste="onPaste" />
          <button v-if="streaming" class="eb-btn eb-stop" @click="stopStreaming"><Square :size="12" /></button>
          <button v-else class="eb-btn eb-send" :disabled="!userInput.trim() && !attachments.length" @click="sendMessage">发送</button>
        </div>
        <p class="eb-hint">回车发送 · 支持图片/文件附件</p>
      </footer>
    </main>
  </div>
</template>

<style scoped>
/* 嵌入页独立样式（自包含，不依赖主站 settings/chat 样式） */
.eb-page { position: fixed; inset: 0; display: flex; background: #F9F9FA; color: #18181B; font-family: 'Geist Sans', -apple-system, sans-serif; }
.eb-rail { width: 190px; flex-shrink: 0; background: var(--surface, #FFFFFF); border-right: 1px solid #E9EAEC; display: flex; flex-direction: column; }
.eb-rail-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 10px 8px; }
.eb-app-name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-rail-toggle { border: none; background: none; cursor: pointer; color: #A1A1AA; padding: 3px; border-radius: 5px; display: flex; }
.eb-rail-toggle:hover { background: #F4F4F5; color: #18181B; }
.eb-new-btn { margin: 4px 10px 8px; display: flex; align-items: center; gap: 5px; justify-content: center; border: 1px solid #E9EAEC; background: #FFFFFF; border-radius: 7px; padding: 7px; font-size: 12px; cursor: pointer; color: #18181B; }
.eb-new-btn:hover { border-color: #D97706; }
.eb-conv-list { flex: 1; overflow-y: auto; padding: 0 6px; display: flex; flex-direction: column; gap: 2px; }
.eb-conv-item { display: flex; align-items: center; gap: 6px; border: none; background: none; text-align: left; padding: 7px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; color: #52525B; }
.eb-conv-item:hover { background: #F4F4F5; }
.eb-conv-item.active { background: #FFFBEB; color: #18181B; }
.eb-conv-icon { flex-shrink: 0; color: #A1A1AA; }
.eb-conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-conv-empty { text-align: center; color: #A1A1AA; font-size: 11.5px; padding: 16px 0; }
.eb-rail-foot { padding: 10px; font-size: 10.5px; color: #A1A1AA; border-top: 1px solid #F0F0F1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-main { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; }
.eb-rail-open { position: absolute; top: 10px; left: 10px; z-index: 5; }
.eb-thread { flex: 1; overflow-y: auto; padding: 18px 16px 10px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.eb-empty { text-align: center; padding: 56px 20px; }
/* 切换会话加载态（与空态区分）：三点脉冲 + 文案 */
.eb-conv-loading { padding: 72px 20px; }
.eb-loading-dots { display: inline-flex; gap: 6px; align-items: center; }
.eb-loading-dots span { width: 7px; height: 7px; border-radius: 50%; background: #A1A1AA; animation: eb-dot-pulse 1.2s infinite ease-in-out; }
.eb-loading-dots span:nth-child(2) { animation-delay: .18s; }
.eb-loading-dots span:nth-child(3) { animation-delay: .36s; }
@keyframes eb-dot-pulse { 0%, 100% { opacity: .25; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
.eb-conv-loading-text { margin: 12px 0 0; font-size: 12.5px; color: #A1A1AA; }
.eb-empty-title { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
.eb-empty-sub { font-size: 12.5px; color: #A1A1AA; margin: 0; }
.eb-msg { margin-bottom: 14px; }
.eb-bubble-user { display: flex; flex-direction: column; align-items: flex-end; }
.eb-bubble-user-text { background: #18181B; color: #FAFAFA; border-radius: 12px 12px 3px 12px; padding: 9px 13px; font-size: 13.5px; max-width: 82%; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.eb-attach-grid { display: flex; gap: 6px; margin-bottom: 6px; justify-content: flex-end; }
.eb-attach-img { display: block; border-radius: 8px; overflow: hidden; border: 1px solid #E9EAEC; }
.eb-attach-img img { display: block; width: 92px; height: 92px; object-fit: cover; }
.eb-bubble-ai { font-size: 13.5px; line-height: 1.65; }
.eb-think { border: 1px solid #E9EAEC; border-radius: 8px; margin-bottom: 8px; background: #FCFCFD; }
.eb-think summary { cursor: pointer; display: flex; align-items: center; gap: 5px; padding: 6px 10px; font-size: 11.5px; color: #A1A1AA; list-style: none; }
.eb-think-body { padding: 2px 12px 10px; font-size: 12px; color: #71717A; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; }
.eb-text { max-width: 100%; }
.eb-text :deep(p) { margin: 0 0 8px; } .eb-text :deep(p:last-child) { margin-bottom: 0; }
.eb-text :deep(pre) { background: #18181B; color: #E4E4E7; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
.eb-text :deep(code) { font-family: 'Geist Mono', monospace; }
.eb-text :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
.eb-text :deep(th), .eb-text :deep(td) { border: 1px solid #E9EAEC; padding: 5px 9px; text-align: left; }
.eb-media { border: 1px solid #E9EAEC; border-radius: 10px; padding: 8px; margin: 8px 0; background: #FFFFFF; }
.eb-media-title { font-size: 12px; color: #52525B; margin-bottom: 6px; text-align: center; }
.eb-media-pending { display: flex; align-items: center; gap: 6px; color: #A1A1AA; font-size: 12px; padding: 22px 0; justify-content: center; }
.eb-pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #D97706; animation: eb-pulse 1.2s infinite; }
@keyframes eb-pulse { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
.eb-plan { display: flex; flex-direction: column; gap: 5px; }
.eb-plan-step { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #52525B; }
.eb-plan-idx { background: #FFFBEB; border: 1px solid #FDE68A; color: #B45309; border-radius: 5px; min-width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 600; }
.eb-tool { border: 1px solid #E9EAEC; border-radius: 8px; margin-bottom: 8px; background: #FCFCFD; }
.eb-tool summary { cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; list-style: none; color: #52525B; }
.eb-tool-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; margin-left: auto; }
.eb-tool-badge.ok { color: #059669; background: #ECFDF5; } .eb-tool-badge.fail { color: #DC2626; background: #FEF2F2; }
.eb-tool-badge.run { color: #B45309; background: #FFFBEB; display: flex; align-items: center; gap: 4px; }
.eb-tool-body { padding: 4px 12px 10px; font-size: 12px; }
.eb-tool-args { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.eb-kv { display: flex; gap: 8px; }
.eb-k { color: #A1A1AA; min-width: 72px; font-size: 11.5px; } .eb-v { color: #52525B; word-break: break-all; }
.eb-tool-result { background: #18181B; color: #E4E4E7; padding: 8px 10px; border-radius: 6px; font-size: 11.5px; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0; }
.eb-thinking-hint { display: flex; align-items: center; gap: 6px; color: #A1A1AA; font-size: 12px; padding: 6px 0; }
.eb-error { color: #DC2626; font-size: 12.5px; padding: 6px 0; white-space: pre-wrap; }
/* ack 卡片（复用 ChatView 的 ack 结构精简） */
.eb-ack { border: 1.5px solid #FDE68A; background: #FFFBEB; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.eb-ack.done { opacity: .75; }
.eb-ack-head { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.eb-ack-risk { font-size: 12px; color: #B45309; margin-top: 4px; }
.eb-ack-plan { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.eb-ack-options { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.eb-ack-option { border: 1px solid #FDE68A; background: #FFFFFF; border-radius: 8px; padding: 8px 11px; cursor: pointer; text-align: left; font-size: 12.5px; }
.eb-ack-option:hover { border-color: #D97706; }
.eb-ack-option.picked { border-color: #D97706; box-shadow: 0 0 0 2px rgba(217,119,6,.12); }
.eb-ack-option.ch-ack-custom { border-style: dashed; }
.eb-ack-option.ch-ack-custom.picked { border-style: solid; }
.eb-ack-opt-label { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.eb-ack-custom-hint { font-size: 11px; font-weight: 400; color: #A1A1AA; }
.eb-ack-opt-detail { display: block; margin-top: 2px; font-size: 11.5px; color: #A1A1AA; }
.eb-ack-input-row { margin-top: 8px; }
.eb-ack-input { width: 100%; box-sizing: border-box; border: 1px solid #FDE68A; border-radius: 7px; padding: 7px 10px; font-size: 12.5px; background: #FFFFFF; }
.eb-ack-input:focus { outline: none; border-color: #D97706; }
.eb-ack-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.eb-ack-btn { border: 1px solid #D97706; background: #D97706; color: #FFF; border-radius: 7px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
.eb-ack-btn:disabled { opacity: .5; cursor: not-allowed; }
.eb-ack-btn.ghost { background: #FFFFFF; color: #52525B; border-color: #E9EAEC; }
.eb-ack-hint { font-size: 11.5px; color: #A1A1AA; margin-right: auto; }
.eb-ack-resolved { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #059669; margin-top: 6px; }
.eb-ack-rec { font-size: 10px; background: #D97706; color: #fff; border-radius: 4px; padding: 1px 5px; margin-left: 4px; }
/* 输入区 */
.eb-composer { padding: 8px 16px 10px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.eb-attach-bar { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.eb-attach-chip { display: flex; align-items: center; gap: 6px; border: 1px solid #E9EAEC; border-radius: 7px; padding: 4px 8px; font-size: 11.5px; background: #FFFFFF; }
.eb-attach-thumb { width: 26px; height: 26px; object-fit: cover; border-radius: 4px; }
.eb-attach-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-attach-x { border: none; background: none; cursor: pointer; color: #A1A1AA; font-size: 13px; padding: 0 2px; }
.eb-input-row { display: flex; align-items: center; gap: 8px; background: #FFFFFF; border: 1px solid #E9EAEC; border-radius: 12px; padding: 7px 8px 7px 10px; box-shadow: 0 1px 4px rgba(24,24,27,.04); }
.eb-input-row:focus-within { border-color: #D97706; }
.eb-input { flex: 1; border: none; outline: none; font-size: 13.5px; background: none; color: #18181B; }
.eb-attach-btn { border: none; background: none; color: #A1A1AA; cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
.eb-attach-btn:hover { background: #F4F4F5; color: #18181B; }
.eb-btn { border: none; border-radius: 8px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; }
.eb-send { background: #18181B; color: #FAFAFA; }
.eb-send:disabled { opacity: .4; cursor: not-allowed; }
.eb-stop { background: #FEF2F2; color: #DC2626; border: 1px solid #FECACA; display: flex; align-items: center; }
.eb-hint { text-align: center; font-size: 11px; color: #A1A1AA; margin: 7px 0 0; }
.eb-file-input { display: none; }
/* 拖拽遮罩 & 错误页 */
.eb-drop-mask { position: absolute; inset: 0; background: rgba(24,24,27,.06); z-index: 20; display: flex; align-items: center; justify-content: center; }
.eb-drop-mask p { border: 1.5px dashed #D97706; border-radius: 12px; padding: 18px 34px; color: #B45309; font-size: 13px; background: #FFFBEB; }
.eb-error-page { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #F9F9FA; }
.eb-error-card { text-align: center; padding: 40px 50px; background: #FFF; border: 1px solid #E9EAEC; border-radius: 14px; }
.eb-error-icon { font-size: 30px; margin-bottom: 10px; }
.eb-error-card h3 { margin: 0 0 8px; font-size: 16px; color: #18181B; }
.eb-error-card p { margin: 0; font-size: 13px; color: #52525B; }
.eb-error-sub { margin-top: 6px !important; color: #A1A1AA !important; font-size: 12px !important; }
.mono { font-family: 'Geist Mono', monospace; }
/* 移动端（widget 全屏形态） */
@media (max-width: 640px) {
  .eb-rail { position: absolute; z-index: 10; top: 0; bottom: 0; box-shadow: 4px 0 14px rgba(24,24,27,.08); }
  .eb-thread { padding: 14px 12px 8px; }
}
</style>
