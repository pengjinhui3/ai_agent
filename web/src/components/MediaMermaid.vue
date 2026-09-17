<script setup>
import { onMounted, ref, watch, computed } from 'vue'
import mermaid from 'mermaid'

/**
 * media_mermaid 富媒体段渲染组件（09 方案媒体族扩展：流程图/架构/时序/状态）。
 *
 * mermaid 单例初始化 + 按图编号 render（返回 SVG 字符串 → v-html 注入容器）；
 * 非法语法降级显示错误 + 可折叠原文（与 media_chart 容错策略一致）。
 */
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',   // 禁止 SVG 内交互脚本（模型输出不可信）
  fontFamily: 'inherit',
})

const props = defineProps({
  /** mermaid 源码（media_json 条目 data 或 SSE MEDIA_END mediaData） */
  code: { type: String, required: true },
})

const svg = ref('')
const renderError = ref('')
let renderSeq = 0   // 异步竞态防护：仅最后一次 watch 的结果生效

async function render() {
  const seq = ++renderSeq
  renderError.value = ''
  try {
    const { svg: out } = await mermaid.render(`mmd-${Date.now()}-${seq}`, props.code)
    if (seq === renderSeq) svg.value = out
  } catch (e) {
    if (seq === renderSeq) {
      renderError.value = e?.message?.split('\n')[0] || 'mermaid 语法解析失败'
      svg.value = ''
    }
  }
}

onMounted(render)
watch(() => props.code, render)

const rawCode = computed(() => props.code)
</script>

<template>
  <div class="media-mermaid-box">
    <div v-if="renderError" class="media-mermaid-error">
      ⚠️ 流程图渲染失败：{{ renderError }}
      <details><summary>查看 mermaid 源码</summary><pre class="media-mermaid-raw">{{ rawCode }}</pre></details>
    </div>
    <!-- mermaid.render 输出的 SVG 已经 securityLevel:strict 消毒，v-html 安全 -->
    <div v-else-if="svg" class="media-mermaid-svg" v-html="svg"></div>
  </div>
</template>

<style scoped>
.media-mermaid-box {
  width: 100%;
  overflow-x: auto;   /* 宽图横向滚动，不挤压消息流 */
  padding: 4px 0;
}
.media-mermaid-svg :deep(svg) {
  max-width: 100%;
  height: auto;
}
.media-mermaid-error {
  font-size: 12.5px;
  color: #B45309;
  background: #FEF3C7;
  border: 1px solid #FDE68A;
  border-radius: 8px;
  padding: 10px 12px;
}
.media-mermaid-raw {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  color: var(--text-3);
}
</style>
